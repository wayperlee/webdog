# Competitor groups

Implemented and released to Cloudflare production on 2026-10-02, following the accepted [plan](competitor-groups-plan.md). The plan records the original design; local and production evidence below describe the implemented result.

A competitor group collects websites operated by the same competitor. It belongs to an existing account owner and does not add collaboration, invites or shared public links. Each website can belong to one group or remain ungrouped. Deleting a group detaches every website, including archived websites, and preserves monitors, URL inventory, events, candidates and runs.

## Behavior

- `/dashboard/groups`: create/search groups, summaries, 24h/7d windows and archived toggle.
- `/dashboard/groups/[id]`: edit notes/name, add a website with group preselected, website activity ranking, filtered/paginated Changes, remove members and delete group.
- `/dashboard`: group column/filter, Ungrouped view and explicit selections (maximum 100) for one atomic membership change. Changing list filters clears selection.
- Website detail: group link and Change group.
- Owner and existing account members can read. Mutations resolve the existing active account owner, revalidate access in a transaction, and reject mixed owners. Database composite foreign keys also reject cross-owner membership.
- History follows current group membership, current monitor scope and current Include/Exclude paths. Moving a website changes group history views; it does not create crawl runs, baselines or URL events.
- Paused sites participate in summaries. Archived sites are excluded by default. Current URL counts include active and pending_removed inventory; no baseline displays `—`. Baseline coverage is displayed as baselined websites / total websites.
- A group has multiple individual monitor states; latest site scan is not a claim that every site is up to date.

Group member writes share an owner-level transaction advisory lock and acquire website row locks in ID order. Bulk writes compare expectedGroupId, roll back all changes on any conflict, and are idempotent when already at the destination. The UI retains the expected memberships captured when opening the dialog, even if background refresh updates the table.

Events use signed `(observedAt,id)` cursors, a database asOf and a fingerprint of membership and monitor configuration. Changed membership/scope/paths invalidate the cursor (409). Refresh starts over; window/archived changes reset pagination. This is not a database snapshot spanning HTTP requests and is not an export guarantee. Inactive Changes tabs do not poll event history.

## Validation

- `PR3_QUEUE_ACCEPTANCE=1 PR4_INVENTORY_ACCEPTANCE=1 GROUPS_ACCEPTANCE=1 npm test`: 111 passed, 0 failed, 0 skipped, against local PostgreSQL.
- `npm run typecheck`, `npm run lint`, isolated `npm run build`: pass. Lint retains 8 pre-existing warnings; new files introduce none.
- [HTTP acceptance](acceptance/competitor-groups/http.json): actual login cookies, ownership rejection, summaries, paging/filtering, paused/archive behavior, bulk rollback, stale membership and cursor rejection, crawl fact preservation.
- Browser TaskSpace 46: create → rename → add with preselection → change group → bulk move → filter → activity → Changes pagination/filter/window → delete → Ungrouped and preserved inventory. A concurrently moved selected website triggers a conflict after background refresh, with the remaining selected website unchanged. Mobile width 390 has document width 390; wide tables scroll within their cards. Browser fixture used controlled XML with 122 added events, not a claim of fresh external site crawling.
- [Performance fixture](acceptance/competitor-groups/performance.json): 10 groups, 50 websites, 50,000 inventory rows and 200,000 events. One service SQL query per summary/list/event page, with EXPLAIN ANALYZE BUFFERS. Local request times: list 326 ms, detail 46 ms, events 31 ms. No extra event index was necessary at this scale. This is not Cloudflare/Supabase production capacity evidence.
- [Backup/restore](acceptance/competitor-groups/backup.json): all 23 schema tables restored into a fresh temporary local database; data, columns, indexes, foreign keys, RLS/policies and grants match. Restored group query and application-role reads/writes succeed. Only two precisely observed equivalent CHECK parenthesis forms are canonicalized; changed bounds/logic remain detectable. Temporary database, roles and private dump were removed.
- Production grant migration exercised with temporary local roles: app read/write succeeds, RLS is enabled, anon/authenticated/service_role receive no SELECT grant. This is a local simulation, not a production grant audit.

Reproducible scripts `scripts/competitor-groups-{acceptance,performance,backup}.ts` enforce the dedicated local DB `127.0.0.1:55471/sitemap_radar_pr1`. HTTP and backup additionally require a generated `groups_ui_<32 hex>` schema. They must not be pointed at production. HTTP requires an app on localhost:31073 using that same isolated schema, and an absolute private output directory. Performance takes an absolute JSON output path. Backup takes an absolute private directory. Credentials/cookies and raw backups are private and excluded from these published reports.

## Production release — 2026-10-02

[Production evidence](acceptance/competitor-groups/production.json) records the authenticated acceptance and provider state. Entry point: https://sitemap.lipeiwei.com/dashboard/groups.

- PRs #9–13 are merged. Deployed application source is `a99447ccfe7dedc62310cb865c656f3b8021aa77`; Worker version `1a63b773-e10e-470f-bcbd-4db984056c72` receives 100% of traffic. Both container rollouts completed with image digest `sha256:401b925a4f455c64c96124d0a68dc86d7ca5c1ff013e74d8c01f1e8a9a147058`. Later documentation commits do not change that deployed application revision.
- Supabase `common` now has 10 migration entries and 23 tables in `sitemap_radar`. Drizzle 0009 and `supabase/migrations/20261002094037_competitor_groups_access.sql` were applied once. The new table has RLS and app-role CRUD; anon/authenticated/service_role have no schema USAGE or table access. The application role cannot CREATE or BYPASSRLS. Both client TLS connections were encrypted with authorized certificates; Data API was observed disabled in the project dashboard.
- Migration-window crawl facts were unchanged, verified by row hashes. Existing websites started ungrouped; no local accounts or sites were imported into production. Cloudflare Access and localhost:31072 configuration/database schema were preserved.
- Real production browser acceptance covered group creation, note editing, existing website assignment through the bulk dialog, and adding a website with group preselected. Paused sites contribute to summaries; archived inclusion was verified before fixture cleanup. Cross-account reads/writes return 404 and stale membership returns 409 / GROUP_ASSIGNMENT_CHANGED. Mobile viewport and document width both measured 390.
- Two QA monitor records of the same `supermaker.ai` domain each observed 1,735 URLs; the group showed 2/2 baseline coverage and 3,470 current URLs. This verifies aggregation by Website, not a two-distinct-competitor dataset. Initial baselines correctly produced no added events. Actual 24h/7d overview requests took 1,096 / 1,041 / 1,027 ms; this small dataset is not production capacity proof.
- With the QA browser away from the app, a scheduled run succeeded/complete on attempt 1 (10:44:16–10:44:18 UTC). The deployed Cron also reported outcome ok during that short window. An existing QA site's manual run succeeded/complete on attempt 1 (10:46:40–10:46:41 UTC). Original run history and inventory remained; the baseline pointer advanced normally after the complete scan.
- Before-migration (22 tables) and after-release (23 tables) private backups were each restored into isolated local PostgreSQL 17. All table data hashes, columns, indexes, constraints, RLS/policies and grants matched; restored app-role reads/writes passed. No restore was executed against production. Private credentials, cookies and dumps remain excluded from published evidence.
- QA cleanup restored the original fixture site to paused/ungrouped and paused/archived the added site. One archived QA group member is retained for backup read/write evidence. Other-owner website metadata hashes remained unchanged; this is not a claim of a separately sampled hash of every other owner's crawl fact throughout the browser run.

### Startup fix and verification scope

The first groups image failed to become ready because `npm prune --omit=dev` removed TypeScript while `next start` loaded `next.config.ts` and attempted to install the compiler. PR #13 converted that configuration to `next.config.mjs` without changing its settings. An actual pruned linux/amd64 image, without network access or TypeScript, responded after 7,792 ms. Its health status was intentionally 503 with an unavailable fixture DB; authenticated production health and groups overview both returned 200 after deployment. Temporary container diagnostics were removed from the final Worker; error diagnostics redact secrets and URLs.

The feature revision passed 111 local tests, 0 failures and 0 skips before this startup fix. The startup fix passed 5 targeted runtime tests, application/Worker typechecks, lint and app build. The complete 111-test suite was not rerun after that configuration/diagnostic change. GitHub has no configured CI workflows/checks, so these are local and production evidence, not a CI result.

Local Docker disk exhaustion interrupted the backup restore attempt and subsequently the original local PostgreSQL health check. Cleanup removed only unused sitemap-radar image references and 12 exact reclaimable, unshared radar runtime cache records (about 3.75 GB). No database volumes, other-project caches/images, or production resources were deleted; the current image was retained and localhost:31072 health returned 200. The successful after-release restore used network-isolated tmpfs storage.

Still NOT RUN: long-term Cron liveness, cloud process/container fault injection and same-Run retry recovery, production remote load acceptance at the 200,000-event local fixture scale, and full cloud partial-sitemap/Candidate scenarios. The short scheduled-run observation does not prove these behaviors. Production group deletion and event-rich Changes pagination were covered by local acceptance, not repeated in this production fixture.

### Future migration procedure

For an existing deployment, take a private-schema backup before running `db:migrate:scoped` with the verified project/admin connection and DATABASE_SCHEMA=sitemap_radar. Apply only outstanding permissions migrations; the groups permissions migration above has already run and must not be blindly repeated. A fresh `db:prepare:supabase` grants policies for all tables and does not need the same policy creation again. Verify migration hashes, counts, app-role CRUD, RLS, unauthorized-role isolation and post-migration backup restoration before declaring the database release complete. Application/packaging changes require full image deployment; `--containers-rollout none` is only for controller-only changes.

Reverting the application release can leave the additive schema in place, which is compatible with the previous app. Do not drop the group table or column after users have created groups without a separate backup and explicit data-loss decision.
