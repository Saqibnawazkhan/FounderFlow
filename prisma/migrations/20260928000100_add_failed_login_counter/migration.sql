-- add_failed_login_counter
--
-- A durable per-account brute-force counter for the login throttle. The
-- in-process limiter in lib/rate-limit.ts keeps its state in a module-level
-- Map, which on Vercel means it resets on every cold start and is not shared
-- between concurrent lambdas: an attacker gets a fresh quota per instance.
-- These two columns give the throttle one counter per account that survives
-- both, without adding Redis.
--
-- Written by hand (repo convention) and kept in its own migration so it can be
-- reverted independently of 20260928000000_recurring_project_and_cron_indexes.
--
-- SAFE ON A POPULATED TABLE, and deliberately so:
--   * `INTEGER NOT NULL DEFAULT 0` is a metadata-only ALTER in Postgres 11+ —
--     the default is recorded in the catalog and no existing row is rewritten,
--     so this does not scan or lock "User" for any meaningful time.
--   * The timestamp is NULLable: a NULL window means "no failures recorded
--     yet", which is exactly the state every existing row should be in.
--   * No back-fill, no index. Every read of these columns is by the existing
--     unique "User_email_key" or by the primary key.

ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "failedLoginWindowStartedAt" TIMESTAMP(3);
