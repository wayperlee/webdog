import { crawlSitemaps, SitemapError, type CrawlResult } from "./sitemap";
import { CrawlQueue, QueueError, type RunError, type RunRow } from "./crawl-queue";

export async function executeClaim(queue: CrawlQueue, run: RunRow, shutdown?: AbortSignal, crawler = crawlSitemaps) {
  const controller = new AbortController();
  let heartbeat: Promise<void> | undefined;
  let leaseLost = false;
  const abort = () => controller.abort();
  shutdown?.addEventListener("abort", abort, { once: true });
  if (shutdown?.aborted) abort();
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = queue.heartbeat(run).catch(() => { leaseLost = true; controller.abort(); }).finally(() => { heartbeat = undefined; });
  }, 20_000);
  let result: CrawlResult | undefined;
  let failed: RunError | undefined;
  try {
    const state = await queue.loadState(run);
    result = await crawler({ ...run.config, state, signal: controller.signal });
  } catch (error) {
    failed = error instanceof SitemapError ? { code: error.code, message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterMs }
      : { code: error instanceof QueueError ? error.code : "WORKER_ERROR", message: "Worker attempt failed", retryable: !(error instanceof QueueError) };
  } finally {
    clearInterval(timer); await heartbeat;
    shutdown?.removeEventListener("abort", abort);
  }
  if (leaseLost) return "lease_lost";
  try {
    if (shutdown?.aborted) await queue.fail(run, { code: "WORKER_SHUTDOWN", message: "Worker stopped", retryable: true });
    else if (result) await queue.finish(run, result);
    else await queue.fail(run, failed ?? { code: "WORKER_ERROR", message: "Missing attempt result", retryable: true });
    return "finished";
  } catch (error) {
    if (error instanceof QueueError && error.code === "LEASE_LOST") return "lease_lost";
    // Uncertain persistence leaves the running row for lease recovery, never writes a second transition.
    throw error;
  }
}
