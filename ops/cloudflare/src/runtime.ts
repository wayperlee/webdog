export interface RuntimeEnv {
  RADAR_ENABLED: string;
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL: string;
  SITEMAP_DNS_RESOLVER: string;
  DATABASE_SCHEMA?: string;
}

export function containerEnvironment(env: RuntimeEnv, crawler: boolean): Record<string, string> {
  if (env.RADAR_ENABLED !== "true") throw new Error("RADAR_DISABLED");
  const database = new URL(env.DATABASE_URL || "");
  const origin = new URL(env.BETTER_AUTH_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol) ||
      database.searchParams.get("sslmode") !== "verify-full" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
      origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(env.DATABASE_SCHEMA || "sitemap_radar") ||
      ["public", "auth", "storage", "extensions", "pg_catalog", "information_schema"].includes(env.DATABASE_SCHEMA || "sitemap_radar") ||
      !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || env.BETTER_AUTH_SECRET.startsWith("replace-") ||
      !["system", "cloudflare-doh"].includes(env.SITEMAP_DNS_RESOLVER)) {
    throw new Error("RUNTIME_CONFIG_INVALID");
  }
  return {
    DATABASE_URL: env.DATABASE_URL!, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: origin.origin, NEXT_PUBLIC_APP_URL: origin.origin,
    SITEMAP_DNS_RESOLVER: env.SITEMAP_DNS_RESOLVER,
    DB_POOL_MAX: crawler ? "2" : "10", DB_CONNECTION_TIMEOUT_MS: "5000", DB_IDLE_TIMEOUT_MS: "30000",
    DB_APPLICATION_NAME: crawler ? "sitemap-radar-cf-crawler" : "sitemap-radar-cf-web",
    DATABASE_SCHEMA: env.DATABASE_SCHEMA || "sitemap_radar",
    NODE_EXTRA_CA_CERTS: "/app/ops/cloudflare/certs/supabase-prod-ca-2021.crt",
    ...(crawler ? { WORKER_HEALTH_FILE: "/tmp/sitemap-worker-health.json", WORKER_HEALTH_PORT: "3001", WORKER_SHUTDOWN_TIMEOUT_MS: "15000" } : { PORT: "3000" }),
  };
}

export interface ContainerRuntime {
  readonly running: boolean;
  start(options: { env: Record<string, string>; entrypoint?: string[]; enableInternet: boolean }): void;
  setInactivityTimeout(ms: number): Promise<void>;
  getTcpPort(port: number): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
  signal(signal: number): void;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
}

export function serviceUnavailable(code = "SERVICE_UNAVAILABLE", status = 503) {
  return new Response(JSON.stringify({ error: code }), { status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CONTAINER_TIMEOUT")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One controller per stable DO instance. Requests never retry application POSTs. */
export class RuntimeController {
  private startup?: Promise<void>;
  private maintenance?: Promise<void>;
  private failures = 0;
  constructor(private readonly container: ContainerRuntime, private readonly env: RuntimeEnv,
    private readonly crawler: boolean, private readonly startupMs = 60_000,
    private readonly failureStore?: { get(): Promise<number>; set(count: number): Promise<void> }) {}

  private async saveFailures(count: number) {
    this.failures = count;
    await this.failureStore?.set(count);
  }

  async probe() {
    if (!this.container.running) return false;
    try {
      const response = await this.container.getTcpPort(this.crawler ? 3001 : 3000).fetch(
        this.crawler ? "http://container/health" : "http://container/api/health",
        { signal: AbortSignal.timeout(8000), redirect: "manual" },
      );
      const ok = response.status === 200 && (await response.json() as { ok?: boolean }).ok === true;
      if (!ok) console.warn(JSON.stringify({ event: "container_health_failed", service: this.crawler ? "crawler" : "web", status: response.status }));
      return ok;
    } catch (error) {
      console.warn(JSON.stringify({ event: "container_probe_failed", service: this.crawler ? "crawler" : "web", reason: String(error).slice(0, 240) }));
      return false;
    }
  }

  ensureRunning() {
    this.startup ??= this.startAndWait().finally(() => { this.startup = undefined; });
    return this.startup;
  }

  private async startAndWait() {
    const env = containerEnvironment(this.env, this.crawler);
    if (!this.container.running) {
      this.container.start({ env, enableInternet: true,
        ...(this.crawler ? { entrypoint: ["/usr/local/bin/radar-entrypoint", "node", "--import", "tsx", "scripts/worker.ts"] } : {}),
      });
    }
    await this.container.setInactivityTimeout(this.crawler ? 15 * 60_000 : 10 * 60_000);
    const deadline = Date.now() + this.startupMs;
    do {
      if (await this.probe()) { await this.saveFailures(0); return; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error("CONTAINER_NOT_READY");
  }

  maintain() {
    this.maintenance ??= this.checkAndRecover().finally(() => { this.maintenance = undefined; });
    return this.maintenance;
  }

  private async checkAndRecover() {
    containerEnvironment(this.env, this.crawler);
    if (!this.container.running) return this.ensureRunning();
    await this.container.setInactivityTimeout(this.crawler ? 15 * 60_000 : 10 * 60_000);
    if (await this.probe()) { await this.saveFailures(0); return; }
    const failures = (await this.failureStore?.get() ?? this.failures) + 1;
    await this.saveFailures(failures);
    if (failures < 3) throw new Error("CONTAINER_NOT_READY");
    this.container.signal(15);
    try { await bounded(this.container.monitor(), 20_000); }
    catch { if (this.container.running) await this.container.destroy(); }
    await this.saveFailures(0);
    await this.ensureRunning();
  }

  async fetch(request: Request) {
    if (!this.container.running || this.startup) await this.ensureRunning();
    else await this.maintain();
    // The private container bridge accepts HTTP; preserve the external canonical host and scheme.
    const external = new URL(request.url), internal = new URL(external);
    internal.protocol = "http:";
    const forwarded = new Request(internal, request);
    forwarded.headers.set("Host", external.host);
    forwarded.headers.set("X-Forwarded-Host", external.host);
    forwarded.headers.set("X-Forwarded-Proto", external.protocol.slice(0, -1));
    // Preserve method, path, query, cookies and body; never replay a failed mutation.
    return this.container.getTcpPort(3000).fetch(forwarded);
  }
}

/** Keep bridge diagnostics useful without logging credentials or request data. */
export function runtimeErrorReason(error: unknown, env: RuntimeEnv): string {
  let reason = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown runtime failure";
  for (const secret of [env.DATABASE_URL, env.BETTER_AUTH_SECRET]) {
    if (secret) reason = reason.replaceAll(secret, "[redacted]");
  }
  reason = reason.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, "[url]");
  return reason.slice(0, 240);
}
