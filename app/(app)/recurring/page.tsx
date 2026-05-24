/**
 * /recurring — Server Component. Lists every recurring rule the company has
 * set up (active + paused). The client child owns the New-rule modal +
 * active toggle + delete confirmation.
 */

import type { Metadata } from "next";
import { getRecurringRules } from "@/lib/queries/recurring";
import { requireScopedSession } from "@/lib/queries/session";
import { RecurringClient } from "./recurring-client";

export const metadata: Metadata = {
  title: "Recurring",
  description:
    "Set up monthly or weekly transactions like rent, salary, or subscriptions. They auto-create themselves on schedule.",
};

export default async function RecurringPage() {
  const [session, rules] = await Promise.all([requireScopedSession(), getRecurringRules()]);

  return (
    <RecurringClient rules={rules} currentUserId={session.userId} currentUserRole={session.role} />
  );
}
