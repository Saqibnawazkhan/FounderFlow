/**
 * /settings — Server Component. Fetches the signed-in user + their company
 * from Supabase. Theme + sign-out interactions still live in the client child.
 */

import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/queries/users";
import { getCurrentCompany } from "@/lib/queries/company";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your account, workspace, and appearance preferences.",
};

export default async function SettingsPage() {
  const [user, company] = await Promise.all([getCurrentUser(), getCurrentCompany()]);
  return <SettingsClient user={user} company={company} />;
}
