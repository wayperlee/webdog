import type { Pool } from "pg";

/** Identity rows and URL events are never deleted. FK RESTRICT is a final safety net for concurrent writes. */
export async function collectCrawlGarbage(pool: Pool, limit = 1000) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    // Candidate transitions use the same target-first order as adoption/approval.
    const targets = await client.query<{ id: string }>(`SELECT t.id FROM target t WHERE EXISTS(SELECT 1 FROM removal_candidate c
      WHERE c.target_id=t.id AND c.status IN ('pending','adopted') AND (c.scope_version<>t.scope_version
        OR (c.status='pending' AND (c.expires_at<=clock_timestamp() OR c.origin_baseline_run_id IS DISTINCT FROM t.baseline_run_id))))
      ORDER BY t.id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
    for (const target of targets.rows) await client.query(`UPDATE removal_candidate c SET status=CASE WHEN c.scope_version<>t.scope_version
      OR c.origin_baseline_run_id IS DISTINCT FROM t.baseline_run_id THEN 'stale' ELSE 'expired' END,next_confirmation_at=NULL
      FROM target t WHERE t.id=$1 AND c.target_id=t.id AND c.status IN ('pending','adopted')
      AND (c.scope_version<>t.scope_version OR (c.status='pending' AND (c.expires_at<=clock_timestamp() OR c.origin_baseline_run_id IS DISTINCT FROM t.baseline_run_id)))`, [target.id]);
    // Old scopes do not supply current conditional requests. Their historical Run/source references remain.
    const caches = await client.query(`DELETE FROM sitemap_source_cache WHERE (target_id,scope_version,source_url) IN (
      SELECT c.target_id,c.scope_version,c.source_url FROM sitemap_source_cache c JOIN target t ON t.id=c.target_id
      WHERE c.scope_version<>t.scope_version LIMIT $1)`, [limit]);
    const protectedRun = `EXISTS(SELECT 1 FROM target t WHERE t.baseline_run_id=r.id) OR EXISTS(SELECT 1 FROM removal_candidate c
      WHERE c.status IN ('pending','adopted') AND (c.candidate_run_id=r.id OR c.origin_baseline_run_id=r.id OR c.last_confirmation_run_id=r.id))`;
    const sources = await client.query(`DELETE FROM crawl_run_source WHERE (run_id,attempt,source_url) IN (
      SELECT s.run_id,s.attempt,s.source_url FROM crawl_run_source s JOIN crawl_run r ON r.id=s.run_id
      WHERE s.created_at<clock_timestamp()-interval '90 days' AND NOT(${protectedRun}) LIMIT $1)`, [limit]);
    const diagnostics = await client.query(`UPDATE crawl_run SET result=NULL,error=NULL WHERE id IN (
      SELECT r.id FROM crawl_run r WHERE r.finished_at<clock_timestamp()-interval '180 days'
      AND r.execution_status NOT IN ('queued','running') AND (r.result IS NOT NULL OR r.error IS NOT NULL) AND NOT(${protectedRun}) LIMIT $1)`, [limit]);
    const attempts = await client.query(`UPDATE crawl_run_attempt SET error=NULL WHERE (run_id,attempt) IN (SELECT a.run_id,a.attempt
      FROM crawl_run_attempt a JOIN crawl_run r ON r.id=a.run_id WHERE r.finished_at<clock_timestamp()-interval '180 days'
      AND NOT(${protectedRun}) AND a.error IS NOT NULL LIMIT $1)`, [limit]);
    const revisions = await client.query(`DELETE FROM sitemap_revision WHERE id IN (SELECT r.id FROM sitemap_revision r
      WHERE r.created_at<clock_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM sitemap_source_cache c WHERE c.revision_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM crawl_run_source s WHERE s.revision_id=r.id) LIMIT $1)`, [limit]);
    await client.query("COMMIT");
    return { caches: caches.rowCount, sources: sources.rowCount, diagnostics: diagnostics.rowCount, attempts: attempts.rowCount, revisions: revisions.rowCount };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
