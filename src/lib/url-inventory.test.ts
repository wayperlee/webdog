import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { CrawlQueue, QueueError } from "./crawl-queue";
import { InventoryError, suspicious } from "./url-inventory";
import { monitorSummaries } from "./monitor-summary";
import { pathFilterSql } from "./monitor-filters";
import { collectCrawlGarbage } from "./crawl-gc";
import { crawlSitemaps } from "./sitemap";
import type { CrawlResult } from "./sitemap/types";

test("Frozen suspicious thresholds distinguish count and ratio", () => {
  assert.equal(suspicious(1, 1, 0), true);
  assert.equal(suspicious(0, 0, 0), false);
  assert.equal(suspicious(1000, 299, 701), false);
  assert.equal(suspicious(1000, 300, 700), true);
  assert.equal(suspicious(200, 99, 101), false);
});
test("PostgreSQL URL inventory and Candidate contract", { skip: process.env.PR4_INVENTORY_ACCEPTANCE !== "1" }, async (suite) => {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
  assert.equal(database.pathname, "/sitemap_radar_pr1");
  const schema = `pr4_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: database.toString(), max: 2 });
  const pool = new Pool({ connectionString: database.toString(), max: 10, options: `-c search_path=${schema}` });
  const queue = new CrawlQueue(pool);
  const root = "https://example.com/sitemap.xml";
  let owner: string;
  const urls = (count: number) => Array.from({ length: count }, (_, i) => `https://example.com/p${i}`);
  async function target() {
    const id = randomUUID(), websiteId = randomUUID();
    await pool.query('INSERT INTO website(id,"userId",name,url,domain) VALUES($1,$2,\'fixture\',\'https://example.com\',\'example.com\')', [websiteId, owner]);
    await pool.query(`INSERT INTO target(id,"websiteId",kind,"checkIntervalHours","nextCheckDueAt",sitemap_roots) VALUES($1,$2,'SITEMAP_LINKS',6,clock_timestamp()+interval '6 hours',$3::jsonb)`, [id, websiteId, JSON.stringify([root])]);
    return { id, websiteId };
  }
  async function result(pages: string[], roots = [root]): Promise<CrawlResult> {
    return crawlSitemaps({ siteUrl: "https://example.com", roots, fetcher: async (url, budget) => {
      const body = Buffer.from(`<urlset>${pages.map((page) => `<url><loc>${page}</loc></url>`).join("")}</urlset>`);
      budget.wire(body.length); budget.inflated(body.length);
      return { status: 200, finalUrl: url, body, etag: '"fixture"' };
    } });
  }
  async function scan(id: string, pages: string[]) {
    await queue.enqueueRun(id, "manual"); const run = await queue.claim("inventory-test"); assert.equal(run?.target_id, id);
    await queue.finish(run!, await result(pages, run!.config.roots)); return (await pool.query("SELECT * FROM crawl_run WHERE id=$1", [run!.id])).rows[0];
  }
  const rows = async (websiteId: string) => (await pool.query("SELECT * FROM site_url WHERE website_id=$1 ORDER BY url", [websiteId])).rows;
  const events = async (websiteId: string) => (await pool.query("SELECT * FROM url_event WHERE website_id=$1 ORDER BY observed_at,id", [websiteId])).rows;
  const candidates = async (id: string) => (await pool.query("SELECT * FROM removal_candidate WHERE target_id=$1 ORDER BY observed_at,id", [id])).rows;
  const baseline = async (id: string) => (await pool.query("SELECT baseline_run_id FROM target WHERE id=$1", [id])).rows[0].baseline_run_id;
  const ageMissing = async (websiteId: string) => pool.query("UPDATE site_url SET first_missing_observed_at=clock_timestamp()-interval '61 minutes' WHERE website_id=$1 AND status='pending_removed'", [websiteId]);
  const ageCandidate = async (candidateId: string) => {
    await pool.query("UPDATE removal_candidate SET observed_at=clock_timestamp()-interval '61 minutes',next_confirmation_at=clock_timestamp()-interval '1 second' WHERE id=$1", [candidateId]);
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of (await readdir("drizzle")).filter((file) => file.endsWith(".sql")).sort()) await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    owner = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,\'fixture\',$2,clock_timestamp(),clock_timestamp())', [owner, `${owner}@example.invalid`]);

    await suite.test("View filters preserve inventory evidence, use literal prefixes and match summaries", async () => {
      const t = await target();
      const pages = ["https://example.com/blog/one", "https://example.com/blog/tag/a", "https://example.com/docs/one", "https://example.com/percent%25_/"];
      const base = await scan(t.id, pages);
      await scan(t.id, [...pages, "https://example.com/blog/new"]);
      const before = await rows(t.websiteId), history = await events(t.websiteId), currentBase = await baseline(t.id);
      await queue.configureMonitor(t.id, owner, { includePaths: ["/blog/", "/blog/"], excludePaths: ["/blog/tag/"] });
      const [summary] = await monitorSummaries(pool, [t.id]);
      assert.equal(summary.filterVersion, 2); assert.equal(summary.scopeVersion, 1);
      assert.equal(summary.currentCount, 2); assert.equal(summary.added24h, 1); assert.equal(summary.totalCount, 2);
      assert.deepEqual(await rows(t.websiteId), before); assert.deepEqual(await events(t.websiteId), history); assert.equal(await baseline(t.id), currentBase);
      await queue.configureMonitor(t.id, owner, { includePaths: ["/blog/"], excludePaths: ["/blog/tag/"] });
      assert.equal((await monitorSummaries(pool, [t.id]))[0].filterVersion, 2, "Equivalent rules do not change version");
      const literal = await pool.query(`SELECT url FROM site_url WHERE website_id=$1 AND ${pathFilterSql("url", "$2", "$3")}`, [t.websiteId, ["/percent%25_/"], []]);
      assert.equal(literal.rows.length, 1, "Percent and underscore are literal characters");
      await assert.rejects(queue.configureMonitor(t.id, owner, { includePaths: ["blog/"] }));
      await assert.rejects(queue.configureMonitor(t.id, randomUUID(), { enabled: false }), { code: "TARGET_NOT_FOUND" });
      const due = (await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [t.id])).rows[0].nextCheckDueAt;
      await queue.configureMonitor(t.id, owner, { enabled: false, checkIntervalHours: 6 });
      assert.equal((await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [t.id])).rows[0].nextCheckDueAt.getTime(), due.getTime());
      await queue.configureScope(t.id, owner, { roots: ["https://example.com/other.xml"], allowedPageHosts: null });
      const [newScope] = await monitorSummaries(pool, [t.id]);
      assert.equal(newScope.scopeVersion, 2); assert.deepEqual(newScope.scopes, [2, 1]); assert.equal(newScope.currentCount, 0);
      assert.equal((await rows(t.websiteId)).length, 5); assert.ok(base.id);
    });
    await suite.test("Archive revokes queued and running attempts; restore never revives old work and paused manual scans remain allowed", async () => {
      const t = await target(); await scan(t.id, urls(3)); const initial = await rows(t.websiteId), base = await baseline(t.id);
      const queued = (await queue.enqueueRun(t.id, "manual", owner))!.run;
      await queue.configureMonitor(t.id, owner, { archived: true });
      assert.equal((await pool.query("SELECT execution_status FROM crawl_run WHERE id=$1", [queued.id])).rows[0].execution_status, "cancelled");
      await assert.rejects(queue.enqueueRun(t.id, "manual", owner), { code: "TARGET_ARCHIVED" });
      await assert.rejects(queue.configureMonitor(t.id, owner, { includePaths: [] }), { code: "TARGET_ARCHIVED" });
      await queue.configureMonitor(t.id, owner, { archived: false, enabled: false });
      await queue.enqueueRun(t.id, "manual", owner); const running = (await queue.claim("archive-test"))!;
      await queue.configureMonitor(t.id, owner, { archived: true });
      const archivedAttempt = (await pool.query("SELECT status,finished_at FROM crawl_run_attempt WHERE run_id=$1", [running.id])).rows[0];
      assert.equal(archivedAttempt.status, "discarded"); assert.ok(archivedAttempt.finished_at);
      await queue.configureMonitor(t.id, owner, { archived: false });
      await assert.rejects(queue.heartbeat(running), { code: "LEASE_LOST" });
      await assert.rejects(queue.finish(running, await result(urls(4))), { code: "LEASE_LOST" });
      assert.deepEqual(await rows(t.websiteId), initial); assert.equal(await baseline(t.id), base);
      assert.equal((await pool.query("SELECT execution_status FROM crawl_run WHERE id=$1", [running.id])).rows[0].execution_status, "cancelled");
      assert.ok((await queue.enqueueRun(t.id, "manual", owner))!.created);
      const manual = (await queue.claim("paused-manual"))!; await queue.finish(manual, await result(urls(3)));
    });
    await suite.test("Initial complete baseline emits zero events; 500 additions are stored in full", async () => {
      const t = await target(); const a = await scan(t.id, urls(2));
      assert.equal(a.adoption_status, "baseline"); assert.equal(await baseline(t.id), a.id); assert.equal((await events(t.websiteId)).length, 0);
      await scan(t.id, urls(502)); assert.equal((await rows(t.websiteId)).length, 502); assert.equal((await events(t.websiteId)).length, 500);
    });
    await suite.test("Quick complete Run advances baseline but cannot confirm missing; later independent Run can", async () => {
      const t = await target(); await scan(t.id, urls(5)); const a = await scan(t.id, urls(4));
      let missing = (await rows(t.websiteId)).find((row) => row.status === "pending_removed");
      assert.equal(missing.missing_confirmations, 1); assert.equal(missing.first_missing_run_id, a.id);
      const quick = await scan(t.id, urls(4)); assert.equal(await baseline(t.id), quick.id); assert.equal((await events(t.websiteId)).length, 0);
      await ageMissing(t.websiteId); const b = await scan(t.id, urls(4));
      missing = (await rows(t.websiteId)).find((row) => row.status === "removed");
      assert.equal(missing.missing_confirmations, 2); assert.equal(missing.first_missing_run_id, a.id); assert.equal(missing.last_missing_run_id, b.id);
      assert.equal((await events(t.websiteId))[0].kind, "removed");
    });
    await suite.test("Pending recovery resets evidence; reappearance preserves firstSeenAt", async () => {
      const t = await target(); await scan(t.id, urls(3)); const first = (await rows(t.websiteId))[2].first_seen_at;
      await scan(t.id, urls(2)); await scan(t.id, urls(3));
      const recovered = (await rows(t.websiteId))[2]; assert.equal(recovered.status, "active"); assert.equal(recovered.first_missing_run_id, null); assert.equal(recovered.missing_confirmations, 0);
      await scan(t.id, urls(2)); await ageMissing(t.websiteId); await scan(t.id, urls(2)); await scan(t.id, urls(3));
      const reappeared = (await rows(t.websiteId))[2]; assert.equal(reappeared.first_seen_at.getTime(), first.getTime());
      assert.deepEqual((await events(t.websiteId)).map((event) => event.kind), ["removed", "reappeared"]);
    });
    await suite.test("Partial/unusable and retry attempts never update inventory or baseline", async () => {
      const t = await target(); const a = await scan(t.id, urls(3)); const before = await rows(t.websiteId);
      await queue.enqueueRun(t.id, "manual"); const run = (await queue.claim("partial"))!;
      const incomplete = await result(urls(1)); incomplete.completeness = "partial"; incomplete.urls = null;
      incomplete.issues = [{ code: "HTTP_503", message: "unavailable", retryable: true, sourceUrl: root }];
      await queue.finish(run, incomplete); assert.equal(await baseline(t.id), a.id); assert.deepEqual(await rows(t.websiteId), before);
      await pool.query("UPDATE crawl_run SET available_at=clock_timestamp() WHERE id=$1", [run.id]); const retry = (await queue.claim("retry"))!;
      assert.equal(retry.id, run.id); assert.equal(retry.attempt, 2); await queue.finish(retry, await result(urls(2)));
      const missing = (await rows(t.websiteId)).find((row) => row.status === "pending_removed"); assert.equal(missing.missing_confirmations, 1);
    });
    await suite.test("Empty quarantine releases the active slot and doesn't enqueue an hour-long wait", async () => {
      const t = await target(); const base = await scan(t.id, urls(3)); const a = await scan(t.id, []);
      assert.equal(a.execution_status, "succeeded"); assert.equal(a.adoption_status, "quarantined"); assert.equal(await baseline(t.id), base.id);
      const c = (await candidates(t.id))[0]; assert.equal(c.original_missing_count, 3); assert.equal(c.pending_count, 3);
      assert.equal((await rows(t.websiteId)).filter((row) => row.status === "active").length, 3);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run WHERE target_id=$1 AND execution_status IN ('queued','running')", [t.id])).rows[0].n, 0);
      assert.equal(await queue.enqueueRun(t.id, "confirmation"), null);
    });
    await suite.test("Strict automatic confirmation accepts equal missing sets even when unrelated additions differ", async () => {
      const t = await target(); await scan(t.id, urls(400)); const a = await scan(t.id, urls(200)); const c = (await candidates(t.id))[0];
      const quick = await scan(t.id, [...urls(200), "https://example.com/new"]); assert.equal(quick.adoption_status, "quarantined"); assert.equal((await candidates(t.id)).length, 1);
      await ageCandidate(c.id); const b = await scan(t.id, [...urls(200), "https://example.com/newer"]);
      assert.equal(b.adoption_status, "applied"); assert.equal(await baseline(t.id), b.id);
      const done = (await candidates(t.id))[0]; assert.equal(done.status, "confirmed"); assert.equal(done.removed_count, 200); assert.equal(done.pending_count, 0);
      assert.equal((await pool.query("SELECT adoption_status FROM crawl_run WHERE id=$1", [a.id])).rows[0].adoption_status, "first_observation");
      assert.equal((await events(t.websiteId)).filter((event) => event.kind === "removed").length, 200);
    });
    await suite.test("Changed missing set rejects old Candidate and creates a fresh suspicious Candidate", async () => {
      const t = await target(); const base = await scan(t.id, urls(400)); await scan(t.id, urls(200)); const old = (await candidates(t.id))[0]; await ageCandidate(old.id);
      await scan(t.id, urls(201)); const all = await candidates(t.id);
      assert.equal(all.length, 2); assert.equal(all[0].status, "rejected"); assert.equal(all[0].reason, "missing_set_changed"); assert.equal(all[0].recovered_count, 1);
      assert.equal(all[1].status, "pending"); assert.equal(all[1].original_missing_count, 199); assert.equal(await baseline(t.id), base.id);
      assert.equal((await events(t.websiteId)).length, 0);
    });
    await suite.test("Approve only adopts first missing evidence, is idempotent, and resolves mixed URLs from inventory", async () => {
      const t = await target(); await scan(t.id, urls(4)); const a = await scan(t.id, []); const c = (await candidates(t.id))[0];
      assert.equal((await queue.approve(t.id, c.id, owner)).status, "adopted"); assert.equal(await baseline(t.id), a.id);
      assert.equal((await events(t.websiteId)).length, 0); assert.equal((await rows(t.websiteId)).filter((row) => row.status === "pending_removed").length, 4);
      assert.equal((await queue.approve(t.id, c.id, owner)).changed, false);
      await scan(t.id, urls(2)); let candidate = (await candidates(t.id))[0]; assert.equal(candidate.pending_count, 2); assert.equal(candidate.recovered_count, 2);
      await ageMissing(t.websiteId); await scan(t.id, urls(2)); candidate = (await candidates(t.id))[0];
      assert.equal(candidate.status, "confirmed"); assert.equal(candidate.removed_count, 2); assert.equal(candidate.recovered_count, 2); assert.equal(candidate.pending_count, 0);
      assert.equal((await queue.approve(t.id, c.id, owner)).changed, false);
      await scan(t.id, urls(4)); assert.equal((await candidates(t.id))[0].removed_count, 2, "Terminal summary survives reappearance");
    });
    await suite.test("All adopted candidates recover to rejected without Removed events", async () => {
      const t = await target(); await scan(t.id, urls(4)); await scan(t.id, []); const c = (await candidates(t.id))[0];
      await queue.approve(t.id, c.id, owner); await scan(t.id, urls(4)); const done = (await candidates(t.id))[0];
      assert.equal(done.status, "rejected"); assert.equal(done.recovered_count, 4); assert.equal(done.pending_count, 0); assert.equal((await events(t.websiteId)).length, 0);
    });
    await suite.test("Approve races serialize; a Run started before approval becomes stale and cannot overwrite", async () => {
      const t = await target(); await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0];
      await queue.enqueueRun(t.id, "manual"); const old = (await queue.claim("old-baseline"))!;
      const approvals = await Promise.all(Array.from({ length: 5 }, () => queue.approve(t.id, c.id, owner)));
      assert.equal(approvals.filter((approval) => approval.changed).length, 1);
      await queue.finish(old, await result(urls(3))); const saved = (await pool.query("SELECT * FROM crawl_run WHERE id=$1", [old.id])).rows[0];
      assert.equal(saved.adoption_status, "stale"); assert.equal(await baseline(t.id), c.candidate_run_id);
      assert.equal((await rows(t.websiteId)).filter((row) => row.status === "pending_removed").length, 3);
      await assert.rejects(queue.approve(t.id, c.id, randomUUID()), (error: unknown) => error instanceof QueueError && error.code === "TARGET_NOT_FOUND");
    });
    await suite.test("Expired pending approval conflicts; adopted evidence outlives ordinary TTL", async () => {
      const t = await target(); await scan(t.id, urls(2)); await scan(t.id, []); const c = (await candidates(t.id))[0];
      await pool.query("UPDATE removal_candidate SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.id]);
      await assert.rejects(queue.approve(t.id, c.id, owner), (error: unknown) => error instanceof InventoryError && error.code === "CANDIDATE_STALE");
      await collectCrawlGarbage(pool); assert.equal((await candidates(t.id))[0].status, "expired");
      await scan(t.id, []); const adopted = (await candidates(t.id))[1]; await queue.approve(t.id, adopted.id, owner);
      await pool.query("UPDATE removal_candidate SET expires_at=clock_timestamp()-interval '20 days' WHERE id=$1", [adopted.id]);
      await collectCrawlGarbage(pool); assert.equal((await candidates(t.id))[1].status, "adopted");
    });
    await suite.test("Due confirmation uses one unified Run slot and does not change cadence", async () => {
      const t = await target(); await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0]; await ageCandidate(c.id);
      const due = (await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [t.id])).rows[0].nextCheckDueAt;
      const entries = await Promise.all([queue.enqueueRun(t.id, "confirmation"), queue.enqueueRun(t.id, "manual"), queue.enqueueRun(t.id, "confirmation")]);
      assert.equal(entries.filter((entry) => entry?.created).length, 1); assert.equal(new Set(entries.map((entry) => entry?.run.id)).size, 1);
      const run = (await queue.claim("confirmation"))!; await queue.finish(run, await result([]));
      assert.equal((await candidates(t.id))[0].status, "confirmed");
      assert.equal((await pool.query('SELECT "nextCheckDueAt" FROM target WHERE id=$1', [t.id])).rows[0].nextCheckDueAt.getTime(), due.getTime());
    });
    await suite.test("Scheduler enqueues due confirmation once and a partial attempt cannot confirm it", async () => {
      const t = await target(); const base = await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0]; await ageCandidate(c.id);
      assert.equal(await queue.schedule(), 1); assert.equal(await queue.schedule(), 0);
      const run = (await queue.claim("partial-confirmation"))!; assert.equal(run.trigger, "confirmation"); assert.equal(run.target_id, t.id);
      const partial = await result([]); partial.completeness = "partial"; partial.urls = null;
      partial.issues = [{ code: "INVALID_XML", message: "unusable child", retryable: false, sourceUrl: root }];
      await queue.finish(run, partial); assert.equal(await baseline(t.id), base.id); assert.equal((await candidates(t.id))[0].status, "pending");
      assert.equal((await events(t.websiteId)).length, 0);
      await ageCandidate(c.id); assert.equal(await queue.schedule(), 1); const second = (await queue.claim("complete-confirmation"))!;
      assert.notEqual(second.id, run.id); await queue.finish(second, await result([])); assert.equal((await candidates(t.id))[0].status, "confirmed");
    });
    await suite.test("Changed set below suspicious threshold returns to normal first-missing rules", async () => {
      const t = await target(); await scan(t.id, urls(400)); await scan(t.id, urls(200)); const c = (await candidates(t.id))[0];
      const b = await scan(t.id, urls(301)); assert.equal(b.adoption_status, "applied"); assert.equal(await baseline(t.id), b.id);
      assert.equal((await candidates(t.id))[0].status, "rejected"); assert.equal((await candidates(t.id))[0].reason, "missing_set_changed");
      assert.equal((await candidates(t.id)).length, 1); assert.equal((await rows(t.websiteId)).filter((row) => row.status === "pending_removed").length, 99);
      assert.equal((await events(t.websiteId)).length, 0); assert.equal(c.original_missing_count, 200);
    });
    await suite.test("Failure/partial confirmation provides no evidence, schedules another observation", async () => {
      const t = await target(); const base = await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0]; await ageCandidate(c.id);
      await queue.enqueueRun(t.id, "confirmation"); const run = (await queue.claim("bad-confirmation"))!;
      await queue.fail(run, { code: "INVALID_XML", message: "bad", retryable: false });
      assert.equal(await baseline(t.id), base.id); const pending = (await candidates(t.id))[0]; assert.equal(pending.status, "pending"); assert.equal(pending.confirmation_attempts, 1); assert.ok(pending.next_confirmation_at.getTime() > Date.now());
      assert.equal((await rows(t.websiteId)).filter((row) => row.status === "active").length, 3);
    });
    await suite.test("Expired lease rolls back automatic A/B adoption, events, summary and baseline together", async () => {
      const t = await target(); const base = await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0]; await ageCandidate(c.id);
      await queue.enqueueRun(t.id, "manual"); const run = (await queue.claim("expired"))!;
      await pool.query("UPDATE crawl_run SET lease_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [run.id]);
      const blocker = await pool.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM target WHERE id=$1 FOR UPDATE", [t.id]);
      const waiting = queue.finish(run, await result([])).then(() => null, (error) => error);
      await new Promise((resolve) => setTimeout(resolve, 500)); await blocker.query("COMMIT"); blocker.release();
      const error = await waiting; assert.ok(error instanceof QueueError && error.code === "LEASE_LOST");
      assert.equal(await baseline(t.id), base.id); assert.equal((await candidates(t.id))[0].status, "pending"); assert.equal((await events(t.websiteId)).length, 0);
      await queue.recoverExpired(); await pool.query("UPDATE crawl_run SET available_at=clock_timestamp() WHERE id=$1", [run.id]); const retry = (await queue.claim("retry"))!; await queue.finish(retry, await result([]));
      assert.equal((await events(t.websiteId)).length, 3);
    });
    await suite.test("Lease expiring after inventory writes rolls back every adoption effect", async () => {
      const t = await target(); const base = await scan(t.id, urls(3)); const a = await scan(t.id, []);
      const c = (await candidates(t.id))[0]; await ageCandidate(c.id);
      await queue.enqueueRun(t.id, "manual"); const run = (await queue.claim("late-commit"))!; const complete = await result([]);
      await pool.query(`CREATE FUNCTION delay_baseline() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END$$`);
      await pool.query(`CREATE TRIGGER delay_baseline BEFORE UPDATE OF baseline_run_id ON target FOR EACH ROW EXECUTE FUNCTION delay_baseline()`);
      await pool.query("UPDATE crawl_run SET lease_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1", [run.id]);
      try { await assert.rejects(queue.finish(run, complete), (error: unknown) => error instanceof QueueError && error.code === "LEASE_LOST"); }
      finally { await pool.query("DROP TRIGGER delay_baseline ON target"); await pool.query("DROP FUNCTION delay_baseline()"); }
      assert.equal(await baseline(t.id), base.id); assert.equal((await rows(t.websiteId)).filter((row) => row.status === "active").length, 3); assert.equal((await events(t.websiteId)).length, 0);
      assert.equal((await candidates(t.id))[0].status, "pending");
      assert.equal((await pool.query("SELECT adoption_status FROM crawl_run WHERE id=$1", [a.id])).rows[0].adoption_status, "quarantined");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM crawl_run_source WHERE run_id=$1", [run.id])).rows[0].n, 0);
      await queue.recoverExpired(); await pool.query("UPDATE crawl_run SET available_at=clock_timestamp() WHERE id=$1", [run.id]);
      const retry = (await queue.claim("retry"))!; await queue.finish(retry, complete); assert.equal((await events(t.websiteId)).length, 3); assert.equal((await candidates(t.id))[0].status, "confirmed");
    });
    await suite.test("Scope switch invalidates pending Candidate and queued work without deleting history", async () => {
      const t = await target(); await scan(t.id, urls(3)); await scan(t.id, []); const c = (await candidates(t.id))[0];
      const queued = (await queue.enqueueRun(t.id, "manual"))!.run;
      await assert.rejects(queue.configureScope(t.id, owner, { roots: ["http://127.0.0.1/private"], allowedPageHosts: null }));
      await queue.configureScope(t.id, owner, { roots: [root + "?v2"], allowedPageHosts: ["example.com"] });
      assert.equal((await candidates(t.id))[0].status, "stale");
      assert.equal((await pool.query("SELECT execution_status FROM crawl_run WHERE id=$1", [queued.id])).rows[0].execution_status, "cancelled");
      await assert.rejects(queue.approve(t.id, c.id, owner), (error: unknown) => error instanceof InventoryError && error.code === "CANDIDATE_STALE");
      assert.equal((await rows(t.websiteId)).length, 3);
    });
    await suite.test("New scope establishes a zero-event baseline and preserves prior facts/history", async () => {
      const t = await target(); await scan(t.id, urls(3)); await scan(t.id, urls(4)); const old = await rows(t.websiteId);
      assert.equal((await queue.configureScope(t.id, owner, { roots: [root + "?new"], allowedPageHosts: null })).scopeVersion, 2);
      assert.equal((await queue.configureScope(t.id, owner, { roots: [root + "?new"], allowedPageHosts: null })).changed, false);
      const run = await scan(t.id, urls(1)); assert.equal(run.adoption_status, "baseline");
      assert.equal((await rows(t.websiteId)).filter((row) => row.scope_version === 1).length, old.length);
      assert.equal((await rows(t.websiteId)).filter((row) => row.scope_version === 2).length, 1); assert.equal((await events(t.websiteId)).length, 1);
      const before = await rows(t.websiteId), base = await baseline(t.id); await pool.query("UPDATE target SET filter_version=filter_version+1 WHERE id=$1", [t.id]);
      assert.deepEqual(await rows(t.websiteId), before); assert.equal(await baseline(t.id), base);
    });
    await suite.test("GC retains long-lived current cache/baseline/Candidate revisions, deletes only unreferenced content", async () => {
      const t = await target(); const old = await scan(t.id, urls(7)); await scan(t.id, urls(8)); await scan(t.id, []); const c = (await candidates(t.id))[0];
      const orphan = randomUUID(); await pool.query("INSERT INTO sitemap_revision(id,content,created_at) VALUES($1,'{}',clock_timestamp()-interval '31 days')", [orphan]);
      await pool.query("UPDATE sitemap_revision SET created_at=clock_timestamp()-interval '200 days'");
      await pool.query("UPDATE crawl_run_source SET created_at=clock_timestamp()-interval '200 days' WHERE run_id IN (SELECT id FROM crawl_run WHERE target_id=$1)", [t.id]);
      await pool.query("UPDATE crawl_run SET finished_at=clock_timestamp()-interval '200 days' WHERE target_id=$1", [t.id]);
      await collectCrawlGarbage(pool);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sitemap_revision WHERE id=$1", [orphan])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT result FROM crawl_run WHERE id=$1", [old.id])).rows[0].result, null);
      assert.ok((await pool.query("SELECT result FROM crawl_run WHERE id=$1", [c.candidate_run_id])).rows[0].result);
      assert.ok((await pool.query("SELECT result FROM crawl_run WHERE id=$1", [c.origin_baseline_run_id])).rows[0].result);
      assert.equal((await events(t.websiteId)).length, 1); assert.ok((await pool.query("SELECT count(*)::int AS n FROM sitemap_source_cache WHERE target_id=$1", [t.id])).rows[0].n > 0);
      await queue.approve(t.id, c.id, owner); await scan(t.id, urls(8)); await collectCrawlGarbage(pool);
      assert.equal((await events(t.websiteId)).length, 1); assert.ok((await pool.query("SELECT result FROM crawl_run WHERE id=$1", [await baseline(t.id)])).rows[0].result);
    });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
