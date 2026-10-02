"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MonitorSummary } from "@/lib/monitor-summary";
import { Badge, label, number, time, UrlLink } from "./monitor-format";

type Item = Record<string, string | number | null>;
type Page = { items: Item[]; total: number; nextOffset: number | null };
type Tab = "urls" | "events" | "runs" | "candidates" | "settings";
const tabs: [Tab, string][] = [
  ["urls", "URLs"],
  ["events", "Changes"],
  ["runs", "Runs"],
  ["candidates", "Candidates"],
  ["settings", "Settings"],
];
async function request(url: string, body?: unknown) {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Request failed. Please try again.");
  return data;
}
/** Abort previous view on navigation; poll sequentially so slower responses cannot replace a newer page. */
function usePage(url: string | null, revision: number) {
  const [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null);
    setError("");
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(url!, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Could not load this page");
        if (!controller.signal.aborted) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load this page");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(load, 5000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, revision]);
  return { data, error, loading };
}
function Pager({
  page,
  offset,
  onPage,
}: {
  page: Page;
  offset: number;
  onPage: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 px-5 py-4 text-sm">
      <span className="text-neutral-500">
        {page.total
          ? `${number(offset + 1)}–${number(offset + page.items.length)} of ${number(page.total)}`
          : "0 results"}
      </span>
      <div className="flex gap-2">
        <button
          className="btn-secondary"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - 50))}
        >
          Previous
        </button>
        <button
          className="btn-secondary"
          disabled={page.nextOffset === null}
          onClick={() => onPage(page.nextOffset!)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
export function MonitorDetail({ targetId }: { targetId: string }) {
  const router = useRouter();
  const [monitor, setMonitor] = useState<MonitorSummary | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("urls"),
    [scope, setScope] = useState<number | null>(null),
    [status, setStatus] = useState(""),
    [kind, setKind] = useState(""),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision((r) => r + 1);
    router.refresh();
  }, [router]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch(`/api/targets/${targetId}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load monitor");
        if (!controller.signal.aborted) setMonitor(data.target);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load monitor");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [targetId, revision]);
  const selectedScope = scope ?? monitor?.scopeVersion;
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  if (selectedScope) params.set("scopeVersion", String(selectedScope));
  if (tab === "urls" && status) params.set("status", status);
  if (tab === "events" && kind) params.set("kind", kind);
  if (["urls", "events"].includes(tab) && query) params.set("q", query);
  const collection = usePage(
    monitor && tab !== "settings"
      ? `/api/targets/${targetId}/${tab}?${params}`
      : null,
    revision,
  );
  async function mutate(body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/api/targets/${targetId}`, body);
      setNotice("Monitor updated. History is preserved.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update monitor");
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/targets/${targetId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not queue scan");
      setNotice(
        data.created
          ? "Scan submitted. Results update automatically as the scan progresses."
          : `A scan already exists. Available after ${time(data.run.availableAt)}.`,
      );
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue scan");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-8 space-y-5">
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 p-4 text-sm text-red-700"
        >
          {error}
          <button
            className="ml-4 underline"
            onClick={() => {
              setError("");
              refresh();
            }}
          >
            Reload
          </button>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}
      {!monitor ? (
        <p role="status">Loading monitor…</p>
      ) : (
        <>
          <section className="card p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold">Sitemap monitor</h2>
                <p className="mt-2 text-sm text-neutral-500">
                  {monitor.archivedAt
                    ? "Archived"
                    : monitor.enabled
                      ? "Monitoring"
                      : "Paused"}{" "}
                  · Every {monitor.checkIntervalHours} hours · Scope{" "}
                  {monitor.scopeVersion}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-secondary"
                  disabled={busy || !!monitor.archivedAt}
                  onClick={run}
                >
                  {busy ? "Working…" : "Run now"}
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      monitor.archivedAt
                        ? { archived: false }
                        : { enabled: !monitor.enabled },
                    )
                  }
                >
                  {monitor.archivedAt
                    ? "Restore"
                    : monitor.enabled
                      ? "Pause"
                      : "Resume"}
                </button>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
              {[
                [
                  "Current URLs",
                  monitor.baselineRunId ? number(monitor.currentCount) : "—",
                ],
                ["Pending removal", number(monitor.pendingCount)],
                ["Removed", number(monitor.removedCount)],
                [
                  "Changes · 24h",
                  `+${monitor.added24h} / −${monitor.removed24h}`,
                ],
              ].map(([title, value]) => (
                <div key={title}>
                  <p className="text-xs text-neutral-500">{title}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">
                    {value}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-xs text-neutral-500">
              <span>Last complete scan: {time(monitor.lastSuccessAt)}</span>
              <span>
                Next check:{" "}
                {monitor.enabled && !monitor.archivedAt
                  ? time(monitor.nextCheckDueAt)
                  : "Paused"}
              </span>
              {monitor.activeRun && <Badge value={monitor.activeRun} />}
            </div>
          </section>
          {!monitor.baselineRunId && (
            <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
              Waiting for the first complete scan in this scope. It establishes
              a baseline and creates no change events.{" "}
              {monitor.archivedAt
                ? "Restore to scan again."
                : "Use Run now to start."}
            </p>
          )}
          {monitor.lastError && (
            <p
              role="alert"
              className="rounded-xl bg-red-50 p-4 text-sm text-red-700"
            >
              Last scan issue: {monitor.lastError}. Check Runs for retry timing.
              After a final failure, use Run now to retry.
            </p>
          )}
          {!!(monitor.includePaths.length || monitor.excludePaths.length) && (
            <p className="text-sm text-neutral-500">
              Path filters are applied to URL inventory, changes and counts
              (filter version {monitor.filterVersion}). All observations remain
              stored. Candidates show their full missing set.
            </p>
          )}
          <nav
            aria-label="Website sections"
            className="flex gap-1 overflow-x-auto border-b border-neutral-200"
          >
            {tabs.map(([id, title]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                className={`whitespace-nowrap px-4 py-3 text-sm ${tab === id ? "border-b-2 border-brand-500 font-semibold text-neutral-900" : "text-neutral-500"}`}
                onClick={() => {
                  setTab(id);
                  setOffset(0);
                }}
              >
                {title}
                {id === "candidates" && monitor.pendingCandidates
                  ? ` (${monitor.pendingCandidates})`
                  : ""}
              </button>
            ))}
          </nav>
          {tab === "settings" ? (
            <MonitorSettings
              key={`${monitor.scopeVersion}:${monitor.filterVersion}:${monitor.checkIntervalHours}:${!!monitor.archivedAt}`}
              monitor={monitor}
              onSaved={() => {
                setScope(null);
                setOffset(0);
                refresh();
              }}
              onArchive={() => mutate({ archived: true })}
              busy={busy}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  Scope
                  <select
                    aria-label="Scope version"
                    className="input !w-auto"
                    value={selectedScope ?? ""}
                    onChange={(e) => {
                      setScope(Number(e.target.value));
                      setOffset(0);
                    }}
                  >
                    {monitor.scopes.map((s) => (
                      <option key={s} value={s}>
                        {s}
                        {s === monitor.scopeVersion
                          ? " · current"
                          : " · historical"}
                      </option>
                    ))}
                  </select>
                </label>
                {tab === "urls" && (
                  <select
                    aria-label="URL status"
                    className="input !w-auto"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All URL statuses</option>
                    {["active", "pending_removed", "removed"].map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                )}
                {tab === "events" && (
                  <select
                    aria-label="Change type"
                    className="input !w-auto"
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All change types</option>
                    {["added", "removed", "reappeared"].map((k) => (
                      <option key={k} value={k}>
                        {label(k)}
                      </option>
                    ))}
                  </select>
                )}
                {["urls", "events"].includes(tab) && (
                  <form
                    className="flex w-full gap-2 sm:w-auto"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setQuery(draft.trim());
                      setOffset(0);
                    }}
                  >
                    <input
                      aria-label="Search URLs"
                      className="input min-w-0 max-w-xs"
                      placeholder="Search URL"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <button className="btn-secondary">Search</button>
                    {query && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setQuery("");
                          setDraft("");
                          setOffset(0);
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </form>
                )}
              </div>
              <p className="text-xs text-neutral-500">
                {tab === "urls"
                  ? "First seen means first observed in a sitemap. Pending removal requires another complete scan at least one hour later."
                  : tab === "events"
                    ? "Sitemap removal does not mean a page is offline. The initial baseline creates no events."
                    : tab === "candidates"
                      ? "Large or empty drops are held for review. Adopting records a first missing observation; it does not immediately remove URLs."
                      : "Each attempt can take up to 10 minutes. Retries use the same Run and may extend its total duration."}
              </p>
              {selectedScope !== monitor.scopeVersion && (
                <p className="text-sm text-amber-700">
                  Historical scope {selectedScope}. The summary above describes
                  the current scope.
                </p>
              )}
              {collection.error && (
                <p role="alert" className="text-sm text-red-600">
                  {collection.error}
                  <button className="ml-3 underline" onClick={refresh}>
                    Retry loading
                  </button>
                </p>
              )}
              {!collection.data && !collection.error && (
                <p role="status">Loading {tab}…</p>
              )}
              {collection.data && (
                <div className="card overflow-hidden">
                  {!collection.data.items.length ? (
                    <p className="p-10 text-center text-sm text-neutral-500">
                      {tab === "urls"
                        ? "No URLs match this view. Check the scope and filters, or wait for a complete baseline."
                        : tab === "events"
                          ? "No changes match this view. The first complete scan only establishes a baseline."
                          : tab === "candidates"
                            ? "No removal candidates in this scope."
                            : "No scans in this scope yet. Use Run now to begin."}
                    </p>
                  ) : tab === "candidates" ? (
                    <div className="divide-y divide-neutral-100">
                      {collection.data.items.map((c) => (
                        <Candidate
                          key={String(c.id)}
                          candidate={c}
                          targetId={targetId}
                          archived={!!monitor.archivedAt}
                          onChanged={refresh}
                          revision={revision}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[760px] text-left text-sm">
                        <thead className="border-b border-neutral-100 text-xs text-neutral-500">
                          <tr>
                            {(tab === "urls"
                              ? [
                                  "URL",
                                  "Status",
                                  "First observed",
                                  "Last observed",
                                  "Missing evidence",
                                ]
                              : tab === "events"
                                ? ["URL", "Change", "Observed", "Run"]
                                : [
                                    "Created",
                                    "Execution",
                                    "Coverage",
                                    "Inventory",
                                    "URLs / Attempt",
                                  ]
                            ).map((h) => (
                              <th className="px-5 py-4 font-medium" key={h}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {collection.data.items.map((item, i) => (
                            <tr
                              key={String(item.id ?? item.url ?? i)}
                              className="border-b border-neutral-100 last:border-0"
                            >
                              {tab === "urls" ? (
                                <>
                                  <td className="max-w-md px-5 py-4">
                                    <UrlLink url={String(item.url)} />
                                  </td>
                                  <td className="px-5 py-4">
                                    <Badge value={String(item.status)} />
                                  </td>
                                  <td className="px-5 py-4 text-xs text-neutral-500">
                                    {time(String(item.first_seen_at))}
                                  </td>
                                  <td className="px-5 py-4 text-xs text-neutral-500">
                                    {time(String(item.last_seen_at))}
                                  </td>
                                  <td className="px-5 py-4 text-xs text-neutral-500">
                                    {item.missing_confirmations
                                      ? `${item.missing_confirmations} complete scans`
                                      : "—"}
                                    {item.first_missing_observed_at && (
                                      <p className="mt-1">
                                        Since{" "}
                                        {time(
                                          String(
                                            item.first_missing_observed_at,
                                          ),
                                        )}
                                      </p>
                                    )}
                                  </td>
                                </>
                              ) : tab === "events" ? (
                                <>
                                  <td className="max-w-md px-5 py-4">
                                    <UrlLink url={String(item.url)} />
                                  </td>
                                  <td className="px-5 py-4">
                                    <Badge value={String(item.kind)} />
                                  </td>
                                  <td className="px-5 py-4 text-xs text-neutral-500">
                                    {time(String(item.observed_at))}
                                  </td>
                                  <td className="px-5 py-4 font-mono text-xs">
                                    <span title={String(item.run_id)}>
                                      {String(item.run_id).slice(0, 8)}
                                    </span>
                                  </td>
                                </>
                              ) : (
                                <RunCells run={item} />
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <Pager
                    page={collection.data}
                    offset={offset}
                    onPage={setOffset}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
function RunCells({ run }: { run: Item }) {
  const failure = run.error as unknown as { message?: string } | null;
  return (
    <>
      <td className="px-5 py-4 text-xs text-neutral-500">
        {time(String(run.createdAt))}
        <p className="mt-1 font-mono" title={String(run.id)}>
          {String(run.id).slice(0, 8)} · {run.trigger}
        </p>
      </td>
      <td className="max-w-xs px-5 py-4">
        <Badge
          value={String(run.executionStatus)}
          text={
            run.executionStatus === "queued" && Number(run.attempt) > 0
              ? "Retry scheduled"
              : undefined
          }
        />
        {run.executionStatus === "queued" && (
          <p className="mt-2 text-xs text-neutral-500">
            Available: {time(String(run.availableAt))}
          </p>
        )}
        {failure?.message && (
          <p className="mt-2 text-xs text-red-700">{failure.message}</p>
        )}
      </td>
      <td className="px-5 py-4">
        <Badge value={String(run.completeness)} />
      </td>
      <td className="px-5 py-4">
        <Badge value={String(run.adoptionStatus)} />
      </td>
      <td className="px-5 py-4 text-xs text-neutral-500">
        {run.urlCount === null ? "—" : number(Number(run.urlCount))} URLs
        <p className="mt-1">Attempt {run.attempt}</p>
      </td>
    </>
  );
}
function Candidate({
  candidate: c,
  targetId,
  archived,
  onChanged,
  revision,
}: {
  candidate: Item;
  targetId: string;
  archived: boolean;
  onChanged: () => void;
  revision: number;
}) {
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const page = usePage(
    open
      ? `/api/targets/${targetId}/candidates/${c.id}/urls?limit=50&offset=${offset}`
      : null,
    revision,
  );
  async function approve() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/targets/${targetId}/candidates/${c.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const body = await res.json();
      if (!res.ok)
        throw new Error(
          body.error === "CANDIDATE_STALE"
            ? "This candidate is outdated. Reload to see the current state."
            : (body.error ?? "Could not adopt candidate"),
        );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not adopt candidate");
    } finally {
      setBusy(false);
    }
  }
  const expired = new Date(String(c.expires_at)).getTime() <= Date.now();
  return (
    <article className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Badge
            value={
              c.status === "pending" && expired ? "expired" : String(c.status)
            }
            text={
              c.reason === "missing_set_changed"
                ? "Replaced · missing set changed"
                : undefined
            }
          />
          <p className="mt-3 text-sm tabular-nums">
            Original: {c.original_missing_count} · Pending: {c.pending_count} ·
            Recovered: {c.recovered_count} · Removed: {c.removed_count}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Observed {time(String(c.observed_at))} · Expires{" "}
            {time(String(c.expires_at))}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Baseline{" "}
            <span
              className="font-mono"
              title={String(c.origin_baseline_run_id)}
            >
              {String(c.origin_baseline_run_id).slice(0, 8)}
            </span>
            {c.next_confirmation_at && (
              <> · Next confirmation {time(String(c.next_confirmation_at))}</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide URLs" : "View missing URLs"}
          </button>
          {c.status === "pending" && (
            <button
              className="btn-accent"
              disabled={archived || busy || expired}
              onClick={approve}
            >
              {busy
                ? "Adopting…"
                : expired
                  ? "Expired"
                  : "Adopt first observation"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {open && (
        <div className="mt-4 rounded-xl border border-neutral-100">
          {page.error && (
            <p role="alert" className="p-4 text-sm text-red-600">
              {page.error}
            </p>
          )}
          {!page.data && !page.error && (
            <p className="p-4 text-sm">Loading missing URLs…</p>
          )}
          {page.data && (
            <>
              <ul className="divide-y divide-neutral-100">
                {page.data.items.map((u) => (
                  <li
                    key={String(u.url)}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <UrlLink url={String(u.url)} />
                    <Badge value={String(u.resolution)} />
                  </li>
                ))}
              </ul>
              <Pager page={page.data} offset={offset} onPage={setOffset} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
function MonitorSettings({
  monitor: t,
  onSaved,
  onArchive,
  busy,
}: {
  monitor: MonitorSummary;
  onSaved: () => void;
  onArchive: () => void;
  busy: boolean;
}) {
  const [interval, setInterval] = useState(String(t.checkIntervalHours)),
    [includes, setIncludes] = useState(t.includePaths.join("\n")),
    [excludes, setExcludes] = useState(t.excludePaths.join("\n"));
  const [roots, setRoots] = useState(t.sitemapRoots?.join("\n") ?? ""),
    [hosts, setHosts] = useState(t.allowedPageHosts?.join("\n") ?? ""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  async function save(scope: boolean) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = scope
        ? {
            roots: roots.trim() ? lines(roots) : null,
            allowedPageHosts: hosts.trim() ? lines(hosts) : null,
          }
        : {
            checkIntervalHours: Number(interval),
            includePaths: lines(includes),
            excludePaths: lines(excludes),
          };
      const result = await request(
        `/api/targets/${t.id}${scope ? "/scope" : ""}`,
        body,
      );
      setNotice(
        scope && result.changed
          ? "Scope updated. Run a complete scan to establish the new baseline."
          : "Settings saved.",
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }
  const disabled = saving || busy || !!t.archivedAt;
  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}
      <form
        className="card space-y-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <h3 className="font-semibold">Schedule and view filters</h3>
        <label className="block text-sm">
          Check interval
          <select
            aria-label="Check interval"
            className="input mt-2 max-w-xs"
            disabled={disabled}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {[1, 6, 12, 24].map((h) => (
              <option key={h} value={h}>
                Every {h} hours
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm">
            Include path prefixes
            <textarea
              aria-label="Include path prefixes"
              rows={4}
              className="input mt-2 font-mono"
              placeholder="/blog/"
              value={includes}
              disabled={disabled}
              onChange={(e) => setIncludes(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Exclude path prefixes
            <textarea
              aria-label="Exclude path prefixes"
              rows={4}
              className="input mt-2 font-mono"
              placeholder="/blog/tag/"
              value={excludes}
              disabled={disabled}
              onChange={(e) => setExcludes(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-neutral-500">
          One literal, case-sensitive pathname prefix per line. Empty Include
          shows all paths; Exclude wins. Use the encoded pathname for non-ASCII
          URLs. Filters affect views and counts only, including historical
          scopes; they never change stored inventory or removal evidence.
        </p>
        <button className="btn-accent" disabled={disabled}>
          {saving ? "Saving…" : "Save schedule and filters"}
        </button>
      </form>
      <form
        className="card space-y-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <h3 className="font-semibold">Sitemap scope</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm">
            Sitemap URLs
            <textarea
              aria-label="Sitemap URLs"
              rows={4}
              className="input mt-2 font-mono"
              placeholder="Auto-discover from robots.txt and common paths"
              disabled={disabled}
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Allowed page hosts
            <textarea
              aria-label="Allowed page hosts"
              rows={4}
              className="input mt-2 font-mono"
              placeholder="Default: site host and its www variant"
              disabled={disabled}
              value={hosts}
              onChange={(e) => setHosts(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-neutral-500">
          One URL or hostname per line. Leave blank for automatic defaults.
          Changing scope starts a new baseline, cancels queued scans and
          invalidates active candidates. Earlier inventory and events remain
          available under historical scopes.
        </p>
        <button className="btn-secondary" disabled={disabled}>
          {saving ? "Saving…" : "Save sitemap scope"}
        </button>
      </form>
      <div className="card p-6">
        <h3 className="font-semibold">Archive monitor</h3>
        <p className="mt-2 text-sm text-neutral-500">
          Archiving stops automatic and manual scans, cancels active work and
          preserves all history. Restore from this page or the archived website
          list.
        </p>
        <button
          className="btn-secondary mt-4"
          disabled={disabled}
          onClick={onArchive}
        >
          {t.archivedAt ? "Archived" : "Archive monitor"}
        </button>
      </div>
    </div>
  );
}
