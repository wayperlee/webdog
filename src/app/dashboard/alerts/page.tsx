import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";

export default async function AlertsPage() {
  await requireUser();
  redirect("/dashboard");
}
