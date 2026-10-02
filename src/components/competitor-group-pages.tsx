"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  GroupOverview,
  GroupWebsite,
  GroupWindow,
} from "@/lib/competitor-group-summary";
import { groupWebsiteStatus } from "@/lib/group-status";
import { GroupEditor, AssignGroups, groupRequest } from "./group-controls";
import { AddWebsiteDialog } from "./add-website-dialog";
import { Badge, time, number } from "./monitor-format";
function useData<T>(path: string, revision: number, enabled = true) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setLoading(true);
    setError(null);
    if (!enabled) return () => abort.abort();
    async function load() {
      try {
        const d = await groupRequest(path, { signal: abort.signal });
        if (!abort.signal.aborted) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load groups");
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, revision, enabled]);
  return { data, error, loading };
}
function WindowControls({
  window,
  onWindow,
  archived,
  onArchived,
}: {
  window: GroupWindow;
  onWindow: (w: GroupWindow) => void;
  archived: boolean;
  onArchived: (b: boolean) => void;
}) {
  return (
    <>
      <label className="text-sm">
        Changes window
        <select
          aria-label="Changes window"
          className="input mt-1"
          value={window}
          onChange={(e) => onWindow(e.target.value as GroupWindow)}
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => onArchived(e.target.checked)}
        />
        Show archived
      </label>
    </>
  );
}
function LoadState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <>
      {loading && (
        <p className="mt-5 text-sm" role="status">
          Loading groups…
        </p>
      )}
      {error && (
        <div className="mt-4 rounded-lg bg-red-50 p-4 text-sm">
          <p role="alert">{error}</p>
          <button className="btn-secondary mt-2" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </>
  );
}
export function CompetitorGroupList() {
  const [window, setWindow] = useState<GroupWindow>("24h"),
    [archived, setArchived] = useState(false),
    [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const path = `/api/competitor-groups/overview?window=${window}&includeArchived=${archived}&q=${encodeURIComponent(search)}&limit=50&offset=${offset}`;
  const { data, error, loading } = useData<{
    items: GroupOverview[];
    total: number;
    asOf: string;
  }>(path, revision);
  const refresh = () => setRevision((r) => r + 1);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Competitor groups</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Monitor websites operated by the same competitor.
          </p>
        </div>
        <GroupEditor onSaved={refresh} />
      </div>
      <div className="mt-7 flex flex-wrap items-end gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
            setOffset(0);
          }}
          className="flex gap-2"
        >
          <input
            className="input max-w-xs"
            aria-label="Search groups"
            placeholder="Search groups"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn-secondary">Search</button>
        </form>
        <WindowControls
          window={window}
          onWindow={(w) => {
            setWindow(w);
            setOffset(0);
          }}
          archived={archived}
          onArchived={(b) => {
            setArchived(b);
            setOffset(0);
          }}
        />
      </div>
      <LoadState loading={loading} error={error} onRetry={refresh} />
      {data && (
        <>
          <div className="card mt-5 overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-sm">
              <thead className="border-b text-xs text-neutral-500">
                <tr>
                  {[
                    "Group",
                    "Baselines / websites",
                    "Current URLs",
                    "Added",
                    "Removed",
                    "Reappeared",
                    "Attention",
                  ].map((x) => (
                    <th className="px-4 py-4" key={x}>
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((g) => (
                  <tr key={g.id} className="border-b last:border-0">
                    <td className="px-4 py-5">
                      <Link
                        className="font-semibold"
                        href={`/dashboard/groups/${g.id}`}
                      >
                        {g.name}
                      </Link>
                      {g.description && (
                        <p className="mt-1 max-w-xs truncate text-xs text-neutral-500">
                          {g.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4">
                      {g.baselineWebsiteCount} / {g.websiteCount}
                    </td>
                    <td className="px-4">
                      {g.currentUrlCount === null
                        ? "—"
                        : number(g.currentUrlCount)}
                    </td>
                    <td className="px-4 text-emerald-700">
                      +{number(g.added)}
                    </td>
                    <td className="px-4 text-red-700">−{number(g.removed)}</td>
                    <td className="px-4">{number(g.reappeared)}</td>
                    <td className="px-4 text-xs">
                      {g.pendingRemovalCount} pending URLs
                      <br />
                      {g.pendingCandidates} candidates
                      {g.statusCounts.failed ? (
                        <> · {g.statusCounts.failed} failed</>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.items.length && (
              <p className="p-10 text-center text-sm text-neutral-500">
                {search
                  ? "No groups match this search."
                  : "Create a group, then add existing or new websites."}
              </p>
            )}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              className="btn-secondary"
              disabled={!offset}
              onClick={() => setOffset((o) => Math.max(0, o - 50))}
            >
              Previous
            </button>
            <span className="text-sm text-neutral-500">
              {data.total} groups
            </span>
            <button
              className="btn-secondary"
              disabled={offset + 50 >= data.total}
              onClick={() => setOffset((o) => o + 50)}
            >
              Next
            </button>
          </div>
        </>
      )}
      <GroupMeaning />
    </div>
  );
}
function GroupMeaning() {
  return (
    <p className="mt-5 text-xs text-neutral-500">
      History follows current group members, current monitor scopes and path
      filters. Moving websites changes this view. Current URLs include URLs
      pending removal; sitemap removal does not mean a page is offline.
    </p>
  );
}
type WebsitePage = {
  group: GroupOverview;
  items: GroupWebsite[];
  total: number;
  nextOffset: number | null;
  asOf: string;
  websiteChoices: { id: string; name: string }[];
};
type EventRow = {
  id: string;
  url: string;
  kind: string;
  observedAt: string;
  websiteId: string;
  websiteName: string;
  runId: string;
  targetId: string;
};
export function CompetitorGroupDetail({ id }: { id: string }) {
  const router = useRouter();
  const [window, setWindow] = useState<GroupWindow>("24h"),
    [archived, setArchived] = useState(false),
    [tab, setTab] = useState("websites"),
    [sort, setSort] = useState("changes"),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [deleting, setDeleting] = useState(false),
    [deleteError, setDeleteError] = useState<string | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [siteId, setSiteId] = useState(""),
    [kind, setKind] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]);
  const { data, error, loading } = useData<WebsitePage>(
    `/api/competitor-groups/${id}/websites?window=${window}&includeArchived=${archived}&sort=${sort}&limit=50&offset=${offset}`,
    revision,
  );
  const {
    data: events,
    error: eventError,
    loading: eventLoading,
  } = useData<{ items: EventRow[]; nextCursor: string | null; asOf: string }>(
    `/api/competitor-groups/${id}/events?window=${window}&includeArchived=${archived}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ""}${kind ? `&kind=${kind}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    revision,
    tab === "changes",
  );
  const reset = () => {
    setOffset(0);
    setSelected([]);
    setCursor(null);
    setPrevious([]);
  };
  const refresh = () => {
    if (siteId && !data?.websiteChoices.some((w) => w.id === siteId))
      setSiteId("");
    reset();
    setRevision((r) => r + 1);
  };
  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await groupRequest(`/api/competitor-groups/${id}`, { method: "DELETE" });
      router.push("/dashboard/groups");
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete group");
    } finally {
      setDeleting(false);
    }
  }
  const g = data?.group;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <Link className="text-sm text-neutral-500" href="/dashboard/groups">
        Competitor groups
      </Link>
      <LoadState loading={loading} error={error} onRetry={refresh} />
      {g && (
        <>
          <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">{g.name}</h1>
              {g.description && (
                <p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-sm text-neutral-600">
                  {g.description}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <GroupEditor group={g} onSaved={refresh} />
              <AddWebsiteDialog defaultGroupId={id} />
              <button
                className="btn-secondary"
                onClick={() => setConfirmDelete(true)}
              >
                Delete group
              </button>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <WindowControls
              window={window}
              onWindow={(w) => {
                setWindow(w);
                setSiteId("");
                reset();
              }}
              archived={archived}
              onArchived={(b) => {
                setArchived(b);
                setSiteId("");
                reset();
              }}
            />
            <Link className="text-sm underline" href="/dashboard">
              Assign existing websites
            </Link>
          </div>
          <div className="card mt-5 grid grid-cols-2 gap-5 p-6 md:grid-cols-4">
            {[
              [
                "Baselines / websites",
                `${g.baselineWebsiteCount} / ${g.websiteCount}`,
              ],
              [
                "Current URLs",
                g.currentUrlCount === null ? "—" : number(g.currentUrlCount),
              ],
              [
                "Changes",
                `+${number(g.added)} / −${number(g.removed)} / ${number(g.reappeared)} reappeared`,
              ],
              [
                "Pending",
                `${g.pendingRemovalCount} URLs · ${g.pendingCandidates} candidates`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-neutral-500">{label}</p>
                <p className="mt-2 text-lg font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            Latest individual site scan: {time(g.latestSiteScanAt)} ·{" "}
            {Object.entries(g.statusCounts)
              .map(
                ([state, n]) =>
                  `${n} ${state === "active" ? "monitoring" : state}`,
              )
              .join(" · ")}
          </p>
          <nav className="mt-6 flex gap-3 border-b" aria-label="Group sections">
            {["websites", "changes"].map((x) => (
              <button
                key={x}
                className={`px-4 py-3 text-sm ${tab === x ? "border-b-2 border-brand-500 font-semibold" : "text-neutral-500"}`}
                onClick={() => setTab(x)}
              >
                {x === "websites" ? "Websites" : "Changes"}
              </button>
            ))}
          </nav>
          {tab === "websites" ? (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <select
                  className="input max-w-xs"
                  aria-label="Sort group websites"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setOffset(0);
                    setSelected([]);
                  }}
                >
                  <option value="changes">Most changes first</option>
                  <option value="name">Website name</option>
                </select>
                <span className="text-sm">{selected.length} selected</span>
                <AssignGroups
                  websites={data.items.filter((w) => selected.includes(w.id))}
                  onSaved={refresh}
                />
              </div>
              <div className="card mt-5 overflow-x-auto">
                <table className="w-full min-w-[850px] text-left text-sm">
                  <thead className="border-b text-xs text-neutral-500">
                    <tr>
                      {[
                        "Select",
                        "Website",
                        "Current URLs",
                        "Added / Removed / Reappeared",
                        "Status",
                        "Last complete scan",
                      ].map((x) => (
                        <th key={x} className="px-4 py-4">
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((w) => (
                      <tr key={w.id} className="border-b last:border-0">
                        <td className="px-4 py-4">
                          <input
                            type="checkbox"
                            aria-label={`Select ${w.domain}`}
                            checked={selected.includes(w.id)}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, w.id]
                                  : s.filter((x) => x !== w.id),
                              )
                            }
                          />
                        </td>
                        <td className="px-4">
                          <Link
                            className="font-semibold"
                            href={`/dashboard/websites/${w.id}`}
                          >
                            {w.name}
                          </Link>
                          <p className="text-xs text-neutral-500">{w.domain}</p>
                        </td>
                        <td className="px-4">
                          {w.baselineRunId ? number(w.currentCount) : "—"}
                        </td>
                        <td className="px-4">
                          +{w.added} / −{w.removed} / {w.reappeared}
                        </td>
                        <td className="px-4">
                          <Badge value={groupWebsiteStatus(w)} />
                          {w.lastError && (
                            <p className="mt-1 max-w-xs truncate text-xs text-red-700">
                              {w.lastError}
                            </p>
                          )}
                        </td>
                        <td className="px-4 text-xs">
                          {time(w.lastSuccessAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.items.length && (
                  <p className="p-10 text-center text-sm text-neutral-500">
                    Add existing or new websites to this group, or show archived
                    websites.
                  </p>
                )}
              </div>
              <div className="mt-4 flex gap-3">
                <button
                  className="btn-secondary"
                  disabled={!offset}
                  onClick={() => {
                    setOffset((o) => Math.max(0, o - 50));
                    setSelected([]);
                  }}
                >
                  Previous
                </button>
                <span className="self-center text-sm">
                  {data.total} websites
                </span>
                <button
                  className="btn-secondary"
                  disabled={data.nextOffset === null}
                  onClick={() => {
                    setOffset(data.nextOffset!);
                    setSelected([]);
                  }}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-3">
                <select
                  className="input max-w-xs"
                  aria-label="Filter group changes by website"
                  value={siteId}
                  onChange={(e) => {
                    setSiteId(e.target.value);
                    setCursor(null);
                    setPrevious([]);
                  }}
                >
                  <option value="">All member websites</option>
                  {data.websiteChoices.map((w) => (
                    <option value={w.id} key={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <select
                  className="input max-w-xs"
                  aria-label="Filter group event kind"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setCursor(null);
                    setPrevious([]);
                  }}
                >
                  <option value="">All event types</option>
                  {["added", "removed", "reappeared"].map((k) => (
                    <option value={k} key={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <button className="btn-secondary" onClick={refresh}>
                  Refresh timeline
                </button>
              </div>
              <LoadState
                loading={eventLoading}
                error={eventError}
                onRetry={refresh}
              />
              {events && (
                <>
                  <div className="card mt-5 overflow-x-auto">
                    <table className="w-full min-w-[750px] text-left text-sm">
                      <thead className="border-b text-xs text-neutral-500">
                        <tr>
                          {["Observed", "Website", "Change", "URL"].map((x) => (
                            <th className="px-4 py-4" key={x}>
                              {x}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {events.items.map((e) => (
                          <tr className="border-b last:border-0" key={e.id}>
                            <td className="px-4 py-4 text-xs">
                              {time(e.observedAt)}
                            </td>
                            <td className="px-4">
                              <Link href={`/dashboard/websites/${e.websiteId}`}>
                                {e.websiteName}
                              </Link>
                            </td>
                            <td className="px-4">
                              <Badge value={e.kind} />
                            </td>
                            <td className="max-w-lg break-all px-4">
                              <a
                                href={e.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {e.url}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!events.items.length && (
                      <p className="p-10 text-center text-sm text-neutral-500">
                        No sitemap changes in this view. Initial baselines do
                        not create events.
                      </p>
                    )}
                  </div>
                  <div className="mt-4 flex gap-3">
                    <button
                      className="btn-secondary"
                      disabled={!previous.length}
                      onClick={() => {
                        setCursor(previous.at(-1) ?? null);
                        setPrevious((s) => s.slice(0, -1));
                      }}
                    >
                      Previous
                    </button>
                    <button
                      className="btn-secondary"
                      disabled={!events.nextCursor}
                      onClick={() => {
                        setPrevious((s) => [...s, cursor]);
                        setCursor(events.nextCursor);
                      }}
                    >
                      Next changes
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          <GroupMeaning />
        </>
      )}
      {confirmDelete && g && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete competitor group"
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="font-semibold">Delete {g.name}?</h2>
            <p className="mt-3 text-sm">
              All member websites, including archived websites, become
              ungrouped. Monitoring and history are retained.
            </p>
            {deleteError && (
              <p className="mt-3 text-red-700" role="alert">
                {deleteError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                className="btn-accent"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? "Deleting…" : "Delete group"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
