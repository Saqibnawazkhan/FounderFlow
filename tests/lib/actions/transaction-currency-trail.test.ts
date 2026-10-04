/**
 * transactions-ledger-006 — the PERSISTED half: every sentence a ledger write
 * leaves behind must name the workspace's own currency.
 *
 * WHAT THE FILING CLAIMED, AND WHAT SURVIVED IT. The finding listed six places
 * a non-PKR workspace was told its money was rupees. Five were already closed by
 * the time it was worked:
 *
 *   • `components/transactions/transaction-form.tsx` — the "Amount (PKR)" label
 *     and the in-input "PKR" affix, both now `useCurrency()` (money-011, pinned
 *     by tests/components/money-input-currency-labels.test.tsx). Closed as a
 *     LITERAL; the value it read still arrived too late, so a USD workspace went
 *     on reading "Amount (PKR)" until CompanyHydrator's round-trip landed. That
 *     half was fixed afterwards by passing `Company.currency` down from the three
 *     finance Server Components, and the last two describes in that same file
 *     pin it;
 *   • `app/(app)/expenses/page.tsx` — the "Track every PKR going out"
 *     description, now currency-free (pinned by
 *     tests/app/page-metadata-currency.test.ts);
 *   • and the server-side strings this file is about, which
 *     `addTransactionAction` / `updateTransactionAction` /
 *     `deleteTransactionAction` now build from `Company.currency` (money-006).
 *
 * WHY THIS FILE EXISTS ANYWAY. Nothing pinned that last group for a workspace
 * whose currency is not the default. The only currency assertions reaching these
 * actions were in tests/lib/actions/transaction-edit.test.ts, and they fixture a
 * PKR company — so they pass identically against the hardcoded `" PKR"` the
 * finding describes and against the fix. A test that cannot tell the bug from
 * the fix is this repo's most-repeated defect, and these strings are the
 * expensive ones to regress:
 *
 *   • `Activity.message` is prose written ONCE and read by the whole workspace
 *     forever. No later code change repairs a row that says PKR — the read-time
 *     reformatter (lib/activity/message.ts) can only re-render a figure whose
 *     metadata already carries the right code;
 *   • the notification body LEAVES THE APP verbatim as an email subject and a
 *     lock-screen push (lib/notify/fan-out.ts), so a wrong code there is read by
 *     someone who cannot click through to check it.
 *
 * BOTH WAYS ROUND. A PKR workspace must still read PKR. Swapping one hardcoded
 * code for another would satisfy a USD-only test and ship the same defect to
 * five of the six currencies in lib/schemas/company.ts, so the default is
 * asserted from the same fixtures.
 *
 * The fake Prisma client is the recorder shape used by
 * tests/lib/actions/transaction-edit.test.ts and
 * tests/lib/actions/soft-delete.test.ts: the question is which arguments the
 * action writes, which a `success` assertion cannot answer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["transaction", "project", "user", "activity", "notification"];
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

  /** Every `notifyUsers` input, so the body that leaves the app is assertable. */
  const notified: Array<Record<string, unknown>> = [];

  return { db, calls, results, notified, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/budgets/check", () => ({ checkBudgetThresholdAfterExpense: async () => {} }));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async (input: Record<string, unknown>) => {
    H.notified.push(input);
    return { notified: 1, dispatched: 1 };
  },
}));

import {
  addTransactionAction,
  deleteTransactionAction,
  updateTransactionAction,
} from "@/lib/actions/transactions";

/* ───────────────────────────────── helpers ──────────────────────────────── */

function when(p: string, value: unknown): void {
  H.results.set(p, value);
}

function dataOf(p: string): Record<string, unknown> {
  const call = H.calls.find((c) => c.path === p);
  return (call?.args.data ?? {}) as Record<string, unknown>;
}

/** Stand-in for `Prisma.Decimal` — the action reads `.toNumber()` off the row. */
function money(n: number): unknown {
  return { toNumber: () => n, toString: () => String(n) };
}

/**
 * A workspace keeping its books in `currency`, with one teammate to notify.
 *
 * The whole fixture is parameterised on the currency and nothing else, so the
 * USD case and the PKR case below are provably the same code path asked the
 * same question — which is what makes the PKR assertion evidence rather than
 * decoration.
 */
function workspaceIn(currency: string): void {
  H.session.value = { user: { id: "u1", companyId: "c1", role: "admin" } };
  when("user.findUnique", { id: "u1", name: "Ayesha Khan", company: { currency } });
  // The other LIVE members, for the notification fan-out.
  when("user.findMany", [{ id: "u2" }]);
  when("transaction.create", {
    id: "t1",
    companyId: "c1",
    type: "expense",
    amount: money(12_345),
    category: "Marketing",
    description: "Q3 ad spend",
    date: new Date("2026-09-30T00:00:00.000Z"),
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
  });
  // The row the delete path tombstones.
  when("transaction.findUnique", {
    id: "t1",
    companyId: "c1",
    projectId: null,
    type: "expense",
    amount: money(12_345),
    category: "Marketing",
    description: "Q3 ad spend",
    date: new Date("2026-09-30T00:00:00.000Z"),
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
    deletedAt: null,
  });
}

function anExpense() {
  return {
    type: "expense",
    amount: 12_345,
    category: "Marketing",
    description: "Q3 ad spend",
    date: "2026-09-30T00:00:00.000Z",
    projectId: "",
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.notified.length = 0;
  H.results.clear();
  H.session.value = null;
});

/* ───────────────────────────────── the tests ────────────────────────────── */

describe("the audit trail a ledger write leaves names the workspace's currency", () => {
  it("writes the activity row for a USD workspace in USD, not PKR", async () => {
    workspaceIn("USD");

    const res = await addTransactionAction(anExpense());
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const message = String(dataOf("activity.create").message);
    expect(
      message,
      "Activity.message is prose written once and read by the workspace forever, " +
        "so the figure has to be labelled with the currency the books are kept in"
    ).toContain("12,345.00 USD");
    expect(
      message,
      `a USD workspace's permanent audit trail must not say PKR — got: ${message}`
    ).not.toContain("PKR");
  });

  it("carries the same code in the activity metadata, for the read-time renderer", async () => {
    // lib/activity/message.ts re-formats the figure at read time from this
    // metadata and deliberately never re-derives the code from the live company
    // (a workspace that switches currency must not have its history relabelled).
    // So a wrong code here is wrong forever, with nothing able to repair it.
    workspaceIn("USD");

    await addTransactionAction(anExpense());

    const meta = JSON.parse(String(dataOf("activity.create").metadata)) as Record<string, unknown>;
    expect(meta.currency).toBe("USD");
    expect(meta.amount).toBe(12_345);
  });

  it("sends the teammate a notification body in USD — it leaves the app verbatim", async () => {
    workspaceIn("USD");

    await addTransactionAction(anExpense());

    expect(H.notified, "every other live member is notified of a new expense").toHaveLength(1);
    const body = String(H.notified[0].message);
    expect(body).toContain("12,345.00 USD");
    expect(
      body,
      "this string is the email subject and the lock-screen push, read by " +
        `someone who cannot click through to check it — got: ${body}`
    ).not.toContain("PKR");
  });

  it("records the DELETION in USD too", async () => {
    workspaceIn("USD");

    const res = await deleteTransactionAction("t1");
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const message = String(dataOf("activity.create").message);
    expect(message).toContain("12,345.00 USD");
    expect(
      message,
      `the deletion is the other permanent record of the figure — got: ${message}`
    ).not.toContain("PKR");

    const meta = JSON.parse(String(dataOf("activity.create").metadata)) as Record<string, unknown>;
    expect(meta.currency).toBe("USD");
  });

  it("records a CORRECTION in USD — both the old figure and the new one", async () => {
    // The third write path, and the one the suite could not tell the bug from the
    // fix on: the only currency assertions reaching `updateTransactionAction`
    // live in tests/lib/actions/transaction-edit.test.ts, which fixtures
    // `company: { currency: "PKR" }` — so they pass identically against the
    // hardcoded `" PKR"` the filing describes. A correction writes the same
    // permanent prose as an add and a delete, and it writes TWO figures into it.
    workspaceIn("USD");

    const res = await updateTransactionAction({
      id: "t1",
      amount: 9_000,
      category: "Marketing",
      description: "Q3 ad spend",
      date: "2026-09-30T00:00:00.000Z",
    });
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const message = String(dataOf("activity.create").message);
    expect(message).toContain("12,345.00 USD");
    expect(message).toContain("9,000.00 USD");
    expect(
      message,
      `a correction is as permanent as the entry it corrects — got: ${message}`
    ).not.toContain("PKR");

    const meta = JSON.parse(String(dataOf("activity.create").metadata)) as Record<string, unknown>;
    expect(meta.currency).toBe("USD");
    // The durable pair the read-time renderer works from, so a figure labelled
    // once can still be re-rendered rather than re-derived.
    expect(meta.previousAmount).toBe(12_345);
    expect(meta.amount).toBe(9_000);
  });

  it("still reads PKR for a PKR workspace — the default is a workspace, not a constant", async () => {
    // The guard against "fixing" this by hardcoding a different code. PKR is one
    // of six legal values (lib/schemas/company.ts), not the absence of a value.
    workspaceIn("PKR");

    await addTransactionAction(anExpense());

    const message = String(dataOf("activity.create").message);
    expect(message).toContain("12,345.00 PKR");
    expect(message).not.toContain("USD");

    const body = String(H.notified[0].message);
    expect(body).toContain("12,345.00 PKR");
  });
});
