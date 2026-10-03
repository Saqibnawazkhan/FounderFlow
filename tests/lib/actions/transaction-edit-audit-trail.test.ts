/**
 * R4-money-016-trail — the audit row has to say what actually changed, in
 * English, because it is written once and read forever.
 *
 * money-016 gave the ledger an edit path and an Activity row to go with it. Two
 * defects in the PROSE and the CHANGE DETECTION of that row survive the fix, and
 * both are permanent: `Activity.message` is a persisted string, so a sentence
 * that is wrong on the day it is written is wrong in the feed for good.
 *
 * ## 1. `dateChanged` compared INSTANTS where the product only has DAYS
 *
 * `Transaction.date` is a date-only value stored at UTC midnight (money-007),
 * and the edit form round-trips exactly that day: it fills the field from
 * `editing.date.slice(0, 10)` and submits `new Date(thatDay).toISOString()`
 * (components/transactions/transaction-form.tsx). So the day a customer sees is
 * the day they send back.
 *
 * The stored value, however, is not always midnight. The CSV importer parses
 * whatever the bank wrote — `new Date(rawDate)` in
 * components/transactions/import-transactions-modal.tsx — and `new
 * Date("6/1/2026")` is LOCAL midnight, which on a host west of UTC is
 * `2026-06-01T05:00:00.000Z`. For every imported row of that shape,
 * `txn.date.getTime() !== nextDate.getTime()` was TRUE while the day was
 * unchanged, so correcting only the amount published
 * `(also: date 2026-06-01 → 2026-06-01)`, and re-saving a row without changing
 * anything at all wrote a whole Activity entry claiming an edit that never
 * happened. An audit trail that invents changes is worse than none: it is the
 * record a founder reaches for when a figure is disputed.
 *
 * The fix is the comparison, not the write. The UPDATE still stores the
 * canonical UTC midnight for the submitted day — every reader buckets by UTC day
 * (lib/date-range.ts, lib/utils.ts `formatUtcDate`), so the ledger day does not
 * move and there is nothing for the trail to record.
 *
 * ## 2. "corrected a expense" / "edited a investment"
 *
 * The template was `a ${txnNoun(type)}` over a noun set of {expense, revenue,
 * investment}, so two of the three types produced ungrammatical prose — again,
 * into a persisted column.
 *
 * ## WHY THESE ASSERT ABSENCE AS WELL AS PRESENCE
 *
 * The defect is not a missing sentence, it is a present and confident wrong one,
 * so each case below names the string that must NOT appear. A test that only
 * checked "the message mentions the amount" stays green against both bugs.
 *
 * The fake Prisma client is the recorder shape from
 * tests/lib/actions/transaction-edit.test.ts: the question is which arguments
 * reach `activity.create`, which a `success` assertion cannot answer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["transaction", "user", "activity"];
  const OPS = ["findUnique", "create", "update"];

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
vi.mock("@/lib/budgets/check", () => ({ checkBudgetThresholdAfterExpense: async () => undefined }));

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

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

/** Stand-in for `Prisma.Decimal` — the action reads `.toNumber()` off the row. */
function money(n: number): unknown {
  return { toNumber: () => n, toLocaleString: () => n.toLocaleString("en-US") };
}

/** The one Activity row a correction writes, as prose. */
function auditMessage(): string {
  const written = callsTo("activity.create");
  expect(written.length, "a correction has to write exactly one activity row").toBe(1);
  return String(dataOf(written[0]).message);
}

/**
 * An IMPORTED expense: same ledger day the form shows (2026-06-01), but a
 * stored instant five hours into it, which is what the CSV importer produces
 * from a `6/1/2026` cell on a host west of UTC.
 */
function anImportedExpense(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    companyId: "c1",
    projectId: null,
    type: "expense",
    amount: money(5_000_000),
    category: "Salaries",
    description: "June payroll",
    date: new Date("2026-06-01T05:00:00.000Z"),
    addedBy: "u1",
    addedByName: "Saqib",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    deletedAt: null,
    ...over,
  };
}

/** What the edit form sends for that row: the same UTC day, at midnight. */
function asTheFormSendsIt(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    amount: 5_000,
    category: "Salaries",
    description: "June payroll",
    date: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "u1", companyId: "c1", role: "admin" } };
  when("user.findUnique", { id: "u1", name: "Saqib", company: { currency: "PKR" } });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("the audit row records the DAY, not the stored instant", () => {
  it("does not claim the date changed when only the amount did", async () => {
    when("transaction.findUnique", anImportedExpense());

    const res = await updateTransactionAction(asTheFormSendsIt());
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const message = auditMessage();
    expect(
      message,
      "the ledger day went 2026-06-01 → 2026-06-01; only the amount moved, so the " +
        "trail must not report a date change it can print as `date X → X`"
    ).not.toMatch(/\bdate\b/i);
    expect(message, "there is no `also:` clause to carry — nothing else changed").not.toContain(
      "also:"
    );
    expect(message).toContain("5,000,000");
  });

  it("writes nothing at all when the save changes nothing but the time of day", async () => {
    when("transaction.findUnique", anImportedExpense());

    // Same amount, same category, same description, same ledger day: a customer
    // who opened the edit modal and pressed Save.
    const res = await updateTransactionAction(asTheFormSendsIt({ amount: 5_000_000 }));
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    expect(
      callsTo("transaction.update"),
      "nothing the product can show changed, so there is nothing to write"
    ).toHaveLength(0);
    expect(
      callsTo("activity.create"),
      "an audit trail padded with rows that record no change is one nobody reads"
    ).toHaveLength(0);
  });

  it("still records a REAL day change (the fix must not silence the date)", async () => {
    when("transaction.findUnique", anImportedExpense());

    const res = await updateTransactionAction(
      asTheFormSendsIt({ amount: 5_000_000, date: "2026-06-02T00:00:00.000Z" })
    );
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    expect(auditMessage()).toContain("date 2026-06-01 → 2026-06-02");
  });

  it("stores the submitted day at UTC midnight, as every reader buckets it", async () => {
    when("transaction.findUnique", anImportedExpense());

    await updateTransactionAction(asTheFormSendsIt());

    const written = dataOf(callsTo("transaction.update")[0]);
    expect((written.date as Date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("the persisted prose is grammatical", () => {
  it('says "corrected an expense", never "a expense"', async () => {
    when("transaction.findUnique", anImportedExpense());

    await updateTransactionAction(asTheFormSendsIt());

    const message = auditMessage();
    expect(message).toContain("corrected an expense");
    expect(message, "written into Activity.message, so it is wrong forever").not.toMatch(
      /\ba (?:expense|investment)\b/
    );
  });

  it('says "corrected an investment", never "a investment"', async () => {
    when(
      "transaction.findUnique",
      anImportedExpense({ type: "investment", category: "Seed Capital" })
    );

    await updateTransactionAction(asTheFormSendsIt({ category: "Seed Capital" }));

    const message = auditMessage();
    expect(message).toContain("corrected an investment");
    expect(message).not.toMatch(/\ba (?:expense|investment)\b/);
  });

  it("gives revenue the count noun the finance pages use for the row", async () => {
    when(
      "transaction.findUnique",
      anImportedExpense({ type: "income", category: "Product Sales" })
    );

    await updateTransactionAction(asTheFormSendsIt({ category: "Product Sales" }));

    // "a revenue" is not English; /revenue calls the row a "revenue entry"
    // ("Delete this revenue entry?", "Revenue entry deleted"), so the feed does
    // too.
    expect(auditMessage()).toContain("corrected a revenue entry");
  });

  it('says "edited an expense" on the no-amount-change branch', async () => {
    when("transaction.findUnique", anImportedExpense());

    await updateTransactionAction(
      asTheFormSendsIt({ amount: 5_000_000, description: "June payroll (final)" })
    );

    const message = auditMessage();
    expect(message).toContain("edited an expense");
    expect(message).toContain("description");
    expect(message).not.toMatch(/\ba (?:expense|investment)\b/);
  });
});
