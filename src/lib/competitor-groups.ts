import type { Pool, PoolClient } from "pg";
import { newId } from "./ids";

export class GroupError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export type CompetitorGroup = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
};
export const groupFields = `g.id,g.owner_user_id AS "ownerId",g.name,g.description,
 g.membership_version AS "membershipVersion",g.created_at AS "createdAt",g.updated_at AS "updatedAt"`;
export const accessibleOwnerSql = (
  column: string,
  param: string,
) => `(${column}=${param} OR EXISTS
 (SELECT 1 FROM "accountMembership" am WHERE am."ownerUserId"=${column} AND am."memberUserId"=${param}))`;

export async function readGroup(
  pool: Pool | PoolClient,
  viewerId: string,
  id: string,
): Promise<CompetitorGroup> {
  const {
    rows: [group],
  } = await pool.query(
    `SELECT ${groupFields} FROM competitor_group g WHERE g.id=$1 AND ${accessibleOwnerSql("g.owner_user_id", "$2")}`,
    [id, viewerId],
  );
  if (!group) throw new GroupError("GROUP_NOT_FOUND", 404);
  return group;
}
async function ownerTransaction<T>(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `competitor-groups:${ownerId}`,
    ]);
    const access = await client.query(
      `SELECT 1 FROM "user" u WHERE u.id=$1 AND ${accessibleOwnerSql("u.id", "$2")}`,
      [ownerId, viewerId],
    );
    if (!access.rowCount) throw new GroupError("ACCOUNT_NOT_FOUND", 404);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const code = (error as { code?: string }).code;
    if (code === "23505") throw new GroupError("GROUP_NAME_EXISTS");
    if (["23503", "55P03", "40P01"].includes(code ?? ""))
      throw new GroupError("GROUP_CHANGED");
    throw error;
  } finally {
    client.release();
  }
}
async function ownedGroup(client: PoolClient, ownerId: string, id: string) {
  const {
    rows: [group],
  } = await client.query(
    "SELECT id FROM competitor_group WHERE id=$1 AND owner_user_id=$2",
    [id, ownerId],
  );
  if (!group) throw new GroupError("GROUP_NOT_FOUND", 404);
}
export async function listGroups(
  pool: Pool,
  viewerId: string,
  q = "",
  limit = 50,
  offset = 0,
) {
  const {
    rows: [page],
  } = await pool.query(
    `WITH groups AS MATERIALIZED (SELECT ${groupFields} FROM competitor_group g
    WHERE ${accessibleOwnerSql("g.owner_user_id", "$1")} AND strpos(lower(g.name),lower($2))>0)
    SELECT (SELECT count(*)::int FROM groups) AS total,COALESCE((SELECT jsonb_agg(p) FROM
      (SELECT * FROM groups ORDER BY name,id LIMIT $3 OFFSET $4) p),'[]'::jsonb) AS items`,
    [viewerId, q, limit, offset],
  );
  return {
    ...page,
    limit,
    offset,
    nextOffset:
      offset + page.items.length < page.total
        ? offset + page.items.length
        : null,
  };
}
export async function createGroup(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  name: string,
  description: string | null,
) {
  return ownerTransaction(pool, viewerId, ownerId, async (client) => {
    const id = newId("grp");
    await client.query(
      "INSERT INTO competitor_group(id,owner_user_id,name,description) VALUES($1,$2,$3,$4)",
      [id, ownerId, name, description],
    );
    return readGroup(client, viewerId, id);
  });
}
export async function updateGroup(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  id: string,
  patch: { name?: string; description?: string | null },
) {
  return ownerTransaction(pool, viewerId, ownerId, async (client) => {
    await ownedGroup(client, ownerId, id);
    await client.query(
      `UPDATE competitor_group SET name=COALESCE($3,name),description=CASE WHEN $4 THEN $5 ELSE description END,
      updated_at=clock_timestamp() WHERE id=$1 AND owner_user_id=$2`,
      [
        id,
        ownerId,
        patch.name ?? null,
        "description" in patch,
        patch.description ?? null,
      ],
    );
    return readGroup(client, viewerId, id);
  });
}
export type GroupAssignment = {
  websiteId: string;
  expectedGroupId: string | null;
};
export async function assignWebsites(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  groupId: string | null,
  assignments: GroupAssignment[],
) {
  const unique = new Map<string, GroupAssignment>();
  for (const assignment of assignments) {
    if (
      unique.has(assignment.websiteId) &&
      unique.get(assignment.websiteId)!.expectedGroupId !==
        assignment.expectedGroupId
    )
      throw new GroupError("INVALID_ASSIGNMENTS", 400);
    unique.set(assignment.websiteId, assignment);
  }
  if (!unique.size || unique.size > 100)
    throw new GroupError("INVALID_ASSIGNMENTS", 400);
  return ownerTransaction(pool, viewerId, ownerId, async (client) => {
    if (groupId) await ownedGroup(client, ownerId, groupId);
    const ids = [...unique.keys()].sort();
    const { rows } = await client.query(
      `SELECT id,competitor_group_id FROM website WHERE "userId"=$1 AND id=ANY($2::text[]) ORDER BY id FOR NO KEY UPDATE`,
      [ownerId, ids],
    );
    if (rows.length !== ids.length)
      throw new GroupError("WEBSITE_NOT_FOUND", 404);
    const changed = rows.filter((row) => row.competitor_group_id !== groupId);
    for (const row of changed)
      if (row.competitor_group_id !== unique.get(row.id)!.expectedGroupId)
        throw new GroupError("GROUP_ASSIGNMENT_CHANGED");
    if (changed.length) {
      await client.query(
        'UPDATE website SET competitor_group_id=$1 WHERE "userId"=$2 AND id=ANY($3::text[])',
        [groupId, ownerId, changed.map((r) => r.id)],
      );
      const groups = [
        ...new Set(
          [groupId, ...changed.map((r) => r.competitor_group_id)].filter(
            Boolean,
          ),
        ),
      ];
      await client.query(
        "UPDATE competitor_group SET membership_version=membership_version+1,updated_at=clock_timestamp() WHERE owner_user_id=$1 AND id=ANY($2::text[])",
        [ownerId, groups],
      );
    }
    return { changedCount: changed.length, websiteIds: ids, groupId };
  });
}
export async function deleteGroup(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  id: string,
) {
  return ownerTransaction(pool, viewerId, ownerId, async (client) => {
    await ownedGroup(client, ownerId, id);
    const detached = await client.query(
      'UPDATE website SET competitor_group_id=NULL WHERE competitor_group_id=$1 AND "userId"=$2',
      [id, ownerId],
    );
    await client.query(
      "DELETE FROM competitor_group WHERE id=$1 AND owner_user_id=$2",
      [id, ownerId],
    );
    return { detachedWebsiteCount: detached.rowCount ?? 0 };
  });
}
export async function createGroupedWebsite(
  pool: Pool,
  viewerId: string,
  ownerId: string,
  domain: string,
  groupId: string | null,
) {
  return ownerTransaction(pool, viewerId, ownerId, async (client) => {
    if (groupId) await ownedGroup(client, ownerId, groupId);
    const id = newId("web");
    const {
      rows: [website],
    } = await client.query(
      `INSERT INTO website(id,"userId",name,url,domain,competitor_group_id)
      VALUES($1,$2,$3,$4,$3,$5) RETURNING *,competitor_group_id AS "competitorGroupId"`,
      [id, ownerId, domain, `https://${domain}`, groupId],
    );
    await client.query(
      `INSERT INTO target(id,"websiteId",kind,"linkScope",enabled,"checkIntervalHours","externalNotify","aiChangeSummaryEnabled","aiTriageEnabled")
      VALUES($1,$2,'SITEMAP_LINKS','BOTH',true,6,false,false,false)`,
      [newId("tgt"), id],
    );
    if (groupId)
      await client.query(
        "UPDATE competitor_group SET membership_version=membership_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [groupId],
      );
    delete website.competitor_group_id;
    return website;
  });
}
