-- Tier 3 soft-delete columns.
--
-- Adds a nullable `deletedAt` timestamp on the six "customer data" tables.
-- NULL = live row (default). Any timestamp = soft-deleted; the row survives
-- until a nightly cron hard-deletes it 90 days later.
--
-- Behavioural changes that land alongside:
--   - Auth.js Credentials.authorize + every scoped query filter `deletedAt: null`
--     so a soft-deleted user can't log back in and their data isn't rendered.
--   - deleteAccountAction / deleteWorkspaceAction switch from `.delete()` to
--     `.updateMany({ data: { deletedAt: NOW() }})` and cascade the timestamp
--     to their children in the same $transaction.
--   - New /api/cron/purge-soft-deleted runs nightly and calls the actual
--     `db.*.deleteMany` for rows past the 90-day window.
--
-- Recovery within the window (ops-only, no user UI):
--   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<companyId>';
--   -- then cascade the same UPDATE to child tables that were tombstoned
--   -- at the same time (they share the deletedAt timestamp so a range
--   -- filter reunites them).
--
-- Indexes cover the purge cron's WHERE deletedAt < now() - INTERVAL '90 days'
-- and the "hide soft-deleted rows" filter on every read path.

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Budget_deletedAt_idx" ON "Budget"("deletedAt");

-- CreateIndex
CREATE INDEX "Company_deletedAt_idx" ON "Company"("deletedAt");

-- CreateIndex
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");

-- CreateIndex
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");

-- CreateIndex
CREATE INDEX "Transaction_deletedAt_idx" ON "Transaction"("deletedAt");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
