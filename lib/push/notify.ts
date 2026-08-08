/**
 * Bridge from a created Notification row to a Web Push send. Imported lazily by
 * the Prisma extension in lib/db.ts (a static import would form a db → push →
 * db cycle), and invoked fire-and-forget so a push never blocks or breaks the
 * action that wrote the notification.
 */

import { sendPushToUsers } from "@/lib/push/send";

export type NotificationRowLike = {
  userId: string;
  title: string;
  message: string;
  link?: string | null;
  category?: string | null;
};

export async function pushForNotificationRows(rows: NotificationRowLike[]): Promise<void> {
  await Promise.all(
    rows.map((r) =>
      sendPushToUsers([r.userId], {
        title: r.title,
        body: r.message,
        url: r.link ?? "/notifications",
        tag: r.category ?? undefined,
      })
    )
  );
}
