import type { Pool } from "pg";
import { pathFilterSql } from "./monitor-filters";
export type MonitorSummary = {
  id: string;
  websiteId: string;
  enabled: boolean;
  archivedAt: string | null;
  checkIntervalHours: number;
  scopeVersion: number;
  filterVersion: number;
  baselineRunId: string | null;
  nextCheckDueAt: string | null;
  sitemapRoots: string[] | null;
  allowedPageHosts: string[] | null;
  includePaths: string[];
  excludePaths: string[];
  lastError: string | null;
  lastSuccessAt: string | null;
  activeRun: string | null;
  currentCount: number;
  pendingCount: number;
  removedCount: number;
  totalCount: number;
  added24h: number;
  removed24h: number;
  reappeared24h: number;
  pendingCandidates: number;
  scopes: number[];
};
/** IDs have already passed ownership checks. Counts and configuration share one SQL snapshot. */
export async function monitorSummaries(
  pool: Pool,
  ids: string[],
): Promise<MonitorSummary[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT t.id,t."websiteId",t.enabled,t.archived_at AS "archivedAt",t."checkIntervalHours",
    t.scope_version AS "scopeVersion",t.filter_version AS "filterVersion",t.baseline_run_id AS "baselineRunId",t."nextCheckDueAt",
    t.sitemap_roots AS "sitemapRoots",t.allowed_page_hosts AS "allowedPageHosts",t.include_paths AS "includePaths",t.exclude_paths AS "excludePaths",t."lastError",
    (SELECT max(observed_at) FROM crawl_run WHERE target_id=t.id AND scope_version=t.scope_version AND execution_status='succeeded' AND completeness='complete') AS "lastSuccessAt",
    (SELECT execution_status FROM crawl_run WHERE target_id=t.id AND execution_status IN ('queued','running')) AS "activeRun",
    i.*,e.*,
    (SELECT count(*)::int FROM removal_candidate WHERE target_id=t.id AND scope_version=t.scope_version AND status IN ('pending','adopted') AND (status='adopted' OR expires_at>clock_timestamp())) AS "pendingCandidates",
    ARRAY(SELECT DISTINCT scope_version FROM crawl_run WHERE target_id=t.id UNION SELECT t.scope_version ORDER BY 1 DESC) AS scopes
    FROM target t
    CROSS JOIN LATERAL (SELECT count(*)::int AS "totalCount",count(*) FILTER (WHERE status<>'removed')::int AS "currentCount",
      count(*) FILTER (WHERE status='pending_removed')::int AS "pendingCount",count(*) FILTER (WHERE status='removed')::int AS "removedCount"
      FROM site_url u WHERE u.website_id=t."websiteId" AND u.scope_version=t.scope_version AND ${pathFilterSql("u.url", "ARRAY(SELECT jsonb_array_elements_text(t.include_paths))", "ARRAY(SELECT jsonb_array_elements_text(t.exclude_paths))")}) i
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE kind='added')::int AS "added24h",count(*) FILTER (WHERE kind='removed')::int AS "removed24h",
      count(*) FILTER (WHERE kind='reappeared')::int AS "reappeared24h"
      FROM url_event e WHERE e.website_id=t."websiteId" AND e.scope_version=t.scope_version AND observed_at>=clock_timestamp()-interval '24 hours'
      AND ${pathFilterSql("e.url", "ARRAY(SELECT jsonb_array_elements_text(t.include_paths))", "ARRAY(SELECT jsonb_array_elements_text(t.exclude_paths))")}) e
    WHERE t.id=ANY($1::text[])`,
    [ids],
  );
  // Normalize database Dates to strings for server/client boundaries.
  return JSON.parse(JSON.stringify(rows));
}
