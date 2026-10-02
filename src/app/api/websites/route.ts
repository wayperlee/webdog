import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  badRequest,
  getApiUser,
  parseJson,
  requireApiUserWithWriteOwner,
} from "@/lib/api";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { createGroupedWebsite } from "@/lib/competitor-groups";
import { groupResponse } from "@/lib/competitor-group-api";
import { getPool } from "@/lib/db";
import { normalizeDomain } from "@/lib/domain";
import { monitorLimitError } from "@/lib/account-monitor-limits";

export async function GET() {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const websites = await db
    .select()
    .from(schema.website)
    .where(websiteOwnerAccessible(user.id))
    .orderBy(desc(schema.website.createdAt));
  return NextResponse.json({ websites });
}

const createSchema = z
  .object({
    domain: z.string().trim().min(1).max(253),
    competitorGroupId: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();

export async function POST(req: Request) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, createSchema);
  if (parsed.response) return parsed.response;
  const domain = normalizeDomain(parsed.data.domain);
  if (!domain) return badRequest("Enter a valid domain like example.com");
  const limitError = await monitorLimitError(ownerId);
  if (limitError) return badRequest(limitError);
  return groupResponse(
    async () => ({
      website: await createGroupedWebsite(
        getPool(),
        user.id,
        ownerId,
        domain,
        parsed.data.competitorGroupId ?? null,
      ),
    }),
    201,
  );
}
