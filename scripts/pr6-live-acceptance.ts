import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getPool } from "../src/lib/db";

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.port, "55471");
  assert.equal(database.pathname, "/sitemap_radar_pr1");
  assert.equal(process.env.SITEMAP_DNS_RESOLVER, "cloudflare-doh");
  const origin = "http://localhost:31072",
    pool = getPool();
  const targets: string[] = [],
    checks: string[] = [],
    observations: unknown[] = [];
  const email = `pr6-live-${randomUUID()}@example.invalid`,
    password = randomUUID();
  let cookie = "";
  const authPath = process.env.PR6_AUTH_FILE,
    output = process.env.PR6_LIVE_OUTPUT;
  assert.ok(authPath && authPath.startsWith("/"));
  assert.ok(output && output.startsWith("/"));
  async function req(path: string, method = "GET", body?: unknown) {
    const res = await fetch(origin + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    assert.ok(res.ok, `${method} ${path}: HTTP ${res.status}`);
    return { res, data };
  }
  async function until<T>(
    name: string,
    read: () => Promise<T | null>,
    timeout = 900000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await read();
      if (result !== null) return result;
      await delay(1500);
    }
    throw new Error(`Timed out: ${name}`);
  }
  async function terminal(id: string) {
    return until("terminal Run", async () => {
      const run = (
        await pool.query(
          `SELECT id,target_id,trigger,scope_version,execution_status,completeness,adoption_status,attempt,
        available_at,created_at,finished_at,error,CASE WHEN result->'urls' IS NULL OR result->'urls'='null'::jsonb THEN NULL ELSE jsonb_array_length(result->'urls') END AS url_count FROM crawl_run WHERE id=$1`,
          [id],
        )
      ).rows[0];
      return run &&
        ["succeeded", "failed", "cancelled"].includes(run.execution_status)
        ? run
        : null;
    });
  }
  async function scan(targetId: string) {
    const due = (
      await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [
        targetId,
      ])
    ).rows[0].nextCheckDueAt;
    const { data } = await req(`/api/targets/${targetId}/runs`, "POST", {});
    const run = await terminal(data.run.id);
    const after = (
      await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [
        targetId,
      ])
    ).rows[0].nextCheckDueAt;
    assert.equal(
      after?.getTime() ?? null,
      due?.getTime() ?? null,
      "Manual Run must not move cadence",
    );
    observations.push(run);
    return run;
  }
  function complete(run: Record<string, unknown>) {
    assert.equal(run.execution_status, "succeeded");
    assert.equal(run.completeness, "complete");
    assert.ok(Number(run.attempt) >= 1 && Number(run.attempt) <= 4);
    assert.equal(run.error, null);
    assert.ok(Number(run.url_count) > 0);
  }
  try {
    const signup = await req("/api/auth/sign-up/email", "POST", {
      name: "PR6 live acceptance",
      email,
      password,
    });
    cookie = signup.res.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    await writeFile(authPath, JSON.stringify({ email, password, sites: [] }), {
      mode: 0o600,
    });
    const sites = [];
    for (const domain of ["supermaker.ai", "happy-horse.art"]) {
      const { data } = await req("/api/websites", "POST", { domain });
      const targetId = (
        await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [
          data.website.id,
        ])
      ).rows[0].id;
      targets.push(targetId);
      await req(`/api/targets/${targetId}`, "PATCH", { enabled: false });
      // A scheduler race at website creation is permitted; wait for its cancellation/completion before manual acceptance.
      await until("creation scheduler race", async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM crawl_run WHERE target_id=$1 AND execution_status IN ('queued','running')",
            [targetId],
          )
        ).rows[0].n === 0
          ? true
          : null,
      );
      const first = await scan(targetId);
      complete(first);
      const events = (await req(`/api/targets/${targetId}/events`)).data;
      assert.equal(events.total, 0);
      const second = await scan(targetId);
      complete(second);
      assert.equal(second.adoption_status, "applied");
      const inventory = (await req(`/api/targets/${targetId}/urls`)).data;
      assert.ok(inventory.total >= second.url_count);
      const summary = (await req(`/api/targets/${targetId}`)).data.target;
      assert.equal(summary.baselineRunId, second.id);
      sites.push({
        domain,
        websiteId: data.website.id,
        targetId,
        firstRunId: first.id,
        secondRunId: second.id,
        observedUrls: second.url_count,
        inventoryCount: inventory.total,
        events: (await req(`/api/targets/${targetId}/events`)).data.total,
      });
      await writeFile(authPath, JSON.stringify({ email, password, sites }), {
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          phase: "two_live_scans",
          domain,
          urls: second.url_count,
        }),
      );
    }
    checks.push(
      "Two real complete manual scans on supermaker.ai and happy-horse.art; zero first-baseline events; unchanged manual cadence",
    );
    const scheduledTarget = sites[0].targetId;
    await req(`/api/targets/${scheduledTarget}`, "PATCH", { enabled: true });
    const scheduledAt = new Date();
    // Only this new QA target is made due. We do not shorten the user's configured interval.
    await pool.query(
      "UPDATE target SET \"nextCheckDueAt\"=clock_timestamp()-interval '1 second' WHERE id=$1",
      [scheduledTarget],
    );
    const scheduled = await until(
      "normal daemon scheduler",
      async () =>
        (
          await pool.query(
            "SELECT id FROM crawl_run WHERE target_id=$1 AND trigger='scheduled' AND created_at>=$2 ORDER BY created_at DESC LIMIT 1",
            [scheduledTarget, scheduledAt],
          )
        ).rows[0] ?? null,
    );
    const scheduledRun = await terminal(scheduled.id);
    complete(scheduledRun);
    observations.push(scheduledRun);
    await req(`/api/targets/${scheduledTarget}`, "PATCH", { enabled: false });
    const nextDue = (
      await pool.query(
        'SELECT "nextCheckDueAt">clock_timestamp() AS future FROM target WHERE id=$1',
        [scheduledTarget],
      )
    ).rows[0].future;
    assert.equal(nextDue, true);
    checks.push(
      "Default daemon created and completed a real scheduled Run, then advanced the fixed 6h cadence",
    );
    const recoveryTarget = sites[1].targetId;
    const invalidRoot = `https://happy-horse.art/codex-acceptance-${randomUUID()}.xml`;
    await req(`/api/targets/${recoveryTarget}/scope`, "PATCH", {
      roots: [invalidRoot],
      allowedPageHosts: null,
    });
    const failed = await scan(recoveryTarget);
    assert.equal(failed.execution_status, "failed");
    assert.equal(failed.adoption_status, "none");
    assert.ok(failed.error);
    assert.equal(failed.url_count, null);
    assert.equal(
      (await req(`/api/targets/${recoveryTarget}/urls`)).data.total,
      0,
    );
    assert.equal(
      (await req(`/api/targets/${recoveryTarget}/urls?scopeVersion=1`)).data
        .total,
      sites[1].inventoryCount,
    );
    await req(`/api/targets/${recoveryTarget}/scope`, "PATCH", {
      roots: null,
      allowedPageHosts: null,
    });
    const recovered = await scan(recoveryTarget);
    complete(recovered);
    assert.equal(recovered.adoption_status, "baseline");
    assert.equal(
      (await req(`/api/targets/${recoveryTarget}/events`)).data.total,
      0,
    );
    const recoveredSummary = (await req(`/api/targets/${recoveryTarget}`)).data
      .target;
    assert.equal(recoveredSummary.lastError, null);
    assert.equal(recoveredSummary.scopeVersion, 3);
    checks.push(
      "Deliberately invalid real sitemap root failed without contaminating inventory; automatic discovery recovered in scope 3, preserving scope 1 history",
    );
    await writeFile(authPath, JSON.stringify({ email, password, sites }), {
      mode: 0o600,
    });
    const report = {
      observedAt: new Date().toISOString(),
      sourceDatabase: "127.0.0.1:55471/sitemap_radar_pr1",
      origin,
      resolver: "cloudflare-doh",
      fixtureFetcher: false,
      deliberateInvalidRoot: true,
      userSiteConfigurationChanged: false,
      checks,
      sites,
      observations,
    };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ phase: "complete", checks }));
  } finally {
    for (const targetId of targets)
      await pool.query("UPDATE target SET enabled=false WHERE id=$1", [
        targetId,
      ]);
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Live acceptance failed");
  process.exitCode = 1;
});
