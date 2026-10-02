import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migratePrivateSchema, schemaIdentifier } from "./scoped-migrations";
import { databaseReady } from "./runtime-health";

test("Private schema identifiers cannot select platform or public schemas", () => {
  for (const bad of ["public", "auth", "storage", "pg_catalog", "a;DROP SCHEMA public", "a,b", "A"]) {
    assert.throws(() => schemaIdentifier(bad), /PRIVATE_SCHEMA_REQUIRED/);
  }
});

test("Private migrations keep every foreign key scoped and reject ledger drift", { skip: process.env.PR3_QUEUE_ACCEPTANCE !== "1" }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55471"); assert.equal(url.pathname, "/sitemap_radar_pr1");
  const name = `pr7_schema_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const privatePool = new Pool({ connectionString: url.toString(), max: 2, options: `-c search_path=${name}` });
  try {
    const migrated = await migratePrivateSchema(admin, name);
    assert.equal(migrated.total, 9); assert.equal(migrated.applied, 9);
    await databaseReady(privatePool);
    const crossSchema = await admin.query(`SELECT count(*)::int AS n FROM pg_constraint c
      JOIN pg_class src ON src.oid=c.conrelid JOIN pg_namespace s ON s.oid=src.relnamespace
      JOIN pg_class dst ON dst.oid=c.confrelid JOIN pg_namespace d ON d.oid=dst.relnamespace
      WHERE c.contype='f' AND s.nspname=$1 AND d.nspname<>$1`, [name]);
    assert.equal(crossSchema.rows[0].n, 0);
    assert.equal((await migratePrivateSchema(admin, name)).applied, 0);
    await admin.query(`UPDATE "${name}".__drizzle_migrations SET hash='unexpected' WHERE id=1`);
    await assert.rejects(migratePrivateSchema(admin, name), /MIGRATION_HISTORY_MISMATCH/);
  } finally {
    await privatePool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); await admin.end();
  }
});
