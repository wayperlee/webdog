import { NextResponse } from "next/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { badRequest, notFound, parseJson, requireApiUserWithWriteOwner } from "@/lib/api";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { monitorLimitError } from "@/lib/account-monitor-limits";

async function loadForWrite(sessionUserId: string, ownerId: string, targetId: string) {
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
  return NextResponse.json({ error: "CAPABILITY_DISABLED" }, {
    status: 405, headers: { Allow: "PATCH" },
  });
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalHours: z.number().refine((n) => [1, 6, 12, 24].includes(n)).optional(),
}).strict().refine((d) => d.enabled !== undefined || d.checkIntervalHours !== undefined,
  { message: "At least one field to update is required" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const { id } = await params;

  const owned = await loadForWrite(user.id, ownerId, id);
  if (!owned) return notFound("Target not found");

  const parsed = await parseJson(req, patchSchema);
  if (parsed.response) return parsed.response;

  if (owned.target.kind !== "SITEMAP_LINKS") return badRequest("Only sitemap monitors are available");

  if (parsed.data.enabled === true && !owned.target.enabled) {
    const limitError = await monitorLimitError(ownerId, { excludingTargetId: id });
    if (limitError) return badRequest(limitError);
  }

  const updates: {
    enabled?: boolean;
    checkIntervalHours?: number;
    nextCheckDueAt?: SQL;
  } = {};
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
  if (parsed.data.checkIntervalHours !== undefined) {
    updates.checkIntervalHours = parsed.data.checkIntervalHours;
    updates.nextCheckDueAt = sql`clock_timestamp() + ${parsed.data.checkIntervalHours} * interval '1 hour'`;
  }
  await db.update(schema.target).set(updates).where(eq(schema.target.id, id));
  const [updated] = await db.select().from(schema.target).where(eq(schema.target.id, id)).limit(1);
  return NextResponse.json({ target: updated });
}
