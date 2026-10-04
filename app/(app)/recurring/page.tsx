/**
 * /recurring — Server Component. Lists every recurring rule the company has
 * set up (active + paused). The client child owns the New-rule modal +
 * active toggle + delete confirmation.
 */

import type { Metadata } from "next";
import { getRecurringRules } from "@/lib/queries/recurring";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { RecurringClient } from "./recurring-client";

export const metadata: Metadata = {
  title: "Recurring",
  description:
    "Set up monthly or weekly transactions like rent, salary, or subscriptions. They auto-create themselves on schedule.",
};

export default async function RecurringPage() {
  const [session, rules, projects] = await Promise.all([
    requireScopedSession(),
    getRecurringRules(),
    // money-005. The New-rule modal's project picker. Without this list the
    // whole already-tested server path — tag persisted, carried onto the seed
    // transaction and onto every future posting, budget threshold checked with
    // it — stays unreachable from the product, which is how recurring spend
    // could never trip an over-budget alert. In the Promise.all so it costs no
    // extra waterfall stage; the `requireScopedSession` inside it is the same
    // per-request memo the line above uses.
    listProjectOptions(),
  ]);

  return (
    <RecurringClient
      rules={rules}
      currentUserId={session.userId}
      currentUserRole={session.role}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
    />
  );
}
