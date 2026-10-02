import { parse } from "dotenv";
import { randomBytes } from "node:crypto";
import { readFile, open, unlink } from "node:fs/promises";
import { Pool } from "pg";
import { migratePrivateSchema } from "../src/lib/scoped-migrations";

function argument(flag: string) {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("PROVISION_ARGUMENT_REQUIRED");
  return value;
}
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function main() {
  const projectRef = argument("--project-ref"), input = argument("--env-file"), output = argument("--output");
  if (!/^[a-z]{20}$/.test(projectRef)) throw new Error("PROJECT_REF_INVALID");
  const config = parse(await readFile(input));
  const adminUrl = new URL(config.DATABASE_URL || "");
  const pooler = adminUrl.hostname.endsWith(".pooler.supabase.com") && adminUrl.username === `postgres.${projectRef}`;
  const direct = adminUrl.hostname === `db.${projectRef}.supabase.co` && adminUrl.username === "postgres";
  if ((!pooler && !direct) || !["postgres:", "postgresql:"].includes(adminUrl.protocol) ||
      (adminUrl.port && adminUrl.port !== "5432") || adminUrl.pathname !== "/postgres" || !adminUrl.password) {
    throw new Error("PROJECT_CONNECTION_MISMATCH");
  }
  adminUrl.searchParams.set("sslmode", "verify-full");
  const schema = "sitemap_radar", role = "sitemap_radar_app";
  const pool = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
  // Reserve the private destination before any mutation; never overwrite existing credentials.
  const file = await open(output, "wx", 0o600);
  let commitAttempted = false;
  try {
    const existing = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    if (existing.rowCount) throw new Error("APPLICATION_ROLE_ALREADY_EXISTS");
    await pool.query(await readFile("supabase/migrations/20261002073748_radar_private_schema.sql", "utf8"));
    const migrated = await migratePrivateSchema(pool, schema);
    const password = randomBytes(36).toString("base64url");
    const appUrl = new URL(adminUrl);
    appUrl.username = pooler ? `${role}.${projectRef}` : role;
    appUrl.password = password;
    // Durably save credentials before commit, including an unknown COMMIT outcome.
    await file.writeFile(`DATABASE_URL=${appUrl.toString()}\nDATABASE_SCHEMA=${schema}\nBETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}\nBETTER_AUTH_URL=https://sitemap.lipeiwei.com\nSITEMAP_DNS_RESOLVER=cloudflare-doh\n`);
    await file.sync();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Password is generated as base64url and never printed or passed through a shell.
      await client.query(`CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16 PASSWORD '${password}'`);
      await client.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
      await client.query(`ALTER ROLE ${quote(role)} IN DATABASE postgres SET search_path TO ${quote(schema)}`);
      const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
      for (const { tablename } of tables.rows) {
        const table = `${quote(schema)}.${quote(tablename)}`;
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        if (tablename === "__drizzle_migrations") {
          await client.query(`GRANT SELECT ON ${table} TO ${quote(role)}`);
          await client.query(`CREATE POLICY radar_server_read ON ${table} FOR SELECT TO ${quote(role)} USING (true)`);
        } else {
          await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO ${quote(role)}`);
          await client.query(`CREATE POLICY radar_server ON ${table} FOR ALL TO ${quote(role)} USING (true) WITH CHECK (true)`);
        }
      }
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${quote(schema)} TO ${quote(role)}`);
      commitAttempted = true;
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
    const app = new Pool({ connectionString: appUrl.toString(), max: 1, connectionTimeoutMillis: 10_000,
      options: `-c search_path=${schema}` });
    try {
      const { rows: [check] } = await app.query(`SELECT current_user AS role,current_schema() AS schema,
        has_schema_privilege(current_user,$1,'CREATE') AS can_create`, [schema]);
      if (check.role !== role || check.schema !== schema || check.can_create) throw new Error("APPLICATION_ROLE_NOT_ISOLATED");
      await app.query('SELECT id FROM "user" LIMIT 0');
    } finally { await app.end(); }
    console.log(JSON.stringify({ projectRef, schema, role, migrations: migrated.total, runtimeConnectionVerified: true }));
  } finally {
    await file.close(); await pool.end();
    // Once committed, preserve the private credentials even if the subsequent network check fails.
    if (!commitAttempted) await unlink(output).catch(() => {});
  }
}
main().catch(() => { console.error("SUPABASE_PREPARATION_FAILED: inspect scoped state before retrying"); process.exitCode = 1; });
