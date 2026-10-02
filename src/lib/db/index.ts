import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { resolveDatabaseUrl } from "./database-url";
import * as schema from "./schema";
import { Pool } from "pg";

type Db = NodePgDatabase<typeof schema>;

type Connection = {
  db: Db;
  pool: Pool;
};

declare global {
  var webdogPgConnection: Connection | undefined;
}

function getConnection(): Connection {
  if (globalThis.webdogPgConnection?.pool) return globalThis.webdogPgConnection;

  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  pool.on("error", () => console.error("DB_POOL_ERROR: idle database connection closed"));
  const db = drizzle(pool, { schema });

  globalThis.webdogPgConnection = { db, pool };
  return globalThis.webdogPgConnection;
}

export const db = new Proxy({} as Db, {
  get(_target, prop) {
    return (getConnection().db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { schema };
export function getPool() { return getConnection().pool; }
