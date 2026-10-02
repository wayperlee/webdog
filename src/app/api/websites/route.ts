import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { badRequest, getApiUser, parseJson, requireApiUserWithWriteOwner } from "@/lib/api";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { newId } from "@/lib/ids";
import { normalizeDomain } from "@/lib/domain";
import { monitorLimitError } from "@/lib/account-monitor-limits";

export async function GET() {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const websites = await db.select().from(schema.website)
    .where(websiteOwnerAccessible(user.id)).orderBy(desc(schema.website.createdAt));
  return NextResponse.json({ websites });
}

const createSchema = z.object({ domain: z.string().trim().min(1).max(253) }).strict();

export async function POST(req: Request) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, createSchema);
  if (parsed.response) return parsed.response;
  const domain = normalizeDomain(parsed.data.domain);
  if (!domain) return badRequest("Enter a valid domain like example.com");
  const limitError = await monitorLimitError(ownerId);
  if (limitError) return badRequest(limitError);
  const website = await db.transaction(async (tx) => {
    const [created] = await tx.insert(schema.website).values({
      id: newId("web"), userId: ownerId, name: domain, url: `https://${domain}`, domain,
    }).returning();
    await tx.insert(schema.target).values({
      id: newId("tgt"), websiteId: created.id, kind: "SITEMAP_LINKS", linkScope: "BOTH",
      enabled: true, checkIntervalHours: 6, externalNotify: false,
      aiChangeSummaryEnabled: false, aiTriageEnabled: false,
    });
    return created;
  });
  return NextResponse.json({ website }, { status: 201 });
}
