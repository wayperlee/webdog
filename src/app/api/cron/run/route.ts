import { NextResponse } from "next/server";

/** PR 3 will delegate to enqueueRun; synchronous legacy scraping is never available. */
export async function POST() {
  return NextResponse.json({ error: "CHECKS_NOT_AVAILABLE" }, { status: 503 });
}
