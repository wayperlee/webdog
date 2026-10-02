import { normalizeHttpUrl, normalizedPageHosts } from "./sitemap/urls";
import { adoptComplete, approveCandidate } from "./url-inventory";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NORMALIZATION_POLICY, type CrawlResult, type CrawlState } from "./sitemap/types";
import type { CrawlOptions } from "./sitemap";

export type Trigger = "manual" | "scheduled" | "confirmation";
export type RunError = { code: string; message: string; retryable: boolean; retryAfterMs?: number };
export class QueueError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "QueueError"; }
}
export type RunRow = {
  id: string; target_id: string; trigger: Trigger; scope_version: number;
  origin_baseline_run_id: string | null; config: Pick<CrawlOptions, "siteUrl" | "roots" | "allowedPageHosts">;
  execution_status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number; lease_epoch: number; lease_token: string | null;
  completeness: string; adoption_status: string; available_at: Date; created_at: Date;
  lease_expires_at: Date | null; result: Omit<CrawlResult, "state"> | null;
  attempt_started_at: Date | null; observed_at: Date | null;
};
type TargetRow = {
  id: string; websiteId: string; kind: string; enabled: boolean; archivedAt: Date | null;
  scopeVersion: number; baselineRunId: string | null; checkIntervalHours: number; nextCheckDueAt: Date | null;
  sitemapRoots: string[] | null; allowedPageHosts: string[] | null; normalizationPolicy: string;
  discoveredRoots: string[] | null; liveSources: string[]; crawlPolicyKey: string | null; siteUrl: string;
};
const TARGET = `SELECT t.id,t."websiteId",t.kind,t.enabled,t.archived_at AS "archivedAt",t.scope_version AS "scopeVersion",
 t.baseline_run_id AS "baselineRunId",t."checkIntervalHours",t."nextCheckDueAt",t.sitemap_roots AS "sitemapRoots",
 t.allowed_page_hosts AS "allowedPageHosts",t.normalization_policy AS "normalizationPolicy",
 t.discovered_roots AS "discoveredRoots",t.live_sources AS "liveSources",t.crawl_policy_key AS "crawlPolicyKey",w.url AS "siteUrl"
 FROM target t JOIN website w ON w.id=t."websiteId"`;
const LEASE = `execution_status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`;
export function retryDelay(attempt: number, error: RunError): number | null {
  if (!error.retryable || attempt >= 4) return null;
  return Math.max([300_000, 900_000, 3_600_000][attempt - 1] ?? 300_000, Math.max(0, error.retryAfterMs ?? 0));
}

/** All multi-row mutations lock target then Run. Final lease checks occur after locks and writes. */
export class CrawlQueue {
  constructor(public readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      const result = await work(client);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async enqueueRun(targetId: string, trigger: Trigger, ownerId?: string) {
    return this.transaction(async (client) => {
      const { rows: [target] } = await client.query<TargetRow>(`${TARGET} WHERE t.id=$1 AND ($2::text IS NULL OR w."userId"=$2) FOR UPDATE OF t`, [targetId, ownerId ?? null]);
      if (!target) throw new QueueError("TARGET_NOT_FOUND");
      if (target.kind !== "SITEMAP_LINKS") throw new QueueError("TARGET_UNSUPPORTED");
      if (target.archivedAt) throw new QueueError("TARGET_ARCHIVED");
      if (trigger !== "manual" && !target.enabled) return null;
      if (target.normalizationPolicy !== NORMALIZATION_POLICY) throw new QueueError("SCOPE_CHANGE_REQUIRED");
      if (trigger === "scheduled") {
        if (![1, 6, 12, 24].includes(target.checkIntervalHours)) throw new QueueError("INVALID_INTERVAL");
        // Advance the fixed cadence at scheduling, including a busy slot. Manual/retry never touch it.
        const due = await client.query(`UPDATE target SET "nextCheckDueAt"=COALESCE("nextCheckDueAt",clock_timestamp())+
          (floor(GREATEST(0,extract(epoch FROM clock_timestamp()-COALESCE("nextCheckDueAt",clock_timestamp())))/($2*3600))+1)*($2*interval '1 hour')
          WHERE id=$1 AND ("nextCheckDueAt" IS NULL OR "nextCheckDueAt"<=clock_timestamp()) RETURNING id`, [targetId, target.checkIntervalHours]);
        if (!due.rowCount) return null;
      }
      const { rows: [active] } = await client.query<RunRow>("SELECT * FROM crawl_run WHERE target_id=$1 AND execution_status IN ('queued','running')", [targetId]);
      if (active) return { run: active, created: false };
      let candidateId: string | undefined;
      if (trigger === "confirmation") {
        const candidate = (await client.query<{ id: string }>(`SELECT id FROM removal_candidate WHERE target_id=$1 AND scope_version=$2
          AND status IN ('pending','adopted') AND next_confirmation_at<=clock_timestamp()
          AND (status='adopted' OR (expires_at>clock_timestamp() AND origin_baseline_run_id IS NOT DISTINCT FROM $3::text))
          ORDER BY next_confirmation_at,id LIMIT 1 FOR UPDATE`, [targetId, target.scopeVersion, target.baselineRunId])).rows[0];
        if (!candidate) return null;
        candidateId = candidate.id;
      }
      const roots = target.sitemapRoots ?? target.discoveredRoots;
      const config = { siteUrl: target.siteUrl, roots: roots?.length ? roots : undefined, allowedPageHosts: target.allowedPageHosts ?? undefined };
      const { rows: [run] } = await client.query<RunRow>(`INSERT INTO crawl_run(id,target_id,trigger,scope_version,origin_baseline_run_id,config)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`, [randomUUID(), targetId, trigger, target.scopeVersion, target.baselineRunId, JSON.stringify(config)]);
      if (candidateId) await client.query(`UPDATE removal_candidate SET confirmation_attempts=confirmation_attempts+1,
        last_confirmation_run_id=$2,next_confirmation_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [candidateId, run.id]);
      return { run, created: true };
    });
  }
  async schedule(limit = 100) {
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM target WHERE kind='SITEMAP_LINKS' AND enabled AND archived_at IS NULL
      AND ("nextCheckDueAt" IS NULL OR "nextCheckDueAt"<=clock_timestamp()) ORDER BY "nextCheckDueAt" NULLS FIRST,id LIMIT $1`, [limit]);
    const confirmation = await this.pool.query<{ id: string }>(`SELECT DISTINCT t.id FROM target t JOIN removal_candidate c ON c.target_id=t.id
      WHERE t.enabled AND t.archived_at IS NULL AND c.scope_version=t.scope_version AND c.status IN ('pending','adopted')
      AND c.next_confirmation_at<=clock_timestamp() AND (c.status='adopted' OR c.expires_at>clock_timestamp()) LIMIT $1`, [limit]);
    let created = 0;
    for (const target of confirmation.rows) {
      try { if ((await this.enqueueRun(target.id, "confirmation"))?.created) created++; }
      catch (error) { if (!(error instanceof QueueError && ["TARGET_ARCHIVED", "TARGET_NOT_FOUND"].includes(error.code))) throw error; }
    }
    for (const target of rows) {
      try { if ((await this.enqueueRun(target.id, "scheduled"))?.created) created++; }
      catch (error) { if (!(error instanceof QueueError && ["TARGET_ARCHIVED", "TARGET_NOT_FOUND", "INVALID_INTERVAL", "SCOPE_CHANGE_REQUIRED"].includes(error.code))) throw error; }
    }
    return created;
  }
  async claim(workerId: string): Promise<RunRow | null> {
    return this.transaction(async (client) => {
      const { rows: [target] } = await client.query<{ id: string }>(`SELECT t.id FROM target t JOIN crawl_run r ON r.target_id=t.id
        WHERE r.execution_status='queued' AND r.available_at<=clock_timestamp()
        ORDER BY r.available_at,r.created_at,r.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`);
      if (!target) return null;
      const { rows: [current] } = await client.query<TargetRow>(`${TARGET} WHERE t.id=$1`, [target.id]);
      const { rows: [run] } = await client.query<RunRow>(`SELECT * FROM crawl_run WHERE target_id=$1 AND execution_status='queued' FOR UPDATE`, [target.id]);
      if (!run) return null;
      if (current.archivedAt || run.scope_version !== current.scopeVersion || current.baselineRunId !== run.origin_baseline_run_id || (run.trigger !== "manual" && !current.enabled)) {
        await client.query("UPDATE crawl_run SET execution_status='cancelled',adoption_status='stale',finished_at=clock_timestamp() WHERE id=$1", [run.id]);
        return null;
      }
      const token = randomUUID();
      const { rows: [claimed] } = await client.query<RunRow>(`UPDATE crawl_run SET execution_status='running',attempt=attempt+1,lease_epoch=lease_epoch+1,
        completeness='unknown',result=NULL,error=NULL,
        lease_token=$2,worker_id=$3,started_at=COALESCE(started_at,clock_timestamp()),attempt_started_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
        lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND execution_status='queued' AND available_at<=clock_timestamp() RETURNING *`, [run.id, token, workerId]);
      if (!claimed) return null;
      await client.query("INSERT INTO crawl_run_attempt(run_id,attempt,lease_token,started_at) SELECT id,attempt,lease_token,attempt_started_at FROM crawl_run WHERE id=$1", [run.id]);
      return claimed;
    });
  }
  async heartbeat(run: RunRow) {
    await this.transaction(async (client) => {
      // Acquire the row before evaluating real time: lock waits must never revive expired leases.
      await client.query("SELECT id FROM crawl_run WHERE id=$1 FOR UPDATE", [run.id]);
      const result = await client.query(`UPDATE crawl_run SET lease_expires_at=LEAST(clock_timestamp()+interval '60 seconds',attempt_started_at+interval '10 minutes'),
      heartbeat_at=clock_timestamp() WHERE id=$1 AND ${LEASE} AND attempt_started_at+interval '10 minutes'>clock_timestamp() RETURNING id`, [run.id, run.lease_token]);
      if (!result.rowCount) throw new QueueError("LEASE_LOST");
    });
  }
  async loadState(run: RunRow): Promise<CrawlState | undefined> {
    const { rows: [target] } = await this.pool.query<TargetRow>(`${TARGET} WHERE t.id=$1`, [run.target_id]);
    if (!target || target.scopeVersion !== run.scope_version) throw new QueueError("SCOPE_CHANGED");
    if (!target.crawlPolicyKey) return undefined;
    const { rows } = await this.pool.query(`SELECT c.source_url,c.final_url,c.etag,c.last_modified,c.revision_id,r.content
      FROM sitemap_source_cache c JOIN sitemap_revision r ON r.id=c.revision_id WHERE c.target_id=$1 AND c.scope_version=$2`, [run.target_id, run.scope_version]);
    const state: CrawlState = { version: 1, policyKey: target.crawlPolicyKey, roots: target.sitemapRoots ?? target.discoveredRoots ?? [], liveSources: target.liveSources, cache: {}, revisions: {} };
    for (const row of rows) {
      state.cache[row.source_url] = { finalUrl: row.final_url, revisionId: row.revision_id, etag: row.etag ?? undefined, lastModified: row.last_modified ?? undefined };
      state.revisions[row.revision_id] = row.content;
    }
    return state;
  }
  private async locked(client: PoolClient, run: RunRow) {
    const { rows: [target] } = await client.query<TargetRow>(`${TARGET} WHERE t.id=$1 FOR UPDATE OF t`, [run.target_id]);
    const valid = await client.query(`SELECT id FROM crawl_run WHERE id=$1 AND ${LEASE} FOR UPDATE`, [run.id, run.lease_token]);
    if (!valid.rowCount) throw new QueueError("LEASE_LOST");
    return target;
  }
  private async closeAttempt(client: PoolClient, run: RunRow, status: string, error: RunError | null) {
    await client.query("UPDATE crawl_run_attempt SET status=$3,error=$4::jsonb,finished_at=clock_timestamp() WHERE run_id=$1 AND attempt=$2 AND lease_token=$5 AND status='running'", [run.id, run.attempt, status, JSON.stringify(error), run.lease_token]);
  }
  async finish(run: RunRow, result: CrawlResult) {
    return this.transaction(async (client) => {
      const target = await this.locked(client, run);
      const stale = !target || target.archivedAt || target.scopeVersion !== run.scope_version || target.baselineRunId !== run.origin_baseline_run_id;
      const { state, ...report } = result;
      const error: RunError | null = result.completeness === "complete" ? null : {
        code: result.issues[0]?.code ?? "INCOMPLETE", message: result.issues[0]?.message ?? "Incomplete source graph",
        retryable: result.issues.length > 0 && result.issues.every((issue) => issue.retryable),
        retryAfterMs: Math.max(0, ...result.issues.map((issue) => issue.retryAfterMs ?? 0)),
      };
      const delay = error ? retryDelay(run.attempt, error) : null;
      const observedAt = (await client.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
      let adoption = stale ? "stale" : "none";
      if (!stale) {
        // Enforce completeness at the persistence boundary as well as in the crawler.
        const liveSources = result.completeness === "complete" ? state.liveSources : target.liveSources;
        // Bulk parameterized JSON inputs avoid hundreds of transactions. Revisions are immutable.
        const revisions = Object.values(state.revisions);
        if (revisions.length) await client.query(`INSERT INTO sitemap_revision(id,content) SELECT value->>'id',value FROM jsonb_array_elements($1::jsonb)
          ON CONFLICT(id) DO NOTHING`, [JSON.stringify(revisions)]);
        // Cache is for the last complete graph plus the current observation, not an unbounded archive.
        // Historical revision/source rows remain intact for reference-aware GC in PR 4.
        const retained = new Set([...liveSources, ...result.sources.map((source) => source.url), ...state.roots]);
        const caches = Object.entries(state.cache).filter(([url]) => retained.has(url)).map(([url, cache]) => ({ url, ...cache }));
        if (caches.length) await client.query(`INSERT INTO sitemap_source_cache(target_id,scope_version,source_url,final_url,etag,last_modified,revision_id)
          SELECT $1,$2,value->>'url',value->>'finalUrl',value->>'etag',value->>'lastModified',value->>'revisionId' FROM jsonb_array_elements($3::jsonb)
          ON CONFLICT(target_id,scope_version,source_url) DO UPDATE SET final_url=excluded.final_url,etag=excluded.etag,last_modified=excluded.last_modified,revision_id=excluded.revision_id`, [run.target_id, run.scope_version, JSON.stringify(caches)]);
        await client.query("DELETE FROM sitemap_source_cache WHERE target_id=$1 AND scope_version=$2 AND NOT(source_url=ANY($3::text[]))", [run.target_id, run.scope_version, [...retained]]);
        await client.query(`INSERT INTO crawl_run_source(run_id,attempt,source_url,revision_id,observation)
          SELECT $1,$2,value->>'url',value->>'revisionId',value FROM jsonb_array_elements($3::jsonb)`, [run.id, run.attempt, JSON.stringify(result.sources)]);
        await client.query(`UPDATE target SET discovered_roots=$2::jsonb,live_sources=$3::jsonb,crawl_policy_key=$4,
          "lastCheckedAt"=CASE WHEN $5 THEN clock_timestamp() ELSE "lastCheckedAt" END,"lastError"=$6,"lastErrorAt"=CASE WHEN $6::text IS NULL THEN NULL ELSE clock_timestamp() END WHERE id=$1`,
          [run.target_id, JSON.stringify(state.roots), JSON.stringify(liveSources), state.policyKey, result.completeness === "complete", error?.message ?? null]);
      }
      if (!stale && result.completeness === "complete") {
        if (!result.urls) throw new QueueError("COMPLETE_URLS_MISSING");
        adoption = await adoptComplete(client, target, run, result.urls, observedAt);
      }
      await this.closeAttempt(client, run, stale ? "discarded" : error ? "failed" : "succeeded", error);
      const final = await client.query(`UPDATE crawl_run SET execution_status=$3,completeness=$4,adoption_status=$5,result=$6::jsonb,error=$7::jsonb,observed_at=$9,
        available_at=CASE WHEN $8::double precision IS NULL THEN available_at ELSE clock_timestamp()+$8*interval '1 millisecond' END,
        finished_at=CASE WHEN $3='queued' THEN NULL ELSE clock_timestamp() END,lease_token=NULL,lease_expires_at=NULL
        WHERE id=$1 AND ${LEASE} RETURNING id`, [run.id, run.lease_token, stale ? "cancelled" : error ? delay === null ? "failed" : "queued" : "succeeded", result.completeness, adoption, JSON.stringify(report), JSON.stringify(error), delay, observedAt]);
      if (!final.rowCount) throw new QueueError("LEASE_LOST");
    });
  }
  async configureScope(targetId: string, ownerId: string, input: { roots: string[] | null; allowedPageHosts: string[] | null }) {
    return this.transaction(async (client) => {
      const target = (await client.query<TargetRow>(`${TARGET} WHERE t.id=$1 AND w."userId"=$2 FOR UPDATE OF t`, [targetId, ownerId])).rows[0];
      if (!target) throw new QueueError("TARGET_NOT_FOUND");
      if (target.archivedAt) throw new QueueError("TARGET_ARCHIVED");
      if (input.roots && (input.roots.length === 0 || input.roots.length > 500)) throw new QueueError("INVALID_ROOTS");
      if (input.allowedPageHosts && (input.allowedPageHosts.length === 0 || input.allowedPageHosts.length > 100)) throw new QueueError("INVALID_HOSTS");
      const roots = input.roots ? [...new Set(input.roots.map(normalizeHttpUrl))].sort() : null;
      const hosts = input.allowedPageHosts ? normalizedPageHosts(new URL(target.siteUrl), input.allowedPageHosts) : null;
      const oldRoots = target.sitemapRoots ? [...target.sitemapRoots].sort() : null;
      const oldHosts = target.allowedPageHosts ? [...target.allowedPageHosts].sort() : null;
      if (JSON.stringify(roots) === JSON.stringify(oldRoots) && JSON.stringify(hosts) === JSON.stringify(oldHosts)) return { scopeVersion: target.scopeVersion, changed: false };
      const updated = (await client.query<{ scope_version: number }>(`UPDATE target SET sitemap_roots=$2::jsonb,allowed_page_hosts=$3::jsonb,
        scope_version=scope_version+1,baseline_run_id=NULL,discovered_roots=NULL,live_sources='[]',crawl_policy_key=NULL WHERE id=$1 RETURNING scope_version`,
        [targetId, roots ? JSON.stringify(roots) : null, hosts ? JSON.stringify(hosts) : null])).rows[0];
      await client.query(`UPDATE removal_candidate SET status='stale',next_confirmation_at=NULL WHERE target_id=$1 AND status IN ('pending','adopted')`, [targetId]);
      // A running attempt keeps its lease identity and is discarded by final scope/CAS checks. Queued work is released now.
      await client.query(`UPDATE crawl_run SET execution_status='cancelled',adoption_status='stale',finished_at=clock_timestamp()
        WHERE target_id=$1 AND execution_status='queued'`, [targetId]);
      return { scopeVersion: updated.scope_version, changed: true };
    });
  }
  async approve(targetId: string, candidateId: string, ownerId: string) {
    return this.transaction(async (client) => {
      const target = (await client.query<TargetRow>(`${TARGET} WHERE t.id=$1 AND w."userId"=$2 FOR UPDATE OF t`, [targetId, ownerId])).rows[0];
      if (!target) throw new QueueError("TARGET_NOT_FOUND");
      if (target.archivedAt) throw new QueueError("TARGET_ARCHIVED");
      return approveCandidate(client, target, candidateId);
    });
  }
  async fail(run: RunRow, error: RunError) {
    return this.transaction(async (client) => {
      const target = await this.locked(client, run);
      const stale = !target || target.archivedAt || target.scopeVersion !== run.scope_version || target.baselineRunId !== run.origin_baseline_run_id;
      const delay = stale ? null : retryDelay(run.attempt, error);
      if (!stale) await client.query('UPDATE target SET "lastError"=$2,"lastErrorAt"=clock_timestamp() WHERE id=$1', [run.target_id, error.message]);
      await this.closeAttempt(client, run, stale ? "discarded" : "failed", error);
      const final = await client.query(`UPDATE crawl_run SET execution_status=$3,adoption_status=$4,error=$5::jsonb,
        available_at=CASE WHEN $6::double precision IS NULL THEN available_at ELSE clock_timestamp()+$6*interval '1 millisecond' END,
        finished_at=CASE WHEN $3='queued' THEN NULL ELSE clock_timestamp() END,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND ${LEASE} RETURNING id`,
        [run.id, run.lease_token, stale ? "cancelled" : delay === null ? "failed" : "queued", stale ? "stale" : "none", JSON.stringify(error), delay]);
      if (!final.rowCount) throw new QueueError("LEASE_LOST");
    });
  }
  async recoverExpired(limit = 100) {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT t.id FROM target t JOIN crawl_run r ON r.target_id=t.id
        WHERE r.execution_status='running' AND r.lease_expires_at<=clock_timestamp() ORDER BY r.lease_expires_at FOR UPDATE OF t SKIP LOCKED LIMIT $1`, [limit]);
      let recovered = 0;
      for (const target of rows) {
        const { rows: [run] } = await client.query<RunRow & { attempt_timed_out: boolean }>("SELECT *,attempt_started_at+interval '10 minutes'<=clock_timestamp() AS attempt_timed_out FROM crawl_run WHERE target_id=$1 AND execution_status='running' AND lease_expires_at<=clock_timestamp() FOR UPDATE", [target.id]);
        if (!run) continue;
        const { rows: [current] } = await client.query<TargetRow>(`${TARGET} WHERE t.id=$1`, [target.id]);
        const stale = current.archivedAt || current.scopeVersion !== run.scope_version || current.baselineRunId !== run.origin_baseline_run_id;
        const error: RunError = { code: run.attempt_timed_out ? "ATTEMPT_TIMEOUT" : "LEASE_EXPIRED", message: run.attempt_timed_out ? "Attempt wall-time budget exceeded" : "Worker lease expired", retryable: true };
        const delay = stale ? null : retryDelay(run.attempt, error);
        const updated = await client.query(`UPDATE crawl_run SET execution_status=$2,adoption_status=$3,error=$4::jsonb,
          available_at=CASE WHEN $5::double precision IS NULL THEN available_at ELSE clock_timestamp()+$5*interval '1 millisecond' END,
          finished_at=CASE WHEN $2='queued' THEN NULL ELSE clock_timestamp() END,lease_token=NULL,lease_expires_at=NULL
          WHERE id=$1 AND execution_status='running' AND lease_token=$6 AND lease_expires_at<=clock_timestamp() RETURNING id`,
          [run.id, stale ? "cancelled" : delay === null ? "failed" : "queued", stale ? "stale" : "none", JSON.stringify(error), delay, run.lease_token]);
        if (updated.rowCount) {
          if (!stale) await client.query('UPDATE target SET "lastError"=$2,"lastErrorAt"=clock_timestamp() WHERE id=$1', [run.target_id, error.message]);
          await this.closeAttempt(client, run, run.attempt_timed_out ? "failed" : "lost", error); recovered++;
        }
      }
      return recovered;
    });
  }
}
