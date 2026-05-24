/**
 * /notifications — Server Component. Fetches the per-user notification list
 * and hands it to the client component which owns the mark-read /
 * mark-all-read / clear-all interactions.
 *
 * Mutations call server actions that revalidatePath('/notifications'); the
 * client calls router.refresh() to pull fresh props into this RSC tree.
 */

import type { Metadata } from "next";
import { getNotifications } from "@/lib/queries/notifications";
import { NotificationsClient } from "./notifications-client";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Updates from your team — invites, role changes, new transactions, and tasks.",
};

export default async function NotificationsPage() {
  const notifications = await getNotifications();
  return <NotificationsClient notifications={notifications} />;
}
