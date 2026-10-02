"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AddWebsiteDialog } from "./add-website-dialog";
import { Badge, time, number } from "./monitor-format";
import type { MonitorSummary } from "@/lib/monitor-summary";
type Website = {
  id: string;
  name: string;
  domain: string;
  monitor: MonitorSummary | null;
};
export function WebsiteListView({ websites }: { websites: Website[] }) {
  const router = useRouter();
  const [search, setSearch] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [router]);
  const visible = websites.filter(
    (w) =>
      (showArchived || !w.monitor?.archivedAt) &&
      `${w.name} ${w.domain}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Websites</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Track sitemap inventory and changes over time.
          </p>
        </div>
        <AddWebsiteDialog />
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <input
          aria-label="Search websites"
          className="input max-w-xs"
          placeholder="Search websites"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <span className="text-sm text-neutral-500">
          {visible.length} websites
        </span>
      </div>
      <div className="card mt-5 overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-neutral-100 text-xs text-neutral-500">
            <tr>
              {[
                "Website",
                "Current URLs",
                "Changes · 24h",
                "Status",
                "Last complete scan",
                "Next check",
              ].map((name) => (
                <th className="px-5 py-4 font-medium" key={name}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((w) => {
              const t = w.monitor;
              const status = !t
                ? "No monitor"
                : t.archivedAt
                  ? "Archived"
                  : !t.enabled
                    ? "Paused"
                    : t.activeRun
                      ? t.activeRun
                      : t.lastError
                        ? "failed"
                        : !t.baselineRunId
                          ? "Awaiting baseline"
                          : "active";
              return (
                <tr
                  key={w.id}
                  className="border-b border-neutral-100 last:border-0"
                >
                  <td className="px-5 py-5">
                    <Link
                      className="font-semibold hover:text-brand-600"
                      href={`/dashboard/websites/${w.id}`}
                    >
                      {w.name}
                    </Link>
                    <p className="mt-1 text-xs text-neutral-500">{w.domain}</p>
                  </td>
                  <td className="px-5 py-5 tabular-nums">
                    {t?.baselineRunId ? number(t.currentCount) : "—"}
                    {t && (t.includePaths.length || t.excludePaths.length) ? (
                      <p className="mt-1 text-xs text-neutral-400">Filtered</p>
                    ) : null}
                  </td>
                  <td className="px-5 py-5 tabular-nums">
                    {t ? (
                      <>
                        <span className="text-emerald-700">+{t.added24h}</span>{" "}
                        / <span className="text-red-600">−{t.removed24h}</span>
                        {t.reappeared24h > 0 && (
                          <p className="mt-1 text-xs text-neutral-500">
                            {t.reappeared24h} reappeared
                          </p>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-5">
                    <Badge
                      value={status}
                      text={status === "active" ? "Monitoring" : undefined}
                    />
                    {t && t.pendingCandidates > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        {t.pendingCandidates} awaiting confirmation
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-5 text-xs text-neutral-500">
                    {time(t?.lastSuccessAt)}
                  </td>
                  <td className="px-5 py-5 text-xs text-neutral-500">
                    {t && !t.archivedAt && t.enabled
                      ? time(t.nextCheckDueAt)
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && (
          <div className="p-12 text-center text-sm text-neutral-500">
            {websites.length
              ? "No websites match this view. Try another search or show archived websites."
              : "Add your first website to establish its sitemap baseline."}
          </div>
        )}
      </div>
      <p className="mt-5 text-xs text-neutral-500">
        Current URLs include URLs pending removal. Sitemap removal does not mean
        a page is offline.
      </p>
    </>
  );
}
