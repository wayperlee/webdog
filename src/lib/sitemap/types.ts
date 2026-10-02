export const NORMALIZATION_POLICY = "url-v1";

export const DEFAULT_LIMITS = {
  maxFiles: 500,
  maxUrls: 200_000,
  maxDepth: 10,
  maxRedirects: 5,
  maxFileBytes: 52_428_800,
  maxCompressedBytes: 128_000_000,
  maxInflatedBytes: 256_000_000,
  maxAttemptMs: 600_000,
  requestTimeoutMs: 30_000,
} as const;

export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: number };

export class SitemapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SitemapError";
  }
}

export type ParsedSitemap = { kind: "urlset" | "index"; locations: string[] };
export type Revision = ParsedSitemap & { id: string; bodyBytes: number };
export type SourceCache = { revisionId: string; finalUrl: string; etag?: string; lastModified?: string };

/** Serializable checkpoint. Production persistence and reference-aware GC belong to PR 3/4. */
export type CrawlState = {
  version: 1;
  policyKey: string;
  roots: string[];
  liveSources: string[];
  cache: Record<string, SourceCache>;
  revisions: Record<string, Revision>;
};

export type SourceObservation = {
  url: string;
  depth: number;
  parents: string[];
  status: "fetched" | "not_modified" | "failed";
  finalUrl?: string;
  revisionId?: string;
  error?: string;
};

export type CrawlIssue = {
  sourceUrl: string;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type CrawlResult = {
  completeness: "complete" | "partial" | "unusable";
  /** Null on every incomplete attempt: never adopt a truncated set. */
  urls: string[] | null;
  observedUrlCount: number;
  outOfScopeUrlCount: number;
  roots: string[];
  scopeFingerprint: string;
  sources: SourceObservation[];
  retiredSources: string[];
  issues: CrawlIssue[];
  compressedBytes: number;
  inflatedBytes: number;
  state: CrawlState;
};
