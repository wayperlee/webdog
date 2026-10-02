import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { CrawlQueue } from "./crawl-queue";
import { databaseReady, workerReady, writeWorkerHealth, type WorkerHealth } from "./runtime-health";

test("Runtime health checks real schema, tick progress and lease state", { skip: process.env.PR3_QUEUE_ACCEPTANCE !== "1" }, async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55471"); assert.equal(url.pathname, "/sitemap_radar_pr1");
  const schema = `pr6_health_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const pool = new Pool({ connectionString: url.toString(), max: 2, options: `-c search_path=${schema}` });
  const dir = await mkdtemp(join(tmpdir(), "radar-health-")), path = join(dir, "state.json");
  const state: WorkerHealth = { version: 1, pid: process.pid, workerId: "health-worker", runId: null, lastTickAt: Date.now(), stopping: false };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await assert.rejects(databaseReady(pool), /SCHEMA_NOT_READY/);
    for (const file of (await readdir("drizzle")).filter(f => f.endsWith(".sql")).sort()) await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    await databaseReady(pool); await writeWorkerHealth(path, state); await workerReady(pool, path);
    await writeWorkerHealth(path, { ...state, lastTickAt: Date.now()-60_000 }); await assert.rejects(workerReady(pool, path), /WORKER_TICK_STALE/);
    await writeWorkerHealth(path, { ...state, stopping: true }); await assert.rejects(workerReady(pool, path), /WORKER_NOT_READY/);
    await writeWorkerHealth(path, { ...state, pid: 0 }); await assert.rejects(workerReady(pool, path), /WORKER_NOT_READY/);
    await writeWorkerHealth(path, { ...state, runId: "nonexistent" }); await assert.rejects(workerReady(pool, path), /WORKER_RUN_NOT_FOUND/);
    const owner = randomUUID(), website = randomUUID(), target = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,\'health\',$2,clock_timestamp(),clock_timestamp())', [owner, `${owner}@example.invalid`]);
    await pool.query('INSERT INTO website(id,"userId",name,url,domain) VALUES($1,$2,\'health\',\'https://example.com\',\'example.com\')', [website, owner]);
    await pool.query(`INSERT INTO target(id,"websiteId",kind,enabled,sitemap_roots) VALUES($1,$2,'SITEMAP_LINKS',false,'["https://example.com/sitemap.xml"]')`, [target, website]);
    const queue = new CrawlQueue(pool); await queue.enqueueRun(target, "manual"); const run = await queue.claim(state.workerId); assert.ok(run);
    const busy = { ...state, runId: run.id, lastTickAt: Date.now()-120_000 };
    await writeWorkerHealth(path, busy); await workerReady(pool, path); // A long attempt is healthy only with a live DB lease/heartbeat.
    await pool.query("UPDATE crawl_run SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE id=$1", [run.id]);
    await assert.rejects(workerReady(pool, path), /WORKER_LEASE_NOT_READY/);
    await pool.query("UPDATE crawl_run SET heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.id]);
    await assert.rejects(workerReady(pool, path), /WORKER_LEASE_NOT_READY/);
    assert.equal((await pool.query("SELECT execution_status FROM crawl_run WHERE id=$1", [run.id])).rows[0].execution_status, "running", "Probe never mutates a Run");
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); await rm(dir, { recursive: true, force: true });
  }
});
