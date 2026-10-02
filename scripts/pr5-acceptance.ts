import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { getPool } from "../src/lib/db";
import { crawlSitemaps } from "../src/lib/sitemap";

async function main() {
  const origin = new URL("http://localhost:31072");
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.port, "55471");
  assert.equal(database.pathname, "/sitemap_radar_pr1");
  const pool = getPool(),
    queue = new CrawlQueue(pool),
    checks: string[] = [];
  const authPath = process.env.PR5_ACCEPTANCE_AUTH_FILE;
  assert.ok(authPath && authPath.startsWith("/"));
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
  ) {
    return fetch(new URL(path, origin), {
      method,
      headers: {
        origin: origin.origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function actor(name: string) {
    const email = `pr5-${name}-${randomUUID()}@example.invalid`,
      password = randomUUID();
    const res = await req("/api/auth/sign-up/email", "POST", {
      name: `PR5 ${name}`,
      email,
      password,
    });
    assert.equal(res.status, 200);
    return {
      email,
      password,
      cookie: res.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    };
  }
  try {
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM crawl_run WHERE execution_status IN ('queued','running')",
        )
      ).rows[0].n,
      0,
      "Stop this project's Worker before fixture acceptance",
    );
    const owner = await actor("owner"),
      other = await actor("other");
    const res = await req(
      "/api/websites",
      "POST",
      { domain: "example.com" },
      owner.cookie,
    );
    assert.equal(res.status, 201);
    const { website } = await res.json();
    const t = (
      await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [
        website.id,
      ])
    ).rows[0];
    const base = `/api/targets/${t.id}`;
    const patch = async (body: unknown) => {
      const r = await req(base, "PATCH", body, owner.cookie);
      assert.equal(r.status, 200);
      return r.json();
    };
    const page = async (suffix: string) => {
      const r = await req(base + suffix, "GET", undefined, owner.cookie);
      assert.equal(r.status, 200);
      return r.json();
    };
    await patch({ enabled: false });
    async function scan(urls: string[]) {
      assert.equal(
        (await req(base + "/runs", "POST", {}, owner.cookie)).status,
        202,
      );
      const run = (await queue.claim("pr5-ui-fixture"))!;
      assert.equal(run.target_id, t.id);
      const result = await crawlSitemaps({
        ...run.config,
        roots: ["https://example.com/sitemap.xml"],
        fetcher: async (url, budget) => {
          const body = Buffer.from(
            `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`,
          );
          budget.wire(body.length);
          budget.inflated(body.length);
          return { status: 200, finalUrl: url, body };
        },
      });
      await queue.finish(run, result);
    }
    const initial = [
      "https://example.com/blog/p0",
      "https://example.com/docs/a",
    ];
    const pages = [
      ...Array.from(
        { length: 120 },
        (_, i) => `https://example.com/blog/p${i}`,
      ),
      "https://example.com/docs/a",
      "https://example.com/docs/b",
      "https://example.com/blog/tag/a",
    ];
    await scan(initial);
    assert.equal((await page("/events")).total, 0);
    await scan(pages);
    assert.equal((await page("/events")).total, 121);
    assert.equal((await page("/urls")).total, 123);
    for (const suffix of ["", "/urls", "/events", "/candidates", "/runs"]) {
      assert.equal((await req(base + suffix)).status, 401);
      assert.equal(
        (await req(base + suffix, "GET", undefined, other.cookie)).status,
        404,
      );
    }
    for (const suffix of ["", "/scope"])
      assert.equal(
        (
          await req(
            base + suffix,
            "PATCH",
            suffix
              ? { roots: null, allowedPageHosts: null }
              : { enabled: true },
            other.cookie,
          )
        ).status,
        404,
      );
    assert.equal(
      (await req(base, "PATCH", { leaseToken: "unexpected" }, owner.cookie))
        .status,
      400,
    );
    assert.equal(
      (await req(base, "PATCH", { includePaths: ["blog"] }, owner.cookie))
        .status,
      400,
    );
    assert.equal(
      (
        await req(
          base + "/scope",
          "PATCH",
          { roots: ["http://127.0.0.1/"], allowedPageHosts: null },
          owner.cookie,
        )
      ).status,
      400,
    );
    checks.push(
      "Read/write ownership, strict payloads, unsafe scope and invalid path rules verified through HTTP",
    );
    const digest = async () =>
      (
        await pool.query(
          "SELECT jsonb_agg(to_jsonb(u) ORDER BY normalized_url_hash)::text AS facts FROM site_url u WHERE website_id=$1",
          [website.id],
        )
      ).rows[0].facts;
    const before = await digest();
    await patch({ includePaths: ["/blog/"], excludePaths: ["/blog/tag/"] });
    assert.equal((await page("/urls")).total, 120);
    assert.equal((await page("/events?kind=added")).total, 119);
    const summary = (await page("")).target;
    assert.equal(summary.currentCount, 120);
    assert.equal(summary.added24h, 119);
    assert.equal(summary.scopeVersion, 1);
    assert.equal(summary.filterVersion, 2);
    assert.equal(await digest(), before);
    assert.equal((await page("/urls?q=does-not-exist")).total, 0);
    assert.equal((await page("/urls?limit=50&offset=100")).items.length, 20);
    checks.push(
      "Literal path filters, search and pagination match list counts; filtering leaves all 123 inventory facts unchanged",
    );
    await patch({ includePaths: [], excludePaths: [] });
    await scan([]);
    const candidate = (await page("/candidates")).items[0];
    assert.equal(candidate.original_missing_count, 123);
    assert.equal(
      (await page(`/candidates/${candidate.id}/urls?limit=50&offset=100`)).items
        .length,
      23,
    );
    assert.equal(
      (
        await req(
          `${base}/candidates/${candidate.id}/approve`,
          "POST",
          {},
          other.cookie,
        )
      ).status,
      404,
    );
    checks.push(
      "Quarantine and full 123-URL Candidate detail ready for browser adoption acceptance",
    );
    await patch({ archived: true });
    assert.equal(
      (await req(base + "/runs", "POST", {}, owner.cookie)).status,
      409,
    );
    assert.equal((await page("/urls")).total, 123);
    await patch({ archived: false });
    checks.push(
      "Archive prohibits manual scans, preserves history and restores paused monitor",
    );
    await writeFile(
      authPath,
      JSON.stringify({
        email: owner.email,
        password: owner.password,
        websiteId: website.id,
        targetId: t.id,
        candidateId: candidate.id,
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          checks,
          fixture: true,
          websiteId: website.id,
          targetId: t.id,
          candidateId: candidate.id,
          urlCount: 123,
          events: 121,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "PR5 acceptance failed");
  process.exitCode = 1;
});
