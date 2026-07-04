-- Manual sort key for kanban drag-reorder (audit T3). Smaller = higher in
-- the column. Backfill so the initial ordering matches the previous
-- newest-first default: order = -epoch(createdAt) in ms, giving newer
-- tasks a smaller (more-negative) order so they sort to the top.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "order" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill existing rows to preserve the current newest-first display order.
UPDATE "Task" SET "order" = -EXTRACT(EPOCH FROM "createdAt") * 1000;
