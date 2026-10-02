CREATE TABLE "candidate_missing_url" (
	"candidate_id" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"url" text NOT NULL,
	"resolution" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "candidate_missing_url_candidate_id_normalized_url_hash_pk" PRIMARY KEY("candidate_id","normalized_url_hash"),
	CONSTRAINT "candidate_url_resolution_check" CHECK ("candidate_missing_url"."resolution" IN ('pending','recovered','removed'))
);
--> statement-breakpoint
CREATE TABLE "removal_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"scope_version" integer NOT NULL,
	"origin_baseline_run_id" text NOT NULL,
	"candidate_run_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"missing_set_hash" text NOT NULL,
	"original_missing_count" integer NOT NULL,
	"pending_count" integer NOT NULL,
	"recovered_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"next_confirmation_at" timestamp (3) with time zone,
	"confirmation_attempts" integer DEFAULT 0 NOT NULL,
	"last_confirmation_run_id" text,
	CONSTRAINT "candidate_status_check" CHECK ("removal_candidate"."status" IN ('pending','adopted','confirmed','rejected','stale','expired')),
	CONSTRAINT "candidate_counts_check" CHECK ("removal_candidate"."original_missing_count" > 0 AND "removal_candidate"."pending_count" >= 0 AND "removal_candidate"."recovered_count" >= 0 AND "removal_candidate"."removed_count" >= 0 AND "removal_candidate"."original_missing_count"="removal_candidate"."pending_count"+"removal_candidate"."recovered_count"+"removal_candidate"."removed_count")
);
--> statement-breakpoint
CREATE TABLE "site_url" (
	"website_id" text NOT NULL,
	"scope_version" integer NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"first_missing_run_id" text,
	"first_missing_observed_at" timestamp (3) with time zone,
	"last_missing_run_id" text,
	"missing_confirmations" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp (3) with time zone,
	CONSTRAINT "site_url_website_id_scope_version_normalized_url_hash_pk" PRIMARY KEY("website_id","scope_version","normalized_url_hash"),
	CONSTRAINT "site_url_status_check" CHECK ("site_url"."status" IN ('active','pending_removed','removed')),
	CONSTRAINT "site_url_evidence_check" CHECK (("site_url"."status"='active' AND "site_url"."missing_confirmations"=0 AND "site_url"."first_missing_run_id" IS NULL AND "site_url"."first_missing_observed_at" IS NULL AND "site_url"."last_missing_run_id" IS NULL AND "site_url"."removed_at" IS NULL) OR ("site_url"."status"='pending_removed' AND "site_url"."missing_confirmations"=1 AND "site_url"."first_missing_run_id" IS NOT NULL AND "site_url"."first_missing_observed_at" IS NOT NULL AND "site_url"."last_missing_run_id" IS NOT NULL AND "site_url"."removed_at" IS NULL) OR ("site_url"."status"='removed' AND "site_url"."missing_confirmations"=2 AND "site_url"."first_missing_run_id" IS NOT NULL AND "site_url"."first_missing_observed_at" IS NOT NULL AND "site_url"."last_missing_run_id" IS NOT NULL AND "site_url"."removed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "url_event" (
	"id" text PRIMARY KEY NOT NULL,
	"website_id" text NOT NULL,
	"scope_version" integer NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"url" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "url_event_kind_check" CHECK ("url_event"."kind" IN ('added','removed','reappeared'))
);
--> statement-breakpoint
ALTER TABLE "crawl_run" ADD COLUMN "observed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "candidate_missing_url" ADD CONSTRAINT "candidate_missing_url_candidate_id_removal_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."removal_candidate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_candidate" ADD CONSTRAINT "removal_candidate_target_id_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."target"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_candidate" ADD CONSTRAINT "removal_candidate_origin_baseline_run_id_crawl_run_id_fk" FOREIGN KEY ("origin_baseline_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_candidate" ADD CONSTRAINT "removal_candidate_candidate_run_id_crawl_run_id_fk" FOREIGN KEY ("candidate_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_candidate" ADD CONSTRAINT "removal_candidate_last_confirmation_run_id_crawl_run_id_fk" FOREIGN KEY ("last_confirmation_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_url" ADD CONSTRAINT "site_url_website_id_website_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."website"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_url" ADD CONSTRAINT "site_url_first_missing_run_id_crawl_run_id_fk" FOREIGN KEY ("first_missing_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_url" ADD CONSTRAINT "site_url_last_missing_run_id_crawl_run_id_fk" FOREIGN KEY ("last_missing_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_event" ADD CONSTRAINT "url_event_website_id_website_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."website"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_event" ADD CONSTRAINT "url_event_run_id_crawl_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."crawl_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_one_pending_idx" ON "removal_candidate" USING btree ("target_id","scope_version") WHERE "removal_candidate"."status"='pending';--> statement-breakpoint
CREATE INDEX "candidate_due_idx" ON "removal_candidate" USING btree ("next_confirmation_at") WHERE "removal_candidate"."status" IN ('pending','adopted');--> statement-breakpoint
CREATE INDEX "site_url_status_idx" ON "site_url" USING btree ("website_id","scope_version","status","normalized_url_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "url_event_once_idx" ON "url_event" USING btree ("run_id","normalized_url_hash","kind");--> statement-breakpoint
CREATE INDEX "url_event_history_idx" ON "url_event" USING btree ("website_id","scope_version","observed_at","id");