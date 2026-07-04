-- Email verification (audit A2). Nullable sentinel: NULL = unverified
-- (default for fresh signups + legacy rows), a timestamp = the moment the
-- user clicked their verification link. Soft gate — nothing is blocked
-- while null; drives the in-app "verify your email" banner.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
