import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { getPool } from "@/lib/db";
import { CrawlQueue, QueueError } from "@/lib/crawl-queue";
import { InventoryError } from "@/lib/url-inventory";
export async function POST(req: Request, { params }: { params: Promise<{ id: string; candidateId: string }> }) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, z.object({}).strict());
  if (parsed.response) return parsed.response;
  const { id, candidateId } = await params;
  try { return NextResponse.json(await new CrawlQueue(getPool()).approve(id, candidateId, ownerId)); }
  catch (error) {
    if (!(error instanceof QueueError || error instanceof InventoryError)) throw error;
    return NextResponse.json({ error: error.code }, { status: ["TARGET_NOT_FOUND", "CANDIDATE_NOT_FOUND"].includes(error.code) ? 404 : 409 });
  }
}
