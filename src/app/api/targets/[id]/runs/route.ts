import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUserWithWriteOwner, getApiUser, notFound, parseJson } from "@/lib/api";
import { submitRun, publicRun } from "@/lib/run-api";
import { db, getPool } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { target, website } from "@/lib/db/schema";
import { websiteOwnerAccessible } from "@/lib/account-access";
import type { RunRow } from "@/lib/crawl-queue";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, z.object({}).strict());
  if (parsed.response) return parsed.response;
  return submitRun((await params).id, ownerId);
}
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await params;
  const [owned] = await db.select({ id: target.id }).from(target).innerJoin(website, eq(website.id, target.websiteId))
    .where(and(eq(target.id, id), websiteOwnerAccessible(user.id))).limit(1);
  if (!owned) return notFound();
  const { rows } = await getPool().query<RunRow & { url_count: number | null; error: unknown; finished_at: Date | null }>(`SELECT id,target_id,execution_status,completeness,adoption_status,attempt,available_at,created_at,finished_at,error,
    CASE WHEN result->'urls' IS NULL OR result->'urls'='null'::jsonb THEN NULL ELSE jsonb_array_length(result->'urls') END AS url_count
    FROM crawl_run WHERE target_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [id]);
  return NextResponse.json({ runs: rows.map((run) => ({ ...publicRun(run), finishedAt: run.finished_at, urlCount: run.url_count, error: run.error })) });
}
