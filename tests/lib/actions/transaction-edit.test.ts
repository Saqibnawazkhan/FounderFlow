/**
 * money-016 — a mistyped figure must be CORRECTABLE, not only destroyable.
 *
 * WHAT WAS WRONG. lib/actions/transactions.ts exported add / bulkImport /
 * delete and nothing else, so the only way to fix a wrong amount was to delete
 * the row and retype it. That is not an equivalent remedy: the replacement row
 * gets a new `createdAt`, a new id, and therefore a new (empty) Comment thread,
 * while the original figure survives nowhere a customer can read. Given a
 * finance app whose own audit found two separate ways to produce a wrong amount,
 * "destroy and retype" is the operation customers will reach for most on day
 * one, and it is the one that loses the most.
 *
 * WHAT THIS FILE PINS. Not "an update action exists" — that would pass against
 * an action that silently rewrites the wrong row or loses the old number. Each
 * test below names the property a correction has to have:
 *
 *   • the SAME row is amended (no delete, no tombstone, `createdAt` untouched),
 *     so the comment thread and the row's identity survive the correction;
 *   • an Activity row records what the number USED TO BE, because a ledger you
 *     can quietly rewrite is worse than one you cannot edit at all;
 *   • the permission rule is the delete rule (creator or admin, same company),
 *     since an edit can move money just as effectively as a delete;
 *   • money-002's scale rule applies to a correction too — the path that fixes
 *     a mistyped amount must not be the one place 3-decimal input is accepted
 *     and silently rounded by the column;
 *   • a category cannot be moved onto a row of a different type, which would
 *     file spend under a revenue bucket;
 *   • the budget threshold is re-judged for BOTH the old and the new category
 *     (finance-planning-005): correcting 5,000,000 down to 5,000 has to take
 *     the "over budget" alert back off, and moving the row to another category
 *     changes two months-to-date, not one.
 *
 * The fake Prisma client is the same recorder shape as
 * tests/lib/actions/soft-delete.test.ts: the question here is likewise WHICH
 * operation the action reaches for and with WHICH arguments, which a `success`
 * assertion cannot answer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["transaction", "project", "user", "activity", "notification", "comment"];
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
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const p = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path: p, args: args ?? {} });
        const canned = results.get(p);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
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
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 0 }) }));

/** The threshold hook, recorded rather than silenced: which (category, project)
 *  pairs a correction re-judges is one of the properties under test. */
const thresholdCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: async (input: Record<string, unknown>) => {
    thresholdCalls.push(input);
  },
}));

import { updateTransactionAction } from "@/lib/actions/transactions";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function when(p: string, value: unknown): void {
  H.results.set(p, value);
}

function callsTo(p: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === p).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

/** Stand-in for `Prisma.Decimal` — the action reads `.toNumber()` off the row. */
function money(n: number): unknown {
  return { toNumber: () => n, toLocaleString: () => n.toLocaleString("en-US") };
}

function actor(name: string, currency: string): unknown {
  return { id: "u1", name, companyId: "c1", company: { currency } };
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

/** The mistyped row: 5,000,000 where the founder meant 5,000. */
function aLiveExpense(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    companyId: "c1",
    projectId: null,
    type: "expense",
    amount: money(5_000_000),
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

/** A correction of the amount only, leaving every other field as filed. */
function correctedAmount(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    amount: 5_000,
    category: "Salaries",
    description: "June payroll",
    date: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  thresholdCalls.length = 0;
  H.session.value = null;
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("updateTransactionAction (a mistyped amount must be correctable)", () => {
  it("amends the same row instead of destroying and replacing it", async () => {
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const writes = callsTo("transaction.update");
    expect(
      writes.length,
      "an edit has to UPDATE the existing row — a delete + re-add loses the " +
        "original createdAt, the row id and its whole comment thread"
    ).toBe(1);
    expect(whereOf(writes[0]).id).toBe("t1");
    expect(Number(dataOf(writes[0]).amount)).toBe(5_000);

    expect(
      callsTo("transaction.delete"),
      "correcting a figure must not destroy the row"
    ).toHaveLength(0);
    expect(
      callsTo("transaction.create"),
      "correcting a figure must not mint a replacement row"
    ).toHaveLength(0);
    expect(
      dataOf(writes[0]),
      "an edit must not move the tombstone or rewrite createdAt"
    ).not.toHaveProperty("deletedAt");
    expect(dataOf(writes[0])).not.toHaveProperty("createdAt");
  });

  it("records what the number used to be, in the activity trail", async () => {
    // Without this a ledger line can be rewritten with nothing anywhere saying
    // it ever held a different figure — which is the state an auditor, and a
    // co-founder, cares about most.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    await updateTransactionAction(correctedAmount());

    const rows = callsTo("activity.create");
    expect(rows).toHaveLength(1);
    const data = dataOf(rows[0]);
    expect(data.type).toBe("transaction_edited");
    expect(data.companyId).toBe("c1");

    const meta = JSON.parse(String(data.metadata)) as Record<string, unknown>;
    expect(meta.amount, "the metadata must carry the NEW amount").toBe(5_000);
    expect(
      meta.previousAmount,
      "the metadata must carry the amount the row USED to hold — the message is " +
        "prose, the metadata is the record a reader can format at read time"
    ).toBe(5_000_000);
    // money-006: a figure in persisted prose is only as right as the currency
    // label written beside it, so the code travels with it.
    expect(meta.currency).toBe("PKR");
    expect(String(data.message)).toContain("5,000,000");
    expect(String(data.message)).toContain("PKR");
  });

  it("lets the category, date and description be corrected too", async () => {
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(
      correctedAmount({
        amount: 5_000_000,
        category: "Marketing",
        description: "June ad spend",
        date: "2026-06-01T00:00:00.000Z",
      })
    );
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const data = dataOf(callsTo("transaction.update")[0]);
    expect(data.category).toBe("Marketing");
    expect(data.description).toBe("June ad spend");
    expect((data.date as Date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("re-judges the budget threshold for the OLD and the NEW category", async () => {
    // finance-planning-005, from the edit side. The 100% alert was raised
    // against a month-to-date that this correction changes in two buckets: the
    // category the spend left and the one it arrived in.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    await updateTransactionAction(correctedAmount({ category: "Marketing" }));

    const seen = thresholdCalls.map((c) => String(c.category)).sort();
    expect(
      seen,
      "both months-to-date moved, so both have to be re-judged — otherwise the " +
        "old category's alert stays armed on spend that is no longer there"
    ).toEqual(["Marketing", "Salaries"]);
  });

  it("writes nothing when the submitted values match the row", async () => {
    // A save with no change must not append a meaningless audit row — an
    // activity trail nobody can read is the same cost as no trail.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount({ amount: 5_000_000 }));
    expect(res.success).toBe(true);
    expect(callsTo("transaction.update")).toHaveLength(0);
    expect(callsTo("activity.create")).toHaveLength(0);
  });

  it("refuses an amount with more precision than the column stores", async () => {
    // money-002: `numeric(12,2)` rounds to scale WITHOUT erroring, so 1234.567
    // would land as 1234.57 with nothing on screen saying the figure had been
    // changed. The correction path must not be the hole in that rule.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount({ amount: 1234.567 }));
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });

  it("refuses a category that belongs to a different ledger type", async () => {
    // "Product Sales" is a REVENUE category, and it passes the shared schema's
    // "is this any known category" check. Accepting it on an expense row files
    // spend under a money-in bucket, where no budget and no spend breakdown
    // would ever count it.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount({ category: "Product Sales" }));
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });

  it("refuses someone who is neither the creator nor an admin", async () => {
    signedInAs("cofounder", "u2");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Other", "PKR"));

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
    expect(callsTo("activity.create")).toHaveLength(0);
  });

  it("refuses a member, who cannot see finances at all", async () => {
    signedInAs("member");
    when("transaction.findUnique", aLiveExpense());
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });

  it("refuses a row belonging to another workspace", async () => {
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense({ companyId: "other-co" }));
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });

  it("refuses a tombstoned row", async () => {
    // A deleted row reads as gone everywhere else; editing one would resurrect
    // a figure into the ledger through a side door.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense({ deletedAt: new Date("2026-09-01") }));
    when("user.findUnique", actor("Saqib", "PKR"));

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });

  it("reports the recurring date clash as a message, not an unhandled throw", async () => {
    // `Transaction` carries `@@unique([ruleId, date])` as the idempotency key for
    // materialized recurring spend (cron-003), so moving a rule-generated row
    // onto another occurrence's day is the one correction Postgres itself
    // refuses. Unhandled, that leaves a server action throwing where the person
    // who typed the date sees only a generic failure.
    signedInAs("admin");
    when("transaction.findUnique", aLiveExpense({ ruleId: "r1" }));
    when("user.findUnique", actor("Saqib", "PKR"));
    when("transaction.update", () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    });

    const res = await updateTransactionAction(
      correctedAmount({ date: "2026-06-01T00:00:00.000Z" })
    );
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error).toMatch(/date/i);
  });

  it("refuses an anonymous caller", async () => {
    H.session.value = null;
    when("transaction.findUnique", aLiveExpense());

    const res = await updateTransactionAction(correctedAmount());
    expect(res.success).toBe(false);
    expect(callsTo("transaction.update")).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("the edited-transaction activity row is treated as a money row", () => {
  it("is listed in the export route's finance activity types", () => {
    // app/api/export/route.ts strips finance activity rows for an exporter who
    // cannot see finances. The edit row quotes two figures, so leaving it off
    // that list would hand a member the amounts every other finance row hides.
    const src = readFileSync(path.join(process.cwd(), "app", "api", "export", "route.ts"), "utf8");
    const start = src.indexOf("const FINANCE_ACTIVITY_TYPES");
    expect(start, "FINANCE_ACTIVITY_TYPES not found").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("];", start));
    expect(body).toContain("transaction_edited");
  });
});
