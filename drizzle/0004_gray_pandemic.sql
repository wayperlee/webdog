CREATE TABLE "crawl_run" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"trigger" text NOT NULL,
	"scope_version" integer NOT NULL,
	"origin_baseline_run_id" text,
	"config" jsonb NOT NULL,
	"execution_status" text DEFAULT 'queued' NOT NULL,
	"completeness" text DEFAULT 'unknown' NOT NULL,
	"adoption_status" text DEFAULT 'none' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempt_started_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	CONSTRAINT "crawl_run_status_check" CHECK ("crawl_run"."execution_status" IN ('queued','running','succeeded','failed','cancelled')),
	CONSTRAINT "crawl_run_completeness_check" CHECK ("crawl_run"."completeness" IN ('unknown','complete','partial','unusable')),
	CONSTRAINT "crawl_run_adoption_check" CHECK ("crawl_run"."adoption_status" IN ('none','baseline','applied','quarantined','first_observation','discarded','stale')),
	CONSTRAINT "crawl_run_trigger_check" CHECK ("crawl_run"."trigger" IN ('manual','scheduled','confirmation')),
	CONSTRAINT "crawl_run_lease_check" CHECK (("crawl_run"."execution_status" = 'running') = ("crawl_run"."lease_token" IS NOT NULL AND "crawl_run"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "crawl_run_attempt_check" CHECK ("crawl_run"."attempt" BETWEEN 0 AND 4 AND "crawl_run"."lease_epoch" >= "crawl_run"."attempt")
);
--> statement-breakpoint
CREATE TABLE "crawl_run_attempt" (
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"lease_token" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error" jsonb,
	CONSTRAINT "crawl_run_attempt_run_id_attempt_pk" PRIMARY KEY("run_id","attempt"),
	CONSTRAINT "crawl_attempt_status_check" CHECK ("crawl_run_attempt"."status" IN ('running','succeeded','failed','lost','discarded'))
);
--> statement-breakpoint
CREATE TABLE "crawl_run_source" (
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"source_url" text NOT NULL,
	"revision_id" text,
	"observation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_run_source_run_id_attempt_source_url_pk" PRIMARY KEY("run_id","attempt","source_url")
);
--> statement-breakpoint
CREATE TABLE "sitemap_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitemap_source_cache" (
	"target_id" text NOT NULL,
	"scope_version" integer NOT NULL,
	"source_url" text NOT NULL,
	"final_url" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"revision_id" text NOT NULL,
	CONSTRAINT "sitemap_source_cache_target_id_scope_version_source_url_pk" PRIMARY KEY("target_id","scope_version","source_url")
);
--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "scope_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "filter_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "baseline_run_id" text;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "sitemap_roots" jsonb;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "allowed_page_hosts" jsonb;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "normalization_policy" text DEFAULT 'url-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "discovered_roots" jsonb;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "live_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "crawl_policy_key" text;--> statement-breakpoint
ALTER TABLE "crawl_run" ADD CONSTRAINT "crawl_run_target_id_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."target"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_run_attempt" ADD CONSTRAINT "crawl_run_attempt_run_id_crawl_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_run_source" ADD CONSTRAINT "crawl_run_source_run_id_crawl_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_run_source" ADD CONSTRAINT "crawl_run_source_revision_id_sitemap_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."sitemap_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_source_cache" ADD CONSTRAINT "sitemap_source_cache_target_id_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."target"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_source_cache" ADD CONSTRAINT "sitemap_source_cache_revision_id_sitemap_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."sitemap_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_run_one_active_per_target" ON "crawl_run" USING btree ("target_id") WHERE "crawl_run"."execution_status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "crawl_run_ready_idx" ON "crawl_run" USING btree ("available_at","created_at") WHERE "crawl_run"."execution_status" = 'queued';--> statement-breakpoint
CREATE INDEX "crawl_run_expired_idx" ON "crawl_run" USING btree ("lease_expires_at") WHERE "crawl_run"."execution_status" = 'running';--> statement-breakpoint
CREATE INDEX "crawl_run_history_idx" ON "crawl_run" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "crawl_source_revision_idx" ON "crawl_run_source" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "sitemap_cache_revision_idx" ON "sitemap_source_cache" USING btree ("revision_id");