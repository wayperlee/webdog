import assert from "node:assert/strict";
import test from "node:test";
import { p0RouteDecision } from "./p0-route-policy";

test("legacy destructive and outbound capabilities are closed", () => {
  assert.equal(p0RouteDecision("/api/websites/w", "DELETE")?.status, 405);
  assert.equal(p0RouteDecision("/api/targets/t", "DELETE")?.status, 405);
  for (const path of ["/api/websites/w/share", "/api/account/invites/redeem", "/api/user/notification-settings/test", "/api/user/ai-models", "/api/user/context-intro"]) {
    assert.equal(p0RouteDecision(path, "POST")?.status, 404);
  }
  assert.equal(p0RouteDecision("/share/existing-token", "GET")?.status, 404);
  assert.equal(p0RouteDecision("/invite/existing-token", "GET")?.status, 404);
  assert.equal(p0RouteDecision("/api/cron/run", "POST")?.status, 503);
});

test("base auth and owned website/target routes remain available", () => {
  for (const [path, method] of [["/api/auth/sign-up/email", "POST"], ["/api/websites", "POST"], ["/api/websites/w", "GET"], ["/api/targets/t", "PATCH"]]) {
    assert.equal(p0RouteDecision(path, method), null);
  }
  assert.equal(p0RouteDecision("/api/future-capability", "POST")?.status, 404);
});
