"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
export type GroupChoice = { id: string; name: string; ownerId: string };
const errors: Record<string, string> = {
  GROUP_NAME_EXISTS: "A group with this name already exists.",
  GROUP_ASSIGNMENT_CHANGED:
    "Website membership changed. Refresh and try again.",
  GROUP_CHANGED: "The group changed. Refresh and try again.",
  GROUP_NOT_FOUND: "This group is unavailable in the selected account.",
  WEBSITE_NOT_FOUND: "Some websites are unavailable in the selected account.",
  CURSOR_STALE:
    "Group members or monitor filters changed. Refresh the timeline.",
  INVALID_CURSOR:
    "This timeline page is no longer valid. Refresh the timeline.",
};
export async function groupRequest(path: string, options: RequestInit = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Could not load data. Check your login and try again.");
  }
  if (!r.ok)
    throw new Error(errors[data.error] ?? data.error ?? "Request failed");
  return data;
}
export function useGroupChoices(refreshToken: unknown = 0) {
  const [state, setState] = useState<{
    items: GroupChoice[];
    ownerId: string | null;
    error: string | null;
    loading: boolean;
  }>({ items: [], ownerId: null, error: null, loading: true });
  useEffect(() => {
    const abort = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: null }));
    void (async () => {
      try {
        let offset: number | null = 0;
        const items: GroupChoice[] = [];
        let ownerId: string | null = null;
        while (offset !== null) {
          const data = await groupRequest(
            `/api/competitor-groups?limit=100&offset=${offset}`,
            { signal: abort.signal },
          );
          items.push(...data.items);
          ownerId = data.writeOwnerId;
          offset = data.nextOffset;
          if (items.length > 10000)
            throw new Error("Too many groups to display. Use the Groups page.");
        }
        if (!abort.signal.aborted)
          setState({ items, ownerId, error: null, loading: false });
      } catch (e) {
        if (!abort.signal.aborted)
          setState({
            items: [],
            ownerId: null,
            error: e instanceof Error ? e.message : "Could not load groups",
            loading: false,
          });
      }
    })();
    return () => abort.abort();
  }, [refreshToken]);
  return state;
}
export function GroupSelect({
  value,
  onChange,
  groups,
  disabled = false,
  label = "Competitor group",
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  groups: GroupChoice[];
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="block text-sm">
      {label}
      <select
        className="input mt-1"
        aria-label={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Ungrouped</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function GroupEditor({
  group,
  onSaved,
}: {
  group?: GroupChoice & { description?: string | null };
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [name, setName] = useState(group?.name ?? ""),
    [description, setDescription] = useState(group?.description ?? ""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await groupRequest(
        group ? `/api/competitor-groups/${group.id}` : "/api/competitor-groups",
        {
          method: group ? "PATCH" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || null,
          }),
        },
      );
      setOpen(false);
      if (!group) {
        setName("");
        setDescription("");
      }
      router.refresh();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save group");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={group ? "btn-secondary" : "btn-accent"}
        onClick={() => {
          setName(group?.name ?? "");
          setDescription(group?.description ?? "");
          setError(null);
          setOpen(true);
        }}
      >
        {group ? "Edit group" : "Create group"}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            group ? "Edit competitor group" : "Create competitor group"
          }
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
        >
          <form
            onSubmit={save}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="font-semibold">
              {group ? "Edit competitor group" : "Create competitor group"}
            </h2>
            <label className="mt-4 block text-sm">
              Group name
              <input
                className="input mt-1"
                aria-label="Group name"
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="mt-4 block text-sm">
              Notes
              <textarea
                className="input mt-1"
                aria-label="Group notes"
                rows={3}
                maxLength={4000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button className="btn-accent" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save group"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
export function AssignGroups({
  websites,
  onSaved,
  defaultGroupId = null,
  buttonText = "Move to group",
}: {
  websites: { id: string; ownerId: string; competitorGroupId: string | null }[];
  onSaved?: () => void;
  defaultGroupId?: string | null;
  buttonText?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [groupId, setGroupId] = useState<string | null>(defaultGroupId),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [pendingWebsites, setPendingWebsites] = useState(websites);
  const choices = useGroupChoices(open);
  const mixed = new Set(websites.map((w) => w.ownerId)).size > 1;
  const wrongAccount = pendingWebsites.some(
    (w) => choices.ownerId !== w.ownerId,
  );
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await groupRequest("/api/competitor-groups/assign-websites", {
        method: "POST",
        body: JSON.stringify({
          groupId,
          assignments: pendingWebsites.map((w) => ({
            websiteId: w.id,
            expectedGroupId: w.competitorGroupId,
          })),
        }),
      });
      setOpen(false);
      router.refresh();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move websites");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="btn-secondary"
        disabled={!websites.length || websites.length > 100 || mixed}
        onClick={() => {
          setPendingWebsites(websites.map((w) => ({ ...w })));
          setGroupId(defaultGroupId);
          setError(null);
          setOpen(true);
        }}
      >
        {buttonText}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Move websites to group"
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="font-semibold">
              Move {pendingWebsites.length} website
              {pendingWebsites.length === 1 ? "" : "s"}
            </h2>
            <p className="my-4 text-sm text-neutral-500">
              Monitoring and URL history are retained. Group history follows
              current members.
            </p>
            <GroupSelect
              value={groupId}
              onChange={setGroupId}
              groups={choices.items.filter(
                (g) => g.ownerId === choices.ownerId,
              )}
              disabled={choices.loading || wrongAccount}
            />
            {wrongAccount && !choices.loading && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                Choose the account that owns these websites before moving them.
              </p>
            )}
            {(error || choices.error) && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error ?? choices.error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn-accent"
                disabled={
                  busy || choices.loading || !!choices.error || wrongAccount
                }
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save membership"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
