import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { target, website } from "@/lib/db/schema";
import { requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { submitRun } from "@/lib/run-api";

/** Compatibility submission endpoint. Scheduler runs in the durable worker, never in HTTP. */
export async function POST(req: Request) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, z.object({ websiteId: z.string().min(1) }).strict());
  if (parsed.response) return parsed.response;
  const [owned] = await db.select({ id: target.id }).from(target).innerJoin(website, eq(website.id, target.websiteId))
    .where(and(eq(website.id, parsed.data.websiteId), eq(website.userId, ownerId), eq(target.kind, "SITEMAP_LINKS"))).limit(1);
  if (!owned) return NextResponse.json({ error: "TARGET_NOT_FOUND" }, { status: 404 });
  return submitRun(owned.id, ownerId);
}
