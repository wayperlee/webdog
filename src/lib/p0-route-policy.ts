/** Fixed PR 1 boundary. Expand this allowlist only in the PR that implements a capability. */
export function p0RouteDecision(path: string, method: string): { status: number; allow?: string } | null {
  if (/^\/(share|invite)(\/|$)/.test(path)) return { status: 404 };
  if (!path.startsWith("/api/")) return null;
  if (path.startsWith("/api/auth/") || path === "/api/health") return null;
  if (path === "/api/account/active") return null; // Existing ownership selection, not invitations.
  if (path === "/api/websites") {
    return ["GET", "HEAD", "POST"].includes(method) ? null : { status: 405, allow: "GET, HEAD, POST" };
  }
  if (/^\/api\/websites\/[^/]+$/.test(path)) {
    return ["GET", "HEAD"].includes(method) ? null : { status: 405, allow: "GET, HEAD" };
  }
  if (/^\/api\/websites\/[^/]+\/targets$/.test(path)) {
    return method === "POST" ? null : { status: 405, allow: "POST" };
  }
  if (/^\/api\/targets\/[^/]+$/.test(path)) {
    return ["GET", "HEAD", "PATCH"].includes(method) ? null : { status: 405, allow: "GET, HEAD, PATCH" };
  }
  if (/^\/api\/targets\/[^/]+\/scope$/.test(path)) return method === "PATCH" ? null : { status: 405, allow: "PATCH" };
  if (/^\/api\/targets\/[^/]+\/runs$/.test(path)) return ["POST", "GET", "HEAD"].includes(method) ? null : { status: 405, allow: "GET, HEAD, POST" };
  if (/^\/api\/targets\/[^/]+\/(urls|events|candidates)$/.test(path)) return ["GET", "HEAD"].includes(method) ? null : { status: 405, allow: "GET, HEAD" };
  if (/^\/api\/targets\/[^/]+\/candidates\/[^/]+\/urls$/.test(path)) return ["GET", "HEAD"].includes(method) ? null : { status: 405, allow: "GET, HEAD" };
  if (/^\/api\/targets\/[^/]+\/candidates\/[^/]+\/approve$/.test(path)) return method === "POST" ? null : { status: 405, allow: "POST" };
  if (path === "/api/cron/run") return method === "POST" ? null : { status: 405, allow: "POST" };
  return { status: 404 };
}
