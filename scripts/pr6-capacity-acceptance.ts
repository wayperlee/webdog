import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Pool } from "pg";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { executeClaim } from "../src/lib/crawl-worker";
import { crawlSitemaps } from "../src/lib/sitemap";
import { monitorSummaries } from "../src/lib/monitor-summary";
import type { SitemapFetcher } from "../src/lib/sitemap/http";

// Synthetic XML transport only. Parser, budgets, queue, transactions and inventory are real.
const source = new URL(process.env.DATABASE_URL ?? "");
assert.equal(source.hostname, "127.0.0.1");
assert.equal(source.port, "55471");
assert.equal(source.pathname, "/sitemap_radar_pr1");
const name = `radar_capacity_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: source.toString(), max: 1 });
const testUrl = new URL(source); testUrl.pathname = `/${name}`;
const pool = new Pool({ connectionString: testUrl.toString(), max: 4, application_name: "radar-capacity" });
const queue = new CrawlQueue(pool);
const workerPools: Pool[] = [];
const timings: Record<string, unknown> = {};
const gateMs = 45_000;
let created = false, peakRss = process.memoryUsage().rss, peakConnections = 0;
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
const memory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
const owner = randomUUID(), root = "https://capacity.example/sitemap.xml";
async function measure<T>(label: string, fn: () => Promise<T>, maximumMs?: number) {
  const start = performance.now(); const value = await fn();
  const ms = Math.round(performance.now() - start); timings[label] = { ms };
  console.log(JSON.stringify({ phase: label, ms }));
  if (maximumMs) assert.ok(ms < maximumMs, `${label} exceeded local acceptance gate ${maximumMs}ms`);
  return value;
}
async function target() {
  const id = randomUUID(), websiteId = randomUUID();
  await pool.query('INSERT INTO website(id,"userId",name,url,domain) VALUES($1,$2,\'capacity\',\'https://capacity.example\',\'capacity.example\')', [websiteId, owner]);
  await pool.query(`INSERT INTO target(id,"websiteId",kind,enabled,"checkIntervalHours","nextCheckDueAt",sitemap_roots)
    VALUES($1,$2,'SITEMAP_LINKS',false,6,clock_timestamp()+interval '6 hours',$3::jsonb)`, [id, websiteId, JSON.stringify([root])]);
  return { id, websiteId };
}
function fixture(pages: string[], files = 4, overflow = false): SitemapFetcher {
  const count = Math.ceil(pages.length / files);
  const bodies = Array.from({ length: files }, (_, i) => Buffer.from(`<urlset>${pages.slice(i * count, (i + 1) * count).map(url => `<url><loc>${url}</loc></url>`).join("")}</urlset>`));
  const index = Buffer.from(`<sitemapindex>${bodies.map((_, i) => `<sitemap><loc>https://capacity.example/part-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`);
  return async (url, budget, options) => {
    budget.check();
    if (!overflow && options?.cache?.etag === '"capacity"') return { status: 304, finalUrl: url, body: Buffer.alloc(0), etag: '"capacity"' };
    const match = /part-(\d+)\.xml$/.exec(url);
    const body = match ? bodies[Number(match[1])] : index;
    assert.ok(body); budget.wire(body.length); budget.inflated(body.length);
    return { status: 200, finalUrl: url, body, etag: '"capacity"' };
  };
}
async function scan(id: string, pages: string[], cached = false) {
  await queue.enqueueRun(id, "manual", owner);
  const run = await queue.claim("capacity-large"); assert.equal(run?.target_id, id);
  const fetcher = fixture(pages);
  await executeClaim(queue, run!, undefined, options => crawlSitemaps({ ...options, state: cached ? options.state : undefined, fetcher }));
  const saved = (await pool.query("SELECT * FROM crawl_run WHERE id=$1", [run!.id])).rows[0];
  assert.equal(saved.execution_status, "succeeded"); assert.equal(saved.completeness, "complete");
  return saved;
}
async function page(websiteId: string, offset: number, q = "") {
  // Same snapshot, pagination, count, contains search and ordering as inventoryPage.
  return (await pool.query(`SELECT (SELECT count(*)::int FROM site_url WHERE website_id=$1 AND scope_version=1 AND strpos(lower(url),lower($2))>0) AS total,
    COALESCE((SELECT jsonb_agg(p) FROM (SELECT url,status FROM site_url WHERE website_id=$1 AND scope_version=1 AND strpos(lower(url),lower($2))>0
      ORDER BY normalized_url_hash LIMIT 200 OFFSET $3) p),'[]'::jsonb) AS items`, [websiteId, q, offset])).rows[0];
}
async function main() {
  try {
    assert.equal((await admin.query("SELECT current_database() AS db")).rows[0].db, "sitemap_radar_pr1");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    for (const file of (await readdir("drizzle")).filter(f => f.endsWith(".sql")).sort()) await pool.query(await readFile(`drizzle/${file}`, "utf8"));
    await pool.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,\'capacity\',$2,clock_timestamp(),clock_timestamp())', [owner, `${owner}@example.invalid`]);
    const large = await target();
    const urls = Array.from({ length: 200_000 }, (_, i) => `https://capacity.example/page/${i}`);
    const base = await measure("single_200k_baseline", () => scan(large.id, urls), gateMs);
    assert.equal(base.adoption_status, "baseline");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM site_url WHERE website_id=$1", [large.websiteId])).rows[0].n, 200_000);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM url_event")).rows[0].n, 0);
    const cached = await measure("single_200k_persistent_304", () => scan(large.id, urls, true), gateMs);
    assert.equal(cached.result.sources.length, 5); assert.ok(cached.result.sources.every((s: {status:string}) => s.status === "not_modified"));
    const changed = [...urls.slice(500), ...Array.from({ length: 500 }, (_, i) => `https://capacity.example/new/${i}`)];
    await measure("single_200k_delta_500", () => scan(large.id, changed), gateMs);
    const [summary] = await monitorSummaries(pool, [large.id]);
    assert.equal(summary.currentCount, 200_500); assert.equal(summary.pendingCount, 500); assert.equal(summary.added24h, 500);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM url_event WHERE website_id=$1 AND kind='added'", [large.websiteId])).rows[0].n, 500);
    const overflow = await measure("single_200001_rejected", () => crawlSitemaps({ siteUrl: "https://capacity.example", roots: [root], fetcher: fixture([...urls, "https://capacity.example/overflow"], 5, true) }));
    assert.notEqual(overflow.completeness, "complete"); assert.equal(overflow.urls, null);
    assert.ok(overflow.issues.some(i => i.code === "RESOURCE_LIMIT"));
    await pool.query("ANALYZE site_url");
    const latency: number[] = [];
    for (let batch = 0; batch < 5; batch++) await Promise.all(Array.from({ length: 4 }, async (_, i) => {
      const start = performance.now(), result = await page(large.websiteId, i % 2 ? 199_800 : 0);
      assert.equal(result.total, 200_500); assert.equal(result.items.length, 200); latency.push(performance.now() - start);
    }));
    const search = await measure("contains_search_200k", () => page(large.websiteId, 0, "/new/"), 2_000);
    assert.equal(search.total, 500);
    latency.sort((a,b) => a-b);
    timings.inventoryQuery = { samples: latency.length, concurrency: 4, p50Ms: Math.round(latency[9]), p95Ms: Math.round(latency[18]), deepestOffset: 199_800 };
    assert.ok(latency[18] < 2_000);
    const sites: Awaited<ReturnType<typeof target>>[] = [];
    for (let i = 0; i < 100; i++) sites.push(await target());
    await measure("100_targets_enqueue", async () => {
      for (let i = 0; i < sites.length; i += 10) await Promise.all(sites.slice(i,i+10).map(t => queue.enqueueRun(t.id, "manual", owner)));
    });
    const small = urls.slice(0, 2000), smallFetcher = fixture(small, 1);
    let processed = 0;
    await measure("100_targets_4_worker_queues", async () => {
      await Promise.all(Array.from({ length: 4 }, async (_, i) => {
        const p = new Pool({ connectionString: testUrl.toString(), max: 2, application_name: `radar-capacity-worker-${i}` });
        workerPools.push(p); const q = new CrawlQueue(p);
        while (true) {
          const run = await q.claim(`capacity-${i}`); if (!run) break;
          assert.equal(await executeClaim(q, run, undefined, options => crawlSitemaps({ ...options, fetcher: smallFetcher })), "finished"); processed++;
          const stats = await p.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()");
          peakConnections = Math.max(peakConnections, stats.rows[0].n);
        }
      }));
    }, 60_000);
    assert.equal(processed, 100); assert.ok(peakConnections <= 12);
    // Exercise fresh target statistics too; production must not depend on a manual ANALYZE.
    const sums = await measure("100_site_summary", () => monitorSummaries(pool, sites.map(t => t.id)));
    if ((timings["100_site_summary"] as {ms:number}).ms >= 3000) {
      const diagnostic = { query: async (text: string, values: unknown[]) => {
        const plan = await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + text, values);
        await writeFile("docs/evidence/pr6b/summary-plan.json", JSON.stringify(plan.rows, null, 2) + "\n");
        return pool.query(text, values);
      } } as unknown as Pool;
      await monitorSummaries(diagnostic, sites.map(t => t.id));
      assert.fail("100_site_summary exceeded local acceptance gate 3000ms");
    }
    assert.equal(sums.length, 100); assert.ok(sums.every(s => s.currentCount === 2000 && s.added24h === 0));
    await pool.query("ANALYZE target"); await pool.query("ANALYZE site_url");
    const warm = await measure("100_site_summary_analyzed", () => monitorSummaries(pool, sites.map(t => t.id)), 3000);
    assert.deepEqual(warm.slice().sort((a,b) => a.id.localeCompare(b.id)), sums.slice().sort((a,b) => a.id.localeCompare(b.id)));
    const status = await pool.query("SELECT execution_status,count(*)::int AS n FROM crawl_run GROUP BY execution_status");
    assert.equal(status.rows.length, 1); assert.equal(status.rows[0].execution_status, "succeeded"); assert.equal(status.rows[0].n, 103);
    timings.databaseBytes = Number((await pool.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
    const report = { observedAt: new Date().toISOString(), fixtureTransport: true, realPublicNetwork: false, realPostgresAndApplicationPipeline: true,
      singleSiteUrls: 200_000, sites: 100, urlsPerSmallSite: 2000, workerQueues: 4, processed, peakDatabaseConnections: peakConnections,
      peakHarnessRssBytes: peakRss, eventLoopP99Ms: Math.round(loop.percentile(99)/1e6), timings,
      gates: { attemptMs: gateMs, inventoryQueryP95Ms: 2000, siteSummaryMs: 3000 }, databaseCleanup: "completed", productionTouched: false };
    await Promise.all(workerPools.map(p => p.end())); workerPools.length = 0;
    await pool.end(); await admin.query(`DROP DATABASE "${name}"`); created = false;
    const output = process.env.PR6_CAPACITY_OUTPUT; assert.ok(output, "PR6_CAPACITY_OUTPUT required");
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ phase: "passed", peakHarnessRssBytes: peakRss, peakDatabaseConnections: peakConnections }));
  } finally {
    clearInterval(memory); loop.disable();
    await Promise.all(workerPools.map(p => p.end()));
    if (created) { await pool.end(); await admin.query(`DROP DATABASE "${name}"`); }
    await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Capacity acceptance failed"); process.exitCode = 1; });
