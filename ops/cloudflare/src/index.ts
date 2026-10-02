import { DurableObject } from "cloudflare:workers";
import { RuntimeController, containerEnvironment, serviceUnavailable, runtimeErrorReason, type RuntimeEnv } from "./runtime";

interface Env extends RuntimeEnv {
  RADAR_WEB: DurableObjectNamespace<RadarWeb>;
  RADAR_CRAWLER: DurableObjectNamespace<RadarCrawler>;
}

class RadarService extends DurableObject<Env> {
  private readonly runtime: RuntimeController;
  constructor(ctx: DurableObjectState, env: Env, crawler: boolean) {
    super(ctx, env);
    if (!ctx.container) throw new Error("CONTAINER_BINDING_REQUIRED");
    this.runtime = new RuntimeController(ctx.container, env, crawler, 60_000, {
      get: async () => await ctx.storage.get<number>("healthFailures") ?? 0,
      set: async (count) => { await ctx.storage.put("healthFailures", count); },
    });
    if (ctx.container.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(crawler ? 15 * 60_000 : 10 * 60_000));
    }
  }
  async maintain() { await this.runtime.maintain(); }
  async fetch(request: Request) { return this.runtime.fetch(request); }
}

export class RadarWeb extends RadarService {
  private crawlerBootstrapped = false;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env, false); }
  async fetch(request: Request) {
    // New Cron triggers can take minutes to propagate. Start the independent daemon on first access.
    if (!this.crawlerBootstrapped) {
      this.crawlerBootstrapped = true;
      this.ctx.waitUntil(this.env.RADAR_CRAWLER.getByName("crawler").maintain().catch(() => {
        this.crawlerBootstrapped = false;
        console.error(JSON.stringify({ event: "crawler_bootstrap_failed" }));
      }));
    }
    return super.fetch(request);
  }
}
export class RadarCrawler extends RadarService {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env, true); }
  // The crawler health/control port is internal and has no public forwarding path.
  async fetch() { return serviceUnavailable("NOT_FOUND", 404); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { containerEnvironment(env, false); }
    catch { return serviceUnavailable(); }
    if (new URL(request.url).origin !== new URL(env.BETTER_AUTH_URL).origin) {
      return serviceUnavailable("INVALID_ORIGIN", 421);
    }
    try { return await env.RADAR_WEB.getByName("web").fetch(request); }
    catch (error) {
      console.error(JSON.stringify({ event: "web_unavailable", reason: runtimeErrorReason(error, env) }));
      return serviceUnavailable("SERVICE_UNAVAILABLE", 502);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.RADAR_ENABLED !== "true") return;
    try { await env.RADAR_CRAWLER.getByName("crawler").maintain(); }
    catch {
      console.error(JSON.stringify({ event: "crawler_unavailable" }));
      throw new Error("CRAWLER_UNAVAILABLE");
    }
  },
} satisfies ExportedHandler<Env>;
