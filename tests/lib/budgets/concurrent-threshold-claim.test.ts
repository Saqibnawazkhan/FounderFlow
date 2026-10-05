// @vitest-environment node

/**
 * finance-planning-017 — the month-sentinel claim in `lib/budgets/check.ts` is
 * optimistic concurrency, and it over-pinned.
 *
 * The claim exists so two expenses landing on the same budget in the same moment
 * cannot both email ("once per threshold, not once per transaction"). It pins the
 * sentinel state the pass observed in its WHERE, so the loser's update matches
 * zero rows and it sends nothing. That part works and is not changed here.
 *
 * What it also did was pin `lastWarnedMonth` on the ALERT path, a column the
 * alert decision never reads (`decideThreshold`'s alert branch consults only
 * `lastAlertedMonth` — threshold.ts). So, on a 1,000 cap with two 850 expenses
 * landing together:
 *
 *   • pass W reads 850  → 85%  → `warning`, sentinels {null, null}
 *   • pass A reads 1,700 → 170% → `alert`,  sentinels {null, null}
 *   • W commits first. The row is now {lastWarnedMonth: mk, lastAlertedMonth: null}.
 *   • A's WHERE still pins {null, null} → zero rows → A returns having sent
 *     NOTHING, and `lastAlertedMonth` is never set.
 *
 * A budget that is 70% over its cap announced itself as "at 85%". The re-arm pass
 * cannot rescue it (at 170% `decideRearm` returns null), and the next expense on
 * that budget would fire the alert — but if nothing more is spent on that cap that
 * month, the over-budget notification is never sent at all. Under-alerting on
 * money, in exactly the race the sentinel scheme was written for.
 *
 * THE CONTRACT THESE TESTS STATE: a race must end where the equivalent serial
 * sequence ends. Spend crossing 80% and then 100% sends both messages; spend
 * arriving already over the cap sends only the alert; and two passes that reach
 * the same threshold together still send it once. The claim must pin exactly the
 * sentinels its own decision depended on — no more, no less.
 *
 * WHAT IS NOT MOCKED: `decideThreshold` / `decideRearm` / `monthKey` are the real
 * functions, and the fake `budget.updateMany` below really evaluates its WHERE
 * against a mutable row and really reports `count: 0` when it matches nothing.
 * The other budget tests stub that claim with a canned `{ count: 1 }` — which
 * cannot express this finding at all, because the defect IS the predicate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* A fake Prisma client whose Budget row is REAL state                        */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const SUPERVISOR_ID = "u_admin";

  /** The one Budget row. `updateMany` mutates it, like a real one. */
  const row: Row = {};
  const canned = new Map<string, unknown>();
  const errors: unknown[] = [];
  /** Every WHERE the sentinel claim was attempted with, in order. */
  const claims: Array<{ where: Row; data: Row; count: number }> = [];

  /**
   * Scalar equality, `null` included — the only operator the claim uses.
   * Anything richer THROWS rather than being ignored: a filter this fake
   * silently dropped would make every claim win and turn this finding green.
   */
  function matches(where: Row): boolean {
    const entries = Object.entries(where);
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const want = entries[i][1];
      if (want !== null && typeof want === "object") {
        throw new Error(`fake db: unsupported filter on "${key}": ${JSON.stringify(want)}`);
      }
      if (row[key] !== want) return false;
    }
    return true;
  }

  /** Lets one pass be held INSIDE `$transaction`, just before it claims. */
  const gate = {
    armed: false,
    reached: null as null | (() => void),
    release: null as null | (() => void),
    waitUntilReached: Promise.resolve(),
  };
  function arm() {
    gate.armed = true;
    gate.waitUntilReached = new Promise<void>((res) => {
      gate.reached = res;
    });
    const blocker = new Promise<void>((res) => {
      gate.release = res;
    });
    return blocker;
  }
  let held: Promise<void> = Promise.resolve();

  const db: Record<string, unknown> = {};
  // An explicit model list, not a blanket Proxy: a read of a NEW table fails
  // loudly here instead of returning nothing and passing for the wrong reason.
  const MODELS = ["transaction", "project", "company", "task", "user"];
  const OPS = ["findUnique", "findFirst", "findMany", "aggregate"];
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    const delegate: Record<string, (args?: Row) => Promise<unknown>> = {};
    for (let o = 0; o < OPS.length; o++) {
      const op = OPS[o];
      const path = `${model}.${op}`;
      delegate[op] = async () => (canned.has(path) ? canned.get(path) : null);
    }
    db[model] = delegate;
  }

  db.budget = {
    // A SNAPSHOT, like a real read: the pass that reads first must not see the
    // other pass's write appear in the object it is holding.
    findFirst: async () => ({ ...row }),
    updateMany: async (args: Row = {}) => {
      const where = (args.where ?? {}) as Row;
      const data = (args.data ?? {}) as Row;
      const hit = matches(where);
      if (hit) Object.assign(row, data);
      claims.push({ where, data, count: hit ? 1 : 0 });
      return { count: hit ? 1 : 0 };
    },
  };

  db.$transaction = async (arg: unknown) => {
    if (gate.armed) {
      gate.armed = false;
      if (gate.reached) gate.reached();
      await held;
    }
    return typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  };

  return {
    db,
    row,
    canned,
    errors,
    claims,
    SUPERVISOR_ID,
    holdNextTransaction() {
      held = arm();
      return gate.waitUntilReached;
    },
    releaseHeldTransaction() {
      if (gate.release) gate.release();
    },
  };
});

const notify = vi.hoisted(() => ({
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 1 })),
}));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));

import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { monthKey } from "@/lib/budgets/threshold";

/* ─────────────────────────────── fixtures ────────────────────────────────── */

/** A `Prisma.Decimal` stand-in — only `.toNumber()` is ever called on it. */
function decimal(n: number) {
  return { toNumber: () => n };
}

/** 1,000 cap, nothing fired yet this month. */
function resetRow() {
  const keys = Object.keys(H.row);
  for (let i = 0; i < keys.length; i++) delete H.row[keys[i]];
  Object.assign(H.row, {
    id: "b-marketing",
    companyId: "c1",
    projectId: "p-alpha",
    category: "Marketing",
    monthlyLimit: decimal(1_000),
    active: true,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
  });
}

/** What the next pass's aggregate will see as month-to-date spend. */
function spendSoFar(amount: number) {
  H.canned.set("transaction.aggregate", { _sum: { amount: decimal(amount) } });
}

function runPass() {
  return checkBudgetThresholdAfterExpense({
    companyId: "c1",
    projectId: "p-alpha",
    category: "Marketing",
  });
}

/** Every notifyUsers call, flattened to the two fields that identify it. */
function sent(): Array<{ tone: unknown; title: unknown }> {
  return notify.notifyUsers.mock.calls.map((c) => {
    const input = c[0] as { tone?: unknown; title?: unknown };
    return { tone: input.tone, title: input.title };
  });
}

beforeEach(() => {
  resetRow();
  H.claims.length = 0;
  H.errors.length = 0;
  notify.notifyUsers.mockClear();
  H.canned.clear();
  H.canned.set("project.findUnique", {
    id: "p-alpha",
    name: "Alpha",
    supervisorId: H.SUPERVISOR_ID,
  });
  H.canned.set("company.findUnique", { currency: "PKR" });
  H.canned.set("task.findMany", []);
  H.canned.set("user.findMany", [{ id: H.SUPERVISOR_ID, role: "admin" }]);
});

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe("finance-planning-017 — concurrent expenses cannot swallow the over-cap alert", () => {
  it("still sends the alert when a concurrent 80% warning claims first", async () => {
    // Two 850s land on a 1,000 cap at the same moment.
    spendSoFar(1_700);
    const alertPass = runPass(); // 170% → alert
    await H.holdNextTransaction(); // …held just before it claims

    spendSoFar(850);
    await runPass(); // 85% → warning, claims and fans out

    H.releaseHeldTransaction();
    await alertPass;

    expect(H.errors).toEqual([]);

    const tones = sent().map((s) => s.tone);
    // The news is that the cap is BLOWN. "At 85%" understates it, and on the
    // broken claim it was the only thing the customer ever heard.
    expect(
      tones,
      "the over-cap alert was dropped: the warning pass's claim moved " +
        "lastWarnedMonth, and the alert pass pinned that column even though its " +
        "decision never reads it"
    ).toContain("danger");
    const alert = sent().filter((s) => s.tone === "danger")[0];
    expect(String(alert?.title)).toContain("Budget exceeded");

    // And the sentinel is set, so the alert is not re-sent on the next expense.
    expect(
      H.row.lastAlertedMonth,
      "lastAlertedMonth was never set, so nothing recorded that the over-cap " +
        "alert is owed — if no further expense lands this month it is never sent"
    ).toBe(monthKey(new Date()));
    expect(H.row.lastWarnedMonth).toBe(H.row.lastAlertedMonth);

    // Exactly the serial outcome: 80% crossed, then 100% crossed. One of each.
    expect(tones.filter((t) => t === "danger")).toHaveLength(1);
    expect(tones.filter((t) => t === "warning")).toHaveLength(1);
  });

  it("drops the warning when the concurrent alert claims first", async () => {
    // The mirror image, and the behaviour the claim already got right: once the
    // cap is known to be blown, "at 85%" is stale news. Serial equivalent: the
    // 1,700 read lands first, so the 850 pass finds lastWarnedMonth already set.
    spendSoFar(850);
    const warnPass = runPass(); // 85% → warning
    await H.holdNextTransaction();

    spendSoFar(1_700);
    await runPass(); // 170% → alert, claims both sentinels

    H.releaseHeldTransaction();
    await warnPass;

    expect(H.errors).toEqual([]);
    expect(sent().map((s) => s.tone)).toEqual(["danger"]);
    expect(H.row.lastAlertedMonth).toBe(monthKey(new Date()));
    expect(H.row.lastWarnedMonth).toBe(monthKey(new Date()));
  });

  it("still alerts ONCE when both concurrent passes decide alert", async () => {
    // The duplicate-email race the claim was written for. Loosening the alert
    // pin must not reopen it: an inbox and a lock screen, twice, for one state.
    spendSoFar(1_700);
    const first = runPass();
    await H.holdNextTransaction();

    spendSoFar(1_900);
    await runPass();

    H.releaseHeldTransaction();
    await first;

    expect(H.errors).toEqual([]);
    expect(sent().map((s) => s.tone)).toEqual(["danger"]);
    // One claim won, one matched zero rows and sent nothing.
    expect(H.claims.map((c) => c.count)).toEqual([1, 0]);
  });

  it("pins the sentinels each decision actually reads, and no others", async () => {
    // The shape of the fix, stated directly: the alert branch of
    // `decideThreshold` reads only `lastAlertedMonth`, so that is the only
    // column its claim may pin. The warning branch is bounded by
    // `pct < ALERT_PCT`, so it depends on — and must pin — both.
    spendSoFar(1_700);
    await runPass();
    expect(Object.keys(H.claims[0].where).sort()).toEqual(["id", "lastAlertedMonth"]);
    // Both columns are still WRITTEN on the alert path: an alert supersedes the
    // 80% message, so a later warning this month would be noise.
    expect(H.claims[0].data).toMatchObject({
      lastAlertedMonth: monthKey(new Date()),
      lastWarnedMonth: monthKey(new Date()),
    });

    resetRow();
    H.claims.length = 0;
    spendSoFar(850);
    await runPass();
    expect(Object.keys(H.claims[0].where).sort()).toEqual([
      "id",
      "lastAlertedMonth",
      "lastWarnedMonth",
    ]);
    expect(H.claims[0].data).toEqual({ lastWarnedMonth: monthKey(new Date()) });
  });
});
