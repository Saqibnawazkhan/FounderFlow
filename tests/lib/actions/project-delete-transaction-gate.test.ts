/**
 * money-013 — deleting a project must not silently strip the project tag off
 * the money booked against it.
 *
 * WHAT WAS WRONG. `deleteProjectAction`'s emptiness gate counted two children:
 * `db.task.count` and `db.budget.count`. `Transaction.projectId` is
 * `onDelete: SetNull` (prisma/schema.prisma:414), so a project carrying real
 * spend passed a check named "only empty projects are deletable", got
 * tombstoned — and the confirm dialog the user had just agreed to says, in
 * lib/i18n/strings.ts:209, "Only empty projects can be deleted. Archive a
 * project to keep its history intact."
 *
 * The loss is not the soft delete. It is what happens 90 days later: the purge
 * cron HARD-deletes that "empty" project (app/api/cron/purge-soft-deleted/
 * route.ts, scope 2) and Postgres nulls every `Transaction.projectId` pointing
 * at it. The transactions survive — company totals never move, which is exactly
 * why nobody notices — but the per-project spend history is gone, and there is
 * nothing to restore it from: `restoreProjectAction` can clear a tombstone, it
 * cannot re-derive a tag Postgres overwrote with NULL.
 *
 * WHY THE FIX IS A REFUSAL rather than a reparent step. `updateTransactionAction`
 * deliberately cannot change `projectId` (lib/actions/transactions.ts:430), so
 * there is no re-tag path to offer, and denormalising a `projectName` onto
 * Transaction would need a migration. Refusing matches what the product already
 * tells the user to do with a project that has history: archive it.
 *
 * THE COUNT IS LIVE ROWS ONLY (`deletedAt: null`), matching the task and budget
 * counts beside it. A project whose every transaction was soft-deleted first is
 * still deletable, and its tombstoned transactions still lose their tag at
 * purge — the same residue the task/budget gate has always had, and not
 * something this gate can fix without refusing deletes forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const revalidated: string[] = [];

  const MODELS = ["project", "user", "activity", "notification", "task", "budget", "transaction"];
  const OPS = ["findUnique", "findFirst", "findMany", "count", "create", "update", "updateMany"];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        return results.get(path);
      };
    }
    db[model] = delegate;
  }
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { db, calls, results, revalidated, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    H.revalidated.push(p);
  },
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 0 }) }));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true, error: undefined }) } },
}));

import { deleteProjectAction } from "@/lib/actions/projects";

const LIVE_PROJECT = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: "d",
  supervisorId: "u-1",
  status: "active",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-1",
  updatedAt: new Date("2026-09-29T09:00:00.000Z"),
  deletedAt: null,
};

/** Did the tombstone actually get stamped? The point of a refused gate. */
function projectWrites(): number {
  return H.calls.filter((c) => c.path === "project.update" || c.path === "project.updateMany")
    .length;
}

function countArgs(model: string): Record<string, unknown> | undefined {
  return H.calls.filter((c) => c.path === `${model}.count`).map((c) => c.args)[0];
}

beforeEach(() => {
  H.calls.length = 0;
  H.revalidated.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "u-1", companyId: "c-1", role: "admin" } };
  H.results.set("project.findFirst", LIVE_PROJECT);
  H.results.set("user.findUnique", { id: "u-1", name: "Ada", companyId: "c-1" });
  H.results.set("project.update", { ...LIVE_PROJECT, deletedAt: new Date() });
  // An otherwise-empty project: no live tasks, no live budgets.
  H.results.set("task.count", 0);
  H.results.set("budget.count", 0);
  H.results.set("transaction.count", 0);
});

describe("money-013 — a project holding live transactions is not 'empty'", () => {
  it("refuses the delete, so the tag survives the purge", async () => {
    H.results.set("transaction.count", 42);

    const res = await deleteProjectAction("p-1");

    expect(
      res.success,
      "the project was tombstoned with 42 transactions tagged to it; when the purge hard-deletes it, Transaction.projectId is SetNull and the per-project spend history is gone with no way back"
    ).toBe(false);
    expect(projectWrites(), "deleteProjectAction stamped deletedAt anyway").toBe(0);
  });

  it("names the figure in the refusal, so the user knows what is at stake", async () => {
    H.results.set("transaction.count", 42);

    const res = await deleteProjectAction("p-1");

    expect(res.success).toBe(false);
    expect(
      res.success ? "" : (res.error ?? ""),
      "the refusal has to say how much money is attributed to this project — the dialog the user just confirmed claims only empty projects are deletable"
    ).toContain("42");
  });

  it("counts LIVE transactions for THIS project only", async () => {
    H.results.set("transaction.count", 1);

    await deleteProjectAction("p-1");

    expect(
      countArgs("transaction"),
      "an unscoped or company-wide count would block every project delete in the workspace; dropping deletedAt:null would block on transactions the user already deleted"
    ).toEqual({ where: { projectId: "p-1", deletedAt: null } });
  });

  it("still deletes a project with no transactions at all", async () => {
    const res = await deleteProjectAction("p-1");

    expect(
      res.success,
      "the gate must not refuse every delete — a genuinely empty project is still deletable"
    ).toBe(true);
    expect(projectWrites()).toBe(1);
  });

  it("still refuses on tasks and budgets, and still names those figures", async () => {
    // Pins the pre-existing half of the gate: adding transactions must not
    // replace the two counts that were already there.
    H.results.set("task.count", 3);
    H.results.set("budget.count", 2);

    const res = await deleteProjectAction("p-1");

    expect(res.success).toBe(false);
    const error = res.success ? "" : (res.error ?? "");
    expect(error).toContain("3");
    expect(error).toContain("2");
    expect(projectWrites()).toBe(0);
  });
});
