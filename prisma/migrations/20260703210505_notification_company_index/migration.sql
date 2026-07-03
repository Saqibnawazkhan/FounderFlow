-- Add companyId-leading index to Notification so company-scoped reads
-- (workspace export, admin views) use an index range scan instead of a
-- full table scan. Notification was the only company-scoped table without
-- a companyId-leading composite index. Surfaced by the export-endpoint
-- adversarial review (2026-07-04).

-- CreateIndex
CREATE INDEX "Notification_companyId_createdAt_idx" ON "Notification"("companyId", "createdAt");
