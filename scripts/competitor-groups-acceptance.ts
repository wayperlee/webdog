import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { crawlSitemaps } from "../src/lib/sitemap";

/** Isolated local HTTP acceptance only; refuses the deployed schema and remote databases. */
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const schema = process.env.DATABASE_SCHEMA ?? "";
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55471");
  assert.equal(url.pathname, "/sitemap_radar_pr1");
  assert.match(schema, /^groups_ui_[a-f0-9]{32}$/);
  const output = process.argv[2];
  assert.ok(
    output?.startsWith("/"),
    "Absolute private output directory required",
  );
  const origin = "http://localhost:31073";
  const pool = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
  });
  const actors: Record<string, { userId: string; cookies: string[] }> = {};
  const checks: string[] = [];
  async function request(
    path: string,
    actor: string | null,
    method = "GET",
    body?: unknown,
    status = 200,
  ) {
    const r = await fetch(origin + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(actor
          ? {
              Cookie: actors[actor].cookies
                .map((c) => c.split(";")[0])
                .join("; "),
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(
      r.status,
      status,
      `${method} ${path}: expected ${status}, received ${r.status}`,
    );
    return r.json();
  }
  try {
    for (const label of ["owner", "other"]) {
      const r = await fetch(origin + "/api/auth/sign-up/email", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Groups ${label}`,
          email: `groups-${randomUUID()}@example.invalid`,
          password: randomUUID() + randomUUID(),
        }),
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      actors[label] = {
        userId: data.user.id,
        cookies: r.headers.getSetCookie(),
      };
    }
    await request("/api/competitor-groups", null, "GET", undefined, 401);
    const a = (
      await request(
        "/api/competitor-groups",
        "owner",
        "POST",
        { name: "小羊团队", description: "UI acceptance: current membership" },
        201,
      )
    ).group;
    const b = (
      await request(
        "/api/competitor-groups",
        "owner",
        "POST",
        { name: "第二个团队" },
        201,
      )
    ).group;
    await request(
      "/api/competitor-groups",
      "owner",
      "POST",
      { name: "  小羊团队  " },
      409,
    );
    await request(
      `/api/competitor-groups/${a.id}`,
      "other",
      "GET",
      undefined,
      404,
    );
    await request(
      `/api/competitor-groups/${a.id}`,
      "other",
      "PATCH",
      { name: "unauthorized" },
      404,
    );
    await request(
      `/api/competitor-groups/${a.id}/events`,
      "other",
      "GET",
      undefined,
      404,
    );
    checks.push(
      "Authentication, strict owner isolation, trimmed name conflict",
    );
    const w1 = (
      await request(
        "/api/websites",
        "owner",
        "POST",
        { domain: "example.com", competitorGroupId: a.id },
        201,
      )
    ).website;
    const w2 = (
      await request(
        "/api/websites",
        "owner",
        "POST",
        { domain: "example.org" },
        201,
      )
    ).website;
    const alien = (
      await request(
        "/api/websites",
        "other",
        "POST",
        { domain: "example.net" },
        201,
      )
    ).website;
    const assign = (
      groupId: string | null,
      assignments: unknown[],
      status = 200,
    ) =>
      request(
        "/api/competitor-groups/assign-websites",
        "owner",
        "POST",
        { groupId, assignments },
        status,
      );
    await assign(
      a.id,
      [
        { websiteId: w2.id, expectedGroupId: null },
        { websiteId: alien.id, expectedGroupId: null },
      ],
      404,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT competitor_group_id FROM website WHERE id=$1",
          [w2.id],
        )
      ).rows[0].competitor_group_id,
      null,
    );
    await assign(a.id, [{ websiteId: w2.id, expectedGroupId: null }]);
    const queue = new CrawlQueue(pool);
    async function scan(w: { id: string; domain: string }, count: number) {
      const t = (
        await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [w.id])
      ).rows[0];
      await queue.enqueueRun(t.id, "manual");
      const claim = await queue.claim("groups-ui");
      assert.equal(claim?.target_id, t.id);
      const result = await crawlSitemaps({
        siteUrl: `https://${w.domain}`,
        roots: [`https://${w.domain}/sitemap.xml`],
        fetcher: async (url, budget) => {
          const body = Buffer.from(
            `<urlset>${Array.from({ length: count }, (_, i) => `<url><loc>https://${w.domain}/page-${i}</loc></url>`).join("")}</urlset>`,
          );
          budget.wire(body.length);
          budget.inflated(body.length);
          return { status: 200, finalUrl: url, body };
        },
      });
      await queue.finish(claim!, result);
      return t.id as string;
    }
    const target1 = await scan(w1, 2);
    await scan(w1, 123);
    const target2 = await scan(w2, 1);
    await scan(w2, 2);
    await request(`/api/targets/${target2}`, "owner", "PATCH", {
      enabled: false,
    });
    let overview = await request(
      `/api/competitor-groups/${a.id}/websites`,
      "owner",
    );
    assert.equal(overview.group.currentUrlCount, 125);
    assert.equal(overview.group.added, 122);
    assert.equal(overview.group.baselineWebsiteCount, 2);
    assert.equal(overview.items[0].id, w1.id);
    assert.equal(overview.group.statusCounts.Paused, 1);
    const page1 = await request(
      `/api/competitor-groups/${a.id}/events?limit=50`,
      "owner",
    );
    const page2 = await request(
      `/api/competitor-groups/${a.id}/events?limit=50&cursor=${encodeURIComponent(page1.nextCursor)}`,
      "owner",
    );
    assert.equal(page1.items.length, 50);
    assert.equal(page2.items.length, 50);
    assert.equal(
      new Set([...page1.items, ...page2.items].map((x) => x.id)).size,
      100,
    );
    const seven = await request(
      `/api/competitor-groups/${a.id}/events?window=7d&siteId=${w2.id}&kind=added`,
      "owner",
    );
    assert.equal(seven.items.length, 1);
    checks.push(
      "Real HTTP summary, baselines, paused sites, ranking, keyset pagination and filters",
    );
    const facts = async () => {
      const rows = [];
      for (const table of [
        "target",
        "crawl_run",
        "site_url",
        "url_event",
        "removal_candidate",
      ])
        rows.push(
          (
            await pool.query(
              `SELECT jsonb_agg(t ORDER BY to_jsonb(t)::text) AS data FROM ${table} t`,
            )
          ).rows[0].data,
        );
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    };
    const before = await facts();
    await assign(b.id, [{ websiteId: w2.id, expectedGroupId: a.id }]);
    await request(
      `/api/competitor-groups/${a.id}/events?limit=50&cursor=${encodeURIComponent(page1.nextCursor)}`,
      "owner",
      "GET",
      undefined,
      409,
    );
    await assign(a.id, [{ websiteId: w2.id, expectedGroupId: null }], 409);
    assert.equal(
      (await request(`/api/competitor-groups/${b.id}/websites`, "owner")).group
        .added,
      1,
    );
    await request(`/api/competitor-groups/${b.id}`, "owner", "DELETE");
    assert.equal(await facts(), before);
    assert.equal(
      (
        await pool.query(
          "SELECT competitor_group_id FROM website WHERE id=$1",
          [w2.id],
        )
      ).rows[0].competitor_group_id,
      null,
    );
    checks.push(
      "Bulk rollback, stale membership conflict, cursor invalidation, move/delete preserve crawl facts",
    );
    await request(`/api/targets/${target1}`, "owner", "PATCH", {
      archived: true,
    });
    overview = await request(
      `/api/competitor-groups/${a.id}/websites`,
      "owner",
    );
    assert.equal(overview.group.websiteCount, 0);
    assert.equal(overview.group.currentUrlCount, null);
    overview = await request(
      `/api/competitor-groups/${a.id}/websites?includeArchived=true`,
      "owner",
    );
    assert.equal(overview.group.websiteCount, 1);
    await request(`/api/targets/${target1}`, "owner", "PATCH", {
      archived: false,
      enabled: false,
    });
    await assign(a.id, [{ websiteId: w2.id, expectedGroupId: null }]);
    checks.push(
      "Archived default exclusion, explicit inclusion and restoration",
    );
    const finalB = (
      await request(
        "/api/competitor-groups",
        "owner",
        "POST",
        { name: "第二个团队" },
        201,
      )
    ).group;
    await writeFile(
      `${output}/groups-browser-private.json`,
      JSON.stringify({
        origin,
        actors,
        groupId: a.id,
        otherGroupId: finalB.id,
        websiteId: w1.id,
        website2Id: w2.id,
      }),
      { mode: 0o600 },
    );
    const report = {
      observedAt: new Date().toISOString(),
      origin,
      schema,
      checks,
      passed: true,
      fixture: {
        groups: 2,
        websites: 3,
        addedEvents: 122,
        network: "Controlled XML fixture; no external site claim",
      },
    };
    await writeFile(
      `${output}/groups-http-acceptance.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "ACCEPTANCE_FAILED");
  process.exitCode = 1;
});
