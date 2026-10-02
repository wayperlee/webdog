import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startWorkerHealthServer, closeWorkerHealthServer } from "./worker-health-server";

test("Container worker health exposes only readiness and closes cleanly", async () => {
  let healthy = true;
  const server = await startWorkerHealthServer(0, async () => { if (!healthy) throw new Error("postgres://private-password"); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ready = await fetch(`${origin}/health`);
    assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { ok: true });
    healthy = false;
    const failed = await fetch(`${origin}/health`);
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { ok: false });
    assert.equal((await fetch(`${origin}/health`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${origin}/health?secret=anything`)).status, 404);
  } finally { await closeWorkerHealthServer(server); }
});
