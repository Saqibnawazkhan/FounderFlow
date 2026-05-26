-- add_projects migration
--
-- Strategy: this migration introduces the Project model AND backfills every
-- existing Task + Budget row in one atomic step so Task.projectId / Budget.projectId
-- can be NOT NULL at the end. Order of operations:
--
--   1. Create the Project table + indexes (no data depends on it yet).
--   2. Add projectId columns as NULLABLE on Task, Budget, and the optional
--      tables (TimeEntry, Transaction, Activity, Notification).
--   3. Backfill: per Company, create one "General" project owned by the
--      company owner (or the first admin if owner is null), then UPDATE every
--      existing Task and Budget to point at it.
--   4. Tighten: ALTER Task.projectId and Budget.projectId to NOT NULL.
--   5. Add the FK constraints + remaining indexes.
--
-- Wrapped in a single SQL file; Prisma applies each migration in its own
-- transaction, so a failure rolls back cleanly.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Project table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "supervisorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "color" TEXT NOT NULL DEFAULT 'primary',
    "targetEndDate" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Project_companyId_status_idx" ON "Project"("companyId", "status");
CREATE INDEX "Project_supervisorId_idx" ON "Project"("supervisorId");

-- ─────────────────────────────────────────────────────────────────────
-- 2. Nullable projectId columns on dependent tables
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"         ADD COLUMN "projectId" TEXT;
ALTER TABLE "Budget"       ADD COLUMN "projectId" TEXT;
ALTER TABLE "TimeEntry"    ADD COLUMN "projectId"   TEXT;
ALTER TABLE "TimeEntry"    ADD COLUMN "projectName" TEXT;
ALTER TABLE "Transaction"  ADD COLUMN "projectId" TEXT;
ALTER TABLE "Activity"     ADD COLUMN "projectId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "projectId" TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Backfill: one "General" Project per Company, point legacy rows at it
-- ─────────────────────────────────────────────────────────────────────
--
-- Supervisor + creator default to the company owner. If the owner is null
-- (legacy state — shouldn't happen in current data but guarded anyway), we
-- fall back to the earliest admin user, then the earliest user of any role.
--
-- Use a single INSERT … SELECT so every company that has tasks OR budgets
-- gets a General project — companies that exist but have no work yet stay
-- empty (admin will create their first project on demand).

INSERT INTO "Project" ("id", "companyId", "name", "description", "supervisorId", "status", "color", "createdBy", "createdAt")
SELECT
  -- Deterministic id derived from companyId so re-running the seed
  -- doesn't try to overwrite. cuid-shaped fallback prefix.
  'pgen_' || substring(md5(c."id"), 1, 20)        AS id,
  c."id"                                          AS companyId,
  'General'                                        AS name,
  'Auto-created on the projects rollout. Houses every task and budget that existed before projects.' AS description,
  COALESCE(
    c."ownerId",
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."role" = 'admin' ORDER BY u."createdAt" ASC LIMIT 1),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" ORDER BY u."createdAt" ASC LIMIT 1)
  )                                               AS supervisorId,
  'active'                                         AS status,
  'primary'                                        AS color,
  COALESCE(
    c."ownerId",
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."role" = 'admin' ORDER BY u."createdAt" ASC LIMIT 1),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" ORDER BY u."createdAt" ASC LIMIT 1)
  )                                               AS createdBy,
  CURRENT_TIMESTAMP                                AS createdAt
FROM "Company" c
WHERE EXISTS (SELECT 1 FROM "Task" t WHERE t."companyId" = c."id")
   OR EXISTS (SELECT 1 FROM "Budget" b WHERE b."companyId" = c."id");

UPDATE "Task" t
SET "projectId" = p."id"
FROM "Project" p
WHERE p."companyId" = t."companyId"
  AND p."name" = 'General'
  AND t."projectId" IS NULL;

UPDATE "Budget" b
SET "projectId" = p."id"
FROM "Project" p
WHERE p."companyId" = b."companyId"
  AND p."name" = 'General'
  AND b."projectId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Tighten: required projectId on Task + Budget
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"   ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "Budget" ALTER COLUMN "projectId" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Indexes + foreign keys
-- ─────────────────────────────────────────────────────────────────────

CREATE INDEX "Task_projectId_status_idx"          ON "Task"("projectId", "status");
CREATE INDEX "Budget_projectId_active_idx"        ON "Budget"("projectId", "active");
CREATE INDEX "Budget_projectId_category_idx"      ON "Budget"("projectId", "category");
CREATE INDEX "TimeEntry_projectId_clockInAt_idx"  ON "TimeEntry"("projectId", "clockInAt");
CREATE INDEX "Transaction_projectId_date_idx"     ON "Transaction"("projectId", "date");
CREATE INDEX "Activity_projectId_createdAt_idx"   ON "Activity"("projectId", "createdAt");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_supervisorId_fkey"
  FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Budget"
  ADD CONSTRAINT "Budget_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
