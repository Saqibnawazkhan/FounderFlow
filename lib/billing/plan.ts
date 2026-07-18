/**
 * Plan model + feature gates. Pure (no I/O), so it's safe on the Edge runtime,
 * server actions, and the client.
 *
 * Two plans today, mirroring the landing pricing page:
 *   free ("Solo") — up to 2 members
 *   team ("Team") — unlimited members + paid features
 *
 * The workspace's `plan` column (kept in sync by the Stripe webhook) is the
 * source of truth. Gate on the plan, not on the raw subscription status.
 */

export type Plan = "free" | "team";

/** Free workspaces are capped at this many active members (pricing: "up to 2"). */
export const FREE_MEMBER_LIMIT = 2;

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Solo",
  team: "Team",
};

/** Coerce any stored/legacy value to a known plan. Unknown → free. */
export function normalizePlan(plan: string | null | undefined): Plan {
  return plan === "team" ? "team" : "free";
}

/** Max members a plan allows (Infinity = unlimited on Team). */
export function memberLimitForPlan(plan: string | null | undefined): number {
  return normalizePlan(plan) === "team" ? Infinity : FREE_MEMBER_LIMIT;
}

/** Stripe subscription statuses that count as "paid + active". */
export function isActiveSubscription(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing";
}
