import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { databaseReady } from "../src/lib/runtime-health";

const source = new URL(process.env.DATABASE_URL ?? "");
assert.equal(source.hostname, "127.0.0.1"); assert.equal(source.port, "55471"); assert.equal(source.pathname, "/sitemap_radar_pr1");
const token = randomUUID().replaceAll("-", ""), name = `radar_runtime_${token}`, project = `radar-pr6b-${token}`;
const admin = new Pool({ connectionString: source.toString(), max: 1 });
const direct = new URL(source); direct.pathname = `/${name}`;
const pool = new Pool({ connectionString: direct.toString(), max: 2 });
const queue = new CrawlQueue(pool);
const privateDir = resolve(process.env.PR6_RUNTIME_PRIVATE_DIR ?? "");
assert.ok(process.env.PR6_RUNTIME_PRIVATE_DIR && !privateDir.startsWith(process.cwd() + "/"), "Private runtime env must be outside repository");
const envFile = resolve(privateDir, `runtime-${token}.env`);
let created = false, composeStarted = false, envCreated = false;
let composeEnv: NodeJS.ProcessEnv;
const report: Record<string, unknown> = { observedAt: new Date().toISOString(), isolatedDatabase: true, productionTouched: false };
async function command(args: string[], publishFailure = false) {
  const child = spawn("docker", args, { env: composeEnv ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
  await new Promise<void>((ok, fail) => {
    child.on("error", fail); child.on("close", code => code === 0 ? ok() : fail(new Error(publishFailure ? err : `Docker ${args[0]} failed`)));
  });
  return out.trim();
}
const compose = (...args: string[]) => command(["compose", "-p", project, "-f", "compose.runtime.yml", ...args]);
async function wait<T>(description: string, fn: () => Promise<T | false>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value !== false) return value; await delay(250); }
  throw new Error(`Timed out: ${description}`);
}
async function info(id: string) {
  const raw = await command(["inspect", "--format", '{{json .State}}|{{json .HostConfig.RestartPolicy}}|{{json .Config.User}}|{{json .RestartCount}}', id]);
  const [state, policy, user, restarts] = raw.split("|").map(s => JSON.parse(s));
  return { state, policy, user, restarts };
}
async function ready(id: string) { return wait("container health", async () => (await info(id)).state.Health?.Status === "healthy" ? true : false); }
async function row(id: string) { return (await pool.query("SELECT * FROM crawl_run WHERE id=$1", [id])).rows[0]; }
async function main() {
  try {
    await mkdir(privateDir, { recursive: true, mode: 0o700 }); await chmod(privateDir, 0o700);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await assert.rejects(databaseReady(pool), /SCHEMA_NOT_READY/);
    const probe = createServer(); await new Promise<void>(ok => probe.listen(0, "127.0.0.1", ok));
    const addr = probe.address(); assert.ok(addr && typeof addr !== "string"); const port = addr.port;
    await new Promise<void>((ok, fail) => probe.close(e => e ? fail(e) : ok()));
    const origin = `http://127.0.0.1:${port}`, containerUrl = new URL(direct); containerUrl.hostname = "host.docker.internal";
    const secret = randomUUID() + randomUUID();
    await writeFile(envFile, `DATABASE_URL=${containerUrl}\nBETTER_AUTH_SECRET=${secret}\nBETTER_AUTH_URL=${origin}\nNEXT_PUBLIC_APP_URL=${origin}\nSITEMAP_DNS_RESOLVER=cloudflare-doh\nDB_CONNECTION_TIMEOUT_MS=5000\nDB_IDLE_TIMEOUT_MS=30000\n`, { mode: 0o600, flag: "wx" }); envCreated = true;
    composeEnv = { ...process.env, RADAR_ENV_FILE: envFile, RADAR_IMAGE: "sitemap-radar:pr6b", RADAR_WEB_PORT: String(port) };
    await compose("config", "--quiet");
    // Empty database is migrated by exactly the same one-shot service used in the runtime template.
    composeStarted = true; await compose("up", "-d", "--no-build");
    const webId = await compose("ps", "-q", "web"), workerId = await compose("ps", "-q", "worker");
    assert.ok(webId && workerId); await ready(webId); await ready(workerId); await databaseReady(pool);
    const webInfo = await info(webId), workerInfo = await info(workerId);
    assert.equal(webInfo.user, "node"); assert.equal(workerInfo.user, "node");
    assert.equal(webInfo.policy.Name, "unless-stopped"); assert.equal(workerInfo.policy.Name, "unless-stopped");
    const health = await fetch(origin + "/api/health"); assert.equal(health.status, 200);
    report.services = { nonRoot: true, separateContainers: true, migrateBeforeStart: true, webReady: true, workerReady: true, restartPolicy: "unless-stopped" };
    let cookie = "";
    async function req(path: string, body?: unknown) {
      const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const cookies = res.headers.getSetCookie(); if (cookies.length) cookie = cookies.map(c => c.split(";")[0]).join("; ");
      assert.ok(res.ok, `HTTP ${res.status} for ${path}`); return res.json();
    }
    const email = `pr6-runtime-${token}@example.invalid`;
    const auth = await req("/api/auth/sign-up/email", { name: "Runtime QA", email, password: randomUUID() });
    const { website: site } = await req("/api/websites", { domain: "supermaker.ai" });
    const detail = await req(`/api/websites/${site.id}`); const targetId = detail.targets[0].id;
    // API-created first Run is consumed by the actual container daemon/default crawler.
    const first = await wait("initial queued Run", async () => (await pool.query("SELECT id FROM crawl_run WHERE target_id=$1 ORDER BY created_at LIMIT 1", [targetId])).rows[0] || false);
    const finished = await wait("real native crawl", async () => { const r = await row(first.id); return r.execution_status === "succeeded" ? r : false; }, 120_000);
    assert.equal(finished.completeness, "complete"); assert.equal(finished.adoption_status, "baseline"); assert.ok(finished.result.urls.length > 0);
    const inventory = await req(`/api/targets/${targetId}/urls?limit=200`); assert.equal(inventory.total, finished.result.urls.length);
    report.containerCrawler = { dnsResolver: "cloudflare-doh", urls: inventory.total, authenticatedApi: true, nativeTransport: true };
    // Health must fail on incomplete schema even when SELECT 1 works.
    await pool.query("ALTER TABLE site_url RENAME TO runtime_hidden_site_url");
    try { assert.equal((await fetch(origin + "/api/health")).status, 503); }
    finally { await pool.query("ALTER TABLE runtime_hidden_site_url RENAME TO site_url"); }
    assert.equal((await fetch(origin + "/api/health")).status, 200);
    const hp = "/tmp/sitemap-worker-health.json";
    const state = JSON.parse(await command(["exec", workerId, "cat", hp]));
    const probeArgs = ["exec", workerId, "node", "--import", "tsx", "scripts/worker-health.ts"];
    await command(probeArgs);
    const stale = { ...state, lastTickAt: Date.now() - 60_000, runId: null };
    await command(["exec", workerId, "node", "-e", `require('fs').writeFileSync(${JSON.stringify(hp)},${JSON.stringify(JSON.stringify(stale))})`]);
    try { await assert.rejects(command(probeArgs), /Docker exec failed/); }
    finally { await command(["exec", workerId, "node", "-e", `require('fs').writeFileSync(${JSON.stringify(hp)},${JSON.stringify(JSON.stringify(state))})`]); }
    report.healthFailureDetection = { missingSchemaReturns503: true, idleStaleProbeFails: true };
    // Wait for an idle tick to avoid accidentally killing during unrelated test work.
    await wait("idle worker", async () => { const s = JSON.parse(await command(["exec", workerId, "cat", hp])); return s.runId === null ? s : false; });
    const killStart = Date.now();
    // Kill the Worker process, not a Docker CLI manual container stop.
    // The exec command can lose its container before it reports success; restart is asserted below.
    await command(["exec", workerId, "node", "-e", `process.kill(${state.pid},'SIGKILL')`]).catch(error => {
      if (!(error instanceof Error) || error.message !== "Docker exec failed") throw error;
    });
    await wait("automatic crash restart", async () => (await info(workerId)).restarts > workerInfo.restarts ? true : false);
    await ready(workerId);
    const restarted = JSON.parse(await command(["exec", workerId, "cat", hp])); assert.notEqual(restarted.workerId, state.workerId);
    report.crashRestart = { actualSigkill: true, automaticRestart: true, readyMs: Date.now() - killStart, workerIdentityChanged: true };
    // Stop during a claimed real request; DB identity and frozen retry policy must survive.
    const entry = (await queue.enqueueRun(targetId, "manual", auth.user.id))!;
    await wait("running attempt before stop", async () => (await row(entry.run.id)).execution_status === "running" ? true : false);
    const stopStart = Date.now(); await command(["stop", "--time", "25", workerId]);
    const stopMs = Date.now() - stopStart;
    const stopped = await info(workerId), saved = await row(entry.run.id);
    assert.equal(stopped.state.ExitCode, 0);
    assert.equal(saved.execution_status, "queued"); assert.equal(saved.error.code, "WORKER_SHUTDOWN"); assert.equal(saved.attempt, 1);
    assert.ok(saved.available_at.getTime() > Date.now() + 280_000);
    await compose("up", "-d", "--no-build", "worker"); await ready(workerId);
    assert.equal((await row(entry.run.id)).execution_status, "queued"); assert.equal((await row(entry.run.id)).attempt, 1);
    report.gracefulShutdown = { stoppedDuringNativeAttempt: true, exitCode: 0, stopMs, persistedSameRun: true, retryDelayAtLeast5Minutes: true, resumedDoesNotClaimEarly: true };
    const sourceAccount = await admin.query('SELECT 1 FROM "user" WHERE email=$1', [email]); assert.equal(sourceAccount.rowCount, 0);
    report.sourceDatabaseUnchanged = true;
    console.log(JSON.stringify({ phase: "runtime_passed", ...report }));
  } finally {
    if (composeStarted) await compose("down", "--remove-orphans");
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (envCreated) await unlink(envFile);
  }
  report.cleanup = { containersRemoved: true, isolatedDatabaseDropped: true, privateEnvDeleted: true };
  assert.ok(process.env.PR6_RUNTIME_OUTPUT);
  await writeFile(process.env.PR6_RUNTIME_OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Runtime acceptance failed"); process.exitCode = 1; });
