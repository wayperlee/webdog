import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getApiUser, notFound } from "./api";
import { db, getPool } from "./db";
import { target, website } from "./db/schema";
import { pathFilterSql } from "./monitor-filters";
import { websiteOwnerAccessible } from "./account-access";

const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(200_000).default(0),
    scopeVersion: z.coerce.number().int().min(1).optional(),
    q: z.string().max(200).optional(),
    kind: z.enum(["added", "removed", "reappeared"]).optional(),
    status: z.enum(["active", "pending_removed", "removed"]).optional(),
  })
  .strict();
export async function inventoryPage(
  req: Request,
  targetId: string,
  collection: "urls" | "events" | "candidates",
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const [owned] = await db
    .select({
      websiteId: target.websiteId,
      scopeVersion: target.scopeVersion,
      filterVersion: target.filterVersion,
      includePaths: target.includePaths,
      excludePaths: target.excludePaths,
    })
    .from(target)
    .innerJoin(website, eq(website.id, target.websiteId))
    .where(and(eq(target.id, targetId), websiteOwnerAccessible(user.id)))
    .limit(1);
  if (!owned) return notFound();
  const parsed = pageSchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  const { limit, offset, status, q, kind } = parsed.data,
    scope = parsed.data.scopeVersion ?? owned.scopeVersion;
  if (status && collection !== "urls")
    return NextResponse.json(
      { error: "Status is only supported for URL inventory" },
      { status: 400 },
    );
  if (
    ((q || kind) && collection === "candidates") ||
    (kind && collection !== "events")
  )
    return NextResponse.json({ error: "Unsupported filter" }, { status: 400 });
  const table = {
    urls: "site_url",
    events: "url_event",
    candidates: "removal_candidate",
  }[collection];
  const identity = collection === "candidates" ? "target_id" : "website_id";
  const order = {
    urls: "normalized_url_hash",
    events: "observed_at DESC,id DESC",
    candidates: "observed_at DESC,id DESC",
  }[collection];
  const fields = {
    urls: "url,status,first_seen_at,last_seen_at,first_missing_run_id,first_missing_observed_at,last_missing_run_id,missing_confirmations,removed_at",
    events: "id,url,kind,run_id,observed_at",
    candidates:
      "id,status,reason,origin_baseline_run_id,candidate_run_id,original_missing_count,pending_count,recovered_count,removed_count,observed_at,expires_at,next_confirmation_at,confirmation_attempts,last_confirmation_run_id",
  }[collection];
  const args: unknown[] = [
    collection === "candidates" ? targetId : owned.websiteId,
    scope,
    status ?? null,
    limit,
    offset,
  ];
  let where = `${identity}=$1 AND scope_version=$2${collection === "urls" ? " AND ($3::text IS NULL OR status=$3)" : " AND $3::text IS NULL"}`;
  if (collection !== "candidates") {
    args.push(owned.includePaths, owned.excludePaths, q ?? "");
    where += ` AND ${pathFilterSql("url", "$6", "$7")} AND strpos(lower(url),lower($8::text))>0`;
    if (collection === "events") {
      args.push(kind ?? null);
      where += " AND ($9::text IS NULL OR kind=$9)";
    }
  }
  // One statement/snapshot keeps page and total consistent even while a Worker commits a new observation.
  const {
    rows: [page],
  } = await getPool().query(
    `SELECT (SELECT count(*)::int FROM ${table} WHERE ${where}) AS total,
    COALESCE((SELECT jsonb_agg(p) FROM (SELECT ${fields} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT $4 OFFSET $5) p),'[]'::jsonb) AS items`,
    args,
  );
  return NextResponse.json({
    ...page,
    scopeVersion: scope,
    filterVersion: owned.filterVersion,
    limit,
    offset,
    nextOffset:
      offset + page.items.length < page.total
        ? offset + page.items.length
        : null,
  });
}

export async function candidateUrlsPage(
  req: Request,
  targetId: string,
  candidateId: string,
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const [owned] = await db
    .select({ id: target.id })
    .from(target)
    .innerJoin(website, eq(website.id, target.websiteId))
    .where(and(eq(target.id, targetId), websiteOwnerAccessible(user.id)))
    .limit(1);
  if (!owned) return notFound();
  const parsed = pageSchema
    .omit({ status: true, scopeVersion: true, q: true, kind: true })
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  const {
    rows: [candidate],
  } = await getPool().query(
    "SELECT id FROM removal_candidate WHERE id=$1 AND target_id=$2",
    [candidateId, targetId],
  );
  if (!candidate) return notFound();
  const { limit, offset } = parsed.data;
  const {
    rows: [page],
  } = await getPool().query(
    `SELECT (SELECT count(*)::int FROM candidate_missing_url WHERE candidate_id=$1) AS total,
    COALESCE((SELECT jsonb_agg(p) FROM (SELECT url,resolution FROM candidate_missing_url WHERE candidate_id=$1 ORDER BY normalized_url_hash LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS items`,
    [candidateId, limit, offset],
  );
  return NextResponse.json({
    ...page,
    limit,
    offset,
    nextOffset:
      offset + page.items.length < page.total
        ? offset + page.items.length
        : null,
  });
}
