/**
 * Behavioural tests for /api/cron/materialize-recurring — the job that turns a
 * recurring rule into real money in a customer's ledger.
 *
 * WHY THESE RUN THE ROUTE INSTEAD OF READING ITS SOURCE. The sibling guards in
 * tests/lib/db/purge-invariants.test.ts and tests/lib/billing/webhook-route.test.ts
 * assert on route SOURCE TEXT, because importing a route used to mean
 * instantiating Prisma. It does not have to: `vi.mock("@/lib/db")` replaces the
 * client before the module graph is built, so the handler can be called for
 * real against an in-memory fake. Nothing here touches a database — there is no
 * PrismaClient in this file and no connection string is read.
 *
 * The fake is not a bag of spies. It models the two things the findings below
 * actually turn on:
 *   - the CLAIM: `updateMany({ where: { id, lastMaterializedAt: <token> } })`
 *     matches one row only while the stored value still equals the token, which
 *     is how Postgres behaves under READ COMMITTED once the first writer
 *     commits (cron-003);
 *   - ROLLBACK: a `$transaction` callback that throws leaves the rule row
 *     exactly as it was, which is what makes a failed night retryable instead
 *     of a permanently skipped month (cron-004);
 *   - and the UNIQUE (ruleId, date) index, so a double post shows up as a hard
 *     error here rather than as a quietly duplicated expense.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { RecurringRule } from "@prisma/client";

const SECRET = "cron-secret-for-tests";

/* ── the fake database ─────────────────────────────────────────────────── */

interface FakeTxnRow {
  ruleId: string | null;
  companyId: string;
  type: string;
  amount: number;
  category: string;
  description: string;
  date: Date;
  projectId: string | null;
}

interface FakeDb {
  recurringRule: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  transaction: { create: ReturnType<typeof vi.fn> };
  activity: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

/**
 * A rule row as the ROUTE loads it: the rule, plus the tombstone of the project
 * its `projectId` names and the tombstone of the USER who created it. The route
 * has to ask for both relations — a rule row on its own cannot say whether its
 * project still exists (R1-money-013-cron) or whether the person who set the
 * charge up is still at the company (finance-planning-013).
 */
type RuleRow = RecurringRule & {
  project?: { deletedAt: Date | null } | null;
  user?: { deletedAt: Date | null } | null;
};

interface Harness {
  db: FakeDb;
  /** Rows the run actually wrote, in order. */
  written: FakeTxnRow[];
  /** Live rule rows, so a test can read back lastMaterializedAt. */
  rows: Map<string, RuleRow>;
  /** Options each $transaction() was opened with. */
  txOptions: unknown[];
}

let harness: Harness;

function buildHarness(
  rules: RuleRow[],
  opts: { failCreateForRule?: string; staleReads?: boolean } = {}
): Harness {
  // `rows` is the durable state; `snapshot` is what findMany hands out. When
  // `staleReads` is set, every run is served the ORIGINAL values — which is
  // precisely two invocations overlapping before either has stamped.
  const rows = new Map<string, RuleRow>(rules.map((r) => [r.id, { ...r }]));
  const snapshot = rules.map((r) => ({ ...r }));
  const written: FakeTxnRow[] = [];
  const txOptions: unknown[] = [];

  const sameInstant = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();

  const claim = (args: {
    where: { id: string; lastMaterializedAt: Date | null };
    data: { lastMaterializedAt: Date };
  }) => {
    const row = rows.get(args.where.id);
    if (!row) return { count: 0 };
    if (!sameInstant(row.lastMaterializedAt, args.where.lastMaterializedAt ?? null)) {
      return { count: 0 };
    }
    row.lastMaterializedAt = args.data.lastMaterializedAt;
    return { count: 1 };
  };

  const create = (args: { data: FakeTxnRow }) => {
    const d = args.data;
    if (opts.failCreateForRule && d.ruleId === opts.failCreateForRule) {
      throw new Error("simulated insert failure");
    }
    // The real Transaction_ruleId_date_key.
    const clash = written.some(
      (w) => w.ruleId !== null && w.ruleId === d.ruleId && w.date.getTime() === d.date.getTime()
    );
    if (clash) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`ruleId`,`date`)",
        { code: "P2002", clientVersion: "test" }
      );
    }
    written.push({ ...d });
    return { id: `txn-${written.length}` };
  };

  const tx = {
    recurringRule: {
      updateMany: vi.fn(async (a: never) => claim(a)),
      // A blind write, faithfully: this is what a plain `update` does, and
      // modelling it is what lets the cron-003 test show the double post as a
      // row count rather than as a missing-method TypeError.
      update: vi.fn(async (a: { where: { id: string }; data: { lastMaterializedAt: Date } }) => {
        const row = rows.get(a.where.id);
        if (row) row.lastMaterializedAt = a.data.lastMaterializedAt;
        return row ?? {};
      }),
    },
    transaction: { create: vi.fn(async (a: never) => create(a)) },
    activity: { create: vi.fn(async () => ({ id: "act" })) },
  };

  const db: FakeDb = {
    recurringRule: {
      findMany: vi.fn(async () =>
        opts.staleReads
          ? snapshot.map((r) => ({ ...r }))
          : Array.from(rows.values()).map((r) => ({ ...r }))
      ),
      updateMany: vi.fn(async (a: never) => claim(a)),
      update: vi.fn(async () => ({})),
    },
    transaction: { create: vi.fn(async (a: never) => create(a)) },
    activity: { create: vi.fn(async () => ({ id: "act" })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, options?: unknown) => {
      txOptions.push(options);
      // Snapshot for rollback: a throw inside the callback must leave the rule
      // rows untouched, or a failed night becomes a skipped month.
      const before = new Map(Array.from(rows.entries()).map(([k, v]) => [k, { ...v }]));
      const writtenBefore = written.length;
      try {
        return await fn(tx);
      } catch (e) {
        rows.clear();
        before.forEach((v, k) => rows.set(k, v));
        written.length = writtenBefore;
        throw e;
      }
    }),
  };

  return { db, written, rows, txOptions };
}

vi.mock("@/lib/db", () => ({
  get db() {
    return harness.db;
  },
}));

const budgetCheck = vi.fn(async () => {});
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: (...args: unknown[]) =>
    budgetCheck(...(args as [])) as Promise<void>,
}));

const sentry = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn(() => "check-in-id"),
};
vi.mock("@sentry/nextjs", () => sentry);

/* ── fixtures ──────────────────────────────────────────────────────────── */

function rule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: "rule-1",
    companyId: "co-1",
    type: "expense",
    amount: new Prisma.Decimal(5000),
    category: "Office Rent",
    description: "Rent",
    addedBy: "user-1",
    addedByName: "Test User",
    frequency: "monthly",
    dayOfMonth: 15,
    dayOfWeek: null,
    active: true,
    startDate: new Date(Date.UTC(2026, 0, 1)),
    lastMaterializedAt: new Date(Date.UTC(2026, 2, 14)),
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    projectId: null,
    // The default author is still at the company. Every test that does not say
    // otherwise is about a rule somebody can still manage (finance-planning-013).
    user: { deletedAt: null },
    ...overrides,
  };
}

async function run(): Promise<{ status: number; body: Record<string, unknown> }> {
  const mod = await import("@/app/api/cron/materialize-recurring/route");
  const res = await mod.GET(
    new Request("https://app.test/api/cron/materialize-recurring", {
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 2, 15, 0, 5, 0)));
});

/* ── cron-003 ──────────────────────────────────────────────────────────── */

describe("cron-003 — two overlapping runs must not post the same expense twice", () => {
  it("creates the transaction once when the same due rule is processed twice", async () => {
    // Both invocations read the rule BEFORE either stamped it. Before the fix
    // both saw a stale lastMaterializedAt, both passed the in-memory
    // idempotency filter, and both inserted — a rent charge the customer was
    // billed for once, in their books twice.
    harness = buildHarness([rule()], { staleReads: true });

    const first = await run();
    const second = await run();

    expect(harness.written).toHaveLength(1);
    expect(first.status).toBe(200);
    expect(first.body.transactionsCreated).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.transactionsCreated).toBe(0);
    // The loser has to be visible as a skipped claim, not as a silent nothing.
    expect(second.body.rulesSkippedConcurrent).toBe(1);
  });

  it("claims the rule with the exact value it read, not with a blind update", async () => {
    harness = buildHarness([rule()], { staleReads: true });
    await run();
    const claims = harness.db.$transaction.mock.calls.length;
    expect(claims).toBeGreaterThan(0);
    // The stored value moved to the occurrence date, so the second run's token
    // no longer matches and its claim matches zero rows.
    expect(harness.rows.get("rule-1")?.lastMaterializedAt?.toISOString()).toBe(
      new Date(Date.UTC(2026, 2, 15)).toISOString()
    );
  });
});

/* ── cron-004 ──────────────────────────────────────────────────────────── */

describe("cron-004 — a missed night is caught up, not lost", () => {
  it("posts every occurrence the job missed, dated when it was due", async () => {
    harness = buildHarness([rule({ lastMaterializedAt: new Date(Date.UTC(2026, 0, 15)) })]);
    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.transactionsCreated).toBe(2);
    expect(harness.written.map((w) => w.date.toISOString())).toEqual([
      new Date(Date.UTC(2026, 1, 15)).toISOString(),
      new Date(Date.UTC(2026, 2, 15)).toISOString(),
    ]);
  });

  it("advances lastMaterializedAt to the last occurrence written, not to now", async () => {
    // Stamping `now` is what would make a capped catch-up lose the tail: the
    // rule would look reconciled up to today while occurrences were never
    // written. Stamping the last one written means the next run resumes there.
    harness = buildHarness([rule({ lastMaterializedAt: new Date(Date.UTC(2026, 0, 15)) })]);
    await run();
    expect(harness.rows.get("rule-1")?.lastMaterializedAt?.toISOString()).toBe(
      new Date(Date.UTC(2026, 2, 15)).toISOString()
    );
  });

  it("caps one run, reports the remainder, and resumes next run", async () => {
    // Weekly rule asleep for a year. One run may not mint a year of history.
    harness = buildHarness([
      rule({
        frequency: "weekly",
        dayOfMonth: null,
        dayOfWeek: 0, // 2026-03-15 is a Sunday
        startDate: new Date(Date.UTC(2025, 2, 16)),
        lastMaterializedAt: new Date(Date.UTC(2025, 2, 16)),
      }),
    ]);

    const first = await run();
    expect(first.body.transactionsCreated).toBe(12);
    expect(first.body.occurrencesDeferred).toBeGreaterThan(0);

    const second = await run();
    expect(second.body.transactionsCreated).toBeGreaterThan(0);
    expect(harness.written.length).toBeGreaterThan(12);
  });

  it("leaves a failed rule retryable — its timestamp does not move", async () => {
    harness = buildHarness([rule({ lastMaterializedAt: new Date(Date.UTC(2026, 1, 15)) })], {
      failCreateForRule: "rule-1",
    });
    const { body } = await run();
    expect(body.transactionsCreated).toBe(0);
    expect(harness.rows.get("rule-1")?.lastMaterializedAt?.toISOString()).toBe(
      new Date(Date.UTC(2026, 1, 15)).toISOString()
    );
  });
});

/* ── money-005 ─────────────────────────────────────────────────────────── */

describe("money-005 — recurring spend reaches the budget alert", () => {
  it("runs the budget threshold check for a materialized expense", async () => {
    harness = buildHarness([rule({ projectId: "proj-1", category: "Office Rent" })]);
    await run();
    expect(budgetCheck).toHaveBeenCalledWith({
      companyId: "co-1",
      projectId: "proj-1",
      category: "Office Rent",
    });
  });

  it("carries the rule's projectId onto the transaction row", async () => {
    harness = buildHarness([rule({ projectId: "proj-1" })]);
    await run();
    expect(harness.written[0].projectId).toBe("proj-1");
  });

  it("does not run it for money coming IN", async () => {
    harness = buildHarness([rule({ type: "investment", projectId: "proj-1" })]);
    await run();
    expect(budgetCheck).not.toHaveBeenCalled();
  });

  it("does not let a budget-check failure undo the transaction", async () => {
    // Same contract as the manual path: an alerting error must never roll back
    // the customer's money row.
    budgetCheck.mockRejectedValueOnce(new Error("notify exploded"));
    harness = buildHarness([rule({ projectId: "proj-1" })]);
    const { status } = await run();
    expect(harness.written).toHaveLength(1);
    expect(status).toBe(200);
  });
});

/* ── cron-008 / prodready-003 ──────────────────────────────────────────── */

describe("cron-008 — a half-failed night has to reach a human", () => {
  it("answers 5xx, not 206, when a rule fails", async () => {
    // 206 is a 2xx: Vercel's cron view reads it as a successful invocation, so
    // the only escalation path this job has never fired.
    harness = buildHarness([rule()], { failCreateForRule: "rule-1" });
    const { status, body } = await run();
    expect(status).toBeGreaterThanOrEqual(500);
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.failures)).toBe(true);
    expect((body.failures as unknown[]).length).toBe(1);
  });

  it("sends a Sentry cron check-in so a night that never runs also alerts", async () => {
    harness = buildHarness([rule()]);
    await run();
    const statuses = (sentry.captureCheckIn.mock.calls as unknown as unknown[][]).map(
      (c) => (c[0] as { status: string; monitorSlug: string }).status
    );
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("ok");
    expect(
      (
        (sentry.captureCheckIn.mock.calls as unknown as unknown[][])[0][0] as {
          monitorSlug: string;
        }
      ).monitorSlug
    ).toContain("materialize-recurring");
  });

  it("closes the check-in as an error when the run partially failed", async () => {
    harness = buildHarness([rule()], { failCreateForRule: "rule-1" });
    await run();
    const statuses = (sentry.captureCheckIn.mock.calls as unknown as unknown[][]).map(
      (c) => (c[0] as { status: string }).status
    );
    expect(statuses).toContain("error");
    expect(statuses).not.toContain("ok");
  });
});

describe("prodready-003 — a missing CRON_SECRET must not fail silently", () => {
  it("raises a Sentry event before answering 500", async () => {
    harness = buildHarness([]);
    delete process.env.CRON_SECRET;
    const mod = await import("@/app/api/cron/materialize-recurring/route");
    const res = await mod.GET(new Request("https://app.test/api/cron/materialize-recurring"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it("still answers 401 — not 500 — for a wrong secret", async () => {
    harness = buildHarness([]);
    const mod = await import("@/app/api/cron/materialize-recurring/route");
    const res = await mod.GET(
      new Request("https://app.test/api/cron/materialize-recurring", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    expect(res.status).toBe(401);
  });
});

/* ── cron-011 ──────────────────────────────────────────────────────────── */

/**
 * cron-011 — the materializer mints REAL MONEY ROWS across every tenant with no
 * ceiling, and the project's own 100-row canary was not wired to it.
 *
 * `lib/safety/bulk-mutation-guard.ts` fires a Sentry warning tagged
 * `boundary: bulk-mutation` above 100 rows, and it had nine call sites — every
 * bulk workspace/project/task/transaction mutation, plus the purge. Neither
 * nightly writer was among them. A bad rule set, a clock problem or a bug in
 * `isRuleDueOn` could post thousands of transactions across every customer
 * overnight with no signal at all.
 *
 * The assertion is the Sentry event rather than the call, for the reason stated
 * in the sibling file: `warnBulkMutation` IS telemetry, so the event is the
 * behaviour, and a source-text assertion would pass on an unused import.
 */
function bulkMutationEvents(): Array<{ message: string; tags: Record<string, string> }> {
  return (sentry.captureMessage.mock.calls as unknown as unknown[][])
    .map((c) => ({
      message: String(c[0]),
      tags: ((c[1] as { tags?: Record<string, string> })?.tags ?? {}) as Record<string, string>,
    }))
    .filter((e) => e.tags.boundary === "bulk-mutation");
}

describe("cron-011 — an outsized materialization run trips the bulk-mutation canary", () => {
  it("fires the canary when one night posts more than a hundred transactions", async () => {
    // 120 workspaces, one due occurrence each — the shape a platform-wide
    // problem takes, rather than one workspace with a long backlog.
    const rules: RecurringRule[] = [];
    for (let i = 0; i < 120; i += 1) {
      rules.push(rule({ id: `rule-${i}`, companyId: `co-${i}` }));
    }
    harness = buildHarness(rules);

    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.transactionsCreated).toBe(120);

    const events = bulkMutationEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tags.action).toBe("materializeRecurring");
    expect(events[0].message).toMatch(/120 rows/);
  });

  it("stays quiet on an ordinary night", async () => {
    harness = buildHarness([rule()]);
    const res = await run();
    expect(res.body.transactionsCreated).toBe(1);
    expect(bulkMutationEvents()).toEqual([]);
  });
});

/* ── R1-money-013-cron ─────────────────────────────────────────────────── */

/**
 * A DELETED PROJECT MUST NOT COLLECT NEW SPEND.
 *
 * money-013 taught `deleteProjectAction` that money counts as content, so a
 * project carrying live transactions can no longer be deleted. Nothing taught
 * this job: it selects on `{ active: true, ...LIVE_WORKSPACE_SCOPE }`, which
 * says nothing about the project a rule points at, and nothing anywhere sets
 * `active: false` when a project is deleted. So a project with an active
 * recurring rule and no live transactions is deletable, and from that night on
 * the cron posts brand-new LIVE transactions tagged to a tombstoned project —
 * counted in company totals, invisible in every project view, and stripped of
 * the tag the day the purge collects the project row.
 *
 * `lib/actions/recurring.ts` already refuses to CREATE a rule against a deleted
 * project for exactly this reason ("every future posting in a ledger tab nobody
 * can open while still counting toward that project's spend aggregate"). This is
 * the same rule, one night later.
 *
 * The contract is to post the money WITHOUT the dead tag, not to skip the rule:
 * the rent is still being paid, and cron-004 is the scar that says a missed
 * posting is a month missing from a founder's books.
 */
describe("R1-money-013-cron — the nightly job must not tag a deleted project", () => {
  it("posts the occurrence with no project tag when the project is tombstoned", async () => {
    harness = buildHarness([
      rule({ projectId: "proj-gone", project: { deletedAt: new Date(Date.UTC(2026, 1, 20)) } }),
    ]);
    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.transactionsCreated).toBe(1);
    expect(harness.written).toHaveLength(1);
    expect(harness.written[0].projectId).toBeNull();
    // Reported, not silent: a rule still naming a deleted project is a thing
    // somebody has to fix at the rule, and nothing else in the product says so.
    expect(body.rulesWithDeletedProject).toEqual(["rule-1"]);
  });

  it("still carries the tag of a project that is alive", async () => {
    // The money-005 half: dropping the tag wholesale would take recurring spend
    // back out of reach of every budget cap.
    harness = buildHarness([rule({ projectId: "proj-live", project: { deletedAt: null } })]);
    const { body } = await run();

    expect(harness.written[0].projectId).toBe("proj-live");
    expect(body.rulesWithDeletedProject).toEqual([]);
  });

  it("asks the database for the project's tombstone at all — guard the guard", () => {
    // Without this, the two assertions above pass vacuously the moment the route
    // stops selecting the relation: the fake row simply has no `project` key,
    // every rule looks live, and the file goes green while checking nothing.
    harness = buildHarness([rule({ projectId: "proj-gone" })]);
    return run().then(() => {
      const args = harness.db.recurringRule.findMany.mock.calls[0]?.[0] as {
        include?: { project?: { select?: { deletedAt?: boolean } } };
      };
      expect(args?.include?.project?.select?.deletedAt).toBe(true);
    });
  });
});

/* ── finance-planning-013 ───────────────────────────────────────── */

/**
 * A REMOVED TEAMMATE'S STANDING CHARGES MUST STOP.
 *
 * `removeUserAction` tombstones the User row and bumps `sessionVersion`
 * (lib/actions/team.ts) and touches nothing else. It does not pause the
 * recurring rules that person set up, and nothing else does either — so this
 * job, which selects on `{ active: true, ...LIVE_WORKSPACE_SCOPE }`, kept
 * posting an ex-employee's salary or subscription into the customer's books
 * every month, stamped with the `addedByName` of somebody who had left. Per
 * CLAUDE.md there is deliberately no individual-user purge, so that tombstone
 * and those rules live for ever: the posting had no end date at all.
 *
 * The contract is the OPPOSITE of the deleted-project case above, and
 * deliberately so. There, the money is still being paid and only the tag is
 * dead, so the posting goes in untagged. Here the AUTHORISATION is what died:
 * nobody at the company is standing behind this charge any more. So the rule is
 * suspended — and named in the response, because a charge that stops silently
 * is its own kind of wrong (the same reasoning as `rulesWithDeletedProject`).
 *
 * Nothing is written: no claim, no stamp, no `active: false`. A suspended rule
 * is left exactly as it was, so `reactivateUserAction` clearing that tombstone
 * resumes it with the same catch-up a resumed PAUSE gets — bounded by
 * MAX_CATCHUP_LOOKBACK_DAYS, which is the behaviour this product already has
 * for a rule somebody paused by hand.
 */
describe("finance-planning-013 — a removed teammate's recurring charges stop", () => {
  it("posts nothing for a rule whose author is tombstoned, and names the rule", async () => {
    harness = buildHarness([rule({ user: { deletedAt: new Date(Date.UTC(2026, 1, 2)) } })]);
    const { status, body } = await run();

    expect(status).toBe(200);
    expect(harness.written).toEqual([]);
    expect(body.transactionsCreated).toBe(0);
    // Reported, not silent: the workspace has a standing charge nobody owns,
    // and this is the only place that says so to an operator.
    expect(body.rulesWithRemovedAuthor).toEqual(["rule-1"]);
  });

  it("leaves the suspended rule untouched, so a reactivated author resumes it", async () => {
    // No claim and no stamp. If the job moved `lastMaterializedAt` forward while
    // declining to post, reactivating the teammate would silently skip every
    // month they were away — cron-004's scar in a new place.
    const stamp = new Date(Date.UTC(2026, 2, 14));
    harness = buildHarness([
      rule({ lastMaterializedAt: stamp, user: { deletedAt: new Date(Date.UTC(2026, 1, 2)) } }),
    ]);
    await run();

    expect(harness.rows.get("rule-1")?.lastMaterializedAt?.toISOString()).toBe(stamp.toISOString());
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it("reports the suspended rule once — not also as a deleted-project rule", async () => {
    // Both things can be true of one rule. It posts nothing either way, so
    // listing it twice would only make the healthy-night signal noisier.
    harness = buildHarness([
      rule({
        projectId: "proj-gone",
        project: { deletedAt: new Date(Date.UTC(2026, 1, 20)) },
        user: { deletedAt: new Date(Date.UTC(2026, 1, 2)) },
      }),
    ]);
    const { body } = await run();

    expect(body.rulesWithRemovedAuthor).toEqual(["rule-1"]);
    expect(body.rulesWithDeletedProject).toEqual([]);
    expect(harness.written).toEqual([]);
  });

  it("still posts for an author who is still at the company", async () => {
    // The other direction, and the expensive one to get wrong: a filter that
    // stopped every rule would take rent, salaries and subscriptions out of
    // every customer's books overnight.
    harness = buildHarness([rule()]);
    const { body } = await run();

    expect(body.transactionsCreated).toBe(1);
    expect(body.rulesWithRemovedAuthor).toEqual([]);
  });

  it("asks the database for the author's tombstone at all — guard the guard", async () => {
    // Without this, the assertions above pass vacuously the moment the route
    // stops selecting the relation: the fake row simply has no `user` key, every
    // author looks live, and the file goes green while checking nothing.
    harness = buildHarness([rule()]);
    await run();

    const args = harness.db.recurringRule.findMany.mock.calls[0]?.[0] as {
      include?: { user?: { select?: { deletedAt?: boolean } } };
    };
    expect(args?.include?.user?.select?.deletedAt).toBe(true);
  });
});
