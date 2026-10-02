import { getEffectiveAccountOwnerForWrites } from "@/lib/effective-account";
import { getApiUser, requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  groupResponse,
  metadataSchema,
  pageSchema,
  parseQuery,
} from "@/lib/competitor-group-api";
import { listGroups, createGroup } from "@/lib/competitor-groups";
export async function GET(req: Request) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  return groupResponse(async () => {
    const p = parseQuery(req, pageSchema);
    const [groups, scope] = await Promise.all([
      listGroups(getPool(), user.id, p.q, p.limit, p.offset),
      getEffectiveAccountOwnerForWrites(user.id),
    ]);
    return { ...groups, writeOwnerId: scope.ok ? scope.ownerId : null };
  });
}
export async function POST(req: Request) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const p = await parseJson(req, metadataSchema);
  if (p.response) return p.response;
  return groupResponse(
    async () => ({
      group: await createGroup(
        getPool(),
        user.id,
        ownerId,
        p.data.name,
        p.data.description ?? null,
      ),
    }),
    201,
  );
}
