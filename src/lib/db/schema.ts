import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  check,
  uniqueIndex,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CrawlOptions } from "../sitemap";
import type { CrawlResult, Revision } from "../sitemap/types";

/* ------------------------------------------------------------------ */
/* BetterAuth core tables — field names follow the BetterAuth defaults. */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  /** Set when user finishes or defers Context.dev onboarding; null means gate /dashboard. */
  contextIntroDismissedAt: timestamp("contextIntroDismissedAt", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true, precision: 3 }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true, precision: 3 }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }).notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 }),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 }),
});

/**
 * One row per user: shared secrets (Resend API key, context.dev) not tied to a single destination.
 */
export const userNotificationSettings = pgTable("userNotificationSettings", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Per-account key used only when CONTEXT_DEV_API_KEY is not configured on the server. */
  contextDevApiKey: text("contextDevApiKey"),
  /** Hotlinked brand icon URL from Context.dev (e.g. dashboard avatar). */
  accountBrandLogoUrl: text("accountBrandLogoUrl"),
  /** Per-account Resend API key used only when RESEND_API_KEY is not configured on the server. */
  resendApiKey: text("resendApiKey"),
  /** openai | vercel_gateway — which LLM endpoint to use for change summaries. */
  aiProvider: text("aiProvider", { enum: ["openai", "vercel_gateway"] }),
  /** Per-account OpenAI key when OPENAI_API_KEY is not configured on the server. */
  openaiApiKey: text("openaiApiKey"),
  /** Per-account Vercel AI Gateway key when AI_GATEWAY_API_KEY is not configured on the server. */
  vercelAiGatewayApiKey: text("vercelAiGatewayApiKey"),
  /** Model id for change summaries (e.g. gpt-5.4-nano or openai/gpt-5.4-nano). */
  aiModel: text("aiModel"),
  updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});

/**
 * Named outbound integrations (Slack webhooks, email routes, generic JSON webhooks).
 */
export const notificationDestination = pgTable(
  "notificationDestination",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["SLACK", "EMAIL", "WEBHOOK"] }).notNull(),
    name: text("name").notNull(),
    slackWebhookUrl: text("slackWebhookUrl"),
    resendFromEmail: text("resendFromEmail"),
    resendToEmails: text("resendToEmails"),
    alertWebhookUrl: text("alertWebhookUrl"),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("notification_destination_user_idx").on(t.userId),
  }),
);

/* ------------------------------------------------------------------ */
/* Domain tables                                                      */
/* ------------------------------------------------------------------ */

export const competitorGroup = pgTable("competitor_group", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  membershipVersion: integer("membership_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerIdentity: uniqueIndex("competitor_group_owner_identity").on(t.id, t.ownerUserId),
  ownerName: uniqueIndex("competitor_group_owner_name").on(t.ownerUserId, sql`lower(btrim(${t.name}))`),
  validName: check("competitor_group_name_check", sql`char_length(${t.name}) BETWEEN 1 AND 80 AND ${t.name}=btrim(${t.name})`),
  validDescription: check("competitor_group_description_check", sql`char_length(${t.description})<=2000`),
  validVersion: check("competitor_group_version_check", sql`${t.membershipVersion}>0`),
}));

export const website = pgTable(
  "website",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    competitorGroupId: text("competitor_group_id"),
    title: text("title"),
    description: text("description"),
    logoUrl: text("logoUrl"),
    /** context.dev /web/screenshot public URL; preferred over `backdropUrl` for hero/cards. */
    heroScreenshotUrl: text("heroScreenshotUrl"),
    backdropUrl: text("backdropUrl"),
    /**
     * JSON string array of notificationDestination ids to notify; null/empty = all destinations.
     * Use `[]` to disable notifications for this site.
     */
    notificationDestinationIds: text("notificationDestinationIds"),
    /** Unguessable token for a read-only public view; null = not shared. */
    publicShareToken: text("publicShareToken").unique(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("website_user_idx").on(t.userId),
    byGroup: index("website_owner_group_idx").on(t.userId, t.competitorGroupId, t.id),
    groupOwner: foreignKey({ columns: [t.competitorGroupId, t.userId], foreignColumns: [competitorGroup.id, competitorGroup.ownerUserId], name: "website_group_owner_fk" }),
  }),
);

/**
 * Target types:
 *   SITEMAP_LINKS     — alert on sitemap URL changes (`linkScope` chooses new / removed / both).
 *   PAGE_CONTENT      — alert when a specific page's markdown changes
 *   PRODUCT_PRICE     — alert when a product page's price/currency changes (context.dev product API)
 */
export const target = pgTable(
  "target",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["SITEMAP_LINKS", "PAGE_CONTENT", "PRODUCT_PRICE"] }).notNull(),
    /** For SITEMAP_LINKS: which diffs notify. Null elsewhere. */
    linkScope: text("linkScope", { enum: ["NEW", "REMOVED", "BOTH"] }),
    /** For PAGE_CONTENT / PRODUCT_PRICE: the page URL. Null for sitemap-based targets. */
    pageUrl: text("pageUrl"),
    /** Optional free-text note of what the user wants to watch for; labels the monitor and focuses AI summaries. */
    watchNote: text("watchNote"),
    enabled: boolean("enabled").notNull().default(true),
    /** Scheduled cadence in hours; P0 API accepts 1/6/12/24 (new monitors default to 6). */
    checkIntervalHours: doublePrecision("checkIntervalHours").notNull().default(1),
    /** Fixed scheduled clock, advanced at scheduling; manual/retry never move it. Null = immediately due. */
    nextCheckDueAt: timestamp("nextCheckDueAt", { withTimezone: true, precision: 3 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    scopeVersion: integer("scope_version").notNull().default(1),
    filterVersion: integer("filter_version").notNull().default(1),
    includePaths: jsonb("include_paths").$type<string[]>().notNull().default([]),
    excludePaths: jsonb("exclude_paths").$type<string[]>().notNull().default([]),
    baselineRunId: text("baseline_run_id").references((): AnyPgColumn => crawlRun.id, { onDelete: "restrict" }),
    sitemapRoots: jsonb("sitemap_roots").$type<string[]>(),
    allowedPageHosts: jsonb("allowed_page_hosts").$type<string[]>(),
    normalizationPolicy: text("normalization_policy").notNull().default("url-v1"),
    discoveredRoots: jsonb("discovered_roots").$type<string[]>(),
    liveSources: jsonb("live_sources").$type<string[]>().notNull().default([]),
    crawlPolicyKey: text("crawl_policy_key"),
    lastCheckedAt: timestamp("lastCheckedAt", { withTimezone: true, precision: 3 }),
    /** Human-readable message from the most recent failed check; null once a check succeeds. */
    lastError: text("lastError"),
    /** When the last failed check happened; null once a check succeeds. */
    lastErrorAt: timestamp("lastErrorAt", { withTimezone: true, precision: 3 }),
    /** context.dev CDN screenshot URL of the watched page from the most recent check. */
    lastScreenshotUrl: text("lastScreenshotUrl"),
    /** When the stored screenshot was captured. */
    lastScreenshotAt: timestamp("lastScreenshotAt", { withTimezone: true, precision: 3 }),
    /**
     * When false, alerts are stored only in-app — no Slack/email/webhook for this target.
     * When true, `notificationDestinationId` selects the target's external destination.
     */
    externalNotify: boolean("externalNotify").notNull().default(true),
    notificationDestinationId: text("notificationDestinationId").references(
      () => notificationDestination.id,
      { onDelete: "set null" },
    ),
    /** When true, new alerts for this target get an LLM-generated plain-language summary. */
    aiChangeSummaryEnabled: boolean("aiChangeSummaryEnabled").notNull().default(false),
    /**
     * When true, a detected change is scored by the LLM against `watchNote` before it
     * notifies. Changes judged to be noise are stored as suppressed alerts (kept for the
     * audit trail, marked read, no Slack/email) instead of paging the owner. Fails open:
     * any triage error surfaces the alert normally.
     */
    aiTriageEnabled: boolean("aiTriageEnabled").notNull().default(false),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byWebsite: index("target_website_idx").on(t.websiteId),
  }),
);

/**
 * Snapshots store the raw scrape result at a point in time. The worker
 * compares the latest snapshot against the previous one to generate alerts.
 *
 *  - kind=SITEMAP         payload = JSON string array of URLs
 *  - kind=MARKDOWN        payload = markdown body; targetUrl set
 *  - kind=PRODUCT        payload = JSON of extracted product/price; targetUrl = product page URL
 */
export const snapshot = pgTable(
  "snapshot",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["SITEMAP", "MARKDOWN", "PRODUCT"] }).notNull(),
    /** For MARKDOWN / PRODUCT: the URL. Null for SITEMAP. */
    targetUrl: text("targetUrl"),
    payload: text("payload").notNull(),
    /** sha256 of payload — cheap equality checks. */
    hash: text("hash").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byLookup: index("snapshot_lookup_idx").on(t.websiteId, t.kind, t.targetUrl, t.createdAt),
  }),
);

export const alert = pgTable(
  "alert",
  {
    id: text("id").primaryKey(),
    websiteId: text("websiteId")
      .notNull()
      .references(() => website.id, { onDelete: "cascade" }),
    targetId: text("targetId")
      .notNull()
      .references(() => target.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["NEW_LINK", "REMOVED_LINK", "PAGE_CONTENT", "PRODUCT_PRICE"] }).notNull(),
    title: text("title").notNull(),
    /** JSON: link/content/product fields depending on kind */
    details: text("details").notNull(),
    read: boolean("read").notNull().default(false),
    /**
     * True when the AI relevance filter judged this change to be noise. Suppressed alerts
     * are persisted (nothing is silently dropped) but arrive read and never notify.
     */
    suppressed: boolean("suppressed").notNull().default(false),
    /** Short LLM rationale for why the change was held; null unless suppressed. */
    suppressionReason: text("suppressionReason"),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byWebsite: index("alert_website_idx").on(t.websiteId, t.createdAt),
    byTarget: index("alert_target_idx").on(t.targetId),
  }),
);

/** Additional users invited to operate on rows keyed by ownerUserId (same as website.userId for that account). */
export const accountMembership = pgTable(
  "accountMembership",
  {
    ownerUserId: text("ownerUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memberUserId: text("memberUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerUserId, t.memberUserId] }),
    byMember: index("account_membership_member_idx").on(t.memberUserId),
  }),
);

/**
 * Multi-seat time-limited invite; store only tokenHash of the opaque token shown in URL.
 * `organizationLabel` is a snapshot for auth-page copy when the invite is opened without login.
 */
export const accountInvite = pgTable(
  "accountInvite",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("ownerUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    createdByUserId: text("createdByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Display name copied at invite time (website title/name or profile name); never inferred from APIs here. */
    organizationLabel: text("organizationLabel"),
    maxUses: integer("maxUses").notNull().default(5),
    useCount: integer("useCount").notNull().default(0),
    redeemedAt: timestamp("redeemedAt", { withTimezone: true, precision: 3 }),
    redeemedByUserId: text("redeemedByUserId").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    byOwner: index("account_invite_owner_idx").on(t.ownerUserId),
    byExpires: index("account_invite_expires_idx").on(t.expiresAt),
  }),
);

export type User = typeof user.$inferSelect;
export type UserNotificationSettings = typeof userNotificationSettings.$inferSelect;
export type NotificationDestination = typeof notificationDestination.$inferSelect;
export type NotificationChannel = NotificationDestination["channel"];
export type Website = typeof website.$inferSelect;
export type Target = typeof target.$inferSelect;
export type Snapshot = typeof snapshot.$inferSelect;
export type Alert = typeof alert.$inferSelect;
export type AlertKind = Alert["kind"];
export type TargetKind = Target["kind"];
export type LinkScope = NonNullable<Target["linkScope"]>;
export type AiProvider = NonNullable<UserNotificationSettings["aiProvider"]>;

// Durable queue identities survive diagnostic/source retention and future inventory GC.
export const crawlRun = pgTable("crawl_run", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull().references(() => target.id, { onDelete: "restrict" }),
  trigger: text("trigger", { enum: ["manual", "scheduled", "confirmation"] }).notNull(),
  scopeVersion: integer("scope_version").notNull(),
  originBaselineRunId: text("origin_baseline_run_id").references((): AnyPgColumn => crawlRun.id, { onDelete: "restrict" }),
  config: jsonb("config").$type<Pick<CrawlOptions, "siteUrl" | "roots" | "allowedPageHosts">>().notNull(),
  executionStatus: text("execution_status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] }).notNull().default("queued"),
  completeness: text("completeness", { enum: ["unknown", "complete", "partial", "unusable"] }).notNull().default("unknown"),
  adoptionStatus: text("adoption_status", { enum: ["none", "baseline", "applied", "quarantined", "first_observation", "discarded", "stale"] }).notNull().default("none"),
  attempt: integer("attempt").notNull().default(0),
  leaseEpoch: integer("lease_epoch").notNull().default(0),
  leaseToken: text("lease_token"),
  workerId: text("worker_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true, precision: 3 }),
  result: jsonb("result").$type<Omit<CrawlResult, "state">>(),
  error: jsonb("error").$type<{ code: string; message: string; retryable: boolean; retryAfterMs?: number }>(),
}, (t) => ({
  oneActive: uniqueIndex("crawl_run_one_active_per_target").on(t.targetId).where(sql`${t.executionStatus} IN ('queued', 'running')`),
  ready: index("crawl_run_ready_idx").on(t.availableAt, t.createdAt).where(sql`${t.executionStatus} = 'queued'`),
  expired: index("crawl_run_expired_idx").on(t.leaseExpiresAt).where(sql`${t.executionStatus} = 'running'`),
  history: index("crawl_run_history_idx").on(t.targetId, t.createdAt),
  status: check("crawl_run_status_check", sql`${t.executionStatus} IN ('queued','running','succeeded','failed','cancelled')`),
  completeness: check("crawl_run_completeness_check", sql`${t.completeness} IN ('unknown','complete','partial','unusable')`),
  adoption: check("crawl_run_adoption_check", sql`${t.adoptionStatus} IN ('none','baseline','applied','quarantined','first_observation','discarded','stale')`),
  trigger: check("crawl_run_trigger_check", sql`${t.trigger} IN ('manual','scheduled','confirmation')`),
  lease: check("crawl_run_lease_check", sql`(${t.executionStatus} = 'running' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) OR (${t.executionStatus} <> 'running' AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL)`),
  attempt: check("crawl_run_attempt_check", sql`${t.attempt} BETWEEN 0 AND 4 AND ${t.leaseEpoch} >= ${t.attempt}`),
}));
export const crawlRunAttempt = pgTable("crawl_run_attempt", {
  runId: text("run_id").notNull().references(() => crawlRun.id, { onDelete: "restrict" }),
  attempt: integer("attempt").notNull(),
  leaseToken: text("lease_token").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  error: jsonb("error"),
}, (t) => ({ pk: primaryKey({ columns: [t.runId, t.attempt] }), status: check("crawl_attempt_status_check", sql`${t.status} IN ('running','succeeded','failed','lost','discarded')`) }));
export const sitemapRevision = pgTable("sitemap_revision", {
  id: text("id").primaryKey(), content: jsonb("content").$type<Revision>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const sitemapSourceCache = pgTable("sitemap_source_cache", {
  targetId: text("target_id").notNull().references(() => target.id, { onDelete: "restrict" }),
  scopeVersion: integer("scope_version").notNull(), sourceUrl: text("source_url").notNull(),
  finalUrl: text("final_url").notNull(), etag: text("etag"), lastModified: text("last_modified"),
  revisionId: text("revision_id").notNull().references(() => sitemapRevision.id, { onDelete: "restrict" }),
}, (t) => ({ pk: primaryKey({ columns: [t.targetId, t.scopeVersion, t.sourceUrl] }), revision: index("sitemap_cache_revision_idx").on(t.revisionId) }));
export const crawlRunSource = pgTable("crawl_run_source", {
  runId: text("run_id").notNull().references(() => crawlRun.id, { onDelete: "restrict" }),
  attempt: integer("attempt").notNull(), sourceUrl: text("source_url").notNull(),
  revisionId: text("revision_id").references(() => sitemapRevision.id, { onDelete: "restrict" }),
  observation: jsonb("observation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.runId, t.attempt, t.sourceUrl] }), revision: index("crawl_source_revision_idx").on(t.revisionId) }));


export const siteUrl = pgTable("site_url", {
  websiteId: text("website_id").notNull().references(() => website.id, { onDelete: "restrict" }),
  scopeVersion: integer("scope_version").notNull(),
  normalizedUrlHash: text("normalized_url_hash").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull().default("active"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true, precision: 3 }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 }).notNull(),
  firstMissingRunId: text("first_missing_run_id").references(() => crawlRun.id, { onDelete: "restrict" }),
  firstMissingObservedAt: timestamp("first_missing_observed_at", { withTimezone: true, precision: 3 }),
  lastMissingRunId: text("last_missing_run_id").references(() => crawlRun.id, { onDelete: "restrict" }),
  missingConfirmations: integer("missing_confirmations").notNull().default(0),
  removedAt: timestamp("removed_at", { withTimezone: true, precision: 3 }),
}, (t) => ({
  pk: primaryKey({ columns: [t.websiteId, t.scopeVersion, t.normalizedUrlHash] }),
  statusIndex: index("site_url_status_idx").on(t.websiteId, t.scopeVersion, t.status, t.normalizedUrlHash),
  state: check("site_url_status_check", sql`${t.status} IN ('active','pending_removed','removed')`),
  evidence: check("site_url_evidence_check", sql`(${t.status}='active' AND ${t.missingConfirmations}=0 AND ${t.firstMissingRunId} IS NULL AND ${t.firstMissingObservedAt} IS NULL AND ${t.lastMissingRunId} IS NULL AND ${t.removedAt} IS NULL) OR (${t.status}='pending_removed' AND ${t.missingConfirmations}=1 AND ${t.firstMissingRunId} IS NOT NULL AND ${t.firstMissingObservedAt} IS NOT NULL AND ${t.lastMissingRunId} IS NOT NULL AND ${t.removedAt} IS NULL) OR (${t.status}='removed' AND ${t.missingConfirmations}=2 AND ${t.firstMissingRunId} IS NOT NULL AND ${t.firstMissingObservedAt} IS NOT NULL AND ${t.lastMissingRunId} IS NOT NULL AND ${t.removedAt} IS NOT NULL)`),
}));
export const urlEvent = pgTable("url_event", {
  id: text("id").primaryKey(),
  websiteId: text("website_id").notNull().references(() => website.id, { onDelete: "restrict" }),
  scopeVersion: integer("scope_version").notNull(),
  normalizedUrlHash: text("normalized_url_hash").notNull(), url: text("url").notNull(),
  runId: text("run_id").notNull().references(() => crawlRun.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(), observedAt: timestamp("observed_at", { withTimezone: true, precision: 3 }).notNull(),
}, (t) => ({
  once: uniqueIndex("url_event_once_idx").on(t.runId, t.normalizedUrlHash, t.kind),
  history: index("url_event_history_idx").on(t.websiteId, t.scopeVersion, t.observedAt, t.id),
  kind: check("url_event_kind_check", sql`${t.kind} IN ('added','removed','reappeared')`),
}));
export const removalCandidate = pgTable("removal_candidate", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull().references(() => target.id, { onDelete: "restrict" }),
  scopeVersion: integer("scope_version").notNull(),
  originBaselineRunId: text("origin_baseline_run_id").notNull().references(() => crawlRun.id, { onDelete: "restrict" }),
  candidateRunId: text("candidate_run_id").notNull().references(() => crawlRun.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("pending"), reason: text("reason"),
  missingSetHash: text("missing_set_hash").notNull(),
  originalMissingCount: integer("original_missing_count").notNull(),
  pendingCount: integer("pending_count").notNull(), recoveredCount: integer("recovered_count").notNull().default(0), removedCount: integer("removed_count").notNull().default(0),
  observedAt: timestamp("observed_at", { withTimezone: true, precision: 3 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
  nextConfirmationAt: timestamp("next_confirmation_at", { withTimezone: true, precision: 3 }),
  confirmationAttempts: integer("confirmation_attempts").notNull().default(0),
  lastConfirmationRunId: text("last_confirmation_run_id").references(() => crawlRun.id, { onDelete: "restrict" }),
}, (t) => ({
  oneRun: uniqueIndex("candidate_run_once_idx").on(t.candidateRunId),
  history: index("candidate_history_idx").on(t.targetId, t.scopeVersion, t.observedAt, t.id),
  activeOrigin: index("candidate_active_origin_idx").on(t.originBaselineRunId).where(sql`${t.status} IN ('pending','adopted')`),
  activeRun: index("candidate_active_run_idx").on(t.candidateRunId).where(sql`${t.status} IN ('pending','adopted')`),
  activeConfirmation: index("candidate_active_confirmation_idx").on(t.lastConfirmationRunId).where(sql`${t.status} IN ('pending','adopted')`),
  onePending: uniqueIndex("candidate_one_pending_idx").on(t.targetId, t.scopeVersion).where(sql`${t.status}='pending'`),
  due: index("candidate_due_idx").on(t.nextConfirmationAt).where(sql`${t.status} IN ('pending','adopted')`),
  state: check("candidate_status_check", sql`${t.status} IN ('pending','adopted','confirmed','rejected','stale','expired')`),
  counts: check("candidate_counts_check", sql`${t.originalMissingCount} > 0 AND ${t.pendingCount} >= 0 AND ${t.recoveredCount} >= 0 AND ${t.removedCount} >= 0 AND ${t.originalMissingCount}=${t.pendingCount}+${t.recoveredCount}+${t.removedCount}`),
}));
export const candidateMissingUrl = pgTable("candidate_missing_url", {
  candidateId: text("candidate_id").notNull().references(() => removalCandidate.id, { onDelete: "restrict" }),
  normalizedUrlHash: text("normalized_url_hash").notNull(), url: text("url").notNull(),
  resolution: text("resolution").notNull().default("pending"),
}, (t) => ({ pk: primaryKey({ columns: [t.candidateId, t.normalizedUrlHash] }), state: check("candidate_url_resolution_check", sql`${t.resolution} IN ('pending','recovered','removed')`) }));
