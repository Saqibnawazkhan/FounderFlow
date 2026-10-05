// @vitest-environment node

/**
 * finance-planning-011 — "One active budget per category per project".
 *
 * That sentence is the invariant `prisma/schema.prisma` (model Budget) states,
 * and it was enforced in exactly ONE place: `createBudgetAction`'s
 * duplicate-category probe. `updateBudgetAction` wrote `active: true` with no
 * re-check, so the ordinary replace-a-cap workflow broke it with three clicks:
 *
 *   pause Marketing/Alpha (10,000)  →  the category is pickable again, because
 *   the New-budget form builds `takenCategories` from ACTIVE caps only  →
 *   create Marketing/Alpha (20,000) →  resume the first one.
 *
 * Two active Marketing caps on Alpha. And `lib/budgets/check.ts` read the cap
 * to evaluate with a bare `findFirst` and NO `orderBy`, so which of the two
 * governed the project's alerting was whatever order Postgres happened to
 * return — the other cap could never fire at all. A workspace could believe a
 * 10,000 cap was in force while the 20,000 row was the one being evaluated, and
 * nothing on screen said which. Silent under-alerting on money.
 *
 * TWO SUITES IN ONE FILE because they are two halves of one invariant and only
 * mean something together. The guard stops NEW duplicates; the ordering decides
 * what the rows that already exist in a customer's database do, and no action
 * layer can retroactively de-duplicate those. Fix one and the finding stays
 * open.
 *
 * WHY THE SECOND SUITE PINS THE *STRICTEST* CAP. Once two caps exist, one of
 * them is going to be ignored, and the choice is which way to be wrong. The
 * lowest cap crosses its thresholds first, so picking it can only ever notify
 * EARLIER than the customer expects; picking the highest is the silent
 * under-alerting the finding is about. Noise beats silence where money is
 * concerned. Ties fall to the oldest row, then to the id, so the pick is a
 * total order and the figures in a notification are reproducible.
 *
 * WHAT IS NOT MOCKED: `decideThreshold` / `decideRearm` (lib/budgets/threshold),
 * `canManageProject` and `canSeeProjectFinances` are the real predicates, and
 * the fake Prisma client below really filters and really sorts. Stubbing
 * `budget.findFirst` with a canned row — the shape the other budget tests use —
 * cannot express this finding at all: the defect IS which row comes back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* A fake Prisma client that honours `where` and `orderBy` for Budget          */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const SUPERVISOR_ID = "u_admin";

  type Row = Record<string, unknown>;

  const calls: Array<{ path: string; args: Row }> = [];
  /** The Budget table. Array ORDER is "whatever Postgres hands back". */
  const budgets: Row[] = [];
  const canned = new Map<string, unknown>();
  const errors: unknown[] = [];
  const revalidated: string[] = [];
  const session = { value: null as unknown };

  /**
   * Scalar equality plus `{ not: x }` — the only operators the three Budget
   * lookups under test use. Anything else THROWS rather than being ignored: a
   * filter this fake silently dropped would make every row match and turn a
   * scoping bug into a green test.
   */
  function matchesWhere(row: Row, where: Row): boolean {
    const entries = Object.entries(where);
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const cond = entries[i][1];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const keys = Object.keys(cond as Row);
        if (keys.length !== 1 || keys[0] !== "not") {
          throw new Error(`fake db: unsupported filter on "${key}": ${JSON.stringify(cond)}`);
        }
        if (row[key] === (cond as { not: unknown }).not) return false;
      } else if (row[key] !== cond) {
        return false;
      }
    }
    return true;
  }

  /** Decimal stand-ins and Dates both have to be comparable. */
  function sortKey(v: unknown): number | string {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { toNumber?: unknown }).toNumber === "function"
    ) {
      return (v as { toNumber: () => number }).toNumber();
    }
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    return String(v);
  }

  function compare(a: unknown, b: unknown): number {
    const x = sortKey(a);
    const y = sortKey(b);
    if (typeof x === "number" && typeof y === "number") return x === y ? 0 : x < y ? -1 : 1;
    const sx = String(x);
    const sy = String(y);
    return sx === sy ? 0 : sx < sy ? -1 : 1;
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    // No orderBy → insertion order. That is the whole point: an unordered
    // `findFirst` returns an arbitrary row, and this fake makes "arbitrary"
    // concrete and repeatable instead of untestable.
    if (!orderBy) return rows;
    const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return rows.slice().sort((a, b) => {
      for (let i = 0; i < terms.length; i++) {
        const pair = Object.entries(terms[i])[0];
        if (!pair) continue;
        const c = compare(a[pair[0]], b[pair[0]]);
        if (c !== 0) return pair[1] === "desc" ? -c : c;
      }
      return 0;
    });
  }

  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "aggregate",
  ];

  const db: Record<string, unknown> = {};
  // An explicit model list, not a blanket Proxy: an action that starts reading
  // a NEW table fails loudly here instead of recording nothing and passing.
  const MODELS = ["transaction", "project", "company", "task", "user", "notification"];
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    const delegate: Record<string, (args?: Row) => Promise<unknown>> = {};
    for (let o = 0; o < OPS.length; o++) {
      const op = OPS[o];
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Row) => {
        calls.push({ path, args: args ?? {} });
        return canned.has(path) ? canned.get(path) : null;
      };
    }
    db[model] = delegate;
  }

  db.budget = {
    findFirst: async (args: Row = {}) => {
      calls.push({ path: "budget.findFirst", args });
      const where = (args.where ?? {}) as Row;
      const hits = sortRows(
        budgets.filter((r) => matchesWhere(r, where)),
        args.orderBy
      );
      return hits.length > 0 ? hits[0] : null;
    },
    findUnique: async (args: Row = {}) => {
      calls.push({ path: "budget.findUnique", args });
      const where = (args.where ?? {}) as Row;
      const row = budgets.filter((r) => matchesWhere(r, where))[0];
      if (!row) return null;
      // The action asks for the owning project in the same include.
      return { ...row, project: { id: row.projectId, supervisorId: SUPERVISOR_ID } };
    },
    update: async (args: Row = {}) => {
      calls.push({ path: "budget.update", args });
      const id = (args.where as Row | undefined)?.id;
      const row = budgets.filter((r) => r.id === id)[0];
      if (row) Object.assign(row, (args.data ?? {}) as Row);
      return row ?? null;
    },
    updateMany: async (args: Row = {}) => {
      calls.push({ path: "budget.updateMany", args });
      // The month-sentinel claim in check.ts — always won here; the race is
      // tests/lib/auth/finance-gate.test.ts's subject, not this file's.
      return { count: 1 };
    },
  };

  db.$transaction = async (arg: unknown) => {
    calls.push({ path: "$transaction", args: {} });
    return typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  };

  return { db, calls, budgets, canned, errors, revalidated, session, SUPERVISOR_ID };
});

const notify = vi.hoisted(() => ({
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 0 })),
}));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    H.revalidated.push(p);
  },
}));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));

import { updateBudgetAction } from "@/lib/actions/budgets";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";

/* ─────────────────────────────── fixtures ────────────────────────────────── */

/** A `Prisma.Decimal` stand-in — only `.toNumber()` is ever called on it. */
function decimal(n: number) {
  return { toNumber: () => n };
}

function cap(over: Partial<Record<string, unknown>> & { id: string }) {
  return {
    companyId: "c1",
    projectId: "p-alpha",
    category: "Marketing",
    monthlyLimit: decimal(10_000),
    createdBy: H.SUPERVISOR_ID,
    createdByName: "Ayesha",
    active: true,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
    ...over,
  };
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function rowById(id: string): Record<string, unknown> {
  const row = H.budgets.filter((b) => b.id === id)[0];
  if (!row) throw new Error(`no fake Budget row with id ${id}`);
  return row;
}

beforeEach(() => {
  H.calls.length = 0;
  H.budgets.length = 0;
  H.errors.length = 0;
  H.revalidated.length = 0;
  H.canned.clear();
  notify.notifyUsers.mockClear();
  H.session.value = { user: { id: H.SUPERVISOR_ID, companyId: "c1", role: "admin" } };

  // Everything check.ts needs AFTER it has chosen a budget.
  H.canned.set("transaction.aggregate", { _sum: { amount: decimal(15_000) } });
  H.canned.set("project.findUnique", {
    id: "p-alpha",
    name: "Alpha",
    supervisorId: H.SUPERVISOR_ID,
  });
  H.canned.set("company.findUnique", { currency: "PKR" });
  H.canned.set("task.findMany", []);
  H.canned.set("user.findMany", [{ id: H.SUPERVISOR_ID, role: "admin" }]);
});

/* ─────────────────── 1. the guard: resuming cannot duplicate ─────────────── */

describe("updateBudgetAction — resuming a cap cannot leave two active for one category", () => {
  it("refuses the resume when that category is already capped in that project", async () => {
    H.budgets.push(cap({ id: "b-old", active: false, monthlyLimit: decimal(10_000) }));
    H.budgets.push(cap({ id: "b-new", active: true, monthlyLimit: decimal(20_000) }));

    const res = await updateBudgetAction({ budgetId: "b-old", active: true });

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(false);
    // The message has to name the category: the user is looking at a list of
    // cards and has to know which one to pause.
    expect(res.success === false ? res.error : "").toContain("Marketing");
    // Nothing written — the row is still paused.
    expect(callsTo("budget.update")).toHaveLength(0);
    expect(rowById("b-old").active).toBe(false);
  });

  it("resumes normally once the replacement has been paused or deleted", async () => {
    H.budgets.push(cap({ id: "b-old", active: false }));

    const res = await updateBudgetAction({ budgetId: "b-old", active: true });

    expect(res.success).toBe(true);
    expect(rowById("b-old").active).toBe(true);
  });

  it("is not blocked by the same category capped in ANOTHER project", async () => {
    // Per-project budgeting is the point of Budget.projectId (money-018).
    H.budgets.push(cap({ id: "b-old", active: false, projectId: "p-alpha" }));
    H.budgets.push(cap({ id: "b-beta", active: true, projectId: "p-beta" }));

    const res = await updateBudgetAction({ budgetId: "b-old", active: true });

    expect(res.success).toBe(true);
    expect(rowById("b-old").active).toBe(true);
  });

  it("is not blocked by a tombstoned duplicate", async () => {
    // A deleted budget KEEPS active:true so a restore comes back in the state
    // it left (see createBudgetAction's probe). Reading it as live would lock
    // the category out of the project forever.
    H.budgets.push(cap({ id: "b-old", active: false }));
    H.budgets.push(
      cap({ id: "b-dead", active: true, deletedAt: new Date("2026-09-20T00:00:00Z") })
    );

    const res = await updateBudgetAction({ budgetId: "b-old", active: true });

    expect(res.success).toBe(true);
    expect(rowById("b-old").active).toBe(true);
  });

  it("asks the question only on the way to active — pausing is never refused", async () => {
    H.budgets.push(cap({ id: "b-old", active: true }));
    H.budgets.push(cap({ id: "b-new", active: true, monthlyLimit: decimal(20_000) }));

    const res = await updateBudgetAction({ budgetId: "b-old", active: false });

    expect(res.success).toBe(true);
    expect(rowById("b-old").active).toBe(false);
    expect(callsTo("budget.findFirst")).toHaveLength(0);
  });

  it("never blocks an ordinary cap edit, even on a workspace that already has two", async () => {
    // The pre-existing duplicates in a real database cannot be un-created by
    // this guard. Refusing to edit either of them would strand the customer
    // with the exact rows they need to correct.
    H.budgets.push(cap({ id: "b-old", active: true }));
    H.budgets.push(cap({ id: "b-new", active: true, monthlyLimit: decimal(20_000) }));

    const res = await updateBudgetAction({ budgetId: "b-old", monthlyLimit: 12_000 });

    expect(res.success).toBe(true);
    expect(callsTo("budget.findFirst")).toHaveLength(0);
    expect(callsTo("budget.update")[0]).toMatchObject({ data: { monthlyLimit: 12_000 } });
  });

  it("scopes the probe to project + category + live + active, excluding itself", async () => {
    H.budgets.push(cap({ id: "b-old", active: false }));

    await updateBudgetAction({ budgetId: "b-old", active: true });

    const probe = (callsTo("budget.findFirst")[0]?.where ?? {}) as Record<string, unknown>;
    expect(probe).toMatchObject({
      projectId: "p-alpha",
      category: "Marketing",
      active: true,
      deletedAt: null,
      // Belt and braces: the row is still paused on disk at this point, so
      // `active: true` already excludes it. The id clause keeps the probe
      // correct if the "only on the transition" gate is ever relaxed.
      id: { not: "b-old" },
    });
  });
});

/* ──────────── 2. the ordering: duplicates that already exist ────────────── */

describe("checkBudgetThresholdAfterExpense — the strictest cap decides, whatever the row order", () => {
  /** 15,000 spent. Over the 10,000 cap (alert); only 75% of the 20,000 one. */
  function twoActiveCaps(order: "strict-last" | "strict-first") {
    const strict = cap({ id: "b-strict", monthlyLimit: decimal(10_000) });
    const loose = cap({
      id: "b-loose",
      monthlyLimit: decimal(20_000),
      createdAt: new Date("2026-09-15T00:00:00Z"),
    });
    if (order === "strict-first") H.budgets.push(strict, loose);
    else H.budgets.push(loose, strict);
  }

  async function run() {
    await checkBudgetThresholdAfterExpense({
      companyId: "c1",
      projectId: "p-alpha",
      category: "Marketing",
    });
    // check.ts swallows everything it throws, by design — a budget-check crash
    // must never roll back somebody's expense. So a fake answering wrongly
    // would read as "no notification" and pass for the wrong reason.
    expect(H.errors).toEqual([]);
  }

  function fannedOut() {
    expect(notify.notifyUsers).toHaveBeenCalledTimes(1);
    return notify.notifyUsers.mock.calls[0][0] as unknown as {
      userIds: string[];
      title: string;
      message: string;
      tone: string;
    };
  }

  it("alerts on the 10,000 cap when Postgres hands back the 20,000 row first", async () => {
    twoActiveCaps("strict-last");

    await run();

    const sent = fannedOut();
    expect(sent.tone).toBe("danger");
    expect(sent.message).toContain("10,000");
    expect(sent.message).not.toContain("20,000");
    // The month sentinel is stamped on the row that actually fired.
    expect(callsTo("budget.updateMany")[0]).toMatchObject({ where: { id: "b-strict" } });
  });

  it("alerts on the same cap when the rows come back the other way round", async () => {
    twoActiveCaps("strict-first");

    await run();

    const sent = fannedOut();
    expect(sent.message).toContain("10,000");
    expect(callsTo("budget.updateMany")[0]).toMatchObject({ where: { id: "b-strict" } });
  });

  it("still reads one cap for the ordinary single-budget project", async () => {
    H.budgets.push(cap({ id: "b-only", monthlyLimit: decimal(10_000) }));

    await run();

    expect(fannedOut().message).toContain("10,000");
  });

  it("ignores a paused or tombstoned row when choosing", async () => {
    // A 1,000 cap would fire first if either filter were dropped by the
    // ordering change.
    H.budgets.push(cap({ id: "b-paused", active: false, monthlyLimit: decimal(1_000) }));
    H.budgets.push(
      cap({
        id: "b-dead",
        monthlyLimit: decimal(2_000),
        deletedAt: new Date("2026-09-20T00:00:00Z"),
      })
    );
    H.budgets.push(cap({ id: "b-live", monthlyLimit: decimal(10_000) }));

    await run();

    expect(fannedOut().message).toContain("10,000");
    expect(callsTo("budget.updateMany")[0]).toMatchObject({ where: { id: "b-live" } });
  });

  it("breaks a tie on equal caps by the older row, so the pick is a total order", async () => {
    const older = cap({
      id: "b-zz-older",
      monthlyLimit: decimal(10_000),
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const newer = cap({
      id: "b-aa-newer",
      monthlyLimit: decimal(10_000),
      createdAt: new Date("2026-09-15T00:00:00Z"),
    });
    H.budgets.push(newer, older);

    await run();

    expect(callsTo("budget.updateMany")[0]).toMatchObject({ where: { id: "b-zz-older" } });
  });
});
