import { z } from "zod";
import { getApiUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  groupResponse,
  windowSchema,
  parseQuery,
  idSchema,
} from "@/lib/competitor-group-api";
import { groupEvents } from "@/lib/competitor-group-summary";
const query = windowSchema
  .extend({
    siteId: idSchema.nullable().default(null),
    kind: z.enum(["added", "removed", "reappeared"]).nullable().default(null),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(4096).optional(),
  })
  .strict();
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await ctx.params;
  return groupResponse(() =>
    groupEvents(
      getPool(),
      user.id,
      id,
      parseQuery(req, query),
      process.env.BETTER_AUTH_SECRET ?? "",
    ),
  );
}
