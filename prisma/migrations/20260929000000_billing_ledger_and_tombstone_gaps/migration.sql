-- billing_ledger_and_tombstone_gaps
--
-- Four independent, strictly ADDITIVE changes. Written by hand (repo convention
-- — see 20260526151502_add_projects) and ordered cheapest-and-safest first,
-- because Prisma runs a migration file inside a SINGLE transaction: if step 4
-- fails, steps 1-3 roll back with it and nothing is half-applied.
--
--   1. Comment.deletedAt    — data-integrity-001. The EIGHTH soft-delete table.
--      A comment on a transaction is the only written record of WHY money moved,
--      and deleting one destroyed it outright while CLAUDE.md's Tier 3 section
--      promised 90-day recovery for it.
--   2. TimeEntry.deletedAt  — data-integrity-001. The NINTH. A MEMBER may delete
--      their own entry, so an accidental tap erased billable hours and the
--      editedBy / editedAt audit trail along with them.
--   3. Project.updatedAt    — projects-010. There was no value that changes on
--      every write, so two people editing one project's NAME could not be told
--      apart from one person editing it, and the slower save silently won.
--   4. BillingEvent         — bill-002 + bill-009. Nothing recorded that any
--      billing event had ever arrived, and replay protection was INFERRED from
--      Company state rather than enforced by a key.
--
-- NOT IN HERE, on purpose. Company.billingSubscriptionId (the other half of
-- bill-012) was ALREADY added by 20260718000000_add_company_billing and is
-- present in production. There is nothing to alter: the bill-012 residue is in
-- how the webhook RESOLVES a workspace, not in the schema.
--
-- NOTHING HERE DELETES, REWRITES OR NULLS A CUSTOMER ROW. There is no DROP, no
-- DELETE, and no ALTER of any existing column's type, nullability or default.
-- The only statement that touches an existing row at all is the Project.updatedAt
-- back-fill, and it writes exactly one brand-new column.
--
-- LOCKING NOTE, for whoever applies this to production. Migrations run at BUILD
-- time (CLAUDE.md) while the PREVIOUS deployment is still serving, so these locks
-- are taken against live traffic. Every ALTER TABLE ... ADD COLUMN below takes an
-- ACCESS EXCLUSIVE lock on its table, held until the transaction commits: writes
-- to Comment, TimeEntry and Project block for the duration of the WHOLE file.
-- That is milliseconds at this scale — three catalog-only column adds, three
-- small index builds, and one UPDATE over a table holding one row per project.
-- The CREATE INDEX statements take a ShareLock, which also blocks writes to their
-- table. CREATE INDEX CONCURRENTLY is NOT an option here and must not be
-- substituted: it cannot run inside a transaction block, so putting it in a
-- Prisma migration file makes the migration fail outright. If Comment or
-- TimeEntry have grown large by the time this ships, build those two indexes
-- CONCURRENTLY BY HAND first — the IF NOT EXISTS below then makes them no-ops.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Comment.deletedAt — data-integrity-001
-- ─────────────────────────────────────────────────────────────────────
--
-- NULLABLE, no default, no backfill. NULL already means exactly the right thing
-- for every row that exists — "live" — so not one existing comment is read or
-- written for its value. In Postgres 11+ adding a nullable column with no default
-- is a catalog-only change: no table rewrite, however many comments there are.
--
-- Matches the convention on all seven existing tombstone columns (see
-- 20260703135542_add_soft_delete), index included. The index serves the same two
-- readers it serves everywhere else: the purge cron's overdue scan, and the
-- deletedAt IS NULL filter on every read path.

ALTER TABLE "Comment" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Comment_deletedAt_idx" ON "Comment"("deletedAt");

-- ─────────────────────────────────────────────────────────────────────
-- 2. TimeEntry.deletedAt — data-integrity-001
-- ─────────────────────────────────────────────────────────────────────
--
-- Same shape, same reasoning, same safety as step 1.

ALTER TABLE "TimeEntry" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TimeEntry_deletedAt_idx" ON "TimeEntry"("deletedAt");

-- ─────────────────────────────────────────────────────────────────────
-- 3. Project.updatedAt — projects-010
-- ─────────────────────────────────────────────────────────────────────
--
-- WHY THERE IS A DEFAULT, AND WHY IT STAYS. The column is NOT NULL, so existing
-- rows need a value; that much is ordinary. What is not ordinary is that the
-- default has to SURVIVE this migration rather than be dropped at the end of it.
-- Migrations run at BUILD time, minutes before the new deployment goes live, so
-- for that window the PREVIOUS build's Prisma client is still inserting Project
-- rows and does not know this column exists. With no database-side default those
-- INSERTs violate the NOT NULL and project creation 500s for every customer,
-- mid-deploy, with a green build. The Prisma schema therefore declares
-- `@default(now()) @updatedAt` — both attributes — so the default below is the
-- schema's stated intent and not drift for the next `migrate dev` to "fix".
--
-- CURRENT_TIMESTAMP is the house spelling of @default(now()) (every createdAt in
-- 20260523212052_init) and it is also what keeps this statement cheap: it is
-- STABLE, not volatile, so Postgres 11+ evaluates it ONCE and stores the result
-- as the column's catalog-level missing value. No table rewrite, and no instant
-- at which any row holds NULL.
--
-- THE BACK-FILL THEN CORRECTS THE VALUE, which is the whole reason there are two
-- statements instead of one. Left at CURRENT_TIMESTAMP, every project in every
-- workspace would claim it was last edited at the exact instant of the deploy — a
-- fabricated audit fact, and one that reads as "somebody just changed all my
-- projects" on any surface showing "last updated". createdAt is the newest
-- timestamp we genuinely hold for the row: for a project never edited it is
-- exactly right, and for one edited before this column existed it understates
-- rather than invents. The concurrency check is indifferent either way — it needs
-- a value that CHANGES on write, not one that is historically true.
--
-- Safe on a populated table: it writes one brand-new column on every Project row
-- and reads only that row's own createdAt. Project is bounded by workspaces ×
-- projects, orders of magnitude below Notification or Message, and no reader for
-- the column exists yet, so a torn read is not possible.

ALTER TABLE "Project" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Project" SET "updatedAt" = "createdAt";

-- ─────────────────────────────────────────────────────────────────────
-- 4. BillingEvent — bill-002 + bill-009
-- ─────────────────────────────────────────────────────────────────────
--
-- Pure CreateTable, no backfill — same strategy as
-- 20260924000000_add_notification_preferences. An absent row means "we hold no
-- record of a delivery from before this shipped", which is true, so there is
-- nothing to invent. No existing row is read, locked or written: the only locks
-- taken are on the new table and on "Company" for the FK, and a foreign key added
-- against an EMPTY child table validates without scanning the parent.
--
-- BillingEvent_eventId_key IS THE IDEMPOTENCY KEY, not decoration. The webhook
-- inserts its row inside the same transaction as the Company update and treats a
-- P2002 on this index as "already applied — skip", so a replayed delivery loses
-- the race inside Postgres rather than in a timestamp comparison. The column is
-- NOT NULL for exactly that reason: Postgres unique indexes are NULLS DISTINCT,
-- so a nullable key would deduplicate nothing while looking like it did.
--
-- "companyId" is a NULLABLE FK with ON DELETE CASCADE. Nullable because the most
-- valuable row in this table is the one that resolved to NO workspace ("money
-- arrived and we could not place it" — bill-008), and a required FK is precisely
-- the constraint that would refuse it. CASCADE because "payload" holds the raw
-- signed body, which carries user_email, user_name, card_brand and
-- card_last_four: that must be erasable WITH the workspace instead of outliving
-- the Tier 3 window. It is identifying customer data, not cardholder data — no
-- PAN, no CVV, no chargeable token — so it does not pull this schema into PCI
-- scope. The purge cron also deletes this table by name rather than leaning on
-- the cascade, because relying on cascade ordering is what purgeCompany's own
-- header calls the bug.

CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "customerId" TEXT,
    "companyId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "payload" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- The idempotency key. One row per provider delivery, for ever.
CREATE UNIQUE INDEX "BillingEvent_eventId_key" ON "BillingEvent"("eventId");

-- "Every delivery for this workspace, newest first" — the support query — and the
-- index Postgres needs to resolve the ON DELETE CASCADE below without a
-- sequential scan of this table once per purged workspace. That omission, on
-- Notification.projectId, was finding perf-005; not repeating it here.
CREATE INDEX "BillingEvent_companyId_receivedAt_idx" ON "BillingEvent"("companyId", "receivedAt");

-- "Every delivery for this subscription" — the bill-012 question: one payer, two
-- workspaces, which cancellation belonged to which.
CREATE INDEX "BillingEvent_subscriptionId_idx" ON "BillingEvent"("subscriptionId");

ALTER TABLE "BillingEvent"
    ADD CONSTRAINT "BillingEvent_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
