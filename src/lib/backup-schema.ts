/** pg_dump/restore may flatten this pure conjunction. Normalize only the observed, exactly equivalent form. */
export function canonicalBackupDefinition(
  kind: string,
  object: string,
  name: string,
  definition: string,
) {
  if (
    kind === "constraint" &&
    object === "crawl_run" &&
    name === "crawl_run_attempt_check" &&
    definition ===
      "CHECK ((((attempt >= 0) AND (attempt <= 4)) AND (lease_epoch >= attempt)))"
  ) {
    return "CHECK (((attempt >= 0) AND (attempt <= 4) AND (lease_epoch >= attempt)))";
  }
  return definition;
}
