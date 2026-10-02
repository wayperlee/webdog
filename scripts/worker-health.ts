import "dotenv/config";
import { getPool } from "../src/lib/db";
import { workerReady } from "../src/lib/runtime-health";

async function main() {
  process.env.DB_POOL_MAX = "1";
  process.env.DB_APPLICATION_NAME = "sitemap-radar-worker-probe";
  const pool = getPool();
  try {
    if (!process.env.WORKER_HEALTH_FILE) throw new Error("WORKER_HEALTH_FILE_REQUIRED");
    await workerReady(pool, process.env.WORKER_HEALTH_FILE);
    console.log(JSON.stringify({ ok: true }));
  } catch {
    console.log(JSON.stringify({ ok: false })); process.exitCode = 1;
  } finally { await pool.end(); }
}
main().catch(() => { console.log(JSON.stringify({ ok: false })); process.exitCode = 1; });
