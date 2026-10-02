import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getPool } from "@/lib/db";
import { readGroup, GroupError } from "@/lib/competitor-groups";
import { CompetitorGroupDetail } from "@/components/competitor-group-pages";
export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  try {
    await readGroup(getPool(), user.id, id);
  } catch (e) {
    if (e instanceof GroupError && e.status === 404) notFound();
    throw e;
  }
  return <CompetitorGroupDetail id={id} />;
}
