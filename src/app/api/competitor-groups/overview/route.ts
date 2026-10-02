import { getApiUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  groupResponse,
  pageSchema,
  windowSchema,
  parseQuery,
} from "@/lib/competitor-group-api";
import { groupOverviews } from "@/lib/competitor-group-summary";
export async function GET(req: Request) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  return groupResponse(() =>
    groupOverviews(
      getPool(),
      user.id,
      parseQuery(req, pageSchema.merge(windowSchema).strict()),
    ),
  );
}
