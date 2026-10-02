CREATE TABLE "competitor_group" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"membership_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_group_name_check" CHECK (char_length("competitor_group"."name") BETWEEN 1 AND 80 AND "competitor_group"."name"=btrim("competitor_group"."name")),
	CONSTRAINT "competitor_group_description_check" CHECK (char_length("competitor_group"."description")<=2000),
	CONSTRAINT "competitor_group_version_check" CHECK ("competitor_group"."membership_version">0)
);
--> statement-breakpoint
ALTER TABLE "website" ADD COLUMN "competitor_group_id" text;--> statement-breakpoint
ALTER TABLE "competitor_group" ADD CONSTRAINT "competitor_group_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_group_owner_identity" ON "competitor_group" USING btree ("id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_group_owner_name" ON "competitor_group" USING btree ("owner_user_id",lower(btrim("name")));--> statement-breakpoint
ALTER TABLE "website" ADD CONSTRAINT "website_group_owner_fk" FOREIGN KEY ("competitor_group_id","userId") REFERENCES "public"."competitor_group"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_owner_group_idx" ON "website" USING btree ("userId","competitor_group_id","id");