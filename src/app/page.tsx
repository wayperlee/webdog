import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@/lib/product-info";
import { getCurrentSession } from "@/lib/session";

export default async function LandingPage() {
  if ((await getCurrentSession())?.user) redirect("/dashboard");
  return <main className="mx-auto max-w-4xl px-6 py-20">
    <h1 className="text-4xl font-semibold">{APP_NAME}</h1>
    <p className="mt-6 text-neutral-600">Save websites for sitemap monitoring. No provider API key is required.</p>
    <div className="mt-8 flex gap-4"><Link className="btn-accent" href="/sign-up">Create account</Link>
      <Link className="btn-secondary" href="/sign-in">Sign in</Link></div>
    <p className="mt-10 text-sm text-neutral-500">Sitemap checks are not available yet.</p>
  </main>;
}
