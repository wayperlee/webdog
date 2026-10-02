import { NextResponse, type NextRequest } from "next/server";
import { p0RouteDecision } from "@/lib/p0-route-policy";

export function middleware(request: NextRequest) {
  const decision = p0RouteDecision(request.nextUrl.pathname, request.method);
  if (!decision) return NextResponse.next();
  const code = decision.status === 503 ? "CHECKS_NOT_AVAILABLE" : "CAPABILITY_DISABLED";
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (decision.allow) headers.Allow = decision.allow;
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse("Not found", { status: decision.status, headers });
  }
  return NextResponse.json({ error: code }, { status: decision.status, headers });
}

export const config = { matcher: ["/api/:path*", "/share/:path*", "/invite/:path*"] };
