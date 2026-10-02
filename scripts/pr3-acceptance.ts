import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { getPool } from "../src/lib/db";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { executeClaim } from "../src/lib/crawl-worker";
import { crawlSitemaps } from "../src/lib/sitemap";
import type { SitemapFetcher } from "../src/lib/sitemap/http";

async function main() {
  const origin = new URL(process.env.PR3_ACCEPTANCE_ORIGIN ?? "http://localhost:31072");
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname)); assert.equal(database.pathname, "/sitemap_radar_pr1");
  const authFile = process.env.PR3_ACCEPTANCE_AUTH_FILE;
  assert.ok(authFile, "Explicit private QA credentials file required");
  const pool = getPool(), queue = new CrawlQueue(pool), checks: string[] = [];
  const fetcher: SitemapFetcher = async (url, budget) => {
    const body = Buffer.from(url.endsWith("/robots.txt") ? "User-agent: *\nSitemap: https://happy-horse.art/sitemap.xml\n" : "<urlset><url><loc>https://happy-horse.art/fixture-a</loc></url><url><loc>https://happy-horse.art/fixture-b</loc></url></urlset>");
    budget.wire(body.length); budget.inflated(body.length); return { status: 200, finalUrl: url, body, etag: '"pr3-fixture"' };
  };
  const execute = async (targetId: string) => {
    const run = await queue.claim("pr3-api-qa"); assert.equal(run?.target_id, targetId);
    await executeClaim(queue, run!, undefined, (options) => crawlSitemaps({ ...options, fetcher }));
  };
  async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
    return fetch(new URL(path, origin), { method, headers: { origin: origin.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  }
  async function actor(label: string) {
    const email = `pr3-${label}-${randomUUID()}@example.invalid`, password = randomUUID();
    const response = await request("/api/auth/sign-up/email", "POST", { name: `PR3 ${label}`, email, password }); assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie);
    return { email, password, cookie };
  }
  try {
    if (process.argv.includes("--finish-preview")) {
      const data = JSON.parse(await readFile(authFile, "utf8")); await execute(data.targetId);
      console.log(JSON.stringify({ check: "preview queued Run executed with native XML fixture", urls: 2 })); return;
    }
    const history = async () => {
      const { rows: [row] } = await pool.query(`SELECT jsonb_build_object('snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM snapshot s), 'alerts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM alert a))::text AS data`);
      return createHash("sha256").update(row.data).digest("hex");
    };
    const before = await history();
    const a = await actor("owner"), b = await actor("other");
    const created = await request("/api/websites", "POST", { domain: "happy-horse.art" }, a.cookie); assert.equal(created.status, 201);
    const { website } = await created.json();
    const { rows: [target] } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [website.id]);
    const path = `/api/targets/${target.id}/runs`;
    assert.equal((await request(path, "POST", {})).status, 401);
    assert.equal((await request(path, "GET", undefined, b.cookie)).status, 404);
    assert.equal((await request(path, "POST", {}, b.cookie)).status, 404);
    assert.equal((await request(path, "POST", { leaseToken: "untrusted" }, a.cookie)).status, 400);
    checks.push("anonymous and cross-owner access denied; client lease/config fields rejected");
    assert.equal((await request(`/api/targets/${target.id}`, "PATCH", { enabled: false }, a.cookie)).status, 200);
    const start = performance.now();
    const responses = await Promise.all(Array.from({ length: 10 }, () => request(path, "POST", {}, a.cookie)));
    assert.ok(responses.every((response) => response.status === 202));
    const entries = await Promise.all(responses.map((response) => response.json()));
    assert.equal(new Set(entries.map((entry) => entry.run.id)).size, 1); assert.equal(entries.filter((entry) => entry.created).length, 1);
    assert.ok(performance.now() - start < 5_000); assert.ok(entries.every((entry) => entry.run.attempt === 0 && entry.run.executionStatus === "queued"));
    checks.push("paused manual Run accepted; 10 concurrent HTTP submissions return 202, one durable Run, zero attempts");
    const compatibility = await request("/api/cron/run", "POST", { websiteId: website.id }, a.cookie); assert.equal(compatibility.status, 202);
    assert.equal((await compatibility.json()).run.id, entries[0].run.id);
    assert.equal((await request("/api/cron/run", "POST", { websiteId: website.id }, b.cookie)).status, 404);
    checks.push("legacy run submission delegates to the same owned queue without HTTP scraping");
    await execute(target.id);
    const listed = (await (await request(path, "GET", undefined, a.cookie)).json()).runs;
    assert.equal(listed[0].executionStatus, "succeeded"); assert.equal(listed[0].completeness, "complete"); assert.equal(listed[0].attempt, 1); assert.equal(listed[0].urlCount, 2);
    assert.equal(listed[0].leaseToken, undefined); assert.equal(listed[0].result, undefined);
    checks.push("native fixture execution persisted; history exposes summary without tokens or full inventory");
    await pool.query("UPDATE target SET archived_at=clock_timestamp() WHERE id=$1", [target.id]);
    assert.equal((await request(path, "POST", {}, a.cookie)).status, 409);
    await pool.query("UPDATE target SET archived_at=NULL WHERE id=$1", [target.id]);
    assert.equal(await history(), before); checks.push("archive denies submission; retained snapshot and alert contents unchanged");
    const detail = await request(`/dashboard/websites/${website.id}`, "GET", undefined, a.cookie); assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Run now/);
    await writeFile(authFile, JSON.stringify({ email: a.email, password: a.password, websiteId: website.id, targetId: target.id, origin: origin.origin }), { mode: 0o600 });
    console.log(JSON.stringify({ checks, websiteId: website.id, targetId: target.id, fixtureUrls: 2, historicalDigest: before }, null, 2));
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "QA failed"); process.exitCode = 1; });
