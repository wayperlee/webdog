import { requireUser } from "@/lib/session";
import { CompetitorGroupList } from "@/components/competitor-group-pages";
export default async function GroupsPage() {
  await requireUser();
  return <CompetitorGroupList />;
}
