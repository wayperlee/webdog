import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { migratePrivateSchema } from "./scoped-migrations";
import {
  createGroup,
  readGroup,
  updateGroup,
  assignWebsites,
  deleteGroup,
  createGroupedWebsite,
} from "./competitor-groups";
import {
  groupOverviews,
  groupEvents,
  decodeGroupCursor,
} from "./competitor-group-summary";
import { CrawlQueue } from "./crawl-queue";
import { crawlSitemaps } from "./sitemap";
const secret = "groups-test-secret-".repeat(3);
test("Group cursors reject unsigned or malformed content", () => {
  for (const token of ["", "aaa.bbb", "{}", "x".repeat(5000)])
    assert.throws(() => decodeGroupCursor(token, secret), {
      code: "INVALID_CURSOR",
    });
});
test(
  "PostgreSQL competitor group contracts",
  { skip: process.env.GROUPS_ACCEPTANCE !== "1" },
  async (suite) => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55471");
    assert.equal(url.pathname, "/sitemap_radar_pr1");
    const schema = `groups_${randomUUID().replaceAll("-", "")}`,
      admin = new Pool({ connectionString: url.toString(), max: 1 });
    const pool = new Pool({
      connectionString: url.toString(),
      max: 8,
      options: `-c search_path=${schema}`,
    });
    const owner = randomUUID(),
      other = randomUUID(),
      member = randomUUID();
    const queue = new CrawlQueue(pool);
    const group = (name: string = randomUUID()) =>
      createGroup(pool, owner, owner, name, null);
    const site = (groupId: string | null = null) =>
      createGroupedWebsite(pool, owner, owner, "example.com", groupId);
    async function scan(websiteId: string, urls: string[]) {
      const {
        rows: [t],
      } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [
        websiteId,
      ]);
      await queue.enqueueRun(t.id, "manual");
      const claim = await queue.claim("groups-test");
      assert.equal(claim?.target_id, t.id);
      const result = await crawlSitemaps({
        siteUrl: "https://example.com",
        roots: ["https://example.com/sitemap.xml"],
        fetcher: async (url, budget) => {
          const body = Buffer.from(
            `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
          );
          budget.wire(body.length);
          budget.inflated(body.length);
          return { status: 200, finalUrl: url, body };
        },
      });
      await queue.finish(claim!, result);
      return claim!.id;
    }
    async function facts() {
      const rows = [];
      for (const table of [
        "target",
        "crawl_run",
        "site_url",
        "url_event",
        "removal_candidate",
      ]) {
        rows.push(
          (
            await pool.query(
              `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`,
            )
          ).rows[0].rows,
        );
      }
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    const eventOptions = {
      window: "24h" as const,
      includeArchived: false,
      siteId: null,
      kind: null,
      limit: 1,
    };
    try {
      await migratePrivateSchema(admin, schema);
      for (const id of [owner, other, member])
        await pool.query(
          'INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',
          [id, `${id}@example.invalid`],
        );
      await pool.query(
        'INSERT INTO "accountMembership"("ownerUserId","memberUserId") VALUES($1,$2)',
        [owner, member],
      );
      await suite.test(
        "Same-owner name uniqueness and existing membership access",
        async () => {
          const g = await group("Alpha");
          await assert.rejects(group("alpha"), { code: "GROUP_NAME_EXISTS" });
          await createGroup(pool, other, other, "Alpha", null);
          assert.equal((await readGroup(pool, member, g.id)).id, g.id);
          await assert.rejects(readGroup(pool, other, g.id), {
            code: "GROUP_NOT_FOUND",
          });
          await updateGroup(pool, member, owner, g.id, {
            name: "Alpha renamed",
          });
          await assert.rejects(
            updateGroup(pool, other, owner, g.id, { name: "stolen" }),
            { code: "ACCOUNT_NOT_FOUND" },
          );
        },
      );
      await suite.test(
        "Database rejects cross-owner membership even without API checks",
        async () => {
          const g = await createGroup(pool, other, other, "Other", null),
            w = await site();
          await assert.rejects(
            pool.query(
              "UPDATE website SET competitor_group_id=$1 WHERE id=$2",
              [g.id, w.id],
            ),
            { code: "23503" },
          );
          await assert.rejects(
            assignWebsites(pool, owner, owner, g.id, [
              { websiteId: w.id, expectedGroupId: null },
            ]),
            { code: "GROUP_NOT_FOUND" },
          );
        },
      );
      await suite.test(
        "Assign, move and delete leave every crawl fact unchanged",
        async () => {
          const a = await group(),
            b = await group(),
            w = await site();
          await scan(w.id, ["https://example.com/a", "https://example.com/b"]);
          await scan(w.id, ["https://example.com/a", "https://example.com/c"]);
          const before = await facts();
          assert.equal(
            (
              await assignWebsites(pool, owner, owner, a.id, [
                { websiteId: w.id, expectedGroupId: null },
              ])
            ).changedCount,
            1,
          );
          const version = (await readGroup(pool, owner, a.id))
            .membershipVersion;
          assert.equal(
            (
              await assignWebsites(pool, owner, owner, a.id, [
                { websiteId: w.id, expectedGroupId: null },
              ])
            ).changedCount,
            0,
          );
          assert.equal(
            (await readGroup(pool, owner, a.id)).membershipVersion,
            version,
          );
          await assignWebsites(pool, owner, owner, b.id, [
            { websiteId: w.id, expectedGroupId: a.id },
          ]);
          assert.equal(
            (await deleteGroup(pool, owner, owner, b.id)).detachedWebsiteCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT competitor_group_id FROM website WHERE id=$1",
                [w.id],
              )
            ).rows[0].competitor_group_id,
            null,
          );
          assert.equal(await facts(), before);
        },
      );
      await suite.test(
        "Bulk invalid assignment rolls back all websites",
        async () => {
          const g = await group(),
            w = await site();
          const alien = await createGroupedWebsite(
            pool,
            other,
            other,
            "example.net",
            null,
          );
          await assert.rejects(
            assignWebsites(pool, owner, owner, g.id, [
              { websiteId: w.id, expectedGroupId: null },
              { websiteId: alien.id, expectedGroupId: null },
            ]),
            { code: "WEBSITE_NOT_FOUND" },
          );
          assert.equal(
            (
              await pool.query(
                "SELECT competitor_group_id FROM website WHERE id=$1",
                [w.id],
              )
            ).rows[0].competitor_group_id,
            null,
          );
        },
      );
      await suite.test(
        "Concurrent stale moves cannot overwrite each other",
        async () => {
          const a = await group(),
            b = await group(),
            w = await site();
          const r = await Promise.allSettled([
            assignWebsites(pool, owner, owner, a.id, [
              { websiteId: w.id, expectedGroupId: null },
            ]),
            assignWebsites(pool, owner, owner, b.id, [
              { websiteId: w.id, expectedGroupId: null },
            ]),
          ]);
          assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
          assert.equal(
            r.filter(
              (x) =>
                x.status === "rejected" &&
                (x.reason as { code: string }).code ===
                  "GROUP_ASSIGNMENT_CHANGED",
            ).length,
            1,
          );
        },
      );
      await suite.test(
        "Concurrent delete and assign leave no dangling membership",
        async () => {
          const g = await group(),
            w = await site();
          await Promise.allSettled([
            deleteGroup(pool, owner, owner, g.id),
            assignWebsites(pool, owner, owner, g.id, [
              { websiteId: w.id, expectedGroupId: null },
            ]),
          ]);
          const {
            rows: [row],
          } = await pool.query(
            "SELECT competitor_group_id FROM website WHERE id=$1",
            [w.id],
          );
          assert.equal(row.competitor_group_id, null);
          await assert.rejects(readGroup(pool, owner, g.id), {
            code: "GROUP_NOT_FOUND",
          });
        },
      );
      await suite.test(
        "Window aggregation includes pending inventory and current members only",
        async () => {
          const a = await group(),
            b = await group(),
            w = await site(a.id);
          await scan(w.id, ["https://example.com/a", "https://example.com/b"]);
          await scan(w.id, ["https://example.com/a", "https://example.com/c"]);
          const result = await groupOverviews(pool, owner, { groupId: a.id });
          assert.equal(result.items[0].currentUrlCount, 3);
          assert.equal(result.items[0].pendingRemovalCount, 1);
          assert.equal(result.items[0].added, 1);
          assert.equal(result.items[0].removed, 0);
          await assignWebsites(pool, owner, owner, b.id, [
            { websiteId: w.id, expectedGroupId: a.id },
          ]);
          assert.equal(
            (await groupOverviews(pool, owner, { groupId: a.id })).items[0]
              .added,
            0,
          );
          assert.equal(
            (await groupOverviews(pool, owner, { groupId: b.id })).items[0]
              .added,
            1,
          );
          await assert.rejects(groupOverviews(pool, other, { groupId: b.id }), {
            code: "GROUP_NOT_FOUND",
          });
        },
      );
      await suite.test(
        "Scopes, filters, pause, archive and missing baselines have explicit metrics",
        async () => {
          const g = await group(),
            w = await site(g.id),
            unseen = await site(g.id);
          await scan(w.id, [
            "https://example.com/blog/a",
            "https://example.com/docs/a",
          ]);
          await scan(w.id, [
            "https://example.com/blog/a",
            "https://example.com/docs/a",
            "https://example.com/blog/b",
            "https://example.com/docs/b",
          ]);
          const {
            rows: [t],
          } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [
            w.id,
          ]);
          await queue.configureMonitor(t.id, owner, {
            includePaths: ["/blog/"],
            enabled: false,
          });
          let s = (await groupOverviews(pool, owner, { groupId: g.id }))
            .items[0];
          assert.equal(s.websiteCount, 2);
          assert.equal(s.baselineWebsiteCount, 1);
          assert.equal(s.currentUrlCount, 2);
          assert.equal(s.added, 1);
          assert.equal(s.statusCounts.Paused, 1);
          await queue.configureMonitor(t.id, owner, { archived: true });
          s = (await groupOverviews(pool, owner, { groupId: g.id })).items[0];
          assert.equal(s.websiteCount, 1);
          assert.equal(s.currentUrlCount, null);
          assert.equal(
            (
              await groupOverviews(pool, owner, {
                groupId: g.id,
                includeArchived: true,
              })
            ).items[0].currentUrlCount,
            2,
          );
          await queue.configureMonitor(t.id, owner, { archived: false });
          await queue.configureScope(t.id, owner, {
            roots: ["https://example.com/new.xml"],
            allowedPageHosts: null,
          });
          s = (await groupOverviews(pool, owner, { groupId: g.id })).items[0];
          assert.equal(s.added, 0);
          assert.equal(s.currentUrlCount, null);
          assert.ok(unseen.id);
        },
      );
      await suite.test(
        "7d events and keyset cursors survive equal timestamps but invalidate on membership/filter changes",
        async () => {
          const g = await group(),
            w = await site(g.id);
          const run = await scan(w.id, ["https://example.com/a"]);
          await scan(w.id, [
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
          ]);
          const same = new Date(Date.now() - 3600000);
          await pool.query(
            "UPDATE url_event SET observed_at=$1 WHERE website_id=$2",
            [same, w.id],
          );
          await pool.query(
            "INSERT INTO url_event(id,website_id,scope_version,normalized_url_hash,url,run_id,kind,observed_at) VALUES($1,$2,1,$3,'https://example.com/old',$4,'removed',now()-interval '3 days')",
            [randomUUID(), w.id, "old", run],
          );
          assert.equal(
            (await groupOverviews(pool, owner, { groupId: g.id })).items[0]
              .removed,
            0,
          );
          assert.equal(
            (await groupOverviews(pool, owner, { groupId: g.id, window: "7d" }))
              .items[0].removed,
            1,
          );
          const first = await groupEvents(
            pool,
            owner,
            g.id,
            eventOptions,
            secret,
          );
          assert.ok(first.nextCursor);
          const second = await groupEvents(
            pool,
            owner,
            g.id,
            { ...eventOptions, cursor: first.nextCursor! },
            secret,
          );
          assert.equal(second.items.length, 1);
          assert.notEqual(first.items[0].id, second.items[0].id);
          await assert.rejects(
            groupEvents(pool, other, g.id, eventOptions, secret),
            { code: "GROUP_NOT_FOUND" },
          );
          await assert.rejects(
            groupEvents(
              pool,
              owner,
              g.id,
              { ...eventOptions, siteId: randomUUID() },
              secret,
            ),
            { code: "GROUP_NOT_FOUND" },
          );
          const {
            rows: [t],
          } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [
            w.id,
          ]);
          await queue.configureMonitor(t.id, owner, {
            excludePaths: ["/no-match"],
          });
          await assert.rejects(
            groupEvents(
              pool,
              owner,
              g.id,
              { ...eventOptions, cursor: first.nextCursor! },
              secret,
            ),
            { code: "CURSOR_STALE" },
          );
          const fresh = await groupEvents(
            pool,
            owner,
            g.id,
            eventOptions,
            secret,
          );
          await site(g.id);
          await assert.rejects(
            groupEvents(
              pool,
              owner,
              g.id,
              { ...eventOptions, cursor: fresh.nextCursor! },
              secret,
            ),
            { code: "CURSOR_STALE" },
          );
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
