import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { databaseReady } from "@/lib/runtime-health";

/** Readiness-style check: verifies PostgreSQL is reachable (Railway healthchecks). */
export async function GET() {
  try {
    await databaseReady(getPool());
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
