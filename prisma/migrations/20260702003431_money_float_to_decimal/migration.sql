-- Money precision migration (BUGS.md P0-4).
--
-- Was: Float (PostgreSQL DOUBLE PRECISION) — 15-17 significant digits with
-- IEEE-754 rounding. Storing 0.10 as 0.09999999... means a rolling SUM()
-- drifts as row-count grows, and equality checks (`amount = 100.00`) can
-- silently miss rows.
--
-- Now: DECIMAL(12, 2) — 10 digits before the decimal, 2 after. Caps a single
-- row at 9,999,999,999.99. Exact arithmetic, exact equality. Prisma returns
-- @prisma/client's Decimal type on reads; the app boundary in
-- lib/queries/* converts to Number for RSC/client serialization.
--
-- Cast semantics: PostgreSQL's `SET DATA TYPE DECIMAL(12,2)` rounds the
-- existing DOUBLE values half-to-even. Manually spot-checked the seed data
-- (15 Transaction rows in local + 15-ish in prod-shape) — every value
-- already has at most 2 fractional digits, so the round-trip is lossless.
--
-- Rollout order (from Tier 2 CLAUDE.md):
--   1. Applied to LOCAL docker Postgres via `prisma migrate deploy`. ✓
--   2. Apply to STAGING Supabase before prod (staging is deferred until
--      first launch — see [[staging-supabase-deferred]] memory note).
--   3. Apply to PROD Supabase via `prisma migrate deploy` in a controlled
--      window. Zero downtime — ALTER COLUMN … SET DATA TYPE holds a brief
--      ACCESS EXCLUSIVE lock but the tables are tiny.

-- AlterTable
ALTER TABLE "Budget" ALTER COLUMN "monthlyLimit" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "RecurringRule" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);
