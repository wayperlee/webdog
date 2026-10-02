import { SaxesParser, type SaxesTagNS } from "saxes";
import { setImmediate } from "node:timers/promises";
import { SitemapError, type ParsedSitemap } from "./types";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

export async function parseSitemapXml(bytes: Buffer, check: () => void = () => {}): Promise<ParsedSitemap> {
  let xml: string;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new SitemapError("INVALID_ENCODING", "Sitemap must be valid UTF-8");
  }
  if (/^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(xml)) throw new SitemapError("HTML_DOCUMENT", "Received HTML instead of a sitemap");
  const stack: SaxesTagNS[] = [];
  let kind: ParsedSitemap["kind"] | undefined;
  let namespace = "";
  let loc: string | undefined;
  let entryLocations = 0;
  const locations: string[] = [];
  const invalid = (message: string): never => { throw new SitemapError("INVALID_XML", message); };
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => invalid("Malformed sitemap XML"));
  parser.on("doctype", (value) => {
    if (/^\s*html(?:\s|$)/i.test(value)) throw new SitemapError("HTML_DOCUMENT", "Received HTML instead of a sitemap");
    throw new SitemapError("DTD_DISALLOWED", "DTD and external entities are disabled");
  });
  parser.on("xmldecl", (decl) => {
    if (decl.encoding && !/^utf-?8$/i.test(decl.encoding)) invalid("Only UTF-8 XML declarations are supported");
  });
  parser.on("opentag", (tag) => {
    if (loc !== undefined) invalid("Nested markup inside loc");
    stack.push(tag);
    if (stack.length > 32) throw new SitemapError("RESOURCE_LIMIT", "XML nesting limit exceeded");
    if (stack.length === 1) {
      if (tag.local.toLowerCase() === "html") throw new SitemapError("HTML_DOCUMENT", "Received HTML instead of a sitemap");
      if (!["urlset", "sitemapindex"].includes(tag.local) || (tag.uri !== "" && tag.uri !== NS)) {
        invalid("Expected urlset or sitemapindex");
      }
      kind = tag.local === "urlset" ? "urlset" : "index";
      namespace = tag.uri;
    } else if (stack.length === 2 && tag.uri === namespace) {
      if (tag.local !== (kind === "urlset" ? "url" : "sitemap")) invalid("Unexpected sitemap entry");
      entryLocations = 0;
    } else if (stack.length === 3 && tag.local === "loc" && tag.uri === namespace && stack[1].uri === namespace) {
      if (++entryLocations !== 1) invalid("Duplicate loc in sitemap entry");
      loc = "";
    }
  });
  const text = (value: string) => {
    if (loc !== undefined) {
      loc += value;
      if (loc.length > 2_048) invalid("loc length limit exceeded");
    } else if (stack.length <= 2 && value.trim()) invalid("Unexpected text outside loc");
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", (tag) => {
    if (stack.length === 3 && loc !== undefined) {
      if (!loc.trim()) invalid("Empty loc");
      locations.push(loc.trim());
      if (locations.length > 50_000) throw new SitemapError("RESOURCE_LIMIT", "Sitemap entry limit exceeded");
      loc = undefined;
    }
    if (stack.length === 2 && tag.uri === namespace && entryLocations !== 1) invalid("Missing loc");
    stack.pop();
  });
  // Yield between chunks so cancellation and the attempt deadline remain effective during parsing.
  for (let offset = 0; offset < xml.length; offset += 65_536) {
    check();
    parser.write(xml.slice(offset, offset + 65_536));
    await setImmediate();
  }
  parser.close();
  check();
  if (!kind) invalid("Empty document");
  return { kind: kind!, locations };
}
