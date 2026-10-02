ALTER TABLE "target" ADD COLUMN "include_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "target" ADD COLUMN "exclude_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;