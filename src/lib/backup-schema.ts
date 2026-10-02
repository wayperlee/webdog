/** pg_dump/restore may flatten this pure conjunction. Normalize only the observed, exactly equivalent form. */
export function canonicalBackupDefinition(
  kind: string,
  object: string,
  name: string,
  definition: string,
) {
  if (
    kind === "constraint" &&
    object === "competitor_group" &&
    name === "competitor_group_name_check" &&
    definition ===
      "CHECK ((((char_length(name) >= 1) AND (char_length(name) <= 80)) AND (name = btrim(name))))"
  ) {
    return "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80) AND (name = btrim(name))))";
  }
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
