import { NextResponse } from "next/server";
import { CrawlQueue, QueueError, type RunRow } from "./crawl-queue";
import { getPool } from "./db";
export function publicRun(run: RunRow) {
  return { id: run.id, targetId: run.target_id, executionStatus: run.execution_status, completeness: run.completeness,
    adoptionStatus: run.adoption_status, attempt: run.attempt, availableAt: run.available_at, createdAt: run.created_at };
}
export async function submitRun(targetId: string, ownerId: string) {
  try {
    const entry = await new CrawlQueue(getPool()).enqueueRun(targetId, "manual", ownerId);
    return NextResponse.json({ run: publicRun(entry!.run), created: entry!.created }, { status: 202 });
  } catch (error) {
    if (error instanceof QueueError) return NextResponse.json({ error: error.code }, { status: error.code === "TARGET_NOT_FOUND" ? 404 : 409 });
    throw error;
  }
}
