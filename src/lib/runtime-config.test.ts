import test from "node:test";
import assert from "node:assert/strict";
import { poolConfig, envInteger } from "./runtime-config";

test("Database pool budget and connection timeouts have bounded configuration", () => {
  assert.deepEqual(poolConfig({}), { max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, application_name: "sitemap-radar-web" });
  assert.equal(poolConfig({ DB_POOL_MAX: "2" }).max, 2);
  for (const value of ["0", "51", "NaN", "2.5", "-1", " 2", "1e2"]) assert.throws(() => poolConfig({ DB_POOL_MAX: value }), /Invalid DB_POOL_MAX/);
  assert.throws(() => poolConfig({ DB_CONNECTION_TIMEOUT_MS: "1" }), /Invalid DB_CONNECTION_TIMEOUT_MS/);
  assert.throws(() => poolConfig({ DB_IDLE_TIMEOUT_MS: "999999" }), /Invalid DB_IDLE_TIMEOUT_MS/);
  assert.equal(envInteger({ WORKER_SHUTDOWN_TIMEOUT_MS: "15000" }, "WORKER_SHUTDOWN_TIMEOUT_MS", 15000, 1000, 30000), 15000);
});
