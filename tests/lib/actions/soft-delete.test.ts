/**
 * Behavioural guards over the INDIVIDUAL delete paths — the half of Tier 3 that
 * the docs promised and the code never shipped.
 *
 * WHAT WAS WRONG (data-integrity-001 / tasks-and-comments-005). CLAUDE.md's
 * Tier 3 section, prisma/schema.prisma's `deletedAt` comments and the
 * add_soft_delete migration all state that a deleted Task / Transaction /
 * Budget row "survives until the nightly purge cron hard-deletes it after 90
 * days", recoverable with one `UPDATE … SET "deletedAt" = NULL`. That was true
 * for exactly one caller: `softDeleteWorkspace`. Every single-row delete action
 * called Prisma's real `delete()`, so a mis-clicked expense was gone, and a
 * deleted task took its whole comment thread with it (`Comment.taskId` is
 * `onDelete: Cascade`, and Comment carries no tombstone of its own). Support
 * would have reached for the published one-UPDATE restore and found no row.
 *
 * WHY THESE TESTS LOOK LIKE THIS. tests/lib/db/purge-invariants.test.ts guards
 * the same convention structurally, by reading source text — the right tool
 * there, because it is asking "does this function name that table". Here the
 * question is different and stronger: given a real call, WHICH Prisma operation
 * does the action reach for, and with WHICH `where` clause. A grep for
 * `deletedAt` would pass on a file that writes the tombstone in a branch the
 * caller never enters, and it would say nothing at all about the `deletedAt:
 * null` filters that keep a tombstoned row from blocking its own replacement.
 * So each test drives the action with a fake Prisma client that RECORDS every
 * call, and asserts on the recorded operation and arguments.
 *
 * THE TRAP THIS FILE IS BUILT TO AVOID. This repo has shipped a test named for
 * a bug it could not detect. The cheap version of this file asserts
 * `success === true`, which was already true of the hard-delete code — the row
 * was destroyed successfully. Every assertion below therefore names the
 * operation it forbids (`transaction.delete`, `task.deleteMany`,
 * `budget.delete`) as well as the one it requires, because the defect is not a
 * missing write, it is the WRONG write.
 *
 * Also covered here, because they are the same mechanism seen from the other
 * side (the read filters that make a tombstone invisible):
 *   • data-integrity-002 — a project lookup that forgets `deletedAt: null`
 *     accepts a task or budget into a workspace-deleted project.
 *   • data-integrity-004 — a push/notification recipient query that forgets it
 *     keeps delivering a workspace's expense figures to a deactivated user.
 *   • money-006 — the activity/notification prose that hardcoded "PKR".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories are hoisted above the imports, so everything they close
 * over has to be built inside `vi.hoisted` — a plain `const` at module scope is
 * still undefined when the factory runs, and the failure looks like the action
 * calling a method on undefined rather than like a test-setup mistake.
 */
const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → the value to resolve with, or a function of the call args. */
  const results = new Map<string, unknown>();

  // Only the models + operations these four actions actually touch. A short,
  // explicit list means an action that starts reaching for a NEW table fails
  // loudly here ("db.timeEntry is undefined") instead of silently recording
  // nothing and passing.
  const MODELS = [
    "transaction",
    "task",
    "budget",
    "project",
    "user",
    "company",
    "activity",
    "notification",
    "comment",
    "pushSubscription",
  ];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "aggregate",
    "groupBy",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  // Interactive transactions only — all four actions use the callback form.
  // Handing the callback the same recorder means a `tx.` call and a `db.` call
  // land in one ordered list, which is what lets a test say "the tombstone and
  // the activity row went out together".
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
// lib/queries/transactions.ts (the ledger read the last test in the first
// describe drives) imports @sentry/nextjs for its read-ceiling warning. The real
// module drags a whole runtime into a jsdom test and the ceiling is not what
// this file is about.
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
// The threshold check re-reads the ledger on its own client; it has its own
// tests (tests/lib/budgets/threshold.test.ts) and would only add noise here.
vi.mock("@/lib/budgets/check", () => ({ checkBudgetThresholdAfterExpense: vi.fn() }));

/** Records the fan-out payload so the currency assertions can read the prose. */
const notifyCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async (input: Record<string, unknown>) => {
    notifyCalls.push(input);
    return { notified: 1 };
  },
}));

/** Push config is stubbed ON so `sendPushToUsers` gets past its first guard. */
const pushed: Array<unknown> = [];
vi.mock("@/lib/push/config", () => ({
  isPushConfigured: () => true,
  webpush: {
    sendNotification: async (...args: unknown[]) => {
      pushed.push(args);
    },
  },
}));

import { addTransactionAction, deleteTransactionAction } from "@/lib/actions/transactions";
import { addTaskAction, bulkDeleteTasksAction, deleteTaskAction } from "@/lib/actions/tasks";
import { createBudgetAction, deleteBudgetAction } from "@/lib/actions/budgets";
import { sendPushToUsers } from "@/lib/push/send";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

/**
 * Stand-in for `Prisma.Decimal`. The actions call `.toNumber()` at the client
 * boundary and `.toLocaleString()` when they bake the figure into a persisted
 * message — a bare JS number would pass the first and silently change the
 * second's grouping, so both are provided explicitly.
 */
function money(n: number): unknown {
  return { toNumber: () => n, toLocaleString: () => n.toLocaleString("en-US") };
}

/** A user row shaped the way the actions read it: name + the workspace currency. */
function actor(name: string, currency: string): unknown {
  return { id: "u1", name, companyId: "c1", company: { currency } };
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

/** Tomorrow, ISO — NewTaskSchema rejects a deadline before start-of-today. */
function tomorrow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  notifyCalls.length = 0;
  pushed.length = 0;
  H.session.value = null;
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* data-integrity-001 + tasks-and-comments-005 — the tombstone itself           */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("deleteTransactionAction (a mis-clicked ledger line must be recoverable)", () => {
  function aLiveExpense(over: Record<string, unknown> = {}) {
    return {
      id: "t1",
      companyId: "c1",
      projectId: null,
      type: "expense",
      amount: money(2_500_000),
      category: "Salaries",
      description: "June payroll",
      date: new Date("2026-06-30T00:00:00.000Z"),
      addedBy: "u1",
      addedByName: "Saqib",
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      deletedAt: null,
      ...over,
    };
  }

  it("stamps deletedAt instead of hard-deleting the row", async () => {
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await deleteTransactionAction("t1");
    expect(res.success).toBe(true);

    const tombstones = callsTo("transaction.update");
    expect(
      tombstones.length,
      "deleteTransactionAction must write the Tier 3 tombstone. Without it the " +
        "90-day window CLAUDE.md publishes does not exist for a single expense."
    ).toBe(1);
    expect(dataOf(tombstones[0]).deletedAt).toBeInstanceOf(Date);
    expect(whereOf(tombstones[0]).id).toBe("t1");

    expect(
      callsTo("transaction.delete"),
      "a hard DELETE destroys the row AND cascades its comment thread away"
    ).toHaveLength(0);
  });

  it("still writes the activity row, so the feed records the deletion", async () => {
    // The tombstone must not cost the audit trail: /activities is the only
    // surface that says a row ever existed once it is hidden from the ledger.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    await deleteTransactionAction("t1");
    const activities = callsTo("activity.create");
    expect(activities).toHaveLength(1);
    expect(dataOf(activities[0]).type).toBe("transaction_deleted");
  });

  it("refuses a row that is already tombstoned", async () => {
    // Two deletes of the same id would otherwise move the tombstone timestamp
    // and write a second "deleted" activity row for one deletion. The timestamp
    // matters: CLAUDE.md's restore runbook reunites a workspace's rows by
    // `"companyId" = '<id>' AND "deletedAt" = '<exact t>'`, so moving the stamp
    // takes the row out of the set its siblings will be restored with. (That
    // runbook used a ±1s BETWEEN window until data-integrity-005 corrected it
    // on 2026-09-30 — an exact match, because one transaction wrote one value.)
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense({ deletedAt: new Date("2026-09-01") }));
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await deleteTransactionAction("t1");
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
    expect(callsTo("activity.create")).toHaveLength(0);
  });

  /* ───────────────────────────────────────────────────────────────────────── *
   * transactions-ledger-013 — the author-or-admin gate, on the IRREVERSIBLE
   * path.
   *
   * WHY THIS PAIR EXISTS. The gate is
   * `txn.addedBy !== session.user.id && session.user.role !== "admin"` in BOTH
   * write paths. Its EDIT twin is pinned — tests/lib/actions/transaction-edit.
   * test.ts, "refuses someone who is neither the creator nor an admin", whose
   * header states the rule is deliberate: "the permission rule is the delete
   * rule (creator or admin, same company), since an edit can move money just
   * as effectively as a delete". The DELETE half had no test at all: every
   * `signedInAs` in this file was "admin" and every fixture is `addedBy: "u1"`,
   * which is also the default signed-in id, so both clauses passed on every
   * existing case and no actor ever reached the gate. The reversible path was
   * guarded and the irreversible one was not.
   *
   * WHY TWO TESTS AND NOT ONE. One negative case alone passes against an
   * admin-only gate, which would stop a cofounder deleting their OWN ledger
   * line — a regression in the opposite direction, on the same predicate. The
   * two cases below differ in exactly one input, `addedBy` vs. the signed-in
   * id, with the same non-admin role in both. That makes the pair name the
   * discriminating field rather than the outcome, so dropping the gate fails
   * the first and tightening it to `role === "admin"` fails the second.
   *
   * WHAT THIS DELIBERATELY DOES NOT DECIDE. Whether a cofounder SHOULD be able
   * to delete a teammate's row is a product question and is open with the
   * owner. These tests pin the rule the server enforces TODAY, which is the
   * same rule the three ledger clients render against (the Pencil and the Trash
   * are both inside `currentUserId === t.addedBy || currentUserRole ===
   * "admin"`). If the owner inverts the rule, this pair and its edit twin flip
   * together — they encode one predicate, in one direction, in two files.
   * ───────────────────────────────────────────────────────────────────────── */

  it("refuses someone who is neither the creator nor an admin", async () => {
    // A cofounder — full finance access everywhere else — on a teammate's row.
    signedInAs("cofounder", "u2");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Other", "PKR"));

    const res = await deleteTransactionAction("t1");
    expect(res.success).toBe(false);

    expect(
      callsTo("transaction.update"),
      "a refused delete must not write the tombstone — the row stays visible"
    ).toHaveLength(0);
    expect(
      callsTo("activity.create"),
      "nor an activity row claiming a deletion that did not happen"
    ).toHaveLength(0);
  });

  it("lets a non-admin delete the row they filed themselves", async () => {
    // Same role, same workspace, same fixture — only `addedBy` differs from the
    // case above. This is the clause that makes the gate "creator OR admin"
    // rather than "admin".
    signedInAs("cofounder", "u1");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await deleteTransactionAction("t1");
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const tombstones = callsTo("transaction.update");
    expect(
      tombstones.length,
      "the row's own author is permitted, so the tombstone must be written"
    ).toBe(1);
    expect(dataOf(tombstones[0]).deletedAt).toBeInstanceOf(Date);
    expect(whereOf(tombstones[0]).id).toBe("t1");
  });

  it("hides tombstoned rows from the ledger read the finance pages render", async () => {
    // A soft delete that a list still renders is worse than a hard delete: the
    // user deletes, sees the row, and deletes again.
    //
    // THIS ASSERTION USED TO DRIVE `listTransactionsAction`, which was the one
    // Transaction read in lib/actions/ that shipped WITHOUT the filter. That
    // action is gone (deleted 2026-09-29; the banner in
    // lib/actions/transactions.ts says why), and the property did not go with
    // it — it was never really "some exported function filters the tombstone",
    // it is "the read a customer's /expenses, /revenue, /investments,
    // /dashboard and /reports actually render filters the tombstone". That read
    // is `getTransactions()`. Asserting it against a function no page called is
    // how the filter drifted out of the action unnoticed in the first place.
    //
    // ONE ASSERTION PER TYPE WINDOW, deliberately. `getTransactions()` issues
    // one findMany PER transaction type (the per-type ceiling, money-008), so a
    // filter present in "the query" can still be absent from two of the three
    // windows — revenue and investment rows coming back tombstoned while
    // expenses stayed clean. Indexing [0] would not have seen that.
    signedInAs("admin");
    when("transaction.findMany", []);
    const { getTransactions } = await import("@/lib/queries/transactions");
    await getTransactions();

    const windows = callsTo("transaction.findMany");
    expect(
      windows,
      "getTransactions() with no `type` reads one bounded window per type"
    ).toHaveLength(3);
    expect(windows.map((w) => whereOf(w).type).sort()).toEqual(["expense", "income", "investment"]);
    windows.forEach((w) => {
      expect(
        whereOf(w).deletedAt,
        `the ${String(whereOf(w).type)} window must exclude tombstoned rows`
      ).toBeNull();
    });
  });
});

describe("deleteTaskAction (the comment thread must survive)", () => {
  function aLiveTask(over: Record<string, unknown> = {}) {
    return {
      id: "k1",
      companyId: "c1",
      projectId: "p1",
      title: "Ship the invoice screen",
      assignedTo: "u2",
      assignedBy: "u1",
      deletedAt: null,
      ...over,
    };
  }

  it("stamps deletedAt instead of hard-deleting (which cascaded the comments)", async () => {
    signedInAs("admin");
    when("task.findUnique", aLiveTask());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await deleteTaskAction("k1");
    expect(res.success).toBe(true);

    const tombstones = callsTo("task.update");
    expect(tombstones).toHaveLength(1);
    expect(dataOf(tombstones[0]).deletedAt).toBeInstanceOf(Date);
    expect(
      callsTo("task.delete"),
      "Comment.taskId is onDelete: Cascade and Comment has no tombstone of its " +
        "own, so a hard DELETE here erases the whole conversation with the task"
    ).toHaveLength(0);
  });

  it("refuses a task that is already tombstoned", async () => {
    signedInAs("admin");
    when("task.findUnique", aLiveTask({ deletedAt: new Date("2026-09-01") }));
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await deleteTaskAction("k1");
    expect(res.success).toBe(false);
    expect(callsTo("task.update")).toHaveLength(0);
  });
});

describe("bulkDeleteTasksAction (the floating action bar hits this)", () => {
  it("tombstones the batch instead of deleteMany", async () => {
    signedInAs("admin");
    when("user.findUnique", actor("Saqib", "PKR"));
    when("task.findMany", [{ id: "k1" }, { id: "k2" }]);

    const res = await bulkDeleteTasksAction({ ids: ["k1", "k2"] });
    expect(res.success).toBe(true);

    const tombstones = callsTo("task.updateMany");
    expect(tombstones).toHaveLength(1);
    expect(dataOf(tombstones[0]).deletedAt).toBeInstanceOf(Date);
    expect(
      callsTo("task.deleteMany"),
      "one drag-select + Delete would otherwise destroy 200 tasks and every " +
        "comment on them, permanently"
    ).toHaveLength(0);
  });
});

describe("deleteBudgetAction", () => {
  function aLiveBudget(over: Record<string, unknown> = {}) {
    return {
      id: "b1",
      companyId: "c1",
      projectId: "p1",
      category: "Salaries",
      deletedAt: null,
      project: { id: "p1", supervisorId: "u9" },
      ...over,
    };
  }

  it("stamps deletedAt instead of hard-deleting the row", async () => {
    signedInAs("admin");
    when("budget.findUnique", aLiveBudget());

    const res = await deleteBudgetAction("b1");
    expect(res.success).toBe(true);

    const tombstones = callsTo("budget.update");
    expect(tombstones).toHaveLength(1);
    expect(dataOf(tombstones[0]).deletedAt).toBeInstanceOf(Date);
    expect(callsTo("budget.delete")).toHaveLength(0);
  });

  it("refuses a budget that is already tombstoned", async () => {
    signedInAs("admin");
    when("budget.findUnique", aLiveBudget({ deletedAt: new Date("2026-09-01") }));

    const res = await deleteBudgetAction("b1");
    expect(res.success).toBe(false);
    expect(callsTo("budget.update")).toHaveLength(0);
  });

  it("lets a replacement budget for the same category be created afterwards", async () => {
    // The one-active-budget-per-category guard reads
    // `{ projectId, category, active: true }`. A tombstoned row keeps
    // `active: true` on purpose (so a restore comes back in the state it left),
    // so without `deletedAt: null` here the soft delete would lock that
    // category out of the project forever — a regression the tombstone itself
    // would have caused.
    signedInAs("admin");
    when("project.findFirst", { id: "p1", supervisorId: "u9", status: "active" });
    when("budget.findFirst", null);
    when("user.findUnique", actor("Saqib", "PKR"));
    when("budget.create", { id: "b2" });

    const res = await createBudgetAction({
      projectId: "p1",
      category: "Salaries",
      monthlyLimit: 500000,
    });
    expect(res.success).toBe(true);
    expect(whereOf(callsTo("budget.findFirst")[0]).deletedAt).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* data-integrity-002 — no filing work into a deleted project                  */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a deleted project cannot take new work (data-integrity-002)", () => {
  it("addTaskAction resolves the project with deletedAt: null", async () => {
    signedInAs("admin");
    when("project.findFirst", null); // the tombstoned project must not resolve

    const res = await addTaskAction({
      title: "Stranded",
      description: "",
      status: "pending",
      priority: "high",
      projectId: "p-dead",
      assignedTo: "u2",
      deadline: tomorrow(),
    });

    expect(res.success).toBe(false);
    expect(
      whereOf(callsTo("project.findFirst")[0]).deletedAt,
      "without this filter a stale New-task modal files the task into a " +
        "tombstoned project: it shows on the global board, is missing from " +
        "search and the project page, and pins the project's Restrict FK open"
    ).toBeNull();
  });

  it("createBudgetAction resolves the project with deletedAt: null", async () => {
    signedInAs("admin");
    when("project.findFirst", null);

    const res = await createBudgetAction({
      projectId: "p-dead",
      category: "Salaries",
      monthlyLimit: 1000,
    });
    expect(res.success).toBe(false);
    expect(whereOf(callsTo("project.findFirst")[0]).deletedAt).toBeNull();
  });

  it("addTransactionAction resolves the project tag with deletedAt: null", async () => {
    signedInAs("admin");
    when("project.findFirst", null);

    const res = await addTransactionAction({
      type: "expense",
      amount: 1000,
      category: "Salaries",
      description: "",
      projectId: "p-dead",
      date: new Date().toISOString(),
    });
    expect(res.success).toBe(false);
    expect(whereOf(callsTo("project.findFirst")[0]).deletedAt).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* data-integrity-004 — deactivation must stop delivery                        */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a deactivated teammate stops receiving the workspace's data", () => {
  it("sendPushToUsers only loads devices belonging to a live user", async () => {
    when("pushSubscription.findMany", []);
    await sendPushToUsers(["u-fired"], { title: "New expense", body: "2,500,000 PKR" });

    const where = whereOf(callsTo("pushSubscription.findMany")[0]);
    expect(
      where.user,
      "nothing prunes PushSubscription on deactivation and the purge cron has " +
        "no individual-user stage, so the device rows live forever — this join " +
        "filter is the only thing standing between a removed employee's phone " +
        "and the workspace's expense figures"
    ).toEqual({ deletedAt: null });
  });

  it("addTaskAction refuses to assign work to a deactivated teammate", async () => {
    // The assignee dropdown is built from lib/queries/users.ts, which filters
    // tombstones — but the action re-looked-up the id and checked only the
    // company, so a stale form (or a hand-crafted request) could file work onto
    // someone who has lost access. They would then be emailed and pushed a task
    // they cannot open, and the row would carry their denormalized name forever.
    signedInAs("admin");
    when("project.findFirst", { id: "p1", name: "Nimbus", supervisorId: "u9", status: "active" });
    when("user.findUnique", (args: Record<string, unknown>) => {
      const id = (args.where as { id: string }).id;
      return id === "u1"
        ? { id: "u1", name: "Saqib", companyId: "c1" }
        : { id: "u-fired", name: "Ex Employee", companyId: "c1", deletedAt: new Date() };
    });
    // Canned so that the UNFIXED code fails on the assertion below rather than
    // crashing on an undefined row — a TypeError would "fail first" for the
    // wrong reason and would keep failing for the wrong reason.
    when("task.create", {
      id: "k9",
      companyId: "c1",
      projectId: "p1",
      title: "Onboard the new bank feed",
      description: "",
      status: "pending",
      priority: "high",
      assignedTo: "u-fired",
      assignedToName: "Ex Employee",
      assignedBy: "u1",
      assignedByName: "Saqib",
      deadline: new Date(),
      createdAt: new Date(),
      completedAt: null,
      order: -1,
    });

    const res = await addTaskAction({
      title: "Onboard the new bank feed",
      description: "",
      status: "pending",
      priority: "high",
      projectId: "p1",
      assignedTo: "u-fired",
      deadline: tomorrow(),
    });

    expect(res.success).toBe(false);
    expect(callsTo("task.create")).toHaveLength(0);
  });

  it("addTransactionAction does not gather tombstoned users as recipients", async () => {
    signedInAs("admin");
    when("user.findUnique", actor("Saqib", "PKR"));
    when("user.findMany", []);
    when("transaction.create", {
      id: "t9",
      companyId: "c1",
      type: "expense",
      amount: money(1000),
      category: "Salaries",
      description: "",
      date: new Date(),
      addedBy: "u1",
      addedByName: "Saqib",
      createdAt: new Date(),
    });

    await addTransactionAction({
      type: "expense",
      amount: 1000,
      category: "Salaries",
      description: "",
      date: new Date().toISOString(),
    });

    expect(whereOf(callsTo("user.findMany")[0]).deletedAt).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* money-006 — persisted prose must quote the workspace's own currency         */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the activity trail quotes the workspace's currency, not PKR", () => {
  it("addTransactionAction labels a USD workspace's expense in USD", async () => {
    signedInAs("admin");
    when("user.findUnique", actor("Saqib", "USD"));
    when("user.findMany", [{ id: "u2" }]);
    when("transaction.create", {
      id: "t9",
      companyId: "c1",
      type: "expense",
      amount: money(1234.56),
      category: "Salaries",
      description: "",
      date: new Date(),
      addedBy: "u1",
      addedByName: "Saqib",
      createdAt: new Date(),
    });

    await addTransactionAction({
      type: "expense",
      amount: 1234.56,
      category: "Salaries",
      description: "",
      date: new Date().toISOString(),
    });

    const message = String(dataOf(callsTo("activity.create")[0]).message);
    expect(message).toContain("USD");
    expect(
      message,
      "Activity rows are written once and read forever — a later code fix " +
        "cannot relabel history"
    ).not.toContain("PKR");

    const notified = String(notifyCalls[0]?.message ?? "");
    expect(notified).toContain("USD");
    expect(notified, "this string also leaves the app as an email and a push body").not.toContain(
      "PKR"
    );
  });

  it("deleteTransactionAction labels the deleted figure in the workspace currency", async () => {
    signedInAs("admin");
    when("transaction.findUnique", {
      id: "t1",
      companyId: "c1",
      projectId: null,
      type: "expense",
      amount: money(2_500_000),
      category: "Salaries",
      description: "",
      date: new Date(),
      addedBy: "u1",
      addedByName: "Saqib",
      createdAt: new Date(),
      deletedAt: null,
    });
    when("user.findUnique", actor("Saqib", "AED"));

    await deleteTransactionAction("t1");
    const message = String(dataOf(callsTo("activity.create")[0]).message);
    expect(message).toContain("AED");
    expect(message).not.toContain("PKR");
  });

  it("still says PKR for a workspace that actually chose PKR", async () => {
    // The fix must thread the stored code, not swap one hardcoded literal for
    // another: PKR is the default and the majority case.
    signedInAs("admin");
    when("transaction.findUnique", {
      id: "t1",
      companyId: "c1",
      projectId: null,
      type: "expense",
      amount: money(1000),
      category: "Salaries",
      description: "",
      date: new Date(),
      addedBy: "u1",
      addedByName: "Saqib",
      createdAt: new Date(),
      deletedAt: null,
    });
    when("user.findUnique", actor("Saqib", "PKR"));

    await deleteTransactionAction("t1");
    expect(String(dataOf(callsTo("activity.create")[0]).message)).toContain("PKR");
  });
});
