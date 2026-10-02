import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeController, containerEnvironment, runtimeErrorReason, type ContainerRuntime, type RuntimeEnv } from "../../ops/cloudflare/src/runtime";

const env: RuntimeEnv = { RADAR_ENABLED: "true", DATABASE_URL: "postgresql://radar:private@database.example/radar?sslmode=verify-full",
  BETTER_AUTH_SECRET: "a".repeat(40), BETTER_AUTH_URL: "https://sitemap.lipeiwei.com", SITEMAP_DNS_RESOLVER: "cloudflare-doh" };

function fakeContainer() {
  let running = false, healthy = true, starts = 0, signals = 0, forwarded = 0;
  const requests: Request[] = [];
  const runtime: ContainerRuntime = {
    get running() { return running; },
    start() { running = true; healthy = true; starts++; },
    async setInactivityTimeout() {},
    getTcpPort() { return { async fetch(input) {
      if (input instanceof Request) { forwarded++; requests.push(input); throw new Error("connection lost after application mutation"); }
      return Response.json({ ok: healthy }, { status: healthy ? 200 : 503 });
    } }; },
    signal() { signals++; running = false; },
    async monitor() {}, async destroy() { running = false; },
  };
  return { runtime, requests, unhealthy() { healthy = false; }, counts: () => ({ starts, signals, forwarded }) };
}

test("Cloudflare activation requires secrets before starting compute", async () => {
  for (const bad of [{ ...env, RADAR_ENABLED: "false" }, { ...env, DATABASE_URL: undefined },
    { ...env, DATABASE_URL: "postgres://radar:private@127.0.0.1/radar" }, { ...env, BETTER_AUTH_SECRET: "short" }]) {
    const container = fakeContainer();
    await assert.rejects(new RuntimeController(container.runtime, bad, true).ensureRunning());
    assert.equal(container.counts().starts, 0);
  }
  const configured = containerEnvironment(env, true);
  assert.equal(configured.DATABASE_SCHEMA, "sitemap_radar");
  assert.equal(configured.WORKER_HEALTH_PORT, "3001");
  assert.equal(configured.NODE_EXTRA_CA_CERTS, "/app/ops/cloudflare/certs/supabase-prod-ca-2021.crt");
  assert.throws(() => containerEnvironment({ ...env, DATABASE_URL: env.DATABASE_URL!.replace("verify-full", "require") }, false));
});

test("Simultaneous cold requests start exactly one container", async () => {
  const container = fakeContainer(), control = new RuntimeController(container.runtime, env, false);
  await Promise.all(Array.from({ length: 20 }, () => control.ensureRunning()));
  assert.equal(container.counts().starts, 1);
});

test("Health failures survive control-plane eviction and recover without changing queue facts", async () => {
  const container = fakeContainer();
  let persisted = 0;
  const store = { async get() { return persisted; }, async set(value: number) { persisted = value; } };
  await new RuntimeController(container.runtime, env, true, 60_000, store).ensureRunning();
  container.unhealthy();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(new RuntimeController(container.runtime, env, true, 60_000, store).maintain(), /CONTAINER_NOT_READY/);
  }
  assert.equal(container.counts().signals, 0);
  await new RuntimeController(container.runtime, env, true, 60_000, store).maintain();
  assert.equal(container.counts().signals, 1); assert.equal(container.counts().starts, 2);
  assert.equal(persisted, 0);
});

test("A failed POST is forwarded once and never replayed", async () => {
  const container = fakeContainer();
  await assert.rejects(new RuntimeController(container.runtime, env, false).fetch(
    new Request("https://sitemap.lipeiwei.com/api/websites?check=1", { method: "POST", body: "{}", headers: { Cookie: "session=test", Origin: "https://sitemap.lipeiwei.com" } }),
  ));
  assert.equal(container.counts().forwarded, 1);
  const forwarded = container.requests[0];
  assert.equal(forwarded.url, "http://sitemap.lipeiwei.com/api/websites?check=1");
  assert.equal(forwarded.headers.get("X-Forwarded-Proto"), "https");
  assert.equal(forwarded.headers.get("Cookie"), "session=test");
  assert.equal(forwarded.headers.get("Origin"), "https://sitemap.lipeiwei.com");
  assert.equal(await forwarded.text(), "{}");
});

test("Runtime diagnostics redact credentials and URLs", () => {
  const reason = runtimeErrorReason(new Error(`${env.DATABASE_URL} ${env.BETTER_AUTH_SECRET} https://example.com/?token=secret`), env);
  assert.equal(reason.includes("private"), false);
  assert.equal(reason.includes(env.BETTER_AUTH_SECRET!), false);
  assert.equal(reason.includes("token=secret"), false);
  assert.equal(runtimeErrorReason(new Error("CONTAINER_NOT_READY"), env), "Error: CONTAINER_NOT_READY");
});
