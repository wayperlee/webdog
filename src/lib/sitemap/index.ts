import { createHash } from "node:crypto";
import { CrawlBudget } from "./budget";
import { fetchSitemap, type HttpResult, type SitemapFetcher } from "./http";
import { parseSitemapXml } from "./xml";
import { normalizeHttpUrl, normalizedPageHosts } from "./urls";
import { NORMALIZATION_POLICY, SitemapError, type CrawlIssue, type CrawlResult, type CrawlState, type Limits, type Revision, type SourceObservation } from "./types";

export type CrawlOptions = {
  siteUrl: string; roots?: string[]; allowedPageHosts?: string[]; state?: CrawlState;
  limits?: Partial<Limits>; signal?: AbortSignal;
  /** Adapter seam for deterministic fixtures. Production uses the pinned safe transport. */
  fetcher?: SitemapFetcher;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = (values: string[]) => [...new Set(values)].sort();
const rootSet = (values: string[]) => unique(values.map(normalizeHttpUrl));
function failure(error: unknown): SitemapError {
  return error instanceof SitemapError ? error : new SitemapError("CRAWL_ERROR", "Sitemap processing failed");
}
function revisionId(revision: Pick<Revision, "kind" | "locations" | "bodyBytes">) { return hash([revision.kind, revision.locations, revision.bodyBytes]); }

/** Checkpoint is data, never a source of HTTP headers or URLs without validation. */
function validateState(state: CrawlState, policyKey: string, limits: Limits) {
  if (!state || typeof state !== "object") throw new SitemapError("INVALID_STATE", "Invalid checkpoint shape");
  if (state.version !== 1 || state.policyKey !== policyKey) throw new SitemapError("SCOPE_CHANGE_REQUIRED", "Checkpoint scope differs; establish a new baseline");
  if (!Array.isArray(state.roots) || !Array.isArray(state.liveSources) || !state.cache || !state.revisions) throw new SitemapError("INVALID_STATE", "Invalid checkpoint shape");
  rootSet(state.roots); rootSet(state.liveSources);
  if (state.roots.length > limits.maxFiles) throw new SitemapError("RESOURCE_LIMIT", "Root count exceeds file budget");
}

function cachedRevision(state: CrawlState, source: string, maximum: number): Revision | undefined {
  const cache = state.cache[source];
  if (!cache) return undefined;
  const revision = state.revisions[cache.revisionId];
  if (!revision || !["urlset", "index"].includes(revision.kind) || !Array.isArray(revision.locations) || revision.locations.length > 50_000 ||
      !Number.isSafeInteger(revision.bodyBytes) || revision.bodyBytes < 0 || revision.bodyBytes > maximum ||
      revision.locations.some((entry) => typeof entry !== "string" || entry.length > 2_048) || revision.id !== cache.revisionId || revision.id !== revisionId(revision)) return undefined;
  try {
    if (normalizeHttpUrl(cache.finalUrl) !== cache.finalUrl || [cache.etag, cache.lastModified].some((value) => value !== undefined && (typeof value !== "string" || value.length > 8_192 || /[\r\n]/.test(value)))) return undefined;
  } catch { return undefined; }
  return revision;
}

export async function crawlSitemaps(options: CrawlOptions): Promise<CrawlResult> {
  const site = new URL(normalizeHttpUrl(options.siteUrl));
  const pageHosts = normalizedPageHosts(site, options.allowedPageHosts);
  if (!pageHosts.length) throw new SitemapError("INVALID_HOST", "Page scope must not be empty");
  const policyKey = hash([NORMALIZATION_POLICY, site.origin, pageHosts]);
  const budget = new CrawlBudget(options.limits, options.signal);
  const fetcher = options.fetcher ?? fetchSitemap;
  try {
    if (options.state) validateState(options.state, policyKey, budget.limits);
    const state: CrawlState = options.state ? structuredClone(options.state) : { version: 1, policyKey, roots: [], liveSources: [], cache: {}, revisions: {} };
    const previousLive = [...state.liveSources];
    const explicit = options.roots ? rootSet(options.roots) : undefined;
    if (explicit && !explicit.length) throw new SitemapError("INVALID_ROOT", "At least one root is required");
    if (explicit && state.roots.length && hash(explicit) !== hash(rootSet(state.roots))) throw new SitemapError("SCOPE_CHANGE_REQUIRED", "Root set changed; establish a new baseline");
    let roots = explicit ?? rootSet(state.roots);
    const prefetched = new Map<string, HttpResult>();
    const issues: CrawlIssue[] = [];
    const observations = new Map<string, SourceObservation>();
    const edges = new Map<string, string[]>();
    const urls = new Set<string>();
    const excluded = new Set<string>();
    let successful = 0;
    let discoveryComplete = true;
    const issue = (sourceUrl: string, error: unknown) => {
      const detail = failure(error);
      issues.push({ sourceUrl, code: detail.code, message: detail.message, retryable: detail.retryable, retryAfterMs: detail.retryAfterMs });
      return detail.code;
    };
    if (!roots.length) {
      const robotsUrl = new URL("/robots.txt", site).href;
      try {
        let robots: HttpResult | undefined;
        try { robots = await fetcher(robotsUrl, budget, { maxBodyBytes: 1_048_576 }); }
        catch (error) { if (!["HTTP_404", "HTTP_410"].includes(failure(error).code)) throw error; }
        if (robots) {
          if (robots.status !== 200) throw new SitemapError("INVALID_DISCOVERY", "robots.txt returned an unexpected 304");
          const content = new TextDecoder("utf-8", { fatal: true }).decode(robots.body);
          if (/^\s*(?:<!doctype\s+html|<html)/i.test(content)) throw new SitemapError("HTML_DOCUMENT", "robots.txt returned HTML");
          roots = rootSet([...content.matchAll(/^\s*sitemap\s*:\s*(\S+)(?:\s+#.*)?\s*$/gim)].map((match) => match[1]));
        }
        if (!roots.length) {
          for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
            const source = new URL(path, site).href;
            try {
              const result = await fetcher(source, budget);
              if (result.status !== 200) throw new SitemapError("INVALID_DISCOVERY", "Discovery returned an unexpected 304");
              await parseSitemapXml(result.body, () => budget.check());
              roots.push(source); prefetched.set(source, result);
            } catch (error) {
              if (!["HTTP_404", "HTTP_410"].includes(failure(error).code)) { discoveryComplete = false; issue(source, error); }
            }
          }
          roots = rootSet(roots);
        }
        if (!roots.length && !issues.length) throw new SitemapError("SITEMAP_NOT_FOUND", "No sitemap roots discovered");
      } catch (error) { discoveryComplete = false; issue(robotsUrl, error); }
    }
    if (discoveryComplete) state.roots = roots;
    const queue: { url: string; depth: number; parent?: string }[] = roots.map((url) => ({ url, depth: 0 }));
    const scheduled = new Set(roots);
    try {
      if (scheduled.size > budget.limits.maxFiles) budget.exceeded("source files");
      for (let cursor = 0; cursor < queue.length; cursor++) {
        budget.check();
        const item = queue[cursor];
        const prior = observations.get(item.url);
        if (prior) { if (item.parent && !prior.parents.includes(item.parent)) prior.parents.push(item.parent); continue; }
        if (observations.size >= budget.limits.maxFiles) budget.exceeded("source files");
        if (item.depth > budget.limits.maxDepth) budget.exceeded("source depth");
        const observation: SourceObservation = { url: item.url, depth: item.depth, parents: item.parent ? [item.parent] : [], status: "failed" };
        observations.set(item.url, observation);
        try {
          const valid = cachedRevision(state, item.url, budget.limits.maxFileBytes);
          const response = prefetched.get(item.url) ?? await fetcher(item.url, budget, { cache: valid ? state.cache[item.url] : undefined });
          let revision: Revision;
          if (response.status === 304) {
            if (!valid || response.finalUrl !== state.cache[item.url].finalUrl) throw new SitemapError("INVALID_304", "304 has no matching validated revision");
            revision = valid;
          } else {
            if (response.body.length > budget.limits.maxFileBytes) budget.exceeded("single file inflated bytes");
            const parsed = await parseSitemapXml(response.body, () => budget.check());
            const content = { ...parsed, bodyBytes: response.body.length };
            revision = { ...content, id: revisionId(content) };
          }
          // Validate all loc values before caching or using any entry from this source.
          const locations = revision.locations.map(normalizeHttpUrl);
          state.revisions[revision.id] = revision;
          state.cache[item.url] = { revisionId: revision.id, finalUrl: normalizeHttpUrl(response.finalUrl), etag: response.etag ?? (response.status === 304 ? state.cache[item.url].etag : undefined), lastModified: response.lastModified ?? (response.status === 304 ? state.cache[item.url].lastModified : undefined) };
          observation.status = response.status === 304 ? "not_modified" : "fetched";
          observation.finalUrl = response.finalUrl; observation.revisionId = revision.id;
          successful++;
          if (revision.kind === "index") {
            const children = unique(locations); edges.set(item.url, children);
            for (const child of children) {
              scheduled.add(child);
              if (scheduled.size > budget.limits.maxFiles) budget.exceeded("source files");
              queue.push({ url: child, depth: item.depth + 1, parent: item.url });
            }
          } else {
            edges.set(item.url, []);
            for (const location of locations) {
              if (pageHosts.includes(new URL(location).hostname)) urls.add(location); else excluded.add(location);
              if (urls.size + excluded.size > budget.limits.maxUrls) budget.exceeded("unique page URLs");
            }
          }
        } catch (error) { observation.status = "failed"; observation.error = issue(item.url, error); }
      }
      // Shared children may be reached at greater depth than their first BFS visit.
      const deepest = new Map<string, number>();
      const visit = (source: string, depth: number, path: Set<string>) => {
        budget.check();
        if (path.has(source)) throw new SitemapError("SOURCE_CYCLE", "Cyclic sitemap index references");
        if (depth > budget.limits.maxDepth) budget.exceeded("source depth");
        if ((deepest.get(source) ?? -1) >= depth) return;
        deepest.set(source, depth); path.add(source);
        for (const child of edges.get(source) ?? []) visit(child, depth + 1, path);
        path.delete(source);
      };
      for (const root of roots) visit(root, 0, new Set());
    } catch (error) { issue(site.origin, error); }
    const complete = discoveryComplete && roots.length > 0 && issues.length === 0;
    const live = [...observations.keys()].sort();
    const retiredSources = complete ? previousLive.filter((source) => !observations.has(source)).sort() : [];
    if (complete) state.liveSources = live;
    return {
      completeness: complete ? "complete" : successful ? "partial" : "unusable",
      urls: complete ? [...urls].sort() : null, observedUrlCount: urls.size, outOfScopeUrlCount: excluded.size,
      roots, scopeFingerprint: hash([policyKey, roots]), sources: [...observations.values()].map((source) => ({ ...source, parents: source.parents.sort() })),
      retiredSources, issues, compressedBytes: budget.compressedBytes, inflatedBytes: budget.inflatedBytes, state,
    };
  } finally { budget.dispose(); }
}

export { DEFAULT_LIMITS, SitemapError } from "./types";
export type { CrawlResult, CrawlState } from "./types";
