import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";
import { canonicalBackupDefinition } from "../src/lib/backup-schema";
import { groupOverviews } from "../src/lib/competitor-group-summary";

/** Restore only an isolated local feature fixture into a fresh throwaway database. */
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55471");
  assert.equal(url.pathname, "/sitemap_radar_pr1");
  const schema = process.env.DATABASE_SCHEMA ?? "";
  assert.match(schema, /^groups_ui_[a-f0-9]{32}$/);
  const output = process.argv[2];
  assert.ok(output?.startsWith("/"));
  const source = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
    max: 1,
  });
  const restoreName = `groups_restore_${randomUUID().replaceAll("-", "")}`;
  const role = `groups_backup_${randomUUID().replaceAll("-", "")}`;
  const restoreUrl = new URL(url);
  restoreUrl.pathname = `/${restoreName}`;
  const restored = new Pool({
    connectionString: restoreUrl.toString(),
    options: `-c search_path=${schema}`,
    max: 1,
  });
  const dir = `${output}/groups-private-backup`;
  await mkdir(dir, { mode: 0o700 });
  const dump = `${dir}/${restoreName}.dump`;
  let created = false,
    roleCreated = false;
  const command = (args: string[], input = false) => {
    const p = spawn(
      "docker",
      [
        "exec",
        ...(input ? ["-i"] : []),
        "--user",
        "postgres",
        "codex-sitemap-radar-pr1",
        ...args,
      ],
      { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] },
    );
    p.stderr!.resume();
    const done = new Promise<void>((ok, no) => {
      p.on("error", no);
      p.on("close", (code) =>
        code === 0 ? ok() : no(new Error(`${args[0]} failed (${code})`)),
      );
    });
    return { p, done };
  };
  async function fingerprint(pool: Pool) {
    const rows = [];
    const tables = (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
        [schema],
      )
    ).rows;
    for (const t of tables)
      rows.push({
        table: t.tablename,
        data: (
          await pool.query(
            `SELECT jsonb_agg(t ORDER BY to_jsonb(t)::text) AS rows FROM "${schema}"."${t.tablename}" t`,
          )
        ).rows[0].rows,
      });
    const structure = (
      await pool.query(
        `SELECT 'column' AS kind,table_name AS object,ordinal_position::text AS position,jsonb_build_array(column_name,data_type,is_nullable,column_default)::text AS definition FROM information_schema.columns WHERE table_schema=$1
      UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1
      UNION ALL SELECT 'constraint',t.relname,c.conname,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1
      UNION ALL SELECT 'policy',tablename,policyname,jsonb_build_array(roles,cmd,qual,with_check)::text FROM pg_policies WHERE schemaname=$1
      UNION ALL SELECT 'privilege',c.relname,'rls_acl',jsonb_build_array(c.relrowsecurity,c.relacl)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY 1,2,3`,
        [schema],
      )
    ).rows;
    for (const row of structure)
      row.definition = canonicalBackupDefinition(
        row.kind,
        row.object,
        row.position,
        row.definition,
      );
    return {
      structure,
      tableCount: tables.length,
      dataHash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      schemaHash: createHash("sha256")
        .update(JSON.stringify(structure))
        .digest("hex"),
    };
  }
  try {
    await source.query(`CREATE ROLE ${role} NOLOGIN`);
    roleCreated = true;
    await source.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await source.query(
      "ALTER TABLE competitor_group ENABLE ROW LEVEL SECURITY",
    );
    await source.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON competitor_group TO ${role}`,
    );
    await source.query(
      `CREATE POLICY radar_server ON competitor_group FOR ALL TO ${role} USING(true) WITH CHECK(true)`,
    );
    const before = await fingerprint(source);
    const backup = command([
      "pg_dump",
      "--dbname=sitemap_radar_pr1",
      `--schema=${schema}`,
      "--format=custom",
      "--no-owner",
    ]);
    await Promise.all([
      pipeline(
        backup.p.stdout!,
        createWriteStream(dump, { flags: "wx", mode: 0o600 }),
      ),
      backup.done,
    ]);
    await source.query(`CREATE DATABASE ${restoreName} TEMPLATE template0`);
    created = true;
    const restore = command(
      [
        "pg_restore",
        `--dbname=${restoreName}`,
        "--exit-on-error",
        "--no-owner",
      ],
      true,
    );
    restore.p.stdout!.resume();
    await Promise.all([
      pipeline(createReadStream(dump), restore.p.stdin!),
      restore.done,
    ]);
    const after = await fingerprint(restored);
    if (after.schemaHash !== before.schemaHash) {
      const key = (r: { kind: string; object: string; position: string }) =>
        JSON.stringify([r.kind, r.object, r.position]);
      const actual = new Map(
        after.structure.map((r) => [key(r), r.definition]),
      );
      console.log(
        JSON.stringify({
          schemaDifferences: before.structure
            .filter((r) => actual.get(key(r)) !== r.definition)
            .map((r) => ({ ...r, restored: actual.get(key(r)) })),
        }),
      );
    }
    assert.deepEqual(after, before);
    const owner = (
      await restored.query(
        "SELECT owner_user_id FROM competitor_group ORDER BY id LIMIT 1",
      )
    ).rows[0].owner_user_id;
    const summary = await groupOverviews(restored, owner);
    assert.ok(summary.items.length > 0);
    await restored.query(`SET ROLE ${role}`);
    await restored.query("SELECT id FROM competitor_group LIMIT 1");
    await restored.query("UPDATE competitor_group SET description=description");
    await restored.query("RESET ROLE");
    const report = {
      observedAt: new Date().toISOString(),
      environment: "Isolated local schema, fresh temporary database",
      tableCount: before.tableCount,
      dataHash: before.dataHash,
      schemaHash: before.schemaHash,
      rowsAndDefinitionsMatch: true,
      includesGroupsColumnCompositeForeignKeyRlsAndGrants: true,
      restoredGroupQuery: true,
      restoredApplicationRoleReadWrite: true,
      privateBackupMode: "0600",
      cleanup: "Completed after validation",
    };
    await writeFile(
      `${output}/groups-backup-acceptance.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await restored.end();
    if (created) await source.query(`DROP DATABASE ${restoreName}`);
    if (roleCreated) {
      await source.query(
        "DROP POLICY IF EXISTS radar_server ON competitor_group",
      );
      await source.query(
        "ALTER TABLE competitor_group DISABLE ROW LEVEL SECURITY",
      );
      await source.query(`DROP OWNED BY ${role}`);
      await source.query(`DROP ROLE ${role}`);
    }
    await source.end();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "BACKUP_ACCEPTANCE_FAILED");
  process.exitCode = 1;
});
