import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";

export default async function ContextDevOnboardingPage() {
  await requireUser();
  redirect("/dashboard");
}
