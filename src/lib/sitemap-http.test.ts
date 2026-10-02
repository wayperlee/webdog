import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createSafeFetcher } from "./sitemap/http";
import { CrawlBudget } from "./sitemap/budget";
import { SitemapError } from "./sitemap/types";

const publicIp = "93.184.216.34";
const xml = "<urlset/>";
const errorCode = (expected: string) => (error: unknown) => error instanceof SitemapError && error.code === expected;

async function localFixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://fixture.example:${port}`,
    // Test-only peer substitution lets a local server exercise HTTP behavior.
    // Production connectTcp and the negative private-peer test never substitute peers.
    connect: async (address: { address: string; family: number }, requestedPort: number) => {
      assert.equal(address.address, publicIp); assert.equal(requestedPort, port);
      const socket = net.connect({ host: "127.0.0.1", port }); await once(socket, "connect");
      Object.defineProperty(socket, "remoteAddress", { get: () => publicIp, configurable: true });
      return socket;
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("Safe HTTP rejects mixed/private DNS answers before connecting, including every redirect hop", async () => {
  let connects = 0;
  const budget = new CrawlBudget();
  try {
    for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: publicIp, family: 4 }, { address: "::1", family: 6 }], [{ address: "169.254.169.254", family: 4 }]]) {
      const fetcher = createSafeFetcher({ resolve: async () => addresses, connect: async () => { connects++; throw Error("must not connect"); } });
      await assert.rejects(fetcher("http://fixture.example/sitemap.xml", budget), errorCode("UNSAFE_ADDRESS"));
    }
    assert.equal(connects, 0);
  } finally { budget.dispose(); }
  const fixture = await localFixture((_request, response) => { response.writeHead(302, { Location: "http://127.0.0.1/private" }); response.end(); });
  const redirectBudget = new CrawlBudget();
  try {
    await assert.rejects(createSafeFetcher({ resolve: async () => [{ address: publicIp, family: 4 }], connect: fixture.connect })(`${fixture.url}/sitemap.xml`, redirectBudget), errorCode("UNSAFE_ADDRESS"));
  } finally { redirectBudget.dispose(); await fixture.close(); }
});

test("Connected private peer is rejected before sending any HTTP request", async () => {
  let requests = 0;
  const fixture = await localFixture((_request, response) => { requests++; response.end(xml); });
  const budget = new CrawlBudget();
  try {
    const fetcher = createSafeFetcher({
      resolve: async () => [{ address: publicIp, family: 4 }],
      connect: async (_address, port) => { const socket = net.connect({ host: "127.0.0.1", port }); await once(socket, "connect"); return socket; },
    });
    await assert.rejects(fetcher(`${fixture.url}/sitemap.xml`, budget), errorCode("UNSAFE_ADDRESS"));
    assert.equal(requests, 0);
  } finally { budget.dispose(); await fixture.close(); }
});

test("A different public peer is also rejected; redirected hostname DNS is checked again", async () => {
  let requests = 0;
  const fixture = await localFixture((_request, response) => { requests++; response.writeHead(302, { Location: "http://private.example/hidden" }); response.end(); });
  const budget = new CrawlBudget();
  try {
    const wrongPeer = createSafeFetcher({ resolve: async () => [{ address: publicIp, family: 4 }], connect: async (address, port) => {
      const socket = await fixture.connect(address, port);
      Object.defineProperty(socket, "remoteAddress", { get: () => "8.8.8.8", configurable: true });
      return socket;
    } });
    await assert.rejects(wrongPeer(`${fixture.url}/sitemap.xml`, budget), errorCode("UNSAFE_ADDRESS"));
    assert.equal(requests, 0);
    const redirect = createSafeFetcher({ resolve: async (host) => [{ address: host === "private.example" ? "10.0.0.1" : publicIp, family: 4 }], connect: fixture.connect });
    await assert.rejects(redirect(`${fixture.url}/sitemap.xml`, budget), errorCode("UNSAFE_ADDRESS"));
    assert.equal(requests, 1);
  } finally { budget.dispose(); await fixture.close(); }
});

test("DNS pin is reused for connection; conditional headers are sent only to the matching final URL", async () => {
  let resolutions = 0;
  const requests: { path?: string; etag?: string; modified?: string }[] = [];
  const fixture = await localFixture((request, response) => {
    requests.push({ path: request.url, etag: request.headers["if-none-match"], modified: request.headers["if-modified-since"] });
    if (request.url === "/root.xml") { response.writeHead(302, { Location: "/final.xml" }); response.end(); }
    else if (request.headers["if-none-match"]) { response.writeHead(304, { ETag: '"v1"' }); response.end(); }
    else { response.writeHead(200, { "Content-Encoding": "gzip", ETag: '"v1"' }); response.end(gzipSync(Buffer.from(xml))); }
  });
  const budget = new CrawlBudget();
  try {
    const fetcher = createSafeFetcher({ resolve: async () => { resolutions++; return [{ address: publicIp, family: 4 }]; }, connect: fixture.connect });
    const initial = await fetcher(`${fixture.url}/root.xml`, budget);
    assert.equal(initial.body.toString(), xml); assert.equal(initial.finalUrl, `${fixture.url}/final.xml`);
    const cached = await fetcher(`${fixture.url}/root.xml`, budget, { cache: { revisionId: "id", finalUrl: initial.finalUrl, etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" } });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0); assert.equal(resolutions, 4);
    assert.equal(requests[2].etag, undefined); assert.equal(requests[3].etag, '"v1"'); assert.ok(requests[3].modified);
  } finally { budget.dispose(); await fixture.close(); }
});

test("Retry-After is retained without inline retry; redirect loops and hop caps fail explicitly", async () => {
  let requests = 0;
  const fixture = await localFixture((request, response) => {
    requests++;
    if (request.url === "/busy") { response.writeHead(429, { "Retry-After": "3" }); response.end(); }
    else if (request.url === "/loop") { response.writeHead(302, { Location: "/loop" }); response.end(); }
    else { response.writeHead(302, { Location: "/next" }); response.end(); }
  });
  const fetcher = createSafeFetcher({ resolve: async () => [{ address: publicIp, family: 4 }], connect: fixture.connect });
  for (const [path, limits, expected] of [["/busy", {}, "HTTP_429"], ["/loop", {}, "REDIRECT_LOOP"], ["/root", { maxRedirects: 0 }, "RESOURCE_LIMIT"]] as const) {
    const budget = new CrawlBudget(limits);
    try {
      await assert.rejects(fetcher(`${fixture.url}${path}`, budget), (error: unknown) => {
        assert.ok(errorCode(expected)(error));
        if (path === "/busy") { assert.equal((error as SitemapError).retryAfterMs, 3_000); assert.equal((error as SitemapError).retryable, true); }
        return true;
      });
    } finally { budget.dispose(); }
  }
  assert.equal(requests, 3); await fixture.close();
});

test("Request deadline covers stalled DNS and stalled body; attempt deadline wins across requests", async () => {
  const fixture = await localFixture((_request, response) => { response.writeHead(200); response.write("<urlset>"); });
  for (const [fetcher, limits, expected] of [
    [createSafeFetcher({ resolve: () => new Promise(() => {}) }), { requestTimeoutMs: 20 }, "REQUEST_TIMEOUT"],
    [createSafeFetcher({ resolve: async () => [{ address: publicIp, family: 4 }], connect: fixture.connect }), { requestTimeoutMs: 20 }, "REQUEST_TIMEOUT"],
    [createSafeFetcher({ resolve: () => new Promise(() => {}) }), { requestTimeoutMs: 100, maxAttemptMs: 20 }, "ATTEMPT_TIMEOUT"],
  ] as const) {
    const budget = new CrawlBudget(limits);
    const start = performance.now();
    try { await assert.rejects(fetcher(`${fixture.url}/sitemap.xml`, budget), errorCode(expected)); assert.ok(performance.now() - start < 1_000); }
    finally { budget.dispose(); }
  }
  await fixture.close();
});
