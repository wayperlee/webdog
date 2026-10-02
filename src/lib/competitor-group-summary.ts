import { groupWebsiteStatus } from "./group-status";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  accessibleOwnerSql,
  groupFields,
  GroupError,
  type CompetitorGroup,
} from "./competitor-groups";
import { pathFilterSql } from "./monitor-filters";
export type GroupWindow = "24h" | "7d";
export type GroupWebsite = {
  id: string;
  name: string;
  domain: string;
  url: string;
  ownerId: string;
  competitorGroupId: string;
  targetId: string | null;
  baselineRunId: string | null;
  enabled: boolean | null;
  archivedAt: string | null;
  scopeVersion: number | null;
  filterVersion: number | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  activeRun: string | null;
  currentCount: number;
  pendingCount: number;
  removedCount: number;
  added: number;
  removed: number;
  reappeared: number;
  pendingCandidates: number;
};
export type GroupOverview = CompetitorGroup & {
  websites: GroupWebsite[];
  websiteCount: number;
  baselineWebsiteCount: number;
  currentUrlCount: number | null;
  pendingRemovalCount: number;
  removedUrlCount: number;
  added: number;
  removed: number;
  reappeared: number;
  pendingCandidates: number;
  latestSiteScanAt: string | null;
  statusCounts: Record<string, number>;
};
export async function groupOverviews(
  pool: Pool,
  viewerId: string,
  options: {
    groupId?: string;
    window?: GroupWindow;
    includeArchived?: boolean;
    q?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const {
    rows: [result],
  } = await pool.query(
    `WITH groups_all AS MATERIALIZED (
    SELECT ${groupFields} FROM competitor_group g WHERE ${accessibleOwnerSql("g.owner_user_id", "$1")}
      AND ($2::text IS NULL OR g.id=$2) AND strpos(lower(g.name),lower($5))>0
  ), groups AS MATERIALIZED (SELECT * FROM groups_all ORDER BY name,id LIMIT $6 OFFSET $7),
  moment AS MATERIALIZED (SELECT statement_timestamp() AS as_of),
  members AS MATERIALIZED (
    SELECT w.*,t.id AS target_id,t.scope_version,t.filter_version,t.baseline_run_id,t.enabled,t.archived_at,t."lastError",
      ARRAY(SELECT jsonb_array_elements_text(t.include_paths)) AS include_rules,
      ARRAY(SELECT jsonb_array_elements_text(t.exclude_paths)) AS exclude_rules
    FROM groups g JOIN website w ON w.competitor_group_id=g.id AND w."userId"=g."ownerId"
      LEFT JOIN target t ON t."websiteId"=w.id AND t.kind='SITEMAP_LINKS'
    WHERE ($3 OR t.archived_at IS NULL)
  ), inventory AS MATERIALIZED (
    SELECT m.id,count(*) FILTER(WHERE u.status<>'removed')::int AS current_count,
      count(*) FILTER(WHERE u.status='pending_removed')::int AS pending_count,
      count(*) FILTER(WHERE u.status='removed')::int AS removed_count
    FROM members m JOIN site_url u ON u.website_id=m.id AND u.scope_version=m.scope_version
    WHERE ${pathFilterSql("u.url", "m.include_rules", "m.exclude_rules")} GROUP BY m.id
  ), events AS MATERIALIZED (
    SELECT m.id,count(*) FILTER(WHERE e.kind='added')::int AS added,
      count(*) FILTER(WHERE e.kind='removed')::int AS removed,count(*) FILTER(WHERE e.kind='reappeared')::int AS reappeared
    FROM members m JOIN url_event e ON e.website_id=m.id AND e.scope_version=m.scope_version CROSS JOIN moment
    WHERE e.observed_at BETWEEN moment.as_of-make_interval(days=>$4) AND moment.as_of
      AND ${pathFilterSql("e.url", "m.include_rules", "m.exclude_rules")} GROUP BY m.id
  ), websites AS MATERIALIZED (
    SELECT m.id,m.name,m.domain,m.url,m."userId" AS "ownerId",m.competitor_group_id AS "competitorGroupId",
      m.target_id AS "targetId",m.baseline_run_id AS "baselineRunId",m.enabled,m.archived_at AS "archivedAt",
      m.scope_version AS "scopeVersion",m.filter_version AS "filterVersion",m."lastError",
      (SELECT max(observed_at) FROM crawl_run WHERE target_id=m.target_id AND scope_version=m.scope_version AND execution_status='succeeded' AND completeness='complete') AS "lastSuccessAt",
      (SELECT execution_status FROM crawl_run WHERE target_id=m.target_id AND execution_status IN ('queued','running')) AS "activeRun",
      COALESCE(i.current_count,0) AS "currentCount",COALESCE(i.pending_count,0) AS "pendingCount",COALESCE(i.removed_count,0) AS "removedCount",
      COALESCE(e.added,0) AS added,COALESCE(e.removed,0) AS removed,COALESCE(e.reappeared,0) AS reappeared,
      (SELECT count(*)::int FROM removal_candidate c WHERE c.target_id=m.target_id AND c.scope_version=m.scope_version
        AND c.status IN ('pending','adopted') AND (c.status='adopted' OR c.expires_at>(SELECT as_of FROM moment))) AS "pendingCandidates"
    FROM members m LEFT JOIN inventory i ON i.id=m.id LEFT JOIN events e ON e.id=m.id
  ) SELECT (SELECT as_of FROM moment) AS "asOf",(SELECT count(*)::int FROM groups_all) AS total,
    COALESCE((SELECT jsonb_agg(p) FROM (SELECT g.*,COALESCE((SELECT jsonb_agg(w ORDER BY w.name,w.id) FROM websites w WHERE w."competitorGroupId"=g.id),'[]'::jsonb) AS websites FROM groups g ORDER BY g.name,g.id) p),'[]'::jsonb) AS items`,
    [
      viewerId,
      options.groupId ?? null,
      options.includeArchived ?? false,
      options.window === "7d" ? 7 : 1,
      options.q ?? "",
      options.limit ?? 50,
      options.offset ?? 0,
    ],
  );
  if (options.groupId && !result.items.length)
    throw new GroupError("GROUP_NOT_FOUND", 404);
  const items: GroupOverview[] = result.items.map(
    (g: CompetitorGroup & { websites: GroupWebsite[] }) => {
      const baseline = g.websites.filter((w) => w.baselineRunId);
      const sum = (field: "currentCount" | "pendingCount" | "removedCount") =>
        baseline.reduce((a, w) => a + w[field], 0);
      const counts: Record<string, number> = {};
      for (const w of g.websites) {
        const status = groupWebsiteStatus(w);
        counts[status] = (counts[status] ?? 0) + 1;
      }
      return {
        ...g,
        websiteCount: g.websites.length,
        baselineWebsiteCount: baseline.length,
        currentUrlCount: baseline.length ? sum("currentCount") : null,
        pendingRemovalCount: sum("pendingCount"),
        removedUrlCount: sum("removedCount"),
        added: g.websites.reduce((n, w) => n + w.added, 0),
        removed: g.websites.reduce((n, w) => n + w.removed, 0),
        reappeared: g.websites.reduce((n, w) => n + w.reappeared, 0),
        pendingCandidates: g.websites.reduce(
          (n, w) => n + w.pendingCandidates,
          0,
        ),
        latestSiteScanAt:
          g.websites
            .map((w) => w.lastSuccessAt)
            .filter((s): s is string => !!s)
            .sort()
            .at(-1) ?? null,
        statusCounts: counts,
      };
    },
  );
  return {
    asOf: new Date(result.asOf).toISOString(),
    total: result.total,
    items,
  };
}

type EventOptions = {
  window: GroupWindow;
  includeArchived: boolean;
  siteId: string | null;
  kind: string | null;
  limit: number;
  cursor?: string;
};
type Cursor = {
  v: 1;
  groupId: string;
  window: GroupWindow;
  includeArchived: boolean;
  siteId: string | null;
  kind: string | null;
  asOf: string;
  observedAt: string;
  id: string;
  fingerprint: string;
};
function cursorKey(secret: string) {
  if (secret.length < 32) throw new Error("GROUP_CURSOR_SECRET_REQUIRED");
  return createHmac("sha256", secret)
    .update("sitemap-radar:group-events:v1")
    .digest();
}
export function encodeGroupCursor(cursor: Cursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${createHmac("sha256", cursorKey(secret)).update(payload).digest("base64url")}`;
}
export function decodeGroupCursor(token: string, secret: string): Cursor {
  try {
    if (token.length > 4096) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new Error();
    const actual = Buffer.from(signature, "base64url"),
      expected = createHmac("sha256", cursorKey(secret))
        .update(payload)
        .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      c.v !== 1 ||
      typeof c.id !== "string" ||
      typeof c.fingerprint !== "string" ||
      !Number.isFinite(Date.parse(c.asOf)) ||
      !Number.isFinite(Date.parse(c.observedAt))
    )
      throw new Error();
    return c;
  } catch {
    throw new GroupError("INVALID_CURSOR", 400);
  }
}
export async function groupEvents(
  pool: Pool,
  viewerId: string,
  groupId: string,
  options: EventOptions,
  secret: string,
) {
  const cursor = options.cursor
    ? decodeGroupCursor(options.cursor, secret)
    : null;
  if (
    cursor &&
    (cursor.groupId !== groupId ||
      cursor.window !== options.window ||
      cursor.includeArchived !== options.includeArchived ||
      cursor.siteId !== options.siteId ||
      cursor.kind !== options.kind)
  )
    throw new GroupError("INVALID_CURSOR", 400);
  const {
    rows: [result],
  } = await pool.query(
    `WITH g AS MATERIALIZED (
    SELECT id,membership_version FROM competitor_group WHERE id=$1 AND ${accessibleOwnerSql("owner_user_id", "$2")}
  ), members AS MATERIALIZED (
    SELECT w.id,w.name,w.domain,t.id AS target_id,t.scope_version,t.filter_version,t.archived_at,
      ARRAY(SELECT jsonb_array_elements_text(t.include_paths)) AS include_rules,
      ARRAY(SELECT jsonb_array_elements_text(t.exclude_paths)) AS exclude_rules
    FROM g JOIN website w ON w.competitor_group_id=g.id JOIN target t ON t."websiteId"=w.id AND t.kind='SITEMAP_LINKS'
    WHERE ($3 OR t.archived_at IS NULL)
  ), moment AS MATERIALIZED (SELECT COALESCE($4::timestamptz,statement_timestamp()) AS as_of), page AS MATERIALIZED (
    SELECT e.id,e.url,e.kind,e.run_id AS "runId",e.observed_at AS "observedAt",m.id AS "websiteId",m.name AS "websiteName",m.domain,m.target_id AS "targetId"
    FROM members m JOIN url_event e ON e.website_id=m.id AND e.scope_version=m.scope_version CROSS JOIN moment
    WHERE e.observed_at BETWEEN moment.as_of-make_interval(days=>$5) AND moment.as_of
      AND ($6::text IS NULL OR m.id=$6) AND ($7::text IS NULL OR e.kind=$7)
      AND ${pathFilterSql("e.url", "m.include_rules", "m.exclude_rules")}
      AND ($8::timestamptz IS NULL OR (e.observed_at,e.id)<($8::timestamptz,$9::text))
    ORDER BY e.observed_at DESC,e.id DESC LIMIT $10
  ) SELECT (SELECT id FROM g) AS id,(SELECT membership_version FROM g) AS version,(SELECT as_of FROM moment) AS "asOf",
    ($6::text IS NULL OR EXISTS(SELECT 1 FROM members WHERE id=$6)) AS "siteAllowed",
    COALESCE((SELECT string_agg(jsonb_build_array(id,target_id,scope_version,filter_version,archived_at,include_rules,exclude_rules)::text,',' ORDER BY id) FROM members),'') AS configuration,
    COALESCE((SELECT jsonb_agg(p ORDER BY p."observedAt" DESC,p.id DESC) FROM page p),'[]'::jsonb) AS items`,
    [
      groupId,
      viewerId,
      options.includeArchived,
      cursor?.asOf ?? null,
      options.window === "7d" ? 7 : 1,
      options.siteId,
      options.kind,
      cursor?.observedAt ?? null,
      cursor?.id ?? null,
      options.limit + 1,
    ],
  );
  if (!result.id) throw new GroupError("GROUP_NOT_FOUND", 404);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([result.version, result.configuration]))
    .digest("hex");
  if (cursor && fingerprint !== cursor.fingerprint)
    throw new GroupError("CURSOR_STALE");
  if (!result.siteAllowed) throw new GroupError("GROUP_NOT_FOUND", 404);
  const asOf = new Date(result.asOf).toISOString(),
    more = result.items.length > options.limit,
    items = result.items.slice(0, options.limit),
    last = items.at(-1);
  return {
    asOf,
    items,
    nextCursor:
      more && last
        ? encodeGroupCursor(
            {
              v: 1,
              groupId,
              window: options.window,
              includeArchived: options.includeArchived,
              siteId: options.siteId,
              kind: options.kind,
              asOf,
              observedAt: last.observedAt,
              id: last.id,
              fingerprint,
            },
            secret,
          )
        : null,
  };
}
