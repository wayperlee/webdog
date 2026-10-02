import ipaddr from "ipaddr.js";
import { isIP } from "node:net";
import { SitemapError } from "./types";

export function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ""); }

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    // Reject unspecified, private, loopback, multicast, documentation and transition ranges.
    if (parsed.range() !== "unicast") return false;
    // IPv6 global unicast allocation only; do not accept currently unallocated ranges.
    return parsed.kind() === "ipv4" || (parsed as ipaddr.IPv6).match(ipaddr.parse("2000::") as ipaddr.IPv6, 3);
  } catch { return false; }
}

export function normalizeHttpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new SitemapError("INVALID_URL", "An absolute HTTP/HTTPS URL is required");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw new SitemapError("INVALID_URL", "Unsupported protocol, credentials or URL whitespace");
  }
  const host = hostname(url);
  if (isIP(host) && !isPublicAddress(host)) throw new SitemapError("UNSAFE_ADDRESS", "Non-public IP address rejected");
  url.hash = "";
  // Preserve path case, trailing slashes and query order. They may identify different pages.
  return url.href;
}

export function normalizedPageHosts(site: URL, configured?: string[]): string[] {
  const host = site.hostname;
  const defaults = isIP(hostname(site)) ? [host] : [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];
  return [...new Set((configured ?? defaults).map((entry) => {
    if (!entry || /[\s\/#?@\\]/.test(entry)) throw new SitemapError("INVALID_HOST", "Page scope must contain hostnames only");
    const url = new URL(normalizeHttpUrl(`https://${entry}`));
    if (url.host !== url.hostname || url.pathname !== "/" || url.search || url.hash) {
      throw new SitemapError("INVALID_HOST", "Page scope must contain hostnames only");
    }
    return url.hostname;
  }))].sort();
}
