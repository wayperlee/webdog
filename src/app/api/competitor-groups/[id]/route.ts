import { getApiUser, requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { getPool } from "@/lib/db";
import { groupResponse, metadataSchema } from "@/lib/competitor-group-api";
import { readGroup, updateGroup, deleteGroup } from "@/lib/competitor-groups";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Context) {
  const { user, response } = await getApiUser();
  if (!user) return response;
  const { id } = await ctx.params;
  return groupResponse(async () => ({
    group: await readGroup(getPool(), user.id, id),
  }));
}
export async function PATCH(req: Request, ctx: Context) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const p = await parseJson(
    req,
    metadataSchema.partial().refine((x) => Object.keys(x).length > 0),
  );
  if (p.response) return p.response;
  const { id } = await ctx.params;
  return groupResponse(async () => ({
    group: await updateGroup(getPool(), user.id, ownerId, id, p.data),
  }));
}
export async function DELETE(_req: Request, ctx: Context) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const { id } = await ctx.params;
  return groupResponse(() => deleteGroup(getPool(), user.id, ownerId, id));
}
