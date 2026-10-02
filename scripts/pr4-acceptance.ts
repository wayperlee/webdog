import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getPool } from "../src/lib/db";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { crawlSitemaps } from "../src/lib/sitemap";

async function main() {
  const origin = new URL(process.env.PR4_ACCEPTANCE_ORIGIN ?? "http://localhost:31072");
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname));
  assert.equal(database.hostname, "127.0.0.1"); assert.equal(database.port, "55471"); assert.equal(database.pathname, "/sitemap_radar_pr1");
  const pool = getPool(), queue = new CrawlQueue(pool), checks: string[] = [];
  async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
    return fetch(new URL(path, origin), { method, headers: { origin: origin.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  }
  async function actor(label: string) {
    const response = await request("/api/auth/sign-up/email", "POST", { name: `PR4 ${label}`, email: `pr4-${label}-${randomUUID()}@example.invalid`, password: randomUUID() });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie); return cookie;
  }
  const history = async () => {
    const { rows: [row] } = await pool.query(`SELECT jsonb_build_object('snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM snapshot s), 'alerts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM alert a))::text AS data`);
    return createHash("sha256").update(row.data).digest("hex");
  };
  try {
    const before = await history(), owner = await actor("owner"), other = await actor("other");
    const created = await request("/api/websites", "POST", { domain: "happy-horse.art" }, owner); assert.equal(created.status, 201);
    const { website } = await created.json();
    const { rows: [target] } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [website.id]);
    const base = `/api/targets/${target.id}`;
    assert.equal((await request(base, "PATCH", { enabled: false }, owner)).status, 200);
    async function page(path: string) { const res = await request(base + path, "GET", undefined, owner); assert.equal(res.status, 200); return res.json(); }
    async function scan(count: number) {
      assert.equal((await request(base + "/runs", "POST", {}, owner)).status, 202);
      const run = (await queue.claim("pr4-api-fixture"))!; assert.equal(run.target_id, target.id);
      const result = await crawlSitemaps({ ...run.config, fetcher: async (url, budget) => {
        const body = Buffer.from(url.endsWith("/robots.txt") ? "Sitemap: https://happy-horse.art/sitemap.xml\n" : `<urlset>${Array.from({ length: count }, (_, i) => `<url><loc>https://happy-horse.art/fixture-${i}</loc></url>`).join("")}</urlset>`);
        budget.wire(body.length); budget.inflated(body.length); return { status: 200, finalUrl: url, body };
      } });
      await queue.finish(run, result); return run.id;
    }
    for (const collection of ["urls", "events", "candidates"]) {
      assert.equal((await request(base + "/" + collection)).status, 401);
      assert.equal((await request(base + "/" + collection, "GET", undefined, other)).status, 404);
      assert.equal((await request(base + "/" + collection + "?limit=201", "GET", undefined, owner)).status, 400);
    }
    checks.push("new read endpoints deny anonymous/cross-owner access and bound page size");
    await scan(2); assert.equal((await page("/events")).total, 0); await scan(502);
    const ids = new Set<string>(); let offset: number | null = 0;
    do { const p = await page(`/events?limit=200&offset=${offset}`); assert.equal(p.total, 500); for (const item of p.items) ids.add(item.id); offset = p.nextOffset; } while (offset !== null);
    assert.equal(ids.size, 500); checks.push("first baseline has zero events; all 500 Added events survive HTTP pagination");
    await scan(0); const candidate = (await page("/candidates")).items[0]; assert.equal(candidate.status, "pending"); assert.equal(candidate.original_missing_count, 502);
    assert.equal((await page("/urls?status=active")).total, 502);
    assert.equal((await request(`${base}/candidates/${candidate.id}/urls`, "GET", undefined, other)).status, 404);
    assert.equal((await page(`/candidates/${candidate.id}/urls?limit=200&offset=400`)).items.length, 102);
    const approve = `${base}/candidates/${candidate.id}/approve`;
    assert.equal((await request(approve, "POST", {}, other)).status, 404);
    assert.equal((await request(approve, "POST", { leaseToken: "untrusted" }, owner)).status, 400);
    const accepted = await request(approve, "POST", {}, owner); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).status, "adopted");
    assert.equal((await page("/urls?status=pending_removed")).total, 502); assert.equal((await page("/events")).total, 500);
    assert.equal((await (await request(approve, "POST", {}, owner)).json()).changed, false);
    checks.push("quarantine leaves active inventory untouched; Candidate detail is complete; owner Approve adopts first evidence only and is idempotent");
    await scan(2); assert.equal((await page("/urls?status=pending_removed")).total, 500);
    await pool.query("UPDATE site_url SET first_missing_observed_at=clock_timestamp()-interval '61 minutes' WHERE website_id=$1 AND status='pending_removed'", [website.id]);
    await scan(2); const done = (await page("/candidates")).items[0];
    assert.equal(done.status, "confirmed"); assert.equal(done.pending_count, 0); assert.equal(done.recovered_count, 2); assert.equal(done.removed_count, 500);
    assert.equal((await page("/events")).total, 1000); assert.equal((await page("/urls?status=removed")).total, 500);
    checks.push("mixed recovery resolves at URL level: 2 recovered + 500 removed, terminal Candidate confirmed");
    await scan(0); const stale = (await page("/candidates")).items[0];
    await pool.query("UPDATE removal_candidate SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [stale.id]);
    const denied = await request(`${base}/candidates/${stale.id}/approve`, "POST", {}, owner); assert.equal(denied.status, 409); assert.equal((await denied.json()).error, "CANDIDATE_STALE");
    assert.equal(await history(), before); checks.push("expired Candidate returns 409; upstream snapshot/alert content unchanged");
    console.log(JSON.stringify({ checks, websiteId: website.id, targetId: target.id, fixture: true, historicalDigest: before }, null, 2));
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "PR4 API acceptance failed"); process.exitCode = 1; });
