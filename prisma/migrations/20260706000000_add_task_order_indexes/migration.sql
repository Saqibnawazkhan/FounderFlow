-- Support the kanban/list board sort. getTasks() filters on companyId (or
-- projectId) and orders by "order" asc; without a leading (companyId, order)
-- index Postgres filters via the companyId index then does an in-memory sort
-- of the whole task set on every /tasks load. These composites let it read
-- the rows already ordered. Additive + non-destructive (no data touched).
-- "order" is a reserved word, hence the quoting Prisma also emits.

-- CreateIndex
CREATE INDEX "Task_companyId_order_idx" ON "Task"("companyId", "order");

-- CreateIndex
CREATE INDEX "Task_projectId_order_idx" ON "Task"("projectId", "order");
