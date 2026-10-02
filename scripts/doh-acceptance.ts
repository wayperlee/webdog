import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { getPool } from "../src/lib/db";

async function main() {
  const origin = new URL(process.env.DOH_ACCEPTANCE_ORIGIN ?? "http://localhost:31072");
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname)); assert.equal(origin.port, "31072");
  assert.equal(database.hostname, "127.0.0.1"); assert.equal(database.port, "55471"); assert.equal(database.pathname, "/sitemap_radar_pr1");
  assert.equal(process.env.SITEMAP_DNS_RESOLVER, "cloudflare-doh");
  const pool = getPool(), checks: string[] = [];
  async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
    return fetch(new URL(path, origin), { method, headers: { origin: origin.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  }
  async function workerOnce() {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts", "--once"], { env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, killSignal: "SIGTERM" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, 0, `Worker did not exit successfully: ${stderr}`);
    return stdout.trim().split("\n").map((line) => JSON.parse(line));
  }
  try {
    const active = (await pool.query("SELECT count(*)::int AS n FROM crawl_run WHERE execution_status IN ('queued','running')")).rows[0].n;
    assert.equal(active, 0, "Stop the local daemon and finish existing QA work before live acceptance");
    const signup = await request("/api/auth/sign-up/email", "POST", { name: "DoH live acceptance", email: `doh-${randomUUID()}@example.invalid`, password: randomUUID() });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie);
    const created = await request("/api/websites", "POST", { domain: "happy-horse.art" }, cookie); assert.equal(created.status, 201);
    const { website } = await created.json();
    const { rows: [target] } = await pool.query('SELECT id FROM target WHERE "websiteId"=$1', [website.id]);
    const base = `/api/targets/${target.id}`;
    assert.equal((await request(base, "PATCH", { enabled: false }, cookie)).status, 200);
    const runs = [];
    for (let scan = 0; scan < 2; scan++) {
      const submitted = await request(base + "/runs", "POST", {}, cookie); assert.equal(submitted.status, 202);
      const { run: entry } = await submitted.json(); const worker = await workerOnce();
      assert.ok(worker.some((event) => event.dnsResolver === "cloudflare-doh")); assert.ok(worker.some((event) => event.runId === entry.id));
      const { rows: [run] } = await pool.query("SELECT id,execution_status,completeness,adoption_status,attempt,error,jsonb_array_length(result->'urls') AS url_count FROM crawl_run WHERE id=$1", [entry.id]);
      assert.equal(run.execution_status, "succeeded"); assert.equal(run.completeness, "complete"); assert.equal(run.attempt, 1); assert.equal(run.error, null); assert.ok(run.url_count > 0);
      const history = await request(base + "/events", "GET", undefined, cookie); assert.equal(history.status, 200); const events = await history.json();
      if (scan === 0) { assert.equal(run.adoption_status, "baseline"); assert.equal(events.total, 0); }
      else assert.ok(["applied", "quarantined"].includes(run.adoption_status));
      const { rows: [current] } = await pool.query("SELECT baseline_run_id FROM target WHERE id=$1", [target.id]);
      if (run.adoption_status !== "quarantined") assert.equal(current.baseline_run_id, run.id);
      const inventory = await request(base + "/urls", "GET", undefined, cookie); assert.equal(inventory.status, 200);
      runs.push({ ...run, events: events.total, inventoryCount: (await inventory.json()).total, worker });
    }
    checks.push("authenticated website creation and manual queue submission succeeded without provider keys");
    checks.push("default production Worker used cloudflare-doh; two real sitemap graphs completed without a fixture fetcher");
    checks.push("first complete Run adopted a zero-event baseline; following complete Run used the inventory/CAS path");
    const report = { observedAt: new Date().toISOString(), origin: origin.origin, resolver: "cloudflare-doh", websiteId: website.id, targetId: target.id, checks, runs, fixture: false, productionTouched: false };
    if (process.env.DOH_ACCEPTANCE_OUTPUT) await writeFile(process.env.DOH_ACCEPTANCE_OUTPUT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "DoH acceptance failed"); process.exitCode = 1; });
