import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, getPool } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  badRequest,
  notFound,
  parseJson,
  requireApiUserWithWriteOwner,
  getApiUser,
} from "@/lib/api";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { monitorLimitError } from "@/lib/account-monitor-limits";
import { CrawlQueue, QueueError } from "@/lib/crawl-queue";
import { monitorSummaries } from "@/lib/monitor-summary";

async function loadForWrite(
  sessionUserId: string,
  ownerId: string,
  targetId: string,
) {
  const rows = await db
    .select({ target: schema.target, website: schema.website })
    .from(schema.target)
    .innerJoin(schema.website, eq(schema.website.id, schema.target.websiteId))
    .where(
      and(
        eq(schema.target.id, targetId),
        eq(schema.website.userId, ownerId),
        websiteOwnerAccessible(sessionUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function DELETE() {
  return NextResponse.json(
    { error: "CAPABILITY_DISABLED" },
    {
      status: 405,
      headers: { Allow: "PATCH" },
    },
  );
}

const patchSchema = z
  .object({
    archived: z.boolean().optional(),
    includePaths: z.array(z.string()).max(100).optional(),
    excludePaths: z.array(z.string()).max(100).optional(),
    enabled: z.boolean().optional(),
    checkIntervalHours: z
      .number()
      .refine((n) => [1, 6, 12, 24].includes(n))
      .optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field to update is required",
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const { id } = await params;

  const owned = await loadForWrite(user.id, ownerId, id);
  if (!owned) return notFound("Target not found");

  const parsed = await parseJson(req, patchSchema);
  if (parsed.response) return parsed.response;

  if (owned.target.kind !== "SITEMAP_LINKS")
    return badRequest("Only sitemap monitors are available");

  if (
    (parsed.data.enabled === true && !owned.target.enabled) ||
    (parsed.data.archived === false &&
      owned.target.archivedAt &&
      (parsed.data.enabled ?? owned.target.enabled))
  ) {
    const limitError = await monitorLimitError(ownerId, {
      excludingTargetId: id,
    });
    if (limitError) return badRequest(limitError);
  }

  try {
    await new CrawlQueue(getPool()).configureMonitor(id, ownerId, parsed.data);
    const [target] = await monitorSummaries(getPool(), [id]);
    return NextResponse.json({ target });
  } catch (error) {
    if (error instanceof QueueError)
      return NextResponse.json(
        { error: error.code },
        { status: error.code === "TARGET_NOT_FOUND" ? 404 : 409 },
      );
    if (error instanceof Error && error.message.startsWith("Path prefixes"))
      return badRequest(error.message);
    throw error;
  }
}
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await params;
  const [owned] = await db
    .select({ id: schema.target.id })
    .from(schema.target)
    .innerJoin(schema.website, eq(schema.website.id, schema.target.websiteId))
    .where(and(eq(schema.target.id, id), websiteOwnerAccessible(user.id)))
    .limit(1);
  if (!owned) return notFound();
  const [target] = await monitorSummaries(getPool(), [id]);
  return NextResponse.json({ target });
}
