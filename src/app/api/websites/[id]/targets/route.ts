import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { badRequest, notFound, parseJson, requireApiUserWithWriteOwner } from "@/lib/api";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { newId } from "@/lib/ids";
import { monitorLimitError } from "@/lib/account-monitor-limits";

const createSchema = z.object({
  category: z.literal("LINK"),
  externalNotify: z.literal(false).optional(),
  checkIntervalHours: z.number().refine((n) => [1, 6, 12, 24].includes(n)).optional(),
  aiChangeSummaryEnabled: z.literal(false).optional(),
  aiTriageEnabled: z.literal(false).optional(),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const { id } = await params;
  const parsed = await parseJson(req, createSchema);
  if (parsed.response) return parsed.response;
  const limitError = await monitorLimitError(ownerId);
  if (limitError) return badRequest(limitError);
  return db.transaction(async (tx) => {
    // Serializes creation for existing sites without adding PR 3 schema yet.
    const [website] = await tx.select().from(schema.website)
      .where(and(eq(schema.website.id, id), eq(schema.website.userId, ownerId), websiteOwnerAccessible(user.id)))
      .limit(1).for("update");
    if (!website) return notFound("Website not found");
    const [existing] = await tx.select({ id: schema.target.id }).from(schema.target)
      .where(and(eq(schema.target.websiteId, id), eq(schema.target.kind, "SITEMAP_LINKS"))).limit(1);
    if (existing) return badRequest("A sitemap monitor already exists for this website");
    const [target] = await tx.insert(schema.target).values({
      id: newId("tgt"), websiteId: id, kind: "SITEMAP_LINKS", linkScope: "BOTH",
      enabled: true, checkIntervalHours: parsed.data.checkIntervalHours ?? 6,
      externalNotify: false, aiChangeSummaryEnabled: false, aiTriageEnabled: false,
    }).returning();
    return NextResponse.json({ targets: [target] }, { status: 201 });
  });
}
