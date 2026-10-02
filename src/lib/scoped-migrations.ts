import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool } from "pg";

export function schemaIdentifier(name: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || ["public", "auth", "storage", "extensions", "pg_catalog", "information_schema"].includes(name)) {
    throw new Error("PRIVATE_SCHEMA_REQUIRED");
  }
  return `"${name}"`;
}

/** Preserve committed migration hashes while placing all generated DDL in a private schema. */
export async function migratePrivateSchema(pool: Pool, schema: string, folder = "drizzle") {
  const identifier = schemaIdentifier(schema);
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sitemap-radar:migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
    await client.query(`REVOKE ALL ON SCHEMA ${identifier} FROM PUBLIC`);
    await client.query(`SET LOCAL search_path TO ${identifier}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${identifier}."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const applied = await client.query<{ hash: string; created_at: string }>(`SELECT hash,created_at FROM ${identifier}."__drizzle_migrations" ORDER BY created_at`);
    for (const [index, row] of applied.rows.entries()) {
      if (migrations[index]?.hash !== row.hash || String(migrations[index]?.folderMillis) !== String(row.created_at)) {
        throw new Error("MIGRATION_HISTORY_MISMATCH");
      }
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      for (const statement of migration.sql) {
        // Committed Drizzle DDL uses this qualifier for generated foreign keys.
        await client.query(statement.replaceAll('"public".', `${identifier}.`));
      }
      await client.query(`INSERT INTO ${identifier}."__drizzle_migrations"(hash,created_at) VALUES($1,$2)`, [migration.hash, migration.folderMillis]);
    }
    await client.query("COMMIT");
    return { schema, applied: migrations.length - applied.rows.length, total: migrations.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
