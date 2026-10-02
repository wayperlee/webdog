#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getPool } from "../src/lib/db";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { collectCrawlGarbage } from "../src/lib/crawl-gc";
import { executeClaim } from "../src/lib/crawl-worker";

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const queue = new CrawlQueue(getPool());
  const once = process.argv.includes("--once");
  const workerId = `worker-${randomUUID()}`;
  console.log(JSON.stringify({ workerId, dnsResolver: process.env.SITEMAP_DNS_RESOLVER || "system", event: "started" }));
  let lastGc = 0;
  try {
    do {
      try {
        if (Date.now() - lastGc >= 3_600_000) { await collectCrawlGarbage(queue.pool); lastGc = Date.now(); }
        const recovered = await queue.recoverExpired();
        const scheduled = await queue.schedule();
        const run = await queue.claim(workerId);
        const outcome = run ? await executeClaim(queue, run, controller.signal) : "idle";
        console.log(JSON.stringify({ workerId, recovered, scheduled, runId: run?.id, attempt: run?.attempt, outcome }));
        if (!once && !controller.signal.aborted && !run) await delay(5_000, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(JSON.stringify({ code: "WORKER_TICK_FAILED", message: error instanceof Error ? error.message : "Queue operation failed" }));
        if (once) throw error;
        await delay(5_000, undefined, { signal: controller.signal }).catch(() => {});
      }
    } while (!once && !controller.signal.aborted);
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await queue.pool.end(); }
}
main().catch(() => { process.exitCode = 1; });
