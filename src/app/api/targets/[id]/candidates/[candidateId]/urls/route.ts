import { candidateUrlsPage } from "@/lib/inventory-api";
export async function GET(req: Request, { params }: { params: Promise<{ id: string; candidateId: string }> }) {
  const { id, candidateId } = await params;
  return candidateUrlsPage(req, id, candidateId);
}
