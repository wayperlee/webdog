export type MonitorPatch = {
  enabled?: boolean;
  checkIntervalHours?: number;
  archived?: boolean;
  includePaths?: string[];
  excludePaths?: string[];
};
/** Literal, case-sensitive pathname prefixes. Never mutate inventory or crawler scope. */
export function normalizePathRules(paths: string[]) {
  if (
    paths.length > 100 ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 2048 ||
        /[?#\s\u0000-\u001f]/.test(path),
    )
  ) {
    throw new Error(
      "Path prefixes must start with / and contain no spaces, query or fragment (max 100).",
    );
  }
  return [...new Set(paths)].sort();
}
/** Column and placeholders are internal constants; all user input is bound as parameters. */
export function pathFilterSql(
  urlColumn: string,
  includeParam: string,
  excludeParam: string,
) {
  const path = `regexp_replace(split_part(${urlColumn},'?',1),'^[a-z]+://[^/]+','')`;
  return `(cardinality(${includeParam}::text[])=0 OR EXISTS (SELECT 1 FROM unnest(${includeParam}::text[]) prefix WHERE starts_with(${path},prefix)))
    AND NOT EXISTS (SELECT 1 FROM unnest(${excludeParam}::text[]) prefix WHERE starts_with(${path},prefix))`;
}
