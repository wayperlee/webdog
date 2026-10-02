import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { CrawlQueue, QueueError, retryDelay, type RunRow } from "./crawl-queue";
import { crawlSitemaps } from "./sitemap";
import { executeClaim } from "./crawl-worker";
import type { SitemapFetcher } from "./sitemap/http";

test("Retry policy uses the same Run, three frozen backoffs and Retry-After", () => {
  const error = { code: "HTTP_503", message: "unavailable", retryable: true };
  assert.deepEqual([1, 2, 3, 4].map((attempt) => retryDelay(attempt, error)), [300_000, 900_000, 3_600_000, null]);
  assert.equal(retryDelay(1, { ...error, retryAfterMs: 900_000 }), 900_000);
  assert.equal(retryDelay(1, { ...error, retryable: false }), null);
});

test("PostgreSQL durable queue integration", { skip: process.env.PR3_QUEUE_ACCEPTANCE !== "1" }, async (suite) => {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
  assert.equal(database.pathname, "/sitemap_radar_pr1", "Dedicated local QA database required");
  const schema = `pr3_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: database.toString(), max: 2 });
  const pool = new Pool({ connectionString: database.toString(), max: 10, options: `-c search_path=${schema}` });
  const queue = new CrawlQueue(pool);
  const root = "https://example.com/sitemap.xml", page = "https://example.com/page";
  const fetcher: SitemapFetcher = async (url, budget) => {
    budget.check();
    const body = Buffer.from(`<urlset><url><loc>${page}</loc></url></urlset>`);
    budget.wire(body.length); budget.inflated(body.length);
    return { status: 200, finalUrl: url, body, etag: '"test"' };
  };
  const result = () => crawlSitemaps({ siteUrl: "https://example.com", roots: [root], fetcher });
  let owner: string;
  async function target(enabled = true) {
    const id = randomUUID(), websiteId = randomUUID();
    await pool.query('INSERT INTO website(id,"userId",name,url,domain) VALUES($1,$2,\'fixture\',\'https://example.com\',\'example.com\')', [websiteId, owner]);
    await pool.query(`INSERT INTO target(id,"websiteId",kind,enabled,"checkIntervalHours","nextCheckDueAt",sitemap_roots) VALUES($1,$2,'SITEMAP_LINKS',$3,6,clock_timestamp()+interval '6 hours',$4::jsonb)`, [id, websiteId, enabled, JSON.stringify([root])]);
    return id;
  }
  const row = async (id: string) => (await pool.query<RunRow>("SELECT * FROM crawl_run WHERE id=$1", [id])).rows[0];
  const claim = async (id: string) => { const run = await queue.claim("test-worker"); assert.equal(run?.target_id, id); return run!; };
  const expire = async (id: string) => pool.query("UPDATE crawl_run SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  const ready = async (id: string) => pool.query("UPDATE crawl_run SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  const lost = (error: unknown) => error instanceof QueueError && error.code === "LEASE_LOST";
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir("drizzle")).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations) {
      // Drizzle's generated public FK qualification is relocated only for this isolated test schema.
      const sql = (await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`);
      await pool.query(sql);
    }
    owner = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,\'fixture\',$2,clock_timestamp(),clock_timestamp())', [owner, `${owner}@example.invalid`]);

    await suite.test("Concurrent enqueue has one Run; database unique index rejects direct duplicates; claim is exclusive", async () => {
      const id = await target();
      const entries = await Promise.all(Array.from({ length: 15 }, () => queue.enqueueRun(id, "manual")));
      assert.equal(entries.filter((entry) => entry!.created).length, 1); assert.equal(new Set(entries.map((entry) => entry!.run.id)).size, 1);
      await assert.rejects(pool.query("INSERT INTO crawl_run(id,target_id,trigger,scope_version,config) VALUES($1,$2,'manual',1,'{}')", [randomUUID(), id]), (error: unknown) => (error as { code: string }).code === "23505");
      const claims = (await Promise.all(Array.from({ length: 10 }, (_, i) => queue.claim(`worker-${i}`)))).filter(Boolean);
      assert.equal(claims.length, 1); assert.equal(claims[0]!.attempt, 1);
      await queue.finish(claims[0]!, await result());
      assert.equal((await row(claims[0]!.id)).execution_status, "succeeded");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_source WHERE run_id=$1", [claims[0]!.id])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT baseline_run_id FROM target WHERE id=$1", [id])).rows[0].baseline_run_id, claims[0]!.id);
    });
    await suite.test("Retry stays queued, availableAt gates claim, attempt increments only on claim, old tokens cannot write", async () => {
      const id = await target(); const initialDue = (await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [id])).rows[0].nextCheckDueAt;
      await queue.enqueueRun(id, "manual"); let run = await claim(id); const old = run;
      for (let attempt = 1; attempt <= 4; attempt++) {
        await queue.fail(run, { code: "HTTP_503", message: "temporary", retryable: true, retryAfterMs: attempt === 1 ? 600_000 : undefined });
        const saved = await row(run.id); assert.equal(saved.attempt, attempt);
        assert.equal(saved.execution_status, attempt === 4 ? "failed" : "queued");
        if (attempt < 4) {
          assert.ok(saved.available_at.getTime() - Date.now() > (attempt === 1 ? 590_000 : attempt === 2 ? 890_000 : 3_590_000));
          assert.equal(await queue.claim("too-early"), null); await ready(run.id); run = await claim(id);
          assert.equal(run.attempt, attempt + 1); assert.equal(run.id, old.id); assert.notEqual(run.lease_token, old.lease_token);
          await assert.rejects(queue.heartbeat(old), lost); await assert.rejects(queue.fail(old, { code: "late", message: "late", retryable: true }), lost);
          await assert.rejects(queue.finish(old, await result()), lost);
        }
      }
      assert.equal((await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [id])).rows[0].nextCheckDueAt.getTime(), initialDue.getTime());
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_attempt WHERE run_id=$1", [run.id])).rows[0].n, 4);
    });
    await suite.test("Permanent resource errors do not retry", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await queue.fail(run, { code: "RESOURCE_LIMIT", message: "too large", retryable: false }); assert.equal((await row(run.id)).execution_status, "failed");
    });
    await suite.test("Expired leases recover once, preserve identity and invalidate old execution", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const old = await claim(id); await expire(old.id);
      await assert.rejects(queue.heartbeat(old), lost); await assert.rejects(queue.finish(old, await result()), lost);
      assert.equal(await queue.recoverExpired(), 1); assert.equal(await queue.recoverExpired(), 0);
      assert.equal((await row(old.id)).attempt, 1); await ready(old.id); const next = await claim(id);
      assert.equal(next.id, old.id); assert.equal(next.attempt, 2); assert.notEqual(next.lease_token, old.lease_token);
      await assert.rejects(queue.fail(old, { code: "late", message: "late", retryable: true }), lost);
      await queue.finish(next, await result());
      assert.equal((await pool.query("SELECT status FROM crawl_run_attempt WHERE run_id=$1 AND attempt=1", [old.id])).rows[0].status, "lost");
    });
    await suite.test("Heartbeat lock wait uses fresh DB time, never transaction-start time", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await pool.query("UPDATE crawl_run SET lease_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [run.id]);
      const blocker = await pool.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM crawl_run WHERE id=$1 FOR UPDATE", [run.id]);
      const waiting = queue.heartbeat(run).then(() => null, (error) => error);
      await new Promise((resolve) => setTimeout(resolve, 500)); await blocker.query("COMMIT"); blocker.release();
      assert.ok(lost(await waiting)); await queue.recoverExpired();
    });
    await suite.test("Final commit after lock wait rejects expired lease and rolls back all cache/result writes", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await pool.query("UPDATE crawl_run SET lease_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [run.id]);
      const blocker = await pool.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM target WHERE id=$1 FOR UPDATE", [id]);
      const waiting = queue.finish(run, await result()).then(() => null, (error) => error);
      await new Promise((resolve) => setTimeout(resolve, 500)); await blocker.query("COMMIT"); blocker.release();
      assert.ok(lost(await waiting)); assert.equal((await row(run.id)).result, null);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sitemap_source_cache WHERE target_id=$1", [id])).rows[0].n, 0);
      await queue.recoverExpired();
    });
    await suite.test("Lease extension is capped at the attempt wall-time deadline", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await pool.query("UPDATE crawl_run SET attempt_started_at=clock_timestamp()-interval '590 seconds' WHERE id=$1", [run.id]); await queue.heartbeat(run);
      const timing = (await pool.query("SELECT extract(epoch FROM lease_expires_at-attempt_started_at) AS seconds FROM crawl_run WHERE id=$1", [run.id])).rows[0];
      assert.ok(Number(timing.seconds) <= 600); await queue.finish(run, await result());
    });
    await suite.test("Scope, archive and baseline changes discard stale work without cache adoption", async () => {
      for (const mode of ["scope", "archive", "baseline"]) {
        const id = await target();
        let baseline: string | undefined;
        if (mode === "baseline") { await queue.enqueueRun(id, "manual"); const first = await claim(id); await queue.finish(first, await result()); baseline = first.id; }
        await queue.enqueueRun(id, "manual"); const run = await claim(id);
        if (mode === "scope") await pool.query("UPDATE target SET scope_version=scope_version+1 WHERE id=$1", [id]);
        if (mode === "archive") await pool.query("UPDATE target SET archived_at=clock_timestamp() WHERE id=$1", [id]);
        if (mode === "baseline") { assert.ok(baseline); await pool.query("UPDATE target SET baseline_run_id=NULL WHERE id=$1", [id]); }
        await queue.finish(run, await result()); assert.equal((await row(run.id)).execution_status, "cancelled"); assert.equal((await row(run.id)).adoption_status, "stale");
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_source WHERE run_id=$1", [run.id])).rows[0].n, 0);
      }
    });
    await suite.test("Recovery records attempt wall-time timeout as failed and requeues the same Run", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await pool.query("UPDATE crawl_run SET attempt_started_at=clock_timestamp()-interval '601 seconds',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.id]);
      await queue.recoverExpired(); assert.equal((await row(run.id)).execution_status, "queued"); assert.equal((await row(run.id)).attempt, 1);
      const { rows: [attempt] } = await pool.query("SELECT status,error FROM crawl_run_attempt WHERE run_id=$1 AND attempt=1", [run.id]);
      assert.equal(attempt.status, "failed"); assert.equal(attempt.error.code, "ATTEMPT_TIMEOUT");
    });
    await suite.test("Paused allows manual, archived denies it and queued archive cannot be claimed", async () => {
      const id = await target(false); assert.equal(await queue.enqueueRun(id, "scheduled"), null);
      await queue.enqueueRun(id, "manual"); const run = await claim(id); await queue.finish(run, await result());
      await queue.enqueueRun(id, "manual"); await pool.query("UPDATE target SET archived_at=clock_timestamp() WHERE id=$1", [id]);
      await assert.rejects(queue.enqueueRun(id, "manual"), (error: unknown) => error instanceof QueueError && error.code === "TARGET_ARCHIVED");
      assert.equal(await queue.claim("archive"), null);
    });
    await suite.test("Fixed cadence catches up missed slots; a busy manual slot advances cadence without another Run", async () => {
      const id = await target(); await pool.query('UPDATE target SET "nextCheckDueAt"=clock_timestamp()-interval \'13 hours\' WHERE id=$1', [id]);
      const before = (await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [id])).rows[0].nextCheckDueAt;
      await queue.enqueueRun(id, "manual"); const entry = await queue.enqueueRun(id, "scheduled"); assert.equal(entry!.created, false);
      const after = (await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [id])).rows[0].nextCheckDueAt;
      assert.equal(after.getTime() - before.getTime(), 18 * 3_600_000); assert.ok(after.getTime() > Date.now());
      const run = await claim(id); await queue.finish(run, await result());
      assert.equal((await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [id])).rows[0].nextCheckDueAt.getTime(), after.getTime());
    });
    await suite.test("Constraint failure rolls back revisions, cache, attempt closure and Run update together", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id), bad = await result();
      bad.sources[0].revisionId = "missing";
      await assert.rejects(queue.finish(run, bad)); assert.equal((await row(run.id)).execution_status, "running");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sitemap_source_cache WHERE target_id=$1", [id])).rows[0].n, 0);
      await queue.finish(run, await result());
    });
    await suite.test("Checkpoint survives a new queue instance and parent 304 still checks child", async () => {
      const id = await target(); const child = "https://example.com/child.xml";
      const first = await crawlSitemaps({ siteUrl: "https://example.com", roots: [root], fetcher: async (url, budget, options) => url === root ? {
        status: 200, body: Buffer.from(`<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`), finalUrl: url, etag: '"index"',
      } : fetcher(url, budget, options) });
      await queue.enqueueRun(id, "manual"); const one = await claim(id); await queue.finish(one, first);
      await queue.enqueueRun(id, "manual"); const two = await claim(id); const restarted = new CrawlQueue(pool);
      const calls: string[] = [];
      const next = await crawlSitemaps({ ...two.config, state: await restarted.loadState(two), fetcher: async (url, budget, options) => {
        calls.push(url); return url === root ? { status: 304, body: Buffer.alloc(0), finalUrl: url } : fetcher(url, budget, options);
      } });
      assert.deepEqual(calls, [root, child]); assert.deepEqual(next.urls, first.urls); await restarted.finish(two, next);
    });
    await suite.test("Graceful shutdown requeues the same attempt without marking a scan complete", async () => {
      const id = await target(); await queue.enqueueRun(id, "manual"); const run = await claim(id); const stopped = new AbortController(); stopped.abort();
      await executeClaim(queue, run, stopped.signal, async () => result()); assert.equal((await row(run.id)).execution_status, "queued"); assert.equal((await row(run.id)).attempt, 1);
    });
    await suite.test("Complete retirement removes only current cache refs; partial keeps the previous complete graph", async () => {
      const id = await target(), child = "https://example.com/retiring.xml";
      const scan = async (phase: number) => crawlSitemaps({ siteUrl: "https://example.com", roots: [root], fetcher: async (url, budget, options) => {
        if (phase === 2) throw new Error("fixture failure");
        if (url === root) return { status: 200, finalUrl: url, body: Buffer.from(phase === 3 ? "<urlset/>" : `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`) };
        return fetcher(url, budget, options);
      } });
      await queue.enqueueRun(id, "manual"); const one = await claim(id); await queue.finish(one, await scan(1));
      const previous = (await pool.query("SELECT live_sources FROM target WHERE id=$1", [id])).rows[0].live_sources;
      await queue.enqueueRun(id, "manual"); const two = await claim(id); await queue.finish(two, await scan(2));
      assert.deepEqual((await pool.query("SELECT live_sources FROM target WHERE id=$1", [id])).rows[0].live_sources, previous);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sitemap_source_cache WHERE target_id=$1", [id])).rows[0].n, 2);
      await queue.enqueueRun(id, "manual"); const three = await claim(id); await queue.finish(three, await scan(3));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sitemap_source_cache WHERE target_id=$1", [id])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_source WHERE run_id=$1", [one.id])).rows[0].n, 2);
    });
    await suite.test("Failed discovery checkpoint does not persist empty explicit roots on the next Run", async () => {
      const id = await target(); await pool.query("UPDATE target SET sitemap_roots=NULL WHERE id=$1", [id]);
      await queue.enqueueRun(id, "manual"); const one = await claim(id);
      const bad = await crawlSitemaps({ ...one.config, fetcher: async () => { throw new Error("fixture unavailable"); } });
      await queue.finish(one, bad);
      await queue.enqueueRun(id, "manual"); const two = await claim(id);
      assert.equal(two.config.roots, undefined); const state = await queue.loadState(two); assert.deepEqual(state?.roots, []);
      await queue.fail(two, { code: "FIXTURE_END", message: "fixture ended", retryable: false });
    });
    await suite.test("SIGKILL after actual worker claim leaves durable identity for lease recovery", async () => {
      const id = await target(false); await pool.query("UPDATE target SET sitemap_roots='[\"https://8.8.8.8/stalled.xml\"]' WHERE id=$1", [id]);
      const entry = await queue.enqueueRun(id, "manual");
      const childUrl = new URL(database); childUrl.searchParams.set("options", `-c search_path=${schema}`);
      const process = spawn(globalThis.process.execPath, ["--import", "tsx", "scripts/worker.ts", "--once"], { env: { ...globalThis.process.env, DATABASE_URL: childUrl.toString() }, stdio: "ignore" });
      try {
        let running = false;
        for (let i = 0; i < 60; i++) { if ((await row(entry!.run.id)).execution_status === "running") { running = true; break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
        assert.ok(running, "Child process must claim before kill"); const exited = once(process, "exit"); process.kill("SIGKILL"); await exited;
        assert.equal((await row(entry!.run.id)).execution_status, "running"); await expire(entry!.run.id);
        assert.equal(await new CrawlQueue(pool).recoverExpired(), 1); assert.equal((await row(entry!.run.id)).attempt, 1);
      } finally { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }
    });
    await suite.test("Default native worker rejects an unsafe root and records a permanent failure", async () => {
      const id = await target(); await pool.query("UPDATE target SET sitemap_roots='[\"http://127.0.0.1/private.xml\"]' WHERE id=$1", [id]);
      await queue.enqueueRun(id, "manual"); const run = await claim(id);
      await executeClaim(queue, run);
      assert.equal((await row(run.id)).execution_status, "failed");
      const { rows: [saved] } = await pool.query("SELECT error FROM crawl_run WHERE id=$1", [run.id]);
      assert.equal(saved.error.code, "UNSAFE_ADDRESS"); assert.equal(saved.error.retryable, false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_source WHERE run_id=$1", [run.id])).rows[0].n, 0);
    });
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
});
