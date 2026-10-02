import test from "node:test";
import assert from "node:assert/strict";
import { createCloudflareDohResolver } from "./sitemap/dns";
import { createConfiguredFetcher, createSafeFetcher } from "./sitemap/http";
import { SitemapError } from "./sitemap/types";
import { CrawlBudget } from "./sitemap/budget";

const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => error instanceof SitemapError && error.code === expected;
const answer = (type: number, data: string, TTL = 60) => ({ type, data, TTL });
const json = (Answer: unknown[] = [], Status = 0) => Response.json({ Status, Answer });

test("DoH uses a fixed HTTPS endpoint, queries both families, respects TTL and isolates cache copies", async () => {
  let calls = 0, time = 0;
  const resolver = createCloudflareDohResolver(async (input, options) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, "https://cloudflare-dns.com"); assert.equal(url.pathname, "/dns-query");
    assert.equal(url.searchParams.get("name"), "fixture.example"); assert.equal(options?.redirect, "manual"); assert.ok(options?.signal);
    return url.searchParams.get("type") === "A" ? json([answer(5, "alias.example", 10), answer(1, "8.8.8.8")]) : json([answer(28, "2606:4700:4700::1111")]);
  }, () => time);
  const first = await resolver("fixture.example", signal()); assert.equal(calls, 2); assert.equal(first.length, 2);
  first[0].address = "127.0.0.1";
  time = 9_999; assert.equal((await resolver("fixture.example", signal()))[0].address, "8.8.8.8"); assert.equal(calls, 2);
  time = 10_000; await resolver("fixture.example", signal()); assert.equal(calls, 4);
});

test("DoH rejects private/fake-IP/mismatched family answers, including mixed IPv4/IPv6", async () => {
  for (const bad of [answer(1, "127.0.0.1"), answer(1, "198.18.1.1"), answer(1, "169.254.169.254"), answer(28, "::1"), answer(28, "8.8.8.8")]) {
    const resolver = createCloudflareDohResolver(async (input) => new URL(String(input)).searchParams.get("type") === "A" ? json([answer(1, "8.8.8.8")]) : json([bad]));
    await assert.rejects(resolver("fixture.example", signal()), code("UNSAFE_ADDRESS"));
  }
});

test("DoH fails closed on incomplete families, NXDOMAIN, empty records, malformed and oversized responses", async () => {
  const malformed = [() => Response.json({ Status: 0, TC: true }), () => json([], 3), () => json(),
    () => json([answer(1, "not-an-IP")]), () => Response.json({ Status: 0, Answer: "invalid" }),
    () => json([answer(1, "8.8.8.8", -1)]), () => new Response("{"),
    () => new Response("x".repeat(65_537)), () => json(Array.from({ length: 129 }, () => answer(1, "8.8.8.8")))];
  for (const response of malformed) await assert.rejects(createCloudflareDohResolver(async () => response())("fixture.example", signal()), (error: unknown) => error instanceof SitemapError && ["DNS_RESPONSE_ERROR", "UNSAFE_ADDRESS"].includes(error.code));
  const missingFamily = createCloudflareDohResolver(async (input) => new URL(String(input)).searchParams.get("type") === "A" ? json([answer(1, "8.8.8.8")]) : json([], 2));
  await assert.rejects(missingFamily("fixture.example", signal()), code("DNS_RESPONSE_ERROR"));
});

test("DoH rejects HTTPS redirects, preserves Retry-After and does not cache failures or zero-TTL replies", async () => {
  let calls = 0;
  const redirected = createCloudflareDohResolver(async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); });
  await assert.rejects(redirected("fixture.example", signal()), code("DNS_HTTP_ERROR")); assert.equal(calls, 2);
  await assert.rejects(createCloudflareDohResolver(async () => new Response(null, { status: 429, headers: { "retry-after": "15" } }))("fixture.example", signal()), (error: unknown) => {
    assert.ok(error instanceof SitemapError); assert.equal(error.retryAfterMs, 15_000); assert.equal(error.retryable, true); return true;
  });
  let valid = false; const resolver = createCloudflareDohResolver(async () => valid ? json([answer(1, "8.8.8.8", 0)]) : json([], 2));
  await assert.rejects(resolver("fixture.example", signal()), code("DNS_RESPONSE_ERROR")); valid = true; await resolver("fixture.example", signal());
  valid = false; await assert.rejects(resolver("fixture.example", signal()), code("DNS_RESPONSE_ERROR"));
});

test("DoH propagates cancellation to both HTTP queries and observes request/attempt deadlines", async () => {
  let cancelled = 0;
  const resolver = createCloudflareDohResolver((_input, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => { cancelled++; reject(options!.signal!.reason); }, { once: true });
  }));
  const controller = new AbortController(); const aborted = resolver("fixture.example", controller.signal);
  controller.abort(new SitemapError("ABORTED", "cancelled")); await assert.rejects(aborted, code("ABORTED")); assert.equal(cancelled, 2);
  for (const [limits, expected] of [[{ requestTimeoutMs: 20 }, "REQUEST_TIMEOUT"], [{ requestTimeoutMs: 100, maxAttemptMs: 20 }, "ATTEMPT_TIMEOUT"]] as const) {
    const budget = new CrawlBudget(limits);
    try { await assert.rejects(createSafeFetcher({ resolve: resolver })("https://fixture.example/sitemap.xml", budget), code(expected)); }
    finally { budget.dispose(); }
  }
  assert.equal(cancelled, 6);
});

test("DoH address does not authorize a private connected peer, and invalid resolver configuration is explicit", async () => {
  let connections = 0;
  const resolver = createCloudflareDohResolver(async () => json([answer(1, "8.8.8.8")]));
  const budget = new CrawlBudget();
  try {
    const fetcher = createSafeFetcher({ resolve: resolver, connect: async () => {
      connections++; return { remoteAddress: "127.0.0.1", destroy() {} } as never;
    } });
    await assert.rejects(fetcher("https://fixture.example/sitemap.xml", budget), code("UNSAFE_ADDRESS")); assert.equal(connections, 1);
  } finally { budget.dispose(); }
  assert.throws(() => createConfiguredFetcher("unknown"), code("INVALID_DNS_RESOLVER"));
});


test("DoH internal deadline aborts both family requests", async () => {
  let cancelled = 0;
  const resolver = createCloudflareDohResolver((_input, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => { cancelled++; reject(options!.signal!.reason); }, { once: true });
  }));
  await assert.rejects(resolver("fixture.example", signal()), code("DNS_TIMEOUT"));
  assert.equal(cancelled, 2);
});
