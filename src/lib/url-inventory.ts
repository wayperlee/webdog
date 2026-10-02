import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RunRow } from "./crawl-queue";

export class InventoryError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "InventoryError"; }
}
export type InventoryTarget = { id: string; websiteId: string; scopeVersion: number; baselineRunId: string | null; checkIntervalHours: number };
type Candidate = {
  id: string; target_id: string; scope_version: number; origin_baseline_run_id: string; candidate_run_id: string;
  status: string; missing_set_hash: string; observed_at: Date; expires_at: Date;
};
export const urlHash = (url: string) => createHash("sha256").update(url).digest("hex");
export const missingSetHash = (urls: string[]) => createHash("sha256").update(JSON.stringify([...new Set(urls)].sort())).digest("hex");
const records = (urls: string[]) => JSON.stringify([...new Set(urls)].map((url) => ({ url, hash: urlHash(url) })));
export function suspicious(previous: number, missing: number, current: number) {
  return previous > 0 && (current === 0 || (missing >= 100 && missing / previous >= 0.3));
}

/** Caller holds target then Run locks. Never opens a transaction or performs network IO. */
async function applyObservation(client: PoolClient, target: InventoryTarget, runId: string, urls: string[], observedAt: Date, baseline: boolean) {
  const values = [target.websiteId, target.scopeVersion, records(urls), runId, observedAt];
  // Emit transitions before updating facts. All URLs, including changes beyond the old 100-alert limit.
  if (!baseline) await client.query(`INSERT INTO url_event(id,website_id,scope_version,normalized_url_hash,url,run_id,kind,observed_at)
    SELECT $4||':'||v.hash||':'||CASE WHEN u.status='removed' THEN 'reappeared' ELSE 'added' END,$1,$2,v.hash,v.url,$4,
      CASE WHEN u.status='removed' THEN 'reappeared' ELSE 'added' END,$5
    FROM jsonb_to_recordset($3::jsonb) AS v(url text,hash text)
    LEFT JOIN site_url u ON u.website_id=$1 AND u.scope_version=$2 AND u.normalized_url_hash=v.hash
    WHERE u.normalized_url_hash IS NULL OR u.status='removed' ON CONFLICT DO NOTHING`, values);
  // The caller's target lock serializes all observations for this website/scope.
  // Join-update existing rows rather than probing the unique index once per URL via UPSERT.
  if (!baseline) await client.query(`UPDATE site_url u SET status='active',last_seen_at=$5,
    first_missing_run_id=NULL,first_missing_observed_at=NULL,last_missing_run_id=NULL,missing_confirmations=0,removed_at=NULL
    FROM jsonb_to_recordset($3::jsonb) AS v(url text,hash text)
    WHERE u.website_id=$1 AND u.scope_version=$2 AND u.normalized_url_hash=v.hash AND $4::text IS NOT NULL`, values);
  await client.query(`INSERT INTO site_url(website_id,scope_version,normalized_url_hash,url,first_seen_at,last_seen_at)
    SELECT $1,$2,v.hash,v.url,$5,$5 FROM jsonb_to_recordset($3::jsonb) AS v(url text,hash text)
    WHERE $4::text IS NOT NULL AND NOT EXISTS(SELECT 1 FROM site_url u WHERE u.website_id=$1 AND u.scope_version=$2 AND u.normalized_url_hash=v.hash)`, values);
  if (baseline) return;
  // The second observation is a different Run and >= 1 hour from the first missing observation.
  await client.query(`WITH removed AS (
    UPDATE site_url u SET status='removed',missing_confirmations=2,last_missing_run_id=$4,removed_at=$5
    WHERE website_id=$1 AND scope_version=$2 AND status='pending_removed' AND first_missing_run_id<>$4
      AND first_missing_observed_at+interval '1 hour'<=$5::timestamptz
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS v(url text,hash text) WHERE v.hash=u.normalized_url_hash)
    RETURNING normalized_url_hash,url)
    INSERT INTO url_event(id,website_id,scope_version,normalized_url_hash,url,run_id,kind,observed_at)
      SELECT $4||':'||normalized_url_hash||':removed',$1,$2,normalized_url_hash,url,$4,'removed',$5 FROM removed ON CONFLICT DO NOTHING`, values);
  await client.query(`UPDATE site_url u SET status='pending_removed',first_missing_run_id=$4,first_missing_observed_at=$5,
    last_missing_run_id=$4,missing_confirmations=1
    WHERE website_id=$1 AND scope_version=$2 AND status='active'
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS v(url text,hash text) WHERE v.hash=u.normalized_url_hash)`, values);
}
async function advanceBaseline(client: PoolClient, target: InventoryTarget, runId: string) {
  const updated = await client.query(`UPDATE target SET baseline_run_id=$2 WHERE id=$1 AND scope_version=$3
    AND baseline_run_id IS NOT DISTINCT FROM $4::text AND archived_at IS NULL RETURNING id`, [target.id, runId, target.scopeVersion, target.baselineRunId]);
  if (!updated.rowCount) throw new InventoryError("BASELINE_STALE");
}
async function summarizeAdopted(client: PoolClient, target: InventoryTarget, runId: string) {
  // Only active Candidates are refreshed; terminal snapshots never change after reappearance.
  await client.query(`UPDATE candidate_missing_url m SET resolution=CASE WHEN u.status='removed' THEN 'removed' WHEN u.status='active' THEN 'recovered' ELSE 'pending' END
    FROM removal_candidate c,site_url u WHERE c.id=m.candidate_id AND c.target_id=$1 AND c.scope_version=$2 AND c.status='adopted'
      AND u.website_id=$3 AND u.scope_version=c.scope_version AND u.normalized_url_hash=m.normalized_url_hash`, [target.id, target.scopeVersion, target.websiteId]);
  await client.query(`WITH counts AS (SELECT c.id,count(*) FILTER(WHERE m.resolution='pending')::int AS pending,
    count(*) FILTER(WHERE m.resolution='removed')::int AS removed,count(*) FILTER(WHERE m.resolution='recovered')::int AS recovered
    FROM removal_candidate c JOIN candidate_missing_url m ON m.candidate_id=c.id WHERE c.target_id=$1 AND c.scope_version=$2 AND c.status='adopted' GROUP BY c.id)
    UPDATE removal_candidate c SET pending_count=n.pending,removed_count=n.removed,recovered_count=n.recovered,
      status=CASE WHEN n.pending>0 THEN 'adopted' WHEN n.removed>0 THEN 'confirmed' ELSE 'rejected' END,
      last_confirmation_run_id=$3,next_confirmation_at=CASE WHEN n.pending>0 THEN clock_timestamp()+interval '1 hour' ELSE NULL END
    FROM counts n WHERE c.id=n.id`, [target.id, target.scopeVersion, runId]);
}
async function createCandidate(client: PoolClient, target: InventoryTarget, runId: string, missing: string[], observedAt: Date) {
  const id = randomUUID();
  await client.query(`INSERT INTO removal_candidate(id,target_id,scope_version,origin_baseline_run_id,candidate_run_id,
    missing_set_hash,original_missing_count,pending_count,observed_at,expires_at,next_confirmation_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8::timestamptz+LEAST(interval '14 days',GREATEST(interval '72 hours',$9*interval '3 hours')),$8::timestamptz+interval '1 hour')`,
    [id, target.id, target.scopeVersion, target.baselineRunId, runId, missingSetHash(missing), missing.length, observedAt, target.checkIntervalHours]);
  await client.query(`INSERT INTO candidate_missing_url(candidate_id,normalized_url_hash,url)
    SELECT $1,v.hash,v.url FROM jsonb_to_recordset($2::jsonb) AS v(url text,hash text)`, [id, records(missing)]);
}
export async function adoptComplete(client: PoolClient, target: InventoryTarget, run: RunRow, urls: string[], observedAt: Date): Promise<string> {
  await client.query(`UPDATE removal_candidate SET status=CASE WHEN scope_version<>$2 OR origin_baseline_run_id IS DISTINCT FROM $3::text THEN 'stale' ELSE 'expired' END,next_confirmation_at=NULL
    WHERE target_id=$1 AND status='pending' AND (scope_version<>$2 OR origin_baseline_run_id IS DISTINCT FROM $3::text OR expires_at<=clock_timestamp())`, [target.id, target.scopeVersion, target.baselineRunId]);
  if (!target.baselineRunId) {
    await applyObservation(client, target, run.id, urls, observedAt, true);
    await advanceBaseline(client, target, run.id);
    return "baseline";
  }
  const baseline = (await client.query<{ result: { urls: string[] } | null }>("SELECT result FROM crawl_run WHERE id=$1", [target.baselineRunId])).rows[0];
  if (!baseline?.result?.urls) throw new InventoryError("BASELINE_DATA_MISSING");
  const present = new Set(urls), missing = baseline.result.urls.filter((url) => !present.has(url));
  const candidate = (await client.query<Candidate>("SELECT * FROM removal_candidate WHERE target_id=$1 AND scope_version=$2 AND status='pending' FOR UPDATE", [target.id, target.scopeVersion])).rows[0];
  if (candidate) {
    const setMatches = candidate.missing_set_hash === missingSetHash(missing) && (await client.query(`SELECT 1 FROM candidate_missing_url WHERE candidate_id=$1 AND NOT(url=ANY($2::text[])) LIMIT 1`, [candidate.id, missing])).rowCount === 0;
    if (setMatches) {
      if (observedAt.getTime() - candidate.observed_at.getTime() < 3_600_000) return "quarantined";
      const a = (await client.query<{ result: { urls: string[] } | null }>("SELECT result FROM crawl_run WHERE id=$1 FOR UPDATE", [candidate.candidate_run_id])).rows[0];
      if (!a?.result?.urls) throw new InventoryError("CANDIDATE_DATA_MISSING");
      await applyObservation(client, target, candidate.candidate_run_id, a.result.urls, candidate.observed_at, false);
      await client.query("UPDATE crawl_run SET adoption_status='first_observation' WHERE id=$1", [candidate.candidate_run_id]);
      await client.query("UPDATE removal_candidate SET status='adopted' WHERE id=$1", [candidate.id]);
      await applyObservation(client, target, run.id, urls, observedAt, false);
      await summarizeAdopted(client, target, run.id);
      await advanceBaseline(client, target, run.id);
      return "applied";
    }
    // Explicit supersession required by the frozen contract: preserve the complete original set for audit.
    await client.query("UPDATE removal_candidate SET status='rejected',reason='missing_set_changed',next_confirmation_at=NULL,last_confirmation_run_id=$2 WHERE id=$1", [candidate.id, run.id]);
    await client.query("UPDATE candidate_missing_url SET resolution='recovered' WHERE candidate_id=$1 AND url=ANY($2::text[])", [candidate.id, urls]);
    await client.query(`UPDATE removal_candidate SET recovered_count=(SELECT count(*) FROM candidate_missing_url WHERE candidate_id=$1 AND resolution='recovered'),
      pending_count=(SELECT count(*) FROM candidate_missing_url WHERE candidate_id=$1 AND resolution='pending') WHERE id=$1`, [candidate.id]);
  }
  if (suspicious(baseline.result.urls.length, missing.length, urls.length)) {
    await createCandidate(client, target, run.id, missing, observedAt);
    return "quarantined";
  }
  await applyObservation(client, target, run.id, urls, observedAt, false);
  await summarizeAdopted(client, target, run.id);
  await advanceBaseline(client, target, run.id);
  return "applied";
}
export async function approveCandidate(client: PoolClient, target: InventoryTarget, candidateId: string) {
  const candidate = (await client.query<Candidate>("SELECT * FROM removal_candidate WHERE id=$1 AND target_id=$2 FOR UPDATE", [candidateId, target.id])).rows[0];
  if (!candidate) throw new InventoryError("CANDIDATE_NOT_FOUND");
  if (candidate.scope_version !== target.scopeVersion) throw new InventoryError("CANDIDATE_STALE");
  if (["adopted", "confirmed"].includes(candidate.status)) return { id: candidate.id, status: candidate.status, changed: false };
  const valid = (await client.query("SELECT 1 FROM removal_candidate WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() AND scope_version=$2 AND origin_baseline_run_id IS NOT DISTINCT FROM $3::text", [candidateId, target.scopeVersion, target.baselineRunId])).rowCount;
  if (!valid) throw new InventoryError("CANDIDATE_STALE");
  const a = (await client.query<{ result: { urls: string[] } | null }>("SELECT result FROM crawl_run WHERE id=$1 AND execution_status='succeeded' AND completeness='complete' FOR UPDATE", [candidate.candidate_run_id])).rows[0];
  if (!a?.result?.urls) throw new InventoryError("CANDIDATE_STALE");
  await applyObservation(client, target, candidate.candidate_run_id, a.result.urls, candidate.observed_at, false);
  await advanceBaseline(client, target, candidate.candidate_run_id);
  await client.query("UPDATE crawl_run SET adoption_status='first_observation' WHERE id=$1", [candidate.candidate_run_id]);
  await client.query("UPDATE removal_candidate SET status='adopted',next_confirmation_at=GREATEST(clock_timestamp(),observed_at+interval '1 hour') WHERE id=$1", [candidate.id]);
  return { id: candidate.id, status: "adopted", changed: true };
}
