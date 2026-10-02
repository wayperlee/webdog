import { isIP } from "node:net";
import { SitemapError } from "./types";
import { isPublicAddress } from "./urls";

export type DnsAddress = { address: string; family: number };
export type DnsResolver = (host: string, signal: AbortSignal) => Promise<DnsAddress[]>;
const ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_REPLY_BYTES = 65_536;
type Record = { type: number; data: string; TTL: number };
type Reply = { Status: number; TC?: boolean; Answer?: Record[] };

async function boundedJson(response: Response): Promise<Reply> {
  if (!response.body) throw new SitemapError("DNS_RESPONSE_ERROR", "Empty DNS response", true);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REPLY_BYTES) throw new SitemapError("DNS_RESPONSE_ERROR", "DNS response exceeds size limit", true);
      chunks.push(value);
    }
    const reply: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!reply || typeof reply !== "object") throw new Error("Invalid JSON shape");
    const parsed = reply as Reply;
    if (parsed.Status !== 0 || parsed.TC === true || (parsed.Answer !== undefined && (!Array.isArray(parsed.Answer) || parsed.Answer.length > 128))) {
      throw new SitemapError("DNS_RESPONSE_ERROR", "DNS query failed or returned a truncated response", true);
    }
    return parsed;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Fixed trusted HTTPS control plane. Target connections still use the checked and pinned safe transport. */
export function createCloudflareDohResolver(request: typeof fetch = fetch, now = Date.now): DnsResolver {
  const cache = new Map<string, { expires: number; addresses: DnsAddress[] }>();
  return async (host, signal) => {
    if (signal.aborted) throw signal.reason;
    const cached = cache.get(host);
    if (cached && cached.expires > now()) return cached.addresses.map((entry) => ({ ...entry }));
    cache.delete(host);
    const started = now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new SitemapError("DNS_TIMEOUT", "DNS query timed out", true)), 8_000);
    try {
      // Both families must resolve successfully: never ignore an unsafe IPv6 answer after a safe IPv4 answer.
      const replies = await Promise.all(["A", "AAAA"].map(async (type) => {
        const url = new URL(ENDPOINT); url.searchParams.set("name", host); url.searchParams.set("type", type);
        const response = await request(url, { headers: { accept: "application/dns-json" }, redirect: "manual", signal: controller.signal });
        if (response.status !== 200) {
          await response.body?.cancel();
          const retry = response.headers.get("retry-after");
          const retryAfterMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Math.max(0, Date.parse(retry) - now()) : undefined;
          throw new SitemapError("DNS_HTTP_ERROR", "DNS resolver returned an unsuccessful HTTP response", true, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
        }
        return boundedJson(response);
      }));
      if (controller.signal.aborted) throw controller.signal.reason;
      const answers = replies.flatMap((reply) => reply.Answer ?? []);
      const addresses = new Map<string, DnsAddress>();
      let ttl = 300;
      for (const answer of answers) {
        if (!answer || typeof answer !== "object" || !Number.isInteger(answer.type) || typeof answer.data !== "string" || !Number.isInteger(answer.TTL) || answer.TTL < 0) {
          throw new SitemapError("DNS_RESPONSE_ERROR", "Malformed DNS record", true);
        }
        ttl = Math.min(ttl, answer.TTL); // CNAME TTL also bounds the host's cached resolution.
        if (![1, 28].includes(answer.type)) continue;
        const family = answer.type === 1 ? 4 : 6;
        if (isIP(answer.data) !== family || !isPublicAddress(answer.data)) throw new SitemapError("UNSAFE_ADDRESS", "DNS returned a non-public or invalid address");
        addresses.set(answer.data, { address: answer.data, family });
      }
      if (!addresses.size) throw new SitemapError("DNS_RESPONSE_ERROR", "DNS returned no address records", true);
      if (addresses.size > 64) throw new SitemapError("DNS_RESPONSE_ERROR", "DNS address count exceeds limit", true);
      const result = [...addresses.values()];
      if (ttl > 0 && started + ttl * 1000 > now()) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(host, { addresses: result, expires: started + ttl * 1000 });
      }
      return result.map((entry) => ({ ...entry }));
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof SitemapError) throw error;
      throw new SitemapError("DNS_RESPONSE_ERROR", "DNS HTTPS request or response failed", true);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      controller.abort(); // Cancel a sibling query if one family failed.
    }
  };
}
