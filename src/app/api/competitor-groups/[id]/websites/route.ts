import { z } from "zod";
import { getApiUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  groupResponse,
  pageSchema,
  windowSchema,
  parseQuery,
} from "@/lib/competitor-group-api";
import { groupOverviews } from "@/lib/competitor-group-summary";
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await ctx.params;
  return groupResponse(async () => {
    const p = parseQuery(
      req,
      pageSchema
        .omit({ q: true })
        .merge(windowSchema)
        .extend({ sort: z.enum(["name", "changes"]).default("changes") })
        .strict(),
    );
    const result = await groupOverviews(getPool(), user.id, {
      groupId: id,
      ...p,
      limit: 1,
      offset: 0,
    });
    const group = result.items[0];
    const items = [...group.websites].sort(
      (a, b) =>
        (p.sort === "changes"
          ? b.added +
            b.removed +
            b.reappeared -
            (a.added + a.removed + a.reappeared)
          : a.name.localeCompare(b.name)) || a.id.localeCompare(b.id),
    );
    return {
      websiteChoices: items.map((w) => ({ id: w.id, name: w.name })),
      group: { ...group, websites: undefined },
      asOf: result.asOf,
      total: items.length,
      items: items.slice(p.offset, p.offset + p.limit),
      nextOffset: p.offset + p.limit < items.length ? p.offset + p.limit : null,
    };
  });
}
