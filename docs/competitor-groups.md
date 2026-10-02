# Competitor groups

Implemented locally on 2026-10-02, following the accepted [plan](competitor-groups-plan.md). The plan records the original design; the readiness evidence below describes the implemented result.

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

## Production release, not executed for this feature

The existing Cloudflare runtime baseline is preserved in commit b4c5301. This feature has not been deployed and its migrations have not been run on Supabase. Cloudflare Access is unchanged. Existing localhost:31072 and its original database were not modified by feature acceptance; QA used a separate schema on localhost:31073.

For the existing `common` Supabase project, apply these changes in order using an admin connection whose project and private schema have been checked:

1. Take the existing private-schema backup and record its manifest before migration.
2. Run the existing `db:migrate:scoped` with DATABASE_SCHEMA=sitemap_radar. It verifies migration hashes and applies Drizzle 0009 (one new table, nullable website group column, indexes/constraints). Existing website memberships start as NULL; no crawler state changes.
3. Apply `supabase/migrations/20261002094037_competitor_groups_access.sql` once. This is a permissions migration for an existing deployment, separate from the Drizzle journal. It requires the existing sitemap_radar_app role. Do not omit it; `db:migrate:scoped` alone does not grant access to newly created tables. A fresh `db:prepare:supabase` already sets RLS/policies/grants for all tables, so do not also apply this policy creation to that freshly provisioned database.
4. Verify app role CRUD, no unauthorized role privileges, composite FK, migration journal total 10 and schema table count 23; verify Data API does not expose the private schema. No new database secret or app service key is required for this feature.
5. Build/release the complete tested revision to the existing Cloudflare runtime. Verify authenticated UI, groups, existing site history and background scheduling on the deployed version. Anonymous Access redirects are not application acceptance.
6. Perform a new production-schema backup/restore validation and production capacity/liveness checks. These are still NOT RUN.

Reverting the application release can leave the additive schema in place, which is compatible with the previous app. Do not drop the group table or column after users have created groups without a separate backup and explicit data-loss decision.
