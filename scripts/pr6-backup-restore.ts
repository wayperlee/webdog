import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { Pool, type PoolClient } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalBackupDefinition } from "../src/lib/backup-schema";
import { CrawlQueue } from "../src/lib/crawl-queue";
import { executeClaim } from "../src/lib/crawl-worker";

type Manifest = {
  schema: string;
  table: string;
  rows: number;
  sha256: string;
}[];
const container = "codex-sitemap-radar-pr1";
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function child(args: string[], input = false) {
  const p = spawn(
    "docker",
    [
      "exec",
      ...(input ? ["-i"] : []),
      "--user",
      "postgres",
      container,
      ...args,
    ],
    { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] },
  );
  // Diagnostics remain in memory; do not expose database content, DSN or credentials in logs.
  let diagnostic = "";
  p.stderr!.on("data", (chunk) => {
    diagnostic += String(chunk).slice(0, 4096);
  });
  const done = new Promise<void>((accept, reject) => {
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `${args[0]} exited ${code}; diagnostic bytes ${diagnostic.length}`,
            ),
          ),
    );
  });
  return { p, done };
}
async function fingerprint(client: PoolClient): Promise<Manifest> {
  await client.query("SET LOCAL timezone='UTC'");
  const tables = (
    await client.query(
      `SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename`,
    )
  ).rows;
  const result: Manifest = [];
  for (const t of tables) {
    const hash = createHash("sha256");
    let count = 0;
    // Cursor bounds client memory; JSON text is canonicalized by PostgreSQL and excludes no columns.
    await client.query(
      `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${quote(t.schemaname)}.${quote(t.tablename)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
    );
    try {
      for (;;) {
        const rows = (await client.query("FETCH 100 FROM backup_rows")).rows;
        if (!rows.length) break;
        for (const r of rows) {
          hash.update(r.row);
          hash.update("\n");
          count++;
        }
      }
    } finally {
      await client.query("CLOSE backup_rows");
    }
    result.push({
      schema: t.schemaname,
      table: t.tablename,
      rows: count,
      sha256: hash.digest("hex"),
    });
  }
  return result;
}
async function schemaFingerprint(client: PoolClient) {
  const structure = (
    await client.query(`SELECT 'column' AS kind,table_schema AS namespace,table_name AS object,ordinal_position::text AS position,
    jsonb_build_array(column_name,data_type,udt_name,is_nullable,column_default)::text AS definition
    FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')
    UNION ALL SELECT 'index',schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema')
    UNION ALL SELECT 'constraint',n.nspname,t.relname,c.conname,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3,4`)
  ).rows;
  for (const row of structure)
    row.definition = canonicalBackupDefinition(
      row.kind,
      row.object,
      row.position,
      row.definition,
    );
  return {
    structure,
    hash: createHash("sha256").update(JSON.stringify(structure)).digest("hex"),
  };
}
async function stopProcess(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => process.kill("SIGKILL"), 8000);
    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill("SIGTERM");
  });
}
async function main() {
  const sourceUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(sourceUrl.hostname, "127.0.0.1");
  assert.equal(sourceUrl.port, "55471");
  assert.equal(sourceUrl.pathname, "/sitemap_radar_pr1");
  assert.equal(sourceUrl.username, "postgres");
  const privateDir = process.env.PR6_BACKUP_DIR,
    output = process.env.PR6_BACKUP_OUTPUT;
  assert.ok(privateDir && privateDir.startsWith("/"));
  assert.ok(output && output.startsWith("/"));
  assert.ok(
    !resolve(privateDir).startsWith(resolve(".") + "/"),
    "Backup containing auth data must stay outside the Git repository",
  );
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
  const runId = randomUUID().replaceAll("-", ""),
    restoreName = `radar_restore_${runId}`,
    backupPath = resolve(privateDir, `${restoreName}.dump`);
  const source = new Pool({ connectionString: sourceUrl.toString(), max: 2 });
  const restoreUrl = new URL(sourceUrl);
  restoreUrl.pathname = "/" + restoreName;
  const restored = new Pool({
    connectionString: restoreUrl.toString(),
    max: 3,
  });
  const snapshot = await source.connect();
  let created = false,
    web: ChildProcess | undefined,
    snapshotOpen = false;
  const start = Date.now();
  try {
    const port = spawn("docker", ["port", container, "5432/tcp"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let portValue = "";
    port.stdout.on("data", (chunk) => {
      portValue += chunk;
    });
    await new Promise<void>((ok, fail) => {
      port.on("error", fail);
      port.on("close", (code) =>
        code === 0 ? ok() : fail(new Error("Container mapping unavailable")),
      );
    });
    assert.equal(portValue.trim(), "127.0.0.1:55471");
    const check = await snapshot.query(
      "SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int AS version",
    );
    assert.equal(check.rows[0].database, "sitemap_radar_pr1");
    assert.equal(check.rows[0].role, "postgres");
    assert.ok(
      check.rows[0].version >= 160000 && check.rows[0].version < 170000,
    );
    await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    snapshotOpen = true;
    const token = (await snapshot.query("SELECT pg_export_snapshot() AS token"))
      .rows[0].token;
    const dump = child([
      "pg_dump",
      "--dbname=sitemap_radar_pr1",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      `--snapshot=${token}`,
    ]);
    await Promise.all([
      pipeline(
        dump.p.stdout!,
        createWriteStream(backupPath, { flags: "wx", mode: 0o600 }),
      ),
      dump.done,
    ]);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const expected = await fingerprint(snapshot),
      sourceSchema = await schemaFingerprint(snapshot);
    await snapshot.query("COMMIT");
    snapshotOpen = false;
    await source.query(
      `CREATE DATABASE ${quote(restoreName)} TEMPLATE template0`,
    );
    created = true;
    const restoreStart = Date.now();
    const restore = child(
      [
        "pg_restore",
        `--dbname=${restoreName}`,
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
      ],
      true,
    );
    restore.p.stdout!.resume();
    await Promise.all([
      pipeline(createReadStream(backupPath), restore.p.stdin!),
      restore.done,
    ]);
    const restoreMs = Date.now() - restoreStart;
    const copy = await restored.connect();
    let actual: Manifest,
      restoredSchema: Awaited<ReturnType<typeof schemaFingerprint>>;
    try {
      await copy.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      actual = await fingerprint(copy);
      restoredSchema = await schemaFingerprint(copy);
      await copy.query("COMMIT");
    } finally {
      copy.release();
    }
    assert.deepEqual(
      actual,
      expected,
      "Every row of every application/migration table must match the exported source snapshot",
    );
    if (restoredSchema.hash !== sourceSchema.hash) {
      const key = (r: Record<string, string>) =>
        [r.kind, r.namespace, r.object, r.position].join(":");
      const expectedRows = new Map(
        sourceSchema.structure.map((r) => [key(r), JSON.stringify(r)]),
      );
      const actualRows = new Map(
        restoredSchema.structure.map((r) => [key(r), JSON.stringify(r)]),
      );
      console.log(
        JSON.stringify({
          schemaDifferences: [
            ...new Set([...expectedRows.keys(), ...actualRows.keys()]),
          ]
            .filter((k) => expectedRows.get(k) !== actualRows.get(k))
            .map((k) => ({
              key: k,
              source: expectedRows.get(k),
              restored: actualRows.get(k),
            })),
        }),
      );
    }
    assert.deepEqual(
      restoredSchema.structure,
      sourceSchema.structure,
      "Columns, constraints and indexes must match",
    );
    console.log(
      JSON.stringify({
        phase: "snapshot_restore_verified",
        tables: expected.length,
        rows: expected.reduce((n, t) => n + t.rows, 0),
        restoreMs,
      }),
    );
    // The same compiled Web build is exercised against ONLY the new restored DB.
    const portProbe = createServer();
    await new Promise<void>((ok, fail) => {
      portProbe.once("error", fail);
      portProbe.listen(0, "127.0.0.1", ok);
    });
    const address = portProbe.address();
    assert.ok(address && typeof address !== "string");
    const webPort = address.port;
    await new Promise<void>((ok, fail) =>
      portProbe.close((error) => (error ? fail(error) : ok())),
    );
    const restoreOrigin = `http://127.0.0.1:${webPort}`;
    web = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--port",
        String(webPort),
        "--hostname",
        "127.0.0.1",
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: restoreUrl.toString(),
          BETTER_AUTH_URL: restoreOrigin,
          NEXT_PUBLIC_APP_URL: restoreOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Keep streams drained without publishing env-dependent diagnostics.
    web.stdout!.resume();
    web.stderr!.resume();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (web.exitCode !== null)
        throw new Error("Restored Web process exited before readiness");
      try {
        const res = await fetch(restoreOrigin + "/api/health", {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) break;
      } catch {}
      await delay(300);
    }
    assert.equal((await fetch(restoreOrigin + "/api/health")).status, 200);
    let cookie = "";
    async function req(path: string, method = "GET", body?: unknown) {
      const response = await fetch(restoreOrigin + path, {
        method,
        headers: {
          origin: restoreOrigin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      assert.ok(
        response.ok,
        `Restored API ${method} ${path}: HTTP ${response.status}`,
      );
      return { response, body: await response.json() };
    }
    const authFile = process.env.PR6_AUTH_FILE;
    assert.ok(authFile && authFile.startsWith("/"));
    const original = JSON.parse(await readFile(authFile, "utf8"));
    assert.ok(
      typeof original.email === "string" &&
        original.email.startsWith("pr6-live-") &&
        original.email.endsWith("@example.invalid"),
    );
    assert.equal(
      original.sites.length,
      2,
      "Finish live acceptance before restore login checks",
    );
    const signedIn = await req("/api/auth/sign-in/email", "POST", {
      email: original.email,
      password: original.password,
    });
    cookie = signedIn.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const copiedSites = (await req("/api/websites")).body.websites;
    for (const site of original.sites) {
      assert.ok(
        copiedSites.some((s: { id: string }) => s.id === site.websiteId),
      );
      const copiedInventory = (
        await req(`/api/targets/${site.targetId}/urls?scopeVersion=1`)
      ).body;
      assert.equal(copiedInventory.total, site.inventoryCount);
    }
    // Exact fingerprints were verified before smoke writes. Isolate only copied active tasks in the disposable DB.
    const queue = new CrawlQueue(restored);
    const copiedActive = (
      await restored.query(`SELECT DISTINCT t.id,w."userId" AS owner FROM target t JOIN website w ON w.id=t."websiteId"
      JOIN crawl_run r ON r.target_id=t.id WHERE r.execution_status IN ('queued','running')`)
    ).rows;
    for (const row of copiedActive)
      await queue.configureMonitor(row.id, row.owner, { archived: true });
    // A new account verifies writes in the restored database without changing the source.
    const signup = await req("/api/auth/sign-up/email", "POST", {
      name: "Restore smoke",
      email: `restore-${runId}@example.invalid`,
      password: randomUUID(),
    });
    cookie = signup.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const createdSite = await req("/api/websites", "POST", {
      domain: "supermaker.ai",
    });
    const target = (
      await restored.query('SELECT id FROM target WHERE "websiteId"=$1', [
        createdSite.body.website.id,
      ])
    ).rows[0];
    await req(`/api/targets/${target.id}`, "PATCH", { enabled: false });
    const submission = await req(`/api/targets/${target.id}/runs`, "POST", {});
    for (const [attempt, epoch] of [
      [5, 5],
      [-1, 0],
      [2, 1],
    ]) {
      await assert.rejects(
        restored.query(
          "UPDATE crawl_run SET attempt=$2,lease_epoch=$3 WHERE id=$1",
          [submission.body.run.id, attempt, epoch],
        ),
        (e: unknown) =>
          !!e &&
          typeof e === "object" &&
          "code" in e &&
          e.code === "23514" &&
          "constraint" in e &&
          e.constraint === "crawl_run_attempt_check",
      );
    }
    const claim = await queue.claim("restored-live-smoke");
    assert.equal(claim?.id, submission.body.run.id);
    await executeClaim(queue, claim!); // default real crawler, DoH, TLS, public-IP checks; no mock fetcher
    const completed = (
      await restored.query(
        "SELECT execution_status,completeness,adoption_status FROM crawl_run WHERE id=$1",
        [claim!.id],
      )
    ).rows[0];
    assert.equal(completed.execution_status, "succeeded");
    assert.equal(completed.completeness, "complete");
    assert.equal(completed.adoption_status, "baseline");
    const restoredUrls = (await req(`/api/targets/${target.id}/urls`)).body
      .total;
    assert.ok(restoredUrls > 0);
    assert.equal((await req(`/api/targets/${target.id}/events`)).body.total, 0);
    const sourceHasSmoke = (
      await source.query(
        'SELECT count(*)::int AS n FROM "user" WHERE email=$1',
        [`restore-${runId}@example.invalid`],
      )
    ).rows[0].n;
    assert.equal(sourceHasSmoke, 0);
    const backupHash = createHash("sha256");
    for await (const chunk of createReadStream(backupPath))
      backupHash.update(chunk);
    const report = {
      observedAt: new Date().toISOString(),
      sourceDatabase: "127.0.0.1:55471/sitemap_radar_pr1",
      format: "PostgreSQL 16 custom archive",
      exportedSnapshot: true,
      tables: expected,
      schemaSha256: sourceSchema.hash,
      dataMatches: true,
      schemaMatches: true,
      schemaNormalization:
        "Known equivalent pure AND parentheses in crawl_run_attempt_check only",
      restoredAttemptConstraintEnforcement: true,
      backupSha256: backupHash.digest("hex"),
      backupBytes: (await stat(backupPath)).size,
      backupFileMode: "0600",
      backupDirectoryMode: "0700",
      restoreMs,
      totalMs: Date.now() - start,
      restoredDatabase: restoreName,
      smoke: {
        origin: restoreOrigin,
        existingAccountLoginAndInventory: true,
        signupAndAuthenticatedWrites: true,
        realDefaultCrawler: true,
        observedUrls: restoredUrls,
        baselineEvents: 0,
        sourceContainsSmokeAccount: false,
        copiedActiveRunsIsolatedInDisposableDb: copiedActive.length,
      },
      restoreDatabaseCleanup: "pending",
      backupPathIncluded: false,
      productionTouched: false,
    };
    await stopProcess(web);
    web = undefined;
    await restored.end();
    await source.query(`DROP DATABASE ${quote(restoreName)}`);
    created = false;
    report.restoreDatabaseCleanup = "completed";
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({
        phase: "complete",
        tables: expected.length,
        backupBytes: report.backupBytes,
        restoredLiveUrls: restoredUrls,
        restoreDatabaseCleanup: report.restoreDatabaseCleanup,
      }),
    );
  } finally {
    if (snapshotOpen) await snapshot.query("ROLLBACK");
    snapshot.release();
    await stopProcess(web);
    await restored.end().catch(() => {});
    if (created) await source.query(`DROP DATABASE ${quote(restoreName)}`);
    await source.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Backup restore failed",
  );
  process.exitCode = 1;
});
