/**
 * Read-side billing summary for the Settings → Plan section. Server-only.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { normalizePlan, type Plan } from "@/lib/billing/plan";
import { isBillingConfigured } from "@/lib/lemonsqueezy/config";

export interface BillingSummary {
  plan: Plan;
  status: string | null;
  currentPeriodEnd: string | null;
  /** Whether this workspace has a Stripe customer yet (→ show "Manage"). */
  hasCustomer: boolean;
  /** Whether the deployment has Stripe configured at all. */
  configured: boolean;
}

export async function getBillingSummary(): Promise<BillingSummary> {
  const { companyId } = await requireScopedSession();
  const c = await db.company.findFirst({
    where: { id: companyId, deletedAt: null },
    select: {
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      billingCustomerId: true,
    },
  });
  return {
    plan: normalizePlan(c?.plan),
    status: c?.subscriptionStatus ?? null,
    currentPeriodEnd: c?.currentPeriodEnd ? c.currentPeriodEnd.toISOString() : null,
    hasCustomer: Boolean(c?.billingCustomerId),
    configured: isBillingConfigured(),
  };
}
