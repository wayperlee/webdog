import { inventoryPage } from "@/lib/inventory-api";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return inventoryPage(req, (await params).id, "events");
}
