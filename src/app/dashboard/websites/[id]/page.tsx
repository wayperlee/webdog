import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { websiteOwnerAccessible } from "@/lib/account-access";

export default async function WebsiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [website] = await db.select().from(schema.website)
    .where(and(eq(schema.website.id, id), websiteOwnerAccessible(user.id))).limit(1);
  if (!website) notFound();
  const targets = await db.select().from(schema.target)
    .where(and(eq(schema.target.websiteId, id), eq(schema.target.kind, "SITEMAP_LINKS")));
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
    <Link href="/dashboard" className="text-neutral-500">Websites</Link>
    <h1 className="mt-6 text-3xl font-semibold">{website.name}</h1>
    <p className="mt-2 font-mono text-sm">{website.url}</p>
    <section className="mt-8 rounded-2xl bg-white p-6 ring-1 ring-neutral-950/5">
      <h2 className="font-semibold">Sitemap monitor</h2>
      {targets.map((t) => <p key={t.id} className="mt-2 text-sm text-neutral-600">
        {t.enabled ? "Enabled" : "Paused"} · Every {t.checkIntervalHours} hours
      </p>)}
      <p className="mt-4 text-sm text-neutral-600">Website saved. Sitemap checks are not available yet.</p>
      <button disabled className="btn-secondary mt-4">Run now unavailable</button>
    </section>
  </div>;
}
