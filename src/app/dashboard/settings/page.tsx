import { requireUser } from "@/lib/session";

export default async function SettingsPage() {
  const user = await requireUser();
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
    <h1 className="text-3xl font-semibold">Account</h1>
    <p className="mt-4">{user.name}</p><p className="text-neutral-600">{user.email}</p>
  </div>;
}
