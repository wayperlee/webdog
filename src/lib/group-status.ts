export function groupWebsiteStatus(w: {
  targetId: string | null;
  archivedAt: string | null;
  enabled: boolean | null;
  activeRun: string | null;
  lastError: string | null;
  baselineRunId: string | null;
}) {
  return !w.targetId
    ? "No monitor"
    : w.archivedAt
      ? "Archived"
      : !w.enabled
        ? "Paused"
        : (w.activeRun ??
          (w.lastError
            ? "failed"
            : !w.baselineRunId
              ? "Awaiting baseline"
              : "active"));
}
