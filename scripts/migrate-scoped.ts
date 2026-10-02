import "dotenv/config";
import { Pool } from "pg";
import { resolveDatabaseUrl } from "../src/lib/db/database-url";
import { migratePrivateSchema } from "../src/lib/scoped-migrations";

async function main() {
  const schema = process.env.DATABASE_SCHEMA;
  if (!schema) throw new Error("PRIVATE_SCHEMA_REQUIRED");
  const pool = new Pool({ connectionString: resolveDatabaseUrl(), max: 1, connectionTimeoutMillis: 10_000 });
  try { console.log(JSON.stringify(await migratePrivateSchema(pool, schema))); }
  finally { await pool.end(); }
}
main().catch(() => { console.error("SCOPED_MIGRATION_FAILED"); process.exitCode = 1; });
