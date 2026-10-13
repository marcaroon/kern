import { requireOwner } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { Workspace } from "@/components/workspace";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  try {
    await requireOwner();
  } catch {
    redirect("/login");
  }
  const segments = (await params).section || [],
    section = segments[0] || "home";
  if (
    segments.length > 1 ||
    ![
      "home",
      "transactions",
      "tasks",
      "reminders",
      "notes",
      "budgets",
      "settings",
    ].includes(section)
  )
    notFound();
  return <Workspace section={section} />;
}
