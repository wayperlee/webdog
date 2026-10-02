import { DEFAULT_LIMITS, SitemapError, type Limits } from "./types";

export class CrawlBudget {
  readonly limits: Limits;
  readonly controller = new AbortController();
  compressedBytes = 0;
  inflatedBytes = 0;
  private readonly started = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort: () => void;

  constructor(overrides: Partial<Limits> = {}, private readonly callerSignal?: AbortSignal) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_LIMITS[key as keyof Limits]) {
        throw new SitemapError("INVALID_LIMIT", `${key} must be within the frozen budget`);
      }
    }
    if (!this.limits.maxAttemptMs || !this.limits.requestTimeoutMs) {
      throw new SitemapError("INVALID_LIMIT", "Timeouts must be positive");
    }
    this.onAbort = () => this.controller.abort(new SitemapError("ABORTED", "Attempt cancelled"));
    callerSignal?.addEventListener("abort", this.onAbort, { once: true });
    if (callerSignal?.aborted) this.onAbort();
    this.timer = setTimeout(() => this.controller.abort(this.timeout()), this.limits.maxAttemptMs);
  }

  private timeout() { return new SitemapError("ATTEMPT_TIMEOUT", "Attempt wall-time budget exceeded", true); }

  check() {
    if (performance.now() - this.started >= this.limits.maxAttemptMs) this.controller.abort(this.timeout());
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }

  wire(bytes: number) {
    this.check();
    this.compressedBytes += bytes;
    if (this.compressedBytes > this.limits.maxCompressedBytes) this.exceeded("compressed bytes");
  }

  inflated(bytes: number) {
    this.check();
    this.inflatedBytes += bytes;
    if (this.inflatedBytes > this.limits.maxInflatedBytes) this.exceeded("inflated bytes");
  }

  exceeded(resource: string): never {
    const error = new SitemapError("RESOURCE_LIMIT", `${resource} budget exceeded`);
    this.controller.abort(error);
    throw error;
  }

  dispose() {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener("abort", this.onAbort);
  }
}
