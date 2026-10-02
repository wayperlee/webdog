import { desc, eq, and } from "drizzle-orm";
import { db, getPool } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { requireUser } from "@/lib/session";
import { WebsiteListView } from "@/components/website-list-view";
import { monitorSummaries } from "@/lib/monitor-summary";
export default async function DashboardPage() {
  const user = await requireUser();
  const websites = await db
    .select({
      id: schema.website.id,
      name: schema.website.name,
      domain: schema.website.domain,
      targetId: schema.target.id,
    })
    .from(schema.website)
    .leftJoin(
      schema.target,
      and(
        eq(schema.target.websiteId, schema.website.id),
        eq(schema.target.kind, "SITEMAP_LINKS"),
      ),
    )
    .where(websiteOwnerAccessible(user.id))
    .orderBy(desc(schema.website.createdAt));
  const monitors = await monitorSummaries(
    getPool(),
    websites.flatMap((w) => (w.targetId ? [w.targetId] : [])),
  );
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <WebsiteListView
        websites={websites.map((w) => ({
          ...w,
          monitor: monitors.find((t) => t.id === w.targetId) ?? null,
        }))}
      />
    </div>
  );
}
