import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { lookup } from "node:dns/promises";
import { Readable, type Duplex } from "node:stream";
import { createGunzip } from "node:zlib";
import ipaddr from "ipaddr.js";
import { CrawlBudget } from "./budget";
import { SitemapError, type SourceCache } from "./types";
import { hostname, isPublicAddress, normalizeHttpUrl } from "./urls";

type Address = { address: string; family: number };
export type HttpResult = { status: 200 | 304; finalUrl: string; body: Buffer; etag?: string; lastModified?: string };
export type FetchOptions = { cache?: SourceCache; maxBodyBytes?: number };
export type SitemapFetcher = (url: string, budget: CrawlBudget, options?: FetchOptions) => Promise<HttpResult>;
type Dependencies = {
  resolve?: (host: string) => Promise<Address[]>;
  connect?: (address: Address, port: number, signal: AbortSignal) => Promise<net.Socket>;
};

function aborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function connectTcp(address: Address, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address.address, family: address.family, port });
    const timer = setTimeout(() => socket.destroy(new SitemapError("NETWORK_ERROR", "TCP connection timed out", true)), 5_000);
    const abort = () => socket.destroy(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    socket.once("error", (error) => { cleanup(); reject(error); });
    socket.once("connect", () => { cleanup(); resolve(socket); });
    if (signal.aborted) abort();
  });
}

function verifyPeer(socket: net.Socket, address: Address) {
  const peer = socket.remoteAddress;
  if (!peer || !isPublicAddress(peer) || ipaddr.process(peer).toString() !== ipaddr.process(address.address).toString()) {
    socket.destroy();
    throw new SitemapError("UNSAFE_ADDRESS", "Connected peer differs from the validated public address");
  }
}

async function secureSocket(socket: net.Socket, host: string, address: Address, signal: AbortSignal) {
  const secure = tls.connect({
    socket, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true,
    checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(host, certificate),
  });
  await new Promise<void>((resolve, reject) => {
    const abort = () => secure.destroy(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    secure.once("error", (error) => { cleanup(); reject(error); });
    secure.once("secureConnect", () => { cleanup(); resolve(); });
    if (signal.aborted) abort();
  });
  verifyPeer(secure, address);
  return secure;
}

async function* capped(input: AsyncIterable<Buffer>, maximum: number, budget: CrawlBudget) {
  let bytes = 0;
  for await (const chunk of input) {
    budget.check();
    bytes += chunk.length;
    if (bytes > maximum) budget.exceeded("single file inflated bytes");
    yield chunk;
  }
}

async function* ungzip(input: AsyncIterable<Buffer>, required: boolean, maximum: number, budget: CrawlBudget, countPlain = false): AsyncGenerator<Buffer> {
  const iterator = input[Symbol.asyncIterator]();
  const first: Buffer[] = [];
  let size = 0;
  while (size < 2) {
    const next = await iterator.next();
    if (next.done) break;
    first.push(next.value); size += next.value.length;
  }
  const prefix = Buffer.concat(first);
  const gzip = prefix[0] === 0x1f && prefix[1] === 0x8b;
  if (required && !gzip) {
    await iterator.return?.();
    throw new SitemapError("DECOMPRESSION_ERROR", "Content-Encoding gzip has no gzip header");
  }
  async function* replay() {
    try {
      yield prefix;
      for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; }
    } finally { await iterator.return?.(); }
  }
  if (!gzip) {
    for await (const chunk of capped(replay(), maximum, budget)) { if (countPlain) budget.inflated(chunk.length); yield chunk; }
    return;
  }
  const source = Readable.from(replay());
  const decoder = createGunzip();
  source.on("error", (error) => decoder.destroy(error));
  const abort = () => decoder.destroy(budget.controller.signal.reason);
  budget.controller.signal.addEventListener("abort", abort, { once: true });
  source.pipe(decoder);
  try { for await (const chunk of capped(decoder, maximum, budget)) { budget.inflated(chunk.length); yield chunk; } }
  catch (error) {
    if (error instanceof SitemapError) throw error;
    if ((error as NodeJS.ErrnoException).code?.startsWith("Z_")) throw new SitemapError("DECOMPRESSION_ERROR", "Invalid or truncated gzip stream");
    throw new SitemapError("NETWORK_ERROR", "Compressed response stream was interrupted", true);
  } finally {
    budget.controller.signal.removeEventListener("abort", abort);
    source.destroy(); decoder.destroy();
  }
}

/** Streaming limits apply before buffering; both HTTP gzip and a .gz file may be present. */
export async function decodeBody(input: AsyncIterable<Buffer>, encoding: string, budget: CrawlBudget, maximum = budget.limits.maxFileBytes) {
  if (encoding && encoding !== "identity" && encoding !== "gzip") throw new SitemapError("UNSUPPORTED_ENCODING", "Unsupported HTTP content encoding");
  async function* wire() { for await (const chunk of input) { budget.wire(chunk.length); yield chunk; } }
  const httpDecoded = encoding === "gzip" ? ungzip(wire(), true, maximum, budget) : wire();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ungzip(httpDecoded, false, maximum, budget, encoding !== "gzip")) {
    size += chunk.length; chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function retryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** No proxy or private-network bypass. Resolve once per hop and connect to the checked IP. */
export function createSafeFetcher(dependencies: Dependencies = {}): SitemapFetcher {
  const resolve = dependencies.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? connectTcp;
  return async (source, budget, options = {}) => {
    let current = normalizeHttpUrl(source);
    const visited = new Set<string>();
    for (let hop = 0; ; hop++) {
      budget.check();
      if (visited.has(current)) throw new SitemapError("REDIRECT_LOOP", "Sitemap redirect loop");
      visited.add(current);
      const url = new URL(current);
      const host = hostname(url);
      const controller = new AbortController();
      const abort = () => controller.abort(budget.controller.signal.reason);
      budget.controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new SitemapError("REQUEST_TIMEOUT", "HTTP request timed out", true)), budget.limits.requestTimeoutMs);
      const agent = url.protocol === "https:" ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
      let response: http.IncomingMessage | undefined;
      try {
        const addresses = await aborted(net.isIP(host) ? Promise.resolve([{ address: host, family: net.isIP(host) }]) : resolve(host), controller.signal);
        if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isPublicAddress(entry.address) || net.isIP(entry.address) !== entry.family)) {
          throw new SitemapError("UNSAFE_ADDRESS", "DNS returned a non-public or invalid address");
        }
        agent.createConnection = (_opts, callback) => {
          (async () => {
            let last: unknown;
            for (const address of [...addresses].sort((a, b) => a.family - b.family)) {
              if (controller.signal.aborted) throw controller.signal.reason;
              let socket: net.Socket | undefined;
              try {
                socket = await connect(address, Number(url.port) || (url.protocol === "https:" ? 443 : 80), controller.signal);
                if (controller.signal.aborted) throw controller.signal.reason;
                verifyPeer(socket, address);
                return url.protocol === "https:" ? await secureSocket(socket, host, address, controller.signal) : socket;
              } catch (error) {
                socket?.destroy(); last = error;
                if (error instanceof SitemapError && error.code === "UNSAFE_ADDRESS") throw error;
              }
            }
            throw last ?? new SitemapError("NETWORK_ERROR", "No reachable public address", true);
          })().then((socket) => callback?.(null, socket), (error) => callback?.(error, undefined as unknown as Duplex));
          return undefined;
        };
        const headers: Record<string, string> = { "User-Agent": "SitemapRadar/0.2", Accept: "application/xml,text/xml,text/plain,*/*;q=0.1", "Accept-Encoding": "gzip, identity" };
        if (options.cache?.finalUrl === current) {
          if (options.cache.etag) headers["If-None-Match"] = options.cache.etag;
          if (options.cache.lastModified) headers["If-Modified-Since"] = options.cache.lastModified;
        }
        response = await new Promise<http.IncomingMessage>((resolve, reject) => {
          const request = (url.protocol === "https:" ? https : http).request(url, { agent, headers, signal: controller.signal, maxHeaderSize: 16_384 }, resolve);
          request.once("error", reject); request.end();
        });
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (hop >= budget.limits.maxRedirects) throw new SitemapError("RESOURCE_LIMIT", "Redirect limit exceeded");
          if (!response.headers.location) throw new SitemapError("INVALID_REDIRECT", "Redirect has no Location");
          let destination: URL;
          try { destination = new URL(response.headers.location, current); }
          catch { throw new SitemapError("INVALID_REDIRECT", "Redirect has an invalid Location"); }
          current = normalizeHttpUrl(destination.href);
          continue;
        }
        if (status !== 200 && status !== 304) {
          throw new SitemapError(`HTTP_${status}`, `Sitemap returned HTTP ${status}`, status === 429 || status >= 500, retryAfter(response.headers["retry-after"]));
        }
        const body = status === 304 ? Buffer.alloc(0) : await decodeBody(response, (response.headers["content-encoding"] ?? "").toLowerCase(), budget, Math.min(options.maxBodyBytes ?? budget.limits.maxFileBytes, budget.limits.maxFileBytes));
        return { status, finalUrl: current, body, etag: response.headers.etag, lastModified: response.headers["last-modified"] };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof SitemapError) throw error;
        throw new SitemapError("NETWORK_ERROR", "Sitemap network or TLS connection failed", true);
      } finally {
        clearTimeout(timer); budget.controller.signal.removeEventListener("abort", abort);
        response?.destroy(); agent.destroy();
      }
    }
  };
}

export const fetchSitemap = createSafeFetcher();
