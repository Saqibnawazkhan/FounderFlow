/**
 * /settings — Server Component. Fetches the signed-in user + their company
 * from Supabase. Theme + sign-out interactions still live in the client child.
 */

import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/queries/users";
import { getCurrentCompany } from "@/lib/queries/company";
import { getAccountStats } from "@/lib/queries/stats";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your account, workspace, and appearance preferences.",
};

export default async function SettingsPage() {
  // Stats are per-user; company is per-workspace. Member view in the
  // client hides the company section, but we still fetch it because the
  // current-user query depends on it for the workspace name + currency.
  const [user, company, stats] = await Promise.all([
    getCurrentUser(),
    getCurrentCompany(),
    getAccountStats(),
  ]);
  return <SettingsClient user={user} company={company} stats={stats} />;
}
