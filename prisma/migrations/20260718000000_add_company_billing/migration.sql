-- Subscription billing (LemonSqueezy).
--
-- Provider-neutral column names so the billing layer can be swapped. Additive
-- + nullable, so NO existing workspace row is touched: every company defaults
-- to the free plan. The LemonSqueezy webhook (app/api/webhooks/lemonsqueezy) is
-- the source of truth and fills these columns on subscription lifecycle events.

ALTER TABLE "Company" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "Company" ADD COLUMN "billingCustomerId" TEXT;
ALTER TABLE "Company" ADD COLUMN "billingSubscriptionId" TEXT;
ALTER TABLE "Company" ADD COLUMN "subscriptionStatus" TEXT;
ALTER TABLE "Company" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);
