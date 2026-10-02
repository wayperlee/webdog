export const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";
export const number = (value: number) => value.toLocaleString();
const labels: Record<string, string> = {
  active: "Present",
  pending_removed: "Pending removal",
  removed: "Removed",
  added: "First observed",
  reappeared: "Reappeared",
  pending: "Awaiting review",
  adopted: "Adopted · awaiting confirmation",
  confirmed: "Confirmed",
  rejected: "Recovered",
  stale: "Outdated",
  expired: "Expired",
  queued: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  baseline: "Baseline established",
  applied: "Inventory updated",
  quarantined: "Held for review",
  first_observation: "First missing observation",
  none: "Not applied",
  complete: "Complete",
  partial: "Partial",
  unusable: "Unusable",
  unknown: "Not observed",
  recovered: "Recovered",
};
export function label(value: string) {
  return labels[value] ?? value;
}
export function Badge({ value, text }: { value: string; text?: string }) {
  const color = ["removed", "failed", "unusable"].includes(value)
    ? "bg-red-50 text-red-700"
    : ["active", "succeeded", "confirmed", "applied"].includes(value)
      ? "bg-emerald-50 text-emerald-700"
      : [
            "pending_removed",
            "pending",
            "adopted",
            "quarantined",
            "partial",
            "running",
          ].includes(value)
        ? "bg-amber-50 text-amber-800"
        : "bg-neutral-100 text-neutral-600";
  return (
    <span
      className={`inline-flex rounded-lg px-2 py-1 text-xs font-medium ${color}`}
    >
      {text ?? label(value)}
    </span>
  );
}
export function UrlLink({ url }: { url: string }) {
  // Imported/legacy data must never turn an arbitrary scheme into a clickable link.
  return /^https?:\/\//i.test(url) ? (
    <a
      className="break-all font-mono text-xs text-neutral-700 underline decoration-neutral-200 underline-offset-4 hover:text-brand-600"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {url}
    </a>
  ) : (
    <span className="break-all font-mono text-xs">{url}</span>
  );
}
