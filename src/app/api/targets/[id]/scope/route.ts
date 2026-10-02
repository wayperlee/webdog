import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUserWithWriteOwner, parseJson } from "@/lib/api";
import { getPool } from "@/lib/db";
import { SitemapError } from "@/lib/sitemap/types";
import { CrawlQueue, QueueError } from "@/lib/crawl-queue";
const input = z
  .object({
    roots: z.array(z.string().url()).min(1).max(500).nullable(),
    allowedPageHosts: z.array(z.string().min(1)).min(1).max(100).nullable(),
  })
  .strict();
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, ownerId, response } = await requireApiUserWithWriteOwner();
  if (!user || !ownerId) return response!;
  const parsed = await parseJson(req, input);
  if (parsed.response) return parsed.response;
  try {
    return NextResponse.json(
      await new CrawlQueue(getPool()).configureScope(
        (await params).id,
        ownerId,
        parsed.data,
      ),
    );
  } catch (error) {
    if (error instanceof QueueError)
      return NextResponse.json(
        { error: error.code },
        { status: error.code === "TARGET_NOT_FOUND" ? 404 : 409 },
      );
    // Scope normalization rejects invalid/private URL hosts before mutation.
    if (error instanceof SitemapError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
