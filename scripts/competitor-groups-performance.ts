import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { migratePrivateSchema } from "../src/lib/scoped-migrations";
import {
  createGroup,
  createGroupedWebsite,
} from "../src/lib/competitor-groups";
import {
  groupOverviews,
  groupEvents,
} from "../src/lib/competitor-group-summary";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55471");
  assert.equal(url.pathname, "/sitemap_radar_pr1");
  const schema = `groups_perf_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const pool = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
    max: 1,
  });
  const owner = randomUUID();
  const groups: string[] = [];
  try {
    await migratePrivateSchema(admin, schema);
    await pool.query(
      'INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',
      [owner, `${owner}@example.invalid`],
    );
    for (let i = 0; i < 10; i++)
      groups.push(
        (await createGroup(pool, owner, owner, `Load ${i}`, null)).id,
      );
    for (let i = 0; i < 50; i++)
      await createGroupedWebsite(
        pool,
        owner,
        owner,
        `load-${i}.example.invalid`,
        groups[i % 10],
      );
    await pool.query(`INSERT INTO crawl_run(id,target_id,trigger,scope_version,config,execution_status,completeness,adoption_status,observed_at)
      SELECT 'run-'||id,id,'manual',scope_version,'{}','succeeded','complete','baseline',now() FROM target`);
    await pool.query(`UPDATE target SET baseline_run_id='run-'||id`);
    await pool.query(`INSERT INTO site_url(website_id,scope_version,normalized_url_hash,url,status,first_seen_at,last_seen_at)
      SELECT w.id,1,md5(n::text),'https://'||w.domain||'/page-'||n,'active',now(),now() FROM website w CROSS JOIN generate_series(1,1000) n`);
    await pool.query(`INSERT INTO url_event(id,website_id,scope_version,normalized_url_hash,url,run_id,kind,observed_at)
      SELECT w.id||'-'||n,w.id,1,md5(n::text),'https://'||w.domain||'/page-'||n,'run-'||t.id,
        CASE WHEN n%3=0 THEN 'removed' WHEN n%3=1 THEN 'added' ELSE 'reappeared' END,now()-make_interval(secs=>n)
      FROM website w JOIN target t ON t."websiteId"=w.id CROSS JOIN generate_series(1,4000) n`);
    await pool.query("ANALYZE");
    const queries: { sql: string; values: unknown[]; milliseconds: number }[] =
      [];
    const measured = {
      query: async (sql: string, values: unknown[]) => {
        const before = performance.now();
        const r = await pool.query(sql, values);
        queries.push({ sql, values, milliseconds: performance.now() - before });
        return r;
      },
    } as unknown as Pool;
    const list = await groupOverviews(measured, owner);
    assert.equal(list.total, 10);
    assert.equal(
      list.items.reduce((n, g) => n + g.currentUrlCount!, 0),
      50000,
    );
    assert.equal(
      list.items.reduce((n, g) => n + g.added + g.removed + g.reappeared, 0),
      200000,
    );
    const detail = await groupOverviews(measured, owner, {
      groupId: groups[0],
    });
    assert.equal(detail.items[0].websiteCount, 5);
    const events = await groupEvents(
      measured,
      owner,
      groups[0],
      {
        window: "24h",
        includeArchived: false,
        siteId: null,
        kind: null,
        limit: 50,
      },
      "local-test-secret-".repeat(3),
    );
    assert.equal(events.items.length, 50);
    assert.ok(events.nextCursor);
    const plans = [];
    for (const [i, q] of queries.entries()) {
      const plan = (
        await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`,
          q.values,
        )
      ).rows[0]["QUERY PLAN"][0];
      plans.push({
        operation: ["list", "detail", "events"][i],
        milliseconds: q.milliseconds,
        executionMs: plan["Execution Time"],
        planningMs: plan["Planning Time"],
        plan: plan.Plan,
      });
    }
    // Exercise the production grant migration with temporary local roles, then roll back every privilege mutation.
    const role = `qa_${randomUUID().replaceAll("-", "")}`;
    await pool.query("BEGIN");
    let roleChecks = false;
    try {
      for (const suffix of ["app", "anon", "authenticated", "service"])
        await pool.query(`CREATE ROLE ${role}_${suffix} NOLOGIN`);
      let permissions = await readFile(
        "supabase/migrations/20261002094037_competitor_groups_access.sql",
        "utf8",
      );
      permissions = permissions
        .replace(/^BEGIN;\s*/m, "")
        .replace(/COMMIT;\s*$/m, "")
        .replaceAll("sitemap_radar.", `${schema}.`)
        .replaceAll("sitemap_radar_app", `${role}_app`)
        .replaceAll("service_role", `${role}_service`)
        .replaceAll("authenticated", `${role}_authenticated`)
        .replace(/\banon\b/g, `${role}_anon`);
      await pool.query(permissions);
      await pool.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${role}_app,${role}_anon,${role}_authenticated,${role}_service`,
      );
      await pool.query(`SET LOCAL ROLE ${role}_app`);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM competitor_group"))
          .rows[0].n,
        10,
      );
      await pool.query(
        "UPDATE competitor_group SET description='local grant check' WHERE id=$1",
        [groups[0]],
      );
      await pool.query("RESET ROLE");
      for (const suffix of ["anon", "authenticated", "service"])
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege($1,$2,'SELECT') AS granted",
              [`${role}_${suffix}`, `${schema}.competitor_group`],
            )
          ).rows[0].granted,
          false,
        );
      assert.equal(
        (
          await pool.query(
            "SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass",
            [`${schema}.competitor_group`],
          )
        ).rows[0].relrowsecurity,
        true,
      );
      roleChecks = true;
    } finally {
      await pool.query("ROLLBACK");
    }
    const report = {
      observedAt: new Date().toISOString(),
      environment:
        "Local PostgreSQL synthetic fixture; not production capacity evidence",
      fixture: { groups: 10, websites: 50, inventory: 50000, events: 200000 },
      permissionsMigrationVerified: roleChecks,
      queries: plans,
    };
    const output = process.argv[2];
    assert.ok(output?.startsWith("/"));
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        ...report,
        queries: plans.map(
          ({ operation, milliseconds, executionMs, planningMs }) => ({
            operation,
            milliseconds,
            executionMs,
            planningMs,
          }),
        ),
      }),
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
main().catch((e) => {
  console.error(
    e instanceof Error ? e.message : "PERFORMANCE_ACCEPTANCE_FAILED",
  );
  process.exitCode = 1;
});
