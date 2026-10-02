import { readFile, rename, writeFile } from "node:fs/promises";
import type { Pool } from "pg";

export type WorkerHealth = { version: 1; pid: number; workerId: string; lastTickAt: number; runId: string | null; stopping: boolean };
const tables = ["user", "session", "account", "website", "target", "crawl_run", "crawl_run_attempt", "crawl_run_source",
  "sitemap_revision", "sitemap_source_cache", "site_url", "url_event", "removal_candidate", "candidate_missing_url"];
function boundedQuery(pool: Pool, text: string, values: unknown[] = []) {
  const config = { text, values, query_timeout: 3000 };
  return pool.query(config);
}
/** Reachability and P0 schema readiness, never discloses a DSN or database diagnostics. */
export async function databaseReady(pool: Pool) {
  if (process.env.DATABASE_SCHEMA) {
    const { rows: [schema] } = await boundedQuery(pool, "SELECT current_schema() AS name");
    if (schema?.name !== process.env.DATABASE_SCHEMA) throw new Error("SCHEMA_NOT_READY");
  }
  const { rows: [row] } = await boundedQuery(pool,
    `SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[]) AS names(name) WHERE to_regclass(quote_ident(name)) IS NULL)
      AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('crawl_run_one_active_per_target') AND indisunique AND indisvalid) AS ok`,
    [tables]);
  if (!row?.ok) throw new Error("SCHEMA_NOT_READY");
  // Catch an old target/run schema as well as absent tables.
  await boundedQuery(pool, `SELECT t.scope_version,t.archived_at,r.execution_status,r.lease_token,r.attempt_started_at,
    u.normalized_url_hash,u.first_missing_observed_at,c.pending_count,c.next_confirmation_at
    FROM target t LEFT JOIN crawl_run r ON r.target_id=t.id LEFT JOIN site_url u ON u.website_id=t."websiteId"
    LEFT JOIN removal_candidate c ON c.target_id=t.id LIMIT 0`);
}
export async function writeWorkerHealth(path: string, state: WorkerHealth) {
  const temporary = `${path}.${state.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}
export async function workerReady(pool: Pool, path: string, now = Date.now()) {
  const state = JSON.parse(await readFile(path, "utf8")) as WorkerHealth;
  if (state.version !== 1 || !Number.isInteger(state.pid) || state.pid < 1 || typeof state.workerId !== "string" || !state.workerId ||
      (state.runId !== null && typeof state.runId !== "string") || state.stopping ||
      !Number.isFinite(state.lastTickAt) || state.lastTickAt > now + 1000) throw new Error("WORKER_NOT_READY");
  // PID is checked on the same local/container filesystem; this file is never shared between workers.
  process.kill(state.pid, 0);
  await databaseReady(pool);
  if (state.runId) {
    const { rows: [run] } = await boundedQuery(pool, `SELECT execution_status,
      (lease_expires_at>clock_timestamp() AND heartbeat_at>clock_timestamp()-interval '60 seconds'
       AND attempt_started_at+interval '10 minutes'>clock_timestamp()) AS live
      FROM crawl_run WHERE id=$1 AND worker_id=$2`, [state.runId, state.workerId]);
    if (!run) throw new Error("WORKER_RUN_NOT_FOUND");
    if (run?.execution_status === "running") {
      if (!run.live) throw new Error("WORKER_LEASE_NOT_READY");
      return;
    }
  }
  if (now - state.lastTickAt > 30_000) throw new Error("WORKER_TICK_STALE");
}
