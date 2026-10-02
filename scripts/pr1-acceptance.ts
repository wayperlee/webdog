import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

async function main() {
  const origin = new URL(process.env.PR1_ACCEPTANCE_ORIGIN ?? "http://localhost:31072");
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname), "Local QA origin required");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname), "Local QA database required");
  assert.equal(database.pathname, "/sitemap_radar_pr1", "Dedicated PR 1 QA database required");
  const client = new Client({ connectionString: database.toString() });
  await client.connect();
  const checks: string[] = [];
  async function request(path: string, method = "GET", body?: unknown, cookie?: string, headers?: Record<string,string>) {
    return fetch(new URL(path, origin), { method, headers: { "origin": origin.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  }
  async function actor(label: string) {
    const email = `pr1-${label}-${randomUUID()}@example.invalid`;
    const res = await request("/api/auth/sign-up/email", "POST", { name: `PR1 ${label}`, email, password: randomUUID() });
    assert.equal(res.status, 200, `Sign-up ${label}`);
    const cookie = res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    assert.ok(cookie, "Authenticated cookie required");
    return cookie;
  }
  try {
    const a = await actor("owner"); const b = await actor("other");
    assert.equal((await request("/api/websites")).status, 401); checks.push("anonymous read denied");
    const created = await request("/api/websites", "POST", { domain: "pr1-example.invalid" }, a);
    assert.equal(created.status, 201);
    const { website } = await created.json();
    const targets = (await client.query('SELECT * FROM target WHERE "websiteId"=$1', [website.id])).rows;
    assert.equal(targets.length, 1); const target = targets[0];
    assert.equal(target.kind, "SITEMAP_LINKS"); assert.equal(target.externalNotify, false);
    assert.equal(target.aiChangeSummaryEnabled, false); assert.equal(target.aiTriageEnabled, false);
    checks.push("website and single sitemap target created without provider keys");
    assert.equal((await request(`/api/websites/${website.id}`, "GET", undefined, b)).status, 404);
    assert.equal((await request(`/api/targets/${target.id}`, "PATCH", {enabled:false}, b)).status, 404);
    checks.push("cross-owner read and mutation denied");
    assert.equal((await request(`/api/targets/${target.id}`, "PATCH", {enabled:false}, a)).status, 200);
    assert.equal((await request(`/api/targets/${target.id}`, "PATCH", {enabled:true,checkIntervalHours:12}, a)).status, 200);
    checks.push("owned sitemap pause and interval preserved");
    for (const body of [{externalNotify:true},{aiChangeSummaryEnabled:true},{aiTriageEnabled:true},{notificationDestinationId:"fake"}]) {
      assert.equal((await request(`/api/targets/${target.id}`, "PATCH", body, a)).status, 400);
    }
    for (const category of ["PAGE_CONTENT", "PRODUCT_PRICE"]) {
      assert.equal((await request(`/api/websites/${website.id}/targets`, "POST", {category,pageUrl:"https://pr1-example.invalid/"}, a)).status, 400);
    }
    assert.equal((await request("/api/websites", "POST", {domain:"other.invalid",initialPagePath:"/pricing"}, a)).status, 400);
    const duplicate = await Promise.all(Array.from({length:3},()=>request(`/api/websites/${website.id}/targets`,"POST",{category:"LINK"},a)));
    assert.ok(duplicate.every((r)=>r.status===400)); checks.push("unsupported payloads and duplicate sitemap targets rejected");
    // A retained upstream website may have no sitemap target. Test its first creation,
    // not just rejection on websites that already received a target during onboarding.
    const emptyWebsiteId = `qa-zero-target-${randomUUID()}`;
    await client.query(
      'INSERT INTO website(id,"userId",name,url,domain) VALUES($1,$2,$3,$4,$5)',
      [emptyWebsiteId, website.userId, "PR1 zero-target fixture", "https://zero-target.invalid", "zero-target.invalid"],
    );
    assert.equal((await client.query('SELECT id FROM target WHERE "websiteId"=$1', [emptyWebsiteId])).rowCount, 0);
    const firstCreations = await Promise.all(Array.from({ length: 5 }, () =>
      request(`/api/websites/${emptyWebsiteId}/targets`, "POST", { category: "LINK" }, a),
    ));
    assert.deepEqual(firstCreations.map((res) => res.status).sort(), [201, 400, 400, 400, 400]);
    const firstTargets = (await client.query('SELECT * FROM target WHERE "websiteId"=$1', [emptyWebsiteId])).rows;
    assert.equal(firstTargets.length, 1);
    assert.equal(firstTargets[0].kind, "SITEMAP_LINKS");
    checks.push("five concurrent first creations on a zero-target site produce exactly one sitemap target");
    const shareToken = randomUUID();
    const snapshotId = randomUUID();
    const alertId = randomUUID();
    await client.query('UPDATE website SET "publicShareToken"=$1 WHERE id=$2',[shareToken,website.id]);
    await client.query('INSERT INTO snapshot(id,"websiteId",kind,payload,hash) VALUES($1,$2,$3,$4,$5)',[snapshotId,website.id,"SITEMAP","[]","qa-fixture"]);
    await client.query('INSERT INTO alert(id,"websiteId","targetId",kind,title,details) VALUES($1,$2,$3,$4,$5,$6)',[alertId,website.id,target.id,"NEW_LINK","QA retained history","{}"]);
    async function footprint() {
      // One database snapshot, stable row order, every field (including ids and timestamps).
      // Keep only counts and a digest in assertion output, never raw settings or tokens.
      const result = await client.query(`SELECT jsonb_build_object(
        'websites', COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM website w WHERE w."userId"=$1), '[]'::jsonb),
        'targets', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM target t JOIN website w ON w.id=t."websiteId" WHERE w."userId"=$1), '[]'::jsonb),
        'snapshots', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM snapshot s JOIN website w ON w.id=s."websiteId" WHERE w."userId"=$1), '[]'::jsonb),
        'alerts', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM alert a JOIN website w ON w.id=a."websiteId" WHERE w."userId"=$1), '[]'::jsonb),
        'destinations', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM "notificationDestination" d WHERE d."userId"=$1), '[]'::jsonb),
        'invites', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM "accountInvite" i WHERE i."ownerUserId"=$1), '[]'::jsonb),
        'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."memberUserId") FROM "accountMembership" m WHERE m."ownerUserId"=$1), '[]'::jsonb),
        'settings', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s."userId") FROM "userNotificationSettings" s WHERE s."userId"=$1), '[]'::jsonb)
      )::text AS payload`, [website.userId]);
      const payload: string = result.rows[0].payload;
      const rows: Record<string, unknown[]> = JSON.parse(payload);
      return {
        counts: Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.length])),
        digest: createHash("sha256").update(payload).digest("hex"),
      };
    }
    const before = await footprint();
    // Negative controls: equal row counts must not hide payload, read or token changes.
    for (const [sql, id] of [
      ['UPDATE snapshot SET payload=\'qa-mutated-payload\' WHERE id=$1', snapshotId],
      ['UPDATE alert SET read=true WHERE id=$1', alertId],
      ['UPDATE website SET "publicShareToken"=NULL WHERE id=$1', website.id],
    ]) {
      await client.query("BEGIN");
      try {
        assert.equal((await client.query(sql, [id])).rowCount, 1);
        const changed = await footprint();
        assert.deepEqual(changed.counts, before.counts);
        assert.notEqual(changed.digest, before.digest, "Content mutation must be detected despite equal counts");
      } finally {
        await client.query("ROLLBACK");
      }
    }
    assert.deepEqual(await footprint(), before, "Negative controls must leave fixtures unchanged");
    checks.push("history digest detects equal-count payload, read and share-token mutations; negative controls rolled back");
    const closed: [string,string,number][] = [
      [`/api/websites/${website.id}`,"DELETE",405], [`/api/targets/${target.id}`,"DELETE",405],
      [`/api/websites/${website.id}`,"PATCH",405], [`/api/websites/${website.id}/share`,"POST",404],
      [`/share/${shareToken}`,"GET",404], ["/invite/qa-old-token","GET",404],
      ["/api/account/invites","POST",404], ["/api/account/invites/redeem","POST",404],
      ["/api/account/members/qa","DELETE",404], ["/api/user/context-intro","POST",404],
      ["/api/user/notification-settings","PATCH",404], ["/api/user/notification-settings/test","POST",404],
      ["/api/user/notification-destinations","POST",404], ["/api/user/ai-models","GET",404],
      ["/api/cron/run","POST",503],
    ];
    for (const [path,method,status] of closed) {
      const res=await request(path,method,method === "GET" ? undefined : {websiteId:website.id},a);
      assert.equal(res.status,status,`${method} ${path}`);
    }
    assert.equal((await request(`/api/websites/${website.id}`,"DELETE",undefined,a,{"x-middleware-subrequest":"middleware:middleware:middleware:middleware:middleware"})).status,405);
    assert.deepEqual(await footprint(),before); checks.push("15 legacy routes closed; existing share token blocked; full historical record contents unchanged");
    const page=await request("/dashboard", "GET", undefined, a); assert.equal(page.status,200);
    assert.equal((await request("/onboarding/context-dev", "GET", undefined,a)).status,307);
    const html = await page.text();
    assert.ok(!html.includes('href="/dashboard/alerts"'), "Legacy Alerts navigation must be hidden");
    assert.ok(html.includes("Checks unavailable"), "Saved websites must show checks unavailable");
    const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ");
    assert.ok(!/\b\d+\s+new\b|\ball clear\b/i.test(visibleText), "Legacy health badges must be hidden");
    assert.equal((await request("/dashboard/alerts", "GET", undefined,a)).status,307);
    assert.deepEqual(await footprint(), before, "Viewing saved websites must not alter historical records");
    checks.push("authenticated dashboard bypasses Context.dev onboarding and hides legacy Alerts and health badges");
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  } finally { await client.end(); }
}
main().catch((err)=>{console.error(err instanceof Error ? err.message : "Acceptance failed");process.exitCode=1;});
