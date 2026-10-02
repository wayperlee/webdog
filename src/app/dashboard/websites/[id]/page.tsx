import { AssignGroups } from "@/components/group-controls";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { websiteOwnerAccessible } from "@/lib/account-access";
import { MonitorDetail } from "@/components/monitor-detail";

export default async function WebsiteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [website] = await db
    .select()
    .from(schema.website)
    .where(and(eq(schema.website.id, id), websiteOwnerAccessible(user.id)))
    .limit(1);
  if (!website) notFound();
  const [group] = website.competitorGroupId
    ? await db
        .select()
        .from(schema.competitorGroup)
        .where(eq(schema.competitorGroup.id, website.competitorGroupId))
        .limit(1)
    : [];
  const targets = await db
    .select()
    .from(schema.target)
    .where(
      and(
        eq(schema.target.websiteId, id),
        eq(schema.target.kind, "SITEMAP_LINKS"),
      ),
    );
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <Link href="/dashboard" className="text-neutral-500">
        Websites
      </Link>
      <h1 className="mt-6 text-3xl font-semibold">{website.name}</h1>
      <p className="mt-2 font-mono text-sm">{website.url}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <span>
          Group:{" "}
          {group ? (
            <Link className="underline" href={`/dashboard/groups/${group.id}`}>
              {group.name}
            </Link>
          ) : (
            "Ungrouped"
          )}
        </span>
        <AssignGroups
          buttonText="Change group"
          defaultGroupId={website.competitorGroupId}
          websites={[
            {
              id: website.id,
              ownerId: website.userId,
              competitorGroupId: website.competitorGroupId,
            },
          ]}
        />
      </div>
      {targets.map((t) => (
        <MonitorDetail key={t.id} targetId={t.id} />
      ))}
      {!targets.length && (
        <p className="mt-8">No sitemap monitor configured.</p>
      )}
    </div>
  );
}
