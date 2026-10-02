import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { crawlSitemaps, SitemapError } from "./sitemap";
import { CrawlBudget } from "./sitemap/budget";
import { decodeBody, type SitemapFetcher } from "./sitemap/http";
import { parseSitemapXml } from "./sitemap/xml";
import { normalizeHttpUrl, normalizedPageHosts, isPublicAddress } from "./sitemap/urls";
import type { CrawlOptions } from "./sitemap";

const base = "https://example.com";
const root = `${base}/sitemap.xml`;
const xml = (kind: "urlset" | "index", locations: string[]) => `<${kind === "index" ? "sitemapindex" : "urlset"} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((loc) => `<${kind === "index" ? "sitemap" : "url"}><loc>${loc.replaceAll("&", "&amp;")}</loc></${kind === "index" ? "sitemap" : "url"}>`).join("")}</${kind === "index" ? "sitemapindex" : "urlset"}>`;
type Fixture = string | SitemapError | "304";
function fixture(values: Record<string, Fixture>, calls: string[] = [], options: CrawlOptions["limits"] = {}): CrawlOptions {
  const fetcher: SitemapFetcher = async (url, budget, request) => {
    budget.check(); calls.push(url);
    const value = values[url];
    if (value instanceof SitemapError) throw value;
    if (value === undefined) throw new SitemapError("HTTP_404", "Fixture missing");
    if (value === "304") return { status: 304, finalUrl: url, body: Buffer.alloc(0), etag: request?.cache?.etag };
    const body = Buffer.from(value); budget.wire(body.length); budget.inflated(body.length);
    if (body.length > Math.min(request?.maxBodyBytes ?? Infinity, budget.limits.maxFileBytes)) budget.exceeded("fixture file bytes");
    return { status: 200, finalUrl: url, body, etag: `"${body.length}"` };
  };
  return { siteUrl: base, roots: [root], fetcher, limits: options };
}
const code = (expected: string) => (error: unknown) => error instanceof SitemapError && error.code === expected;

test("XML: namespaces, CDATA, entities, extension metadata and legitimate empty documents", async () => {
  const content = '<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:x="urn:x"><s:url><s:loc><![CDATA[https://example.com/?a=1&b=2]]></s:loc><x:image><x:loc>ignore</x:loc></x:image></s:url></s:urlset>';
  assert.deepEqual(await parseSitemapXml(Buffer.from(content)), { kind: "urlset", locations: [`${base}/?a=1&b=2`] });
  assert.deepEqual(await parseSitemapXml(Buffer.from(xml("urlset", []))), { kind: "urlset", locations: [] });
  assert.deepEqual((await parseSitemapXml(Buffer.from(xml("urlset", [`${base}/?a=1&b=2`])))).locations, [`${base}/?a=1&b=2`]);
});

test("XML: HTML, malformed, DTD, unknown entities, invalid UTF-8 and bad entries are distinct failures", async () => {
  for (const [content, expected] of [
    ["<!doctype html><html>challenge</html>", "HTML_DOCUMENT"], ["<urlset>", "INVALID_XML"],
    ['<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>', "DTD_DISALLOWED"],
    ["<urlset><url><loc>&unknown;</loc></url></urlset>", "INVALID_XML"],
    ["<urlset><url/></urlset>", "INVALID_XML"], ["<urlset><url><loc>x</loc><loc>y</loc></url></urlset>", "INVALID_XML"],
    ["<urlset><url><loc><x/></loc></url></urlset>", "INVALID_XML"],
  ]) await assert.rejects(parseSitemapXml(Buffer.from(content)), code(expected));
  await assert.rejects(parseSitemapXml(Buffer.from([0xff])), code("INVALID_ENCODING"));
  await assert.rejects(parseSitemapXml(Buffer.from(xml("urlset", Array(50_001).fill(`${base}/a`)))), code("RESOURCE_LIMIT"));
});

test("Normalization preserves query order, slash and path case; private and ambiguous host scopes are rejected", () => {
  assert.equal(normalizeHttpUrl("HTTPS://EXAMPLE.COM:443/A/?b=2&a=1#hash"), `${base}/A/?b=2&a=1`);
  for (const url of ["http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "http://user:pass@example.com/", "http://example.com/a b"]) assert.throws(() => normalizeHttpUrl(url));
  for (const address of ["10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "224.0.0.1", "::", "fc00::1", "fe80::1", "2001:db8::1", "2002:0808:0808::1", "64:ff9b::808:808"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const host of ["example.com#x", "example.com/path", "user@example.com", "example.com:123"]) assert.throws(() => normalizedPageHosts(new URL(base), [host]));
});

test("Streaming gzip: magic, HTTP encoding, double gzip, split header, corruption and inflation caps", async () => {
  const bytes = Buffer.from(xml("urlset", [`${base}/a`]));
  for (const [input, encoding] of [[bytes, ""], [gzipSync(bytes), ""], [gzipSync(bytes), "gzip"], [gzipSync(gzipSync(bytes)), "gzip"]] as const) {
    const budget = new CrawlBudget();
    try { assert.deepEqual(await decodeBody(Readable.from([input.subarray(0, 1), input.subarray(1)]), encoding, budget), bytes); assert.equal(budget.compressedBytes, input.length); assert.equal(budget.inflatedBytes, bytes.length + (encoding === "gzip" && input.equals(gzipSync(gzipSync(bytes))) ? gzipSync(bytes).length : 0)); }
    finally { budget.dispose(); }
  }
  for (const [input, encoding, expected, limits] of [
    [bytes, "gzip", "DECOMPRESSION_ERROR", {}], [gzipSync(bytes).subarray(0, 15), "", "DECOMPRESSION_ERROR", {}],
    [gzipSync(Buffer.alloc(100_000)), "", "RESOURCE_LIMIT", { maxFileBytes: 100 }],
    [bytes, "", "RESOURCE_LIMIT", { maxCompressedBytes: 10 }], [bytes, "", "RESOURCE_LIMIT", { maxInflatedBytes: 10 }],
    [bytes, "br", "UNSUPPORTED_ENCODING", {}],
    [gzipSync(gzipSync(bytes)), "gzip", "RESOURCE_LIMIT", { maxInflatedBytes: bytes.length }],
  ] as const) {
    const budget = new CrawlBudget(limits);
    try { await assert.rejects(decodeBody(Readable.from([input]), encoding, budget), code(expected)); }
    finally { budget.dispose(); }
  }
});

test("Interrupted gzip network stream remains retryable and differs from corrupt gzip", async () => {
  async function* interrupted() {
    yield gzipSync(Buffer.from(xml("urlset", []))).subarray(0, 12);
    throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
  }
  const budget = new CrawlBudget();
  try {
    await assert.rejects(decodeBody(interrupted(), "gzip", budget), (error: unknown) => {
      assert.ok(code("NETWORK_ERROR")(error)); assert.equal((error as SitemapError).retryable, true); return true;
    });
  } finally { budget.dispose(); }
});

test("Source DAG: nested indexes, shared child fetched once, full union and parent graph", async () => {
  const child = `${base}/child.xml`, other = `${base}/other.xml`, leaf = `${base}/leaf.xml`;
  const calls: string[] = [];
  const result = await crawlSitemaps(fixture({ [root]: xml("index", [child, other]), [child]: xml("index", [leaf]), [other]: xml("index", [leaf]), [leaf]: xml("urlset", [`${base}/a`, `${base}/a`, "https://www.example.com/b", "https://other.com/c"]) }, calls));
  assert.equal(result.completeness, "complete");
  assert.deepEqual(result.urls, [`${base}/a`, "https://www.example.com/b"]);
  assert.equal(result.outOfScopeUrlCount, 1);
  assert.deepEqual(result.sources.find((source) => source.url === leaf)?.parents, [child, other]);
  assert.equal(calls.filter((url) => url === leaf).length, 1);
});

test("304 index still fetches children; valid leaf 304 restores its revision", async () => {
  const child = `${base}/child.xml`;
  const first = await crawlSitemaps(fixture({ [root]: xml("index", [child]), [child]: xml("urlset", [`${base}/a`]) }));
  const calls: string[] = [];
  const second = await crawlSitemaps({ ...fixture({ [root]: "304", [child]: xml("urlset", [`${base}/b`]) }, calls), state: first.state });
  assert.deepEqual(calls, [root, child]); assert.deepEqual(second.urls, [`${base}/b`]);
  assert.equal(second.sources[0].status, "not_modified");
  const third = await crawlSitemaps({ ...fixture({ [root]: "304", [child]: "304" }), state: second.state });
  assert.deepEqual(third.urls, second.urls);
});

test("Missing/corrupt revision never turns 304 into an empty success", async () => {
  const first = await crawlSitemaps(fixture({ [root]: xml("urlset", [`${base}/a`]) }));
  first.state.revisions = {};
  const result = await crawlSitemaps({ ...fixture({ [root]: "304" }), state: first.state });
  assert.equal(result.completeness, "unusable"); assert.equal(result.urls, null); assert.equal(result.issues[0].code, "INVALID_304");
});

test("304 at a different final URL is rejected and corrupt cache is fetched unconditionally", async () => {
  const first = await crawlSitemaps(fixture({ [root]: xml("urlset", [`${base}/a`]) }));
  const wrong = await crawlSitemaps({ ...fixture({}), state: first.state, fetcher: async () => ({ status: 304, body: Buffer.alloc(0), finalUrl: `${base}/other.xml` }) });
  assert.equal(wrong.issues[0].code, "INVALID_304"); assert.equal(wrong.urls, null);
  first.state.revisions[first.state.cache[root].revisionId].locations = [`${base}/tampered`];
  const ordinary = fixture({ [root]: xml("urlset", [`${base}/b`]) });
  const result = await crawlSitemaps({ ...ordinary, state: first.state, fetcher: async (url, budget, options) => {
    assert.equal(options?.cache, undefined); return ordinary.fetcher!(url, budget, options);
  } });
  assert.equal(result.completeness, "complete"); assert.deepEqual(result.urls, [`${base}/b`]);
});

test("Cached revisions survive arbitrarily old repeated 304 responses", async () => {
  let result = await crawlSitemaps(fixture({ [root]: xml("urlset", [`${base}/a`]) }));
  result.state.cache[root].lastModified = "Wed, 01 Jan 2020 00:00:00 GMT";
  for (let i = 0; i < 40; i++) result = await crawlSitemaps({ ...fixture({ [root]: "304" }), state: result.state });
  assert.equal(result.completeness, "complete"); assert.deepEqual(result.urls, [`${base}/a`]); assert.equal(Object.keys(result.state.revisions).length, 1);
});

test("Partial child failure preserves live sources; only complete graph can retire an unreferenced child", async () => {
  const a = `${base}/a.xml`, b = `${base}/b.xml`;
  const first = await crawlSitemaps(fixture({ [root]: xml("index", [a, b]), [a]: xml("urlset", [`${base}/a`]), [b]: xml("urlset", [`${base}/b`]) }));
  const partial = await crawlSitemaps({ ...fixture({ [root]: xml("index", [a]), [a]: new SitemapError("HTTP_503", "Unavailable", true, 5_000) }), state: first.state });
  assert.equal(partial.completeness, "partial"); assert.equal(partial.urls, null); assert.deepEqual(partial.retiredSources, []); assert.deepEqual(partial.state.liveSources, first.state.liveSources);
  assert.equal(partial.issues[0].retryAfterMs, 5_000);
  const complete = await crawlSitemaps({ ...fixture({ [root]: xml("index", [a]), [a]: xml("urlset", [`${base}/a`]) }), state: partial.state });
  assert.deepEqual(complete.retiredSources, [b]);
});

test("A source still referenced by another root is never retired; split movement preserves page union", async () => {
  const a = `${base}/a.xml`, b = `${base}/b.xml`, secondRoot = `${base}/second.xml`;
  const one = await crawlSitemaps({ ...fixture({ [root]: xml("index", [a, b]), [secondRoot]: xml("index", [b]), [a]: xml("urlset", [`${base}/page`]), [b]: xml("urlset", []) }), roots: [root, secondRoot] });
  const two = await crawlSitemaps({ ...fixture({ [root]: xml("index", [a]), [secondRoot]: xml("index", [b]), [a]: xml("urlset", []), [b]: xml("urlset", [`${base}/page`]) }), roots: [root, secondRoot], state: one.state });
  assert.deepEqual(two.urls, one.urls); assert.deepEqual(two.retiredSources, []);
});

test("Discovery reads robots directives and fixes roots; subsequent root failure does not rediscover", async () => {
  const calls: string[] = [];
  const first = await crawlSitemaps({ ...fixture({ [`${base}/robots.txt`]: `User-agent: *\nSitemap: ${root}\n`, [root]: xml("urlset", []) }, calls), roots: undefined });
  assert.equal(first.completeness, "complete"); assert.deepEqual(first.state.roots, [root]);
  const later: string[] = [];
  const failed = await crawlSitemaps({ ...fixture({ [root]: new SitemapError("HTTP_404", "Gone") }, later), roots: undefined, state: first.state });
  assert.deepEqual(later, [root]); assert.equal(failed.urls, null); assert.deepEqual(failed.state.roots, [root]);
});

test("Discovery conventional roots: missing fallback okay; a failed candidate blocks a smaller baseline", async () => {
  const first = await crawlSitemaps({ ...fixture({ [root]: xml("urlset", []) }), roots: undefined });
  assert.equal(first.completeness, "complete");
  const bad = await crawlSitemaps({ ...fixture({ [root]: xml("urlset", []), [`${base}/sitemap_index.xml`]: new SitemapError("HTTP_503", "Unavailable", true) }), roots: undefined });
  assert.equal(bad.completeness, "partial"); assert.equal(bad.urls, null); assert.deepEqual(bad.state.roots, []);
  const challenge = await crawlSitemaps({ ...fixture({ [`${base}/robots.txt`]: "<html>Challenge</html>", [root]: xml("urlset", []) }), roots: undefined });
  assert.equal(challenge.completeness, "unusable"); assert.equal(challenge.issues[0].code, "HTML_DOCUMENT");
});

test("Root and host changes require an explicit new baseline", async () => {
  const first = await crawlSitemaps(fixture({ [root]: xml("urlset", []) }));
  await assert.rejects(crawlSitemaps({ ...fixture({}), roots: [`${base}/new.xml`], state: first.state }), code("SCOPE_CHANGE_REQUIRED"));
  await assert.rejects(crawlSitemaps({ ...fixture({}), allowedPageHosts: ["www.example.com"], state: first.state }), code("SCOPE_CHANGE_REQUIRED"));
});

test("Cycle, deep/shared paths, file/URL/byte caps all return null rather than a truncated set", async () => {
  const a = `${base}/a.xml`, b = `${base}/b.xml`;
  for (const options of [
    fixture({ [root]: xml("index", [a]), [a]: xml("index", [root]) }),
    fixture({ [root]: xml("index", [a]), [a]: xml("urlset", []) }, [], { maxFiles: 1 }),
    fixture({ [root]: xml("index", [a]), [a]: xml("urlset", []) }, [], { maxDepth: 0 }),
    fixture({ [root]: xml("index", [a, b]), [a]: xml("index", [b]), [b]: xml("urlset", []) }, [], { maxDepth: 1 }),
    fixture({ [root]: xml("urlset", [`${base}/a`, `${base}/b`]) }, [], { maxUrls: 1 }),
    fixture({ [root]: xml("urlset", ["https://other.com/a", "https://other.com/b"]) }, [], { maxUrls: 1 }),
    fixture({ [root]: xml("urlset", []) }, [], { maxFileBytes: 10 }),
    fixture({ [root]: xml("urlset", []) }, [], { maxCompressedBytes: 10 }),
    fixture({ [root]: xml("urlset", []) }, [], { maxInflatedBytes: 10 }),
    fixture({ [root]: xml("urlset", ["/relative"]) }),
  ]) {
    const result = await crawlSitemaps(options);
    assert.notEqual(result.completeness, "complete"); assert.equal(result.urls, null); assert.ok(result.issues.length);
  }
});

test("Attempt deadline and caller cancellation are bounded; frozen ceilings cannot be raised", async () => {
  await assert.rejects(crawlSitemaps({ ...fixture({}), limits: { maxFiles: 501 } }), code("INVALID_LIMIT"));
  const controller = new AbortController(); controller.abort();
  const cancelled = await crawlSitemaps({ ...fixture({}), signal: controller.signal });
  assert.equal(cancelled.issues[0].code, "ABORTED"); assert.equal(cancelled.urls, null);
  const budget = new CrawlBudget({ maxAttemptMs: 5 });
  try { await new Promise((resolve) => setTimeout(resolve, 10)); assert.throws(() => budget.check(), code("ATTEMPT_TIMEOUT")); }
  finally { budget.dispose(); }
});
