import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireApiUserWithWriteOwner,
  getApiUser,
  notFound,
  parseJson,
} from "@/lib/api";
import { submitRun, publicRun } from "@/lib/run-api";
import { db, getPool } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { target, website } from "@/lib/db/schema";
import { websiteOwnerAccessible } from "@/lib/account-access";
import type { RunRow } from "@/lib/crawl-queue";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, z.object({}).strict());
  if (parsed.response) return parsed.response;
  return submitRun((await params).id, ownerId);
}
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await params;
  const [owned] = await db
    .select({ id: target.id })
    .from(target)
    .innerJoin(website, eq(website.id, target.websiteId))
    .where(and(eq(target.id, id), websiteOwnerAccessible(user.id)))
    .limit(1);
  if (!owned) return notFound();
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(200000).default(0),
      scopeVersion: z.coerce.number().int().positive().optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  const { limit, offset, scopeVersion } = parsed.data;
  const {
    rows: [page],
  } = await getPool().query(
    `SELECT (SELECT count(*)::int FROM crawl_run WHERE target_id=$1 AND ($4::int IS NULL OR scope_version=$4)) AS total,
    COALESCE((SELECT jsonb_agg(p) FROM (SELECT id,target_id,execution_status,completeness,adoption_status,attempt,available_at,created_at,finished_at,error,scope_version,trigger,
    CASE WHEN result->'urls' IS NULL OR result->'urls'='null'::jsonb THEN NULL ELSE jsonb_array_length(result->'urls') END AS url_count
    FROM crawl_run WHERE target_id=$1 AND ($4::int IS NULL OR scope_version=$4) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS items`,
    [id, limit, offset, scopeVersion ?? null],
  );
  const runs = page.items.map(
    (
      run: RunRow & {
        finished_at: string | null;
        url_count: number | null;
        error: unknown;
      },
    ) => ({
      ...publicRun(run),
      scopeVersion: run.scope_version,
      trigger: run.trigger,
      finishedAt: run.finished_at,
      urlCount: run.url_count,
      error: run.error,
    }),
  );
  return NextResponse.json({
    runs,
    items: runs,
    total: page.total,
    limit,
    offset,
    nextOffset: offset + runs.length < page.total ? offset + runs.length : null,
  });
}
