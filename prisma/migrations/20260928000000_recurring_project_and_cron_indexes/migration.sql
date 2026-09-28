-- recurring_project_and_cron_indexes
--
-- Three independent changes, all in service of the nightly jobs. Written by
-- hand (repo convention — see 20260526151502_add_projects) and deliberately
-- ordered cheapest-and-safest first, because Prisma runs a migration file in a
-- single transaction: if step 4 fails, steps 1-3 roll back with it and nothing
-- is half-applied.
--
--   1. RecurringRule.projectId          — money-005. Recurring spend could not
--      trip a budget alert, because a Budget belongs to a project and a
--      materialized Transaction had no project to attribute it to.
--   2. Notification_projectId_idx       — perf-005. Notification.projectId is
--      the target of an ON DELETE SET NULL with no index, so every project the
--      nightly purge hard-deletes cost a sequential scan of the
--      fastest-growing table in the schema.
--   3. Transaction_ruleId_date_key      — cron-003. Two overlapping runs of
--      /api/cron/materialize-recurring posted the same expense twice. The
--      route now claims each rule with a conditional UPDATE; this constraint
--      is the guard that does not depend on timing.
--
-- LOCKING NOTE, for whoever applies this to production. All three indexes are
-- built with a plain CREATE INDEX, which takes a ShareLock on the table:
-- concurrent reads are fine, concurrent WRITES to that table block until the
-- build finishes. That is the right trade here (these tables are small
-- pre-launch, and the build is milliseconds), and it is not optional:
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so putting
-- it in a Prisma migration file makes the migration fail outright. If these
-- tables have grown by the time this ships, build the two non-unique indexes
-- CONCURRENTLY by hand first — an existing index makes the CREATE INDEX below
-- a no-op thanks to IF NOT EXISTS — and leave step 3 to this file.

-- ─────────────────────────────────────────────────────────────────────
-- 1. RecurringRule.projectId (nullable, SetNull) — money-005
-- ─────────────────────────────────────────────────────────────────────
--
-- Nullable with no backfill, on purpose: an existing rule genuinely has no
-- project, and inventing one would attribute a founder's rent to whichever
-- project sorted first. Company-wide rules keep behaving exactly as they do
-- today (checkBudgetThresholdAfterExpense returns early on a null projectId);
-- the alerting switches on per rule, as each one is given a project.

ALTER TABLE "RecurringRule" ADD COLUMN "projectId" TEXT;

CREATE INDEX IF NOT EXISTS "RecurringRule_projectId_idx" ON "RecurringRule"("projectId");

ALTER TABLE "RecurringRule"
    ADD CONSTRAINT "RecurringRule_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Notification.projectId index — perf-005
-- ─────────────────────────────────────────────────────────────────────
--
-- The column and its FK have existed since add_projects; only the index was
-- missing. Every sibling project-referencing table already has one.

CREATE INDEX IF NOT EXISTS "Notification_projectId_idx" ON "Notification"("projectId");

-- ─────────────────────────────────────────────────────────────────────
-- 3. One transaction per rule per occurrence date — cron-003
-- ─────────────────────────────────────────────────────────────────────
--
-- Manually-entered transactions have ruleId IS NULL and a composite unique
-- index treats any row with a NULL member as distinct, so they are untouched
-- by this — there is no risk of a unique violation on hand-entered money.
--
-- Only rows already written by the materializer or by the rule-creation seed
-- can collide, and only if two of them share a ruleId AND an identical
-- timestamp to the millisecond. If that has actually happened — i.e. cron-003
-- fired in production before this shipped — we refuse rather than choose a row
-- to destroy: deleting a customer's financial record to let a migration
-- through is not a decision a migration gets to make. The check below turns
-- the bare "duplicate key value violates unique constraint" into an error that
-- says what to do, and the failed migration leaves the previous deployment
-- serving (see CLAUDE.md, "Production migrations run at BUILD time").

DO $$
DECLARE
    dupe_groups INTEGER;
BEGIN
    SELECT COUNT(*) INTO dupe_groups
    FROM (
        SELECT "ruleId", "date"
        FROM "Transaction"
        WHERE "ruleId" IS NOT NULL
        GROUP BY "ruleId", "date"
        HAVING COUNT(*) > 1
    ) d;

    IF dupe_groups > 0 THEN
        RAISE EXCEPTION
            'Cannot add Transaction_ruleId_date_key: % (ruleId, date) pair(s) already hold more than one row. These are duplicate recurring postings (finding cron-003) that predate this migration. Reconcile them by hand first — SELECT "ruleId", "date", COUNT(*) FROM "Transaction" WHERE "ruleId" IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1 — deciding per pair which row is the real charge. This migration deliberately will not pick one for you.',
            dupe_groups;
    END IF;
END $$;

CREATE UNIQUE INDEX "Transaction_ruleId_date_key" ON "Transaction"("ruleId", "date");
