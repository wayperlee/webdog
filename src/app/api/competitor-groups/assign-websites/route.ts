import { z } from "zod";
import { requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { getPool } from "@/lib/db";
import { groupResponse, idSchema } from "@/lib/competitor-group-api";
import { assignWebsites } from "@/lib/competitor-groups";
const body = z
  .object({
    groupId: idSchema.nullable(),
    assignments: z
      .array(
        z
          .object({ websiteId: idSchema, expectedGroupId: idSchema.nullable() })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export async function POST(req: Request) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const p = await parseJson(req, body);
  if (p.response) return p.response;
  return groupResponse(() =>
    assignWebsites(
      getPool(),
      user.id,
      ownerId,
      p.data.groupId,
      p.data.assignments,
    ),
  );
}
