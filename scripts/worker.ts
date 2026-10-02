#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getPool } from "../src/lib/db";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { collectCrawlGarbage } from "../src/lib/crawl-gc";
import { executeClaim } from "../src/lib/crawl-worker";
import { databaseReady, workerReady, writeWorkerHealth, type WorkerHealth } from "../src/lib/runtime-health";
import { envInteger } from "../src/lib/runtime-config";
import { startWorkerHealthServer, closeWorkerHealthServer } from "../src/lib/worker-health-server";
import type { Server } from "node:http";

async function main() {
  const controller = new AbortController();
  const shutdownMs = envInteger(process.env, "WORKER_SHUTDOWN_TIMEOUT_MS", 15_000, 1000, 30_000);
  let shutdownTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    controller.abort();
    if (!shutdownTimer) shutdownTimer = setTimeout(() => {
      console.error(JSON.stringify({ event: "shutdown_timeout", code: "WORKER_SHUTDOWN_TIMEOUT" }));
      process.exit(1); // Lease recovery owns any uncertain persistence after forced exit.
    }, shutdownMs).unref();
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.env.DB_POOL_MAX ||= "2";
  process.env.DB_APPLICATION_NAME ||= "sitemap-radar-worker";
  const queue = new CrawlQueue(getPool());
  const once = process.argv.includes("--once");
  const workerId = `worker-${randomUUID()}`;
  const state: WorkerHealth = { version: 1, pid: process.pid, workerId, lastTickAt: 0, runId: null, stopping: false };
  const health = async () => { if (process.env.WORKER_HEALTH_FILE) await writeWorkerHealth(process.env.WORKER_HEALTH_FILE, state); };
  console.log(JSON.stringify({ workerId, dnsResolver: process.env.SITEMAP_DNS_RESOLVER || "system", event: "started", poolMax: queue.pool.options.max }));
  let lastGc = 0;
  let healthServer: Server | undefined;
  try {
    await databaseReady(queue.pool);
    state.lastTickAt = Date.now(); await health();
    if (process.env.WORKER_HEALTH_PORT) {
      const path = process.env.WORKER_HEALTH_FILE;
      if (!path) throw new Error("WORKER_HEALTH_FILE_REQUIRED");
      healthServer = await startWorkerHealthServer(
        envInteger(process.env, "WORKER_HEALTH_PORT", 3001, 1, 65535),
        () => workerReady(queue.pool, path),
      );
    }
    do {
      try {
        if (Date.now() - lastGc >= 3_600_000) { await collectCrawlGarbage(queue.pool); lastGc = Date.now(); }
        const recovered = await queue.recoverExpired();
        const scheduled = await queue.schedule();
        const run = await queue.claim(workerId);
        state.runId = run?.id ?? null; state.lastTickAt = Date.now(); await health();
        const outcome = run ? await executeClaim(queue, run, controller.signal) : "idle";
        state.runId = null; state.lastTickAt = Date.now(); await health();
        console.log(JSON.stringify({ event: "tick", workerId, recovered, scheduled, runId: run?.id, attempt: run?.attempt, outcome }));
        if (!once && !controller.signal.aborted && !run) await delay(5_000, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(JSON.stringify({ workerId, code: "WORKER_TICK_FAILED", message: "Queue operation failed" }));
        if (once) throw error;
        await delay(5_000, undefined, { signal: controller.signal }).catch(() => {});
      }
    } while (!once && !controller.signal.aborted);
  } finally {
    state.stopping = true; await health().catch(() => {});
    if (healthServer) await closeWorkerHealthServer(healthServer);
    await queue.pool.end();
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    console.log(JSON.stringify({ event: "stopped", workerId }));
  }
}
main().catch(() => { console.error(JSON.stringify({ code: "WORKER_START_FAILED" })); process.exitCode = 1; });
