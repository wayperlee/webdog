"use client";
import { useEffect, useState } from "react";
type Run = { id: string; executionStatus: string; completeness: string; attempt: number; urlCount: number | null; availableAt: string; error: { message?: string } | null };
export function RunControls({ targetId, archived }: { targetId: string; archived: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/targets/${targetId}/runs`);
        if (!response.ok) throw new Error("Could not load runs");
        const data = await response.json(); if (!disposed) setRuns(data.runs);
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "Could not load runs"); }
    };
    void load(); const timer = setInterval(load, 5_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [targetId]);
  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/targets/${targetId}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not queue run");
      const list = await fetch(`/api/targets/${targetId}/runs`); if (list.ok) setRuns((await list.json()).runs);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not queue run"); }
    finally { setBusy(false); }
  }
  return <div className="mt-4">
    <button className="btn-secondary" onClick={submit} disabled={busy || archived}>{busy ? "Queuing…" : "Run now"}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    <p className="mt-3 text-sm text-neutral-500">Scans are processed by the background worker. Changes history will be available in the next stage.</p>
    <ul className="mt-4 space-y-3">{runs.map((run) => <li key={run.id} className="rounded-lg bg-neutral-50 p-3 text-sm">
      <span className="font-medium">{run.executionStatus}</span> · {run.completeness} · attempt {run.attempt}
      {run.urlCount !== null && <> · {run.urlCount} URLs observed</>}
      {run.executionStatus === "queued" && <p className="mt-1 text-neutral-500">Available after {new Date(run.availableAt).toLocaleString()}</p>}
      {run.error?.message && <p className="mt-1 text-red-600">{run.error.message}</p>}
    </li>)}</ul>
  </div>;
}
