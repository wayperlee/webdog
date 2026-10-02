import test from "node:test";
import assert from "node:assert/strict";
import { canonicalBackupDefinition } from "./backup-schema";
test("Group name backup normalization preserves bounds and trim checks", () => {
  const source =
    "CHECK ((((char_length(name) >= 1) AND (char_length(name) <= 80)) AND (name = btrim(name))))";
  const restored =
    "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80) AND (name = btrim(name))))";
  const normalize = (definition: string) =>
    canonicalBackupDefinition(
      "constraint",
      "competitor_group",
      "competitor_group_name_check",
      definition,
    );
  assert.equal(normalize(source), restored);
  for (const altered of [
    source.replace("<= 80", "<= 81"),
    source.replace("AND", "OR"),
    source.replace("btrim(name)", "name"),
  ])
    assert.notEqual(normalize(altered), restored);
});
test("Backup canonicalization tolerates known pure AND parentheses, preserving changed bounds and logic", () => {
  const normalize = (s: string) =>
    canonicalBackupDefinition(
      "constraint",
      "crawl_run",
      "crawl_run_attempt_check",
      s,
    );
  const source =
    "CHECK ((((attempt >= 0) AND (attempt <= 4)) AND (lease_epoch >= attempt)))";
  const restored =
    "CHECK (((attempt >= 0) AND (attempt <= 4) AND (lease_epoch >= attempt)))";
  assert.equal(normalize(source), normalize(restored));
  for (const altered of [
    source.replace("<= 4", "<= 5"),
    source.replace(">= 0", ">= -1"),
    source.replace("AND", "OR"),
    source.replace("lease_epoch >= attempt", "lease_epoch >= 0"),
  ])
    assert.notEqual(normalize(altered), normalize(restored));
  assert.equal(
    canonicalBackupDefinition(
      "index",
      "crawl_run",
      "crawl_run_attempt_check",
      source,
    ),
    source,
  );
  assert.equal(
    canonicalBackupDefinition(
      "constraint",
      "other_table",
      "crawl_run_attempt_check",
      source,
    ),
    source,
  );
});
