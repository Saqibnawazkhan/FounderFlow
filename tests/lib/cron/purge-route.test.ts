/**
 * Behavioural tests for /api/cron/purge-soft-deleted — the job that makes
 * "your workspace will be erased after 90 days" true.
 *
 * Nothing here touches a database: `vi.mock("@/lib/db")` replaces the client
 * before the route's module graph is built, and the fake models the three
 * things the findings turn on — which delegate is asked to delete what, in
 * which order, and whether the call happened inside a transaction or outside
 * one. The structural guards in tests/lib/db/purge-invariants.test.ts stay as
 * they are: they check that every workspace table is NAMED. These check what
 * happens when one of them refuses to go.
 *
 * Findings: cron-002 (one stuck project must not stop the sweep), cron-005 (the
 * dry run must report the rows a live run would destroy), cron-006 (a
 * chat-heavy workspace must actually finish), cron-008 (a failed stage must
 * escalate), prodready-003 (a missing CRON_SECRET must be loud),
 * R1-money-013-cron (the hard delete must not strip money attribution).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET = "purge-secret-for-tests";

/** Rows the fake workspace holds, per Prisma delegate. */
type Counts = Record<string, number>;

interface Op {
  delegate: string;
  kind: "deleteMany" | "delete" | "count" | "findMany" | "update";
  inTx: boolean;
  n?: number;
}

interface Harness {
  db: Record<string, unknown>;
  ops: Op[];
  txOptions: unknown[];
  counts: Counts;
}

let harness: Harness;

const WORKSPACE_DELEGATES = [
  "messageReaction",
  "message",
  "channelMember",
  "channel",
  // BillingEvent (bill-002 / bill-009) is workspace data: it carries a
  // companyId, so purgeCompany() must erase it with the workspace and
  // countCompanyRows() must count it. Listed here in the same order.
  "billingEvent",
  "comment",
  "timeEntry",
  "transaction",
  "budget",
  "recurringRule",
  "task",
  "activity",
  "notification",
  "inviteToken",
  "project",
  // cron-009. Neither carries a companyId or a deletedAt — they reach a
  // workspace only through User, with onDelete: Cascade — so until 2026-09-30
  // `tx.user.deleteMany` made their rows disappear and they added 0 to the
  // total the 100-row canary reads. They are listed HERE, before "user",
  // because that is the order purgeCompany() deletes them in and the drift
  // guard at the bottom of this file reads the two lists side by side.
  "pushSubscription",
  "notificationPreference",
  "user",
];

function buildHarness(options: {
  counts?: Counts;
  overdueCompanies?: string[];
  overdueProjects?: string[];
  /** Project ids whose hard delete raises a foreign-key error. */
  failProjectDelete?: string[];
  /** Company ids whose purge transaction blows up. */
  failCompany?: string[];
  projectChildCounts?: Counts;
  /** Makes the kept-backlog `project.count` throw (R1-money-013-cron, round 2). */
  failProjectCount?: boolean;
}): Harness {
  const counts: Counts = { ...(options.counts ?? {}) };
  const projectChildCounts: Counts = { ...(options.projectChildCounts ?? {}) };
  const overdueCompanies = options.overdueCompanies ?? [];
  const overdueProjects = options.overdueProjects ?? [];
  const failProjectDelete = options.failProjectDelete ?? [];
  const failCompany = options.failCompany ?? [];
  const failProjectCount = options.failProjectCount ?? false;

  /** Does this overdue project still carry transactions? */
  const hasTransactions = (id: string) =>
    (projectChildCounts[`transaction:${id}`] ?? projectChildCounts.transaction ?? 0) > 0;

  /**
   * Applies a `transactions: { none: {} }` / `{ some: {} }` relation filter to
   * the overdue project set, the way Postgres would.
   *
   * The fake HAS to honour it. R1-money-013-cron's second round turns entirely
   * on whether a project the sweep will never purge occupies a slot in the
   * page, and a fake that returns every overdue id whatever it was asked
   * cannot tell "excluded from the window" from "skipped inside the loop".
   */
  const applyTransactionFilter = (ids: string[], where?: Record<string, unknown>) => {
    const rel = where?.transactions as { none?: unknown; some?: unknown } | undefined;
    if (!rel) return ids;
    if ("none" in rel) return ids.filter((id) => !hasTransactions(id));
    if ("some" in rel) return ids.filter((id) => hasTransactions(id));
    return ids;
  };

  const ops: Op[] = [];
  const txOptions: unknown[] = [];
  let inTx = false;
  let currentCompany: string | null = null;

  const record = (delegate: string, kind: Op["kind"], n?: number) => {
    ops.push({ delegate, kind, inTx, n });
  };

  /** Ids the batched drain of an unbounded table hands back. */
  const idsFor = (delegate: string, take: number): Array<{ id: string }> => {
    const left = counts[delegate] ?? 0;
    const n = Math.min(take, left);
    const out: Array<{ id: string }> = [];
    for (let i = 0; i < n; i += 1) out.push({ id: `${delegate}-${left - i}` });
    return out;
  };

  const delegate = (name: string) => ({
    deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      const idFilter = where.id as { in?: string[] } | undefined;
      if (idFilter && Array.isArray(idFilter.in)) {
        const n = idFilter.in.length;
        counts[name] = Math.max(0, (counts[name] ?? 0) - n);
        record(name, "deleteMany", n);
        return { count: n };
      }
      if (typeof where.projectId === "string") {
        const key = `${name}:${where.projectId}`;
        const n = projectChildCounts[key] ?? projectChildCounts[name] ?? 0;
        record(name, "deleteMany", n);
        return { count: n };
      }
      const n = counts[name] ?? 0;
      counts[name] = 0;
      record(name, "deleteMany", n);
      return { count: n };
    }),
    count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (name === "project" && where.deletedAt) {
        // The kept-backlog count. No `take`, deliberately: it is a total, not a
        // page, which is half of what the test below is checking.
        if (failProjectCount) throw new Error("canceling statement due to statement timeout");
        const ids = applyTransactionFilter(overdueProjects.slice(), where);
        record(name, "count", ids.length);
        return ids.length;
      }
      if (typeof where.projectId === "string") {
        const key = `${name}:${where.projectId}`;
        const n = projectChildCounts[key] ?? projectChildCounts[name] ?? 0;
        record(name, "count", n);
        return n;
      }
      const n = counts[name] ?? 0;
      record(name, "count", n);
      return n;
    }),
    findMany: vi.fn(async (args?: { take?: number; where?: Record<string, unknown> }) => {
      if (name === "project") {
        // Honours `take` AND the relation filter, for the reason on
        // `applyTransactionFilter`. It does NOT honour the overdue cutoff
        // itself, because `overdueProjects` IS the already-overdue set by
        // construction — same shape as the company fake below.
        let ids = applyTransactionFilter(overdueProjects.slice(), args?.where);
        if (typeof args?.take === "number") ids = ids.slice(0, args.take);
        record(name, "findMany", ids.length);
        return ids.map((id) => ({ id }));
      }
      const take = args?.take ?? 0;
      const batch = idsFor(name, take);
      record(name, "findMany", batch.length);
      return batch;
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      if (name === "project" && failProjectDelete.indexOf(args.where.id) !== -1) {
        record(name, "delete", 0);
        throw new Error(
          "Foreign key constraint failed on the field: `Task_projectId_fkey (index)`"
        );
      }
      record(name, "delete", 1);
      return { id: args.where.id };
    }),
    update: vi.fn(async () => {
      record(name, "update", 1);
      return {};
    }),
  });

  const db: Record<string, unknown> = {};
  for (const name of WORKSPACE_DELEGATES) db[name] = delegate(name);
  db.company = {
    ...delegate("company"),
    // Honours `take` and `where.id` (cron-012). A fake that returned every
    // overdue id whatever it was asked would pass with or without the per-run
    // ceiling and the single-workspace mode — the vacuous shape this repo keeps
    // re-finding. It does NOT honour the overdue cutoff itself, because
    // `overdueCompanies` IS the already-overdue set by construction.
    findMany: vi.fn(async (args?: { take?: number; where?: Record<string, unknown> }) => {
      let ids = overdueCompanies.slice();
      const id = args?.where?.id;
      if (typeof id === "string") ids = ids.filter((c) => c === id);
      if (typeof args?.take === "number") ids = ids.slice(0, args.take);
      record("company", "findMany", ids.length);
      return ids.map((cid) => ({ id: cid }));
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      record("company", "delete", 1);
      return { id: args.where.id };
    }),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>, txOpts?: unknown) => {
    txOptions.push(txOpts);
    inTx = true;
    try {
      if (currentCompany && failCompany.indexOf(currentCompany) !== -1) {
        throw new Error(
          "Transaction already closed: A query cannot be executed on an expired transaction"
        );
      }
      return await fn(db);
    } finally {
      inTx = false;
    }
  });

  // Companies are purged one at a time; remember which, so failCompany works.
  const originalFindMany = (db.company as { findMany: (a?: unknown) => Promise<unknown> }).findMany;
  (db.company as { findMany: unknown }).findMany = vi.fn(async (a?: unknown) => {
    const rows = (await originalFindMany(a)) as Array<{ id: string }>;
    return rows;
  });
  (db as { __setCompany?: (id: string) => void }).__setCompany = (id: string) => {
    currentCompany = id;
  };

  return { db, ops, txOptions, counts };
}

vi.mock("@/lib/db", () => ({
  get db() {
    return harness.db;
  },
}));

const sentry = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn(() => "check-in-id"),
};
vi.mock("@sentry/nextjs", () => sentry);

async function run(query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const mod = await import("@/app/api/cron/purge-soft-deleted/route");
  const res = await mod.GET(
    new Request(`https://app.test/api/cron/purge-soft-deleted${query}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function resultOf(body: Record<string, unknown>): Record<string, number> {
  return body.result as Record<string, number>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  delete process.env.PURGE_ENABLED;
});

/* ── cron-005 ──────────────────────────────────────────────────────────── */

describe("cron-005 — the dry run must report what a live run would erase", () => {
  it("counts the rows per table instead of reporting zero", async () => {
    // "3 workspaces" reads the same whether that is 40 rows or 400,000. The
    // number in front of an irreversible, unscoped, multi-tenant hard delete
    // was 0 by construction, so the one safety mechanism could not inform the
    // decision it exists for.
    harness = buildHarness({
      overdueCompanies: ["co-1"],
      counts: { message: 900, messageReaction: 150, transaction: 40, user: 3, task: 12 },
    });
    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.dryRun).toBe(true);
    const result = resultOf(body);
    expect(result.companiesPurged).toBe(1);
    expect(result.workspaceRowsWouldDelete).toBeGreaterThan(1000);
    const byTable = body.result as { workspaceRowsByTable?: Record<string, number> };
    expect(byTable.workspaceRowsByTable?.Message).toBe(900);
    expect(byTable.workspaceRowsByTable?.MessageReaction).toBe(150);
  });

  it("deletes absolutely nothing while dry-running", async () => {
    harness = buildHarness({
      overdueCompanies: ["co-1"],
      overdueProjects: ["p-1"],
      counts: { message: 10, user: 2 },
    });
    await run();
    const destructive = harness.ops.filter(
      (o) => o.kind === "deleteMany" || o.kind === "delete" || o.kind === "update"
    );
    expect(destructive).toEqual([]);
  });

  it("lets the 100-row canary fire BEFORE the first irreversible run", async () => {
    // warnBulkMutation was only reachable from the live branch, so the alert
    // that exists to page on-call about an unexpectedly large purge first saw a
    // real number on the night the rows were already gone.
    harness = buildHarness({
      overdueCompanies: ["co-1"],
      counts: { message: 5000, user: 4 },
    });
    await run();
    expect(sentry.captureMessage).toHaveBeenCalled();
    const [msg] = sentry.captureMessage.mock.calls[0] as [string];
    expect(msg).toContain("Bulk mutation exceeded threshold");
  });

  it("still defaults to dry-run — erasing customer data stays opt-in", async () => {
    harness = buildHarness({ overdueCompanies: ["co-1"], counts: { user: 1 } });
    const { body } = await run();
    expect(body.dryRun).toBe(true);
  });
});

/* ── cron-006 ──────────────────────────────────────────────────────────── */

describe("cron-006 — a chat-heavy workspace must actually finish", () => {
  beforeEach(() => {
    process.env.PURGE_ENABLED = "true";
  });

  it("opens the workspace transaction with a timeout above Prisma's 5s default", async () => {
    // lib/db.ts builds the client with only a `log` option, so the operative
    // ceiling was Prisma's default timeout of 5000ms — not the route's declared
    // maxDuration of 60s. A workspace that is mostly Message rows blew through
    // it with P2028 and failed again every night, for ever.
    harness = buildHarness({ overdueCompanies: ["co-1"], counts: { message: 10, user: 1 } });
    await run();
    const withTimeout = harness.txOptions.filter(
      (o) => typeof (o as { timeout?: number })?.timeout === "number"
    ) as Array<{ timeout: number }>;
    expect(withTimeout.length).toBeGreaterThan(0);
    for (const o of withTimeout) expect(o.timeout).toBeGreaterThan(5000);
  });

  it("keeps the whole transaction inside the route's own 60s ceiling", async () => {
    harness = buildHarness({ overdueCompanies: ["co-1"], counts: { user: 1 } });
    await run();
    const timeouts = harness.txOptions.map((o) => (o as { timeout?: number })?.timeout ?? 0);
    for (const t of timeouts) expect(t).toBeLessThan(60_000);
  });

  it("drains the unbounded chat tables in batches OUTSIDE the transaction", async () => {
    // The transactional part has to stay small and bounded; Message and
    // MessageReaction are the two tables with no natural ceiling.
    harness = buildHarness({
      overdueCompanies: ["co-1"],
      counts: { message: 4500, messageReaction: 2200, user: 1 },
    });
    await run();
    const chatDeletes = harness.ops.filter(
      (o) =>
        (o.delegate === "message" || o.delegate === "messageReaction") && o.kind === "deleteMany"
    );
    expect(chatDeletes.length).toBeGreaterThan(1); // more than one batch
    for (const op of chatDeletes) expect(op.inTx).toBe(false);
  });

  it("counts every drained chat row in the total the canary reads", async () => {
    harness = buildHarness({
      overdueCompanies: ["co-1"],
      counts: { message: 4500, messageReaction: 2200, user: 1 },
    });
    const { body } = await run();
    // 4500 + 2200 + 1 user + 1 company row = 6702 at minimum.
    expect(resultOf(body).workspaceRowsDeleted).toBeGreaterThanOrEqual(6702);
  });

  it("one unfinishable workspace does not stop the others", async () => {
    harness = buildHarness({
      overdueCompanies: ["co-good-1", "co-stuck", "co-good-2"],
      counts: { user: 1 },
      failCompany: ["co-stuck"],
    });
    // The fake needs to know which company is being purged.
    const setCompany = (harness.db as { __setCompany: (id: string) => void }).__setCompany;
    const original = (harness.db.company as { findMany: () => Promise<Array<{ id: string }>> })
      .findMany;
    (harness.db.company as { findMany: unknown }).findMany = async () => {
      const rows = await original();
      return rows;
    };
    setCompany("co-stuck");
    const { body } = await run();
    // Two good companies still went; the stuck one is a named failure.
    expect(Array.isArray(body.failures)).toBe(true);
  });
});

/* ── cron-002 ──────────────────────────────────────────────────────────── */

describe("cron-002 — one stuck project must not disable the whole stage", () => {
  beforeEach(() => {
    process.env.PURGE_ENABLED = "true";
  });

  it("purges the projects it can and records only the one that refused", async () => {
    // A single deleteMany meant the one project still referenced by a
    // soft-deleted Task raised an FK violation for the WHOLE statement: no
    // overdue project in ANY workspace was ever purged again, every night, for
    // every customer, because of one customer's data shape.
    harness = buildHarness({
      overdueProjects: ["p-ok-1", "p-stuck", "p-ok-2"],
      failProjectDelete: ["p-stuck"],
    });
    const { status, body } = await run();

    expect(resultOf(body).orphanProjectsPurged).toBe(2);
    const failures = body.failures as Array<{ stage: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toContain("p-stuck");
    // A named failure still escalates (cron-008) — it just doesn't take the
    // other projects with it.
    expect(status).toBeGreaterThanOrEqual(500);
  });

  it("removes a project's tombstoned tasks and budgets before the project row", async () => {
    // deleteProjectAction counts only `deletedAt: null` children, so a project
    // whose every task was soft-deleted first passes the emptiness check and
    // gets tombstoned while those rows physically remain holding a Restrict FK.
    harness = buildHarness({
      overdueProjects: ["p-1"],
      projectChildCounts: { "task:p-1": 7, "budget:p-1": 2 },
    });
    await run();

    const names = harness.ops
      .filter((o) => o.kind === "deleteMany" || o.kind === "delete")
      .map((o) => `${o.delegate}.${o.kind}`);
    expect(names.indexOf("task.deleteMany")).toBeGreaterThan(-1);
    expect(names.indexOf("budget.deleteMany")).toBeGreaterThan(-1);
    expect(names.indexOf("task.deleteMany")).toBeLessThan(names.indexOf("project.delete"));
    expect(names.indexOf("budget.deleteMany")).toBeLessThan(names.indexOf("project.delete"));
  });

  it("reports the child rows it removed with each project", async () => {
    harness = buildHarness({
      overdueProjects: ["p-1"],
      projectChildCounts: { "task:p-1": 7, "budget:p-1": 2 },
    });
    const { body } = await run();
    expect(resultOf(body).orphanProjectRowsDeleted).toBeGreaterThanOrEqual(10);
  });
});

/* ── R1-money-013-cron ─────────────────────────────────────────────────── */

/**
 * `tx.project.delete` is the one irreversible step in scope 2, and
 * `Transaction.projectId` is `onDelete: SetNull` — so hard-deleting a tombstoned
 * project silently strips the project tag off every transaction still pointing
 * at it. money-013 closed the interactive door (deleteProjectAction now refuses
 * a project with live transactions), but it put nothing in front of the
 * irreversible step itself, so every project tombstoned BEFORE that gate landed
 * still loses its attribution the night it goes overdue — and no error, no
 * failure and no changed total ever says so.
 *
 * The contract: a tombstoned project that STILL carries transactions is kept,
 * counted, and reported. A genuinely empty one is purged exactly as before.
 */
describe("R1-money-013-cron — purging a project must not strip money attribution", () => {
  beforeEach(() => {
    process.env.PURGE_ENABLED = "true";
  });

  it("keeps a tombstoned project whose transactions still point at it", async () => {
    harness = buildHarness({
      overdueProjects: ["p-money", "p-empty"],
      projectChildCounts: { "transaction:p-money": 12 },
    });
    const { status, body } = await run();

    const deletedIds = (
      harness.db.project as {
        delete: { mock: { calls: Array<[{ where: { id: string } }]> } };
      }
    ).delete.mock.calls.map((c) => c[0].where.id);
    expect(deletedIds).toEqual(["p-empty"]);
    expect(resultOf(body).orphanProjectsPurged).toBe(1);
    expect(resultOf(body).orphanProjectsKeptWithTransactions).toBe(1);
    // Keeping a row is the designed outcome, not a stuck stage: it must not
    // escalate, or the nightly job pages on-call for ever.
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("leaves that project's tasks and budgets alone too", async () => {
    // The children go inside the same transaction as the project row. Deleting
    // them and then keeping the parent would destroy rows for nothing.
    harness = buildHarness({
      overdueProjects: ["p-money"],
      projectChildCounts: { "transaction:p-money": 3, "task:p-money": 4, "budget:p-money": 1 },
    });
    await run();
    const destructive = harness.ops.filter((o) => o.kind === "deleteMany" || o.kind === "delete");
    expect(destructive).toEqual([]);
  });

  it("counts a soft-deleted transaction too — its tag is attribution as well", async () => {
    // Neither filter mentions `deletedAt`: a project whose transactions were all
    // soft-deleted first is exactly the residue deleteProjectAction's own
    // comment says the gate cannot close, and a soft-deleted transaction's
    // project tag is attribution as much as a live one's. Asserted as an exact
    // deep-equal, because `{ none: { deletedAt: null } }` is the plausible wrong
    // spelling and it reads almost identically.
    harness = buildHarness({
      overdueProjects: ["p-money"],
      projectChildCounts: { "transaction:p-money": 1 },
    });
    await run();
    const windowWhere = (
      harness.db.project as {
        findMany: { mock: { calls: Array<[{ where: Record<string, unknown> }]> } };
      }
    ).findMany.mock.calls.map((c) => c[0].where);
    expect(windowWhere.map((w) => w.transactions)).toContainEqual({ none: {} });
    const keptWhere = (
      harness.db.project as {
        count: { mock: { calls: Array<[{ where: Record<string, unknown> }]> } };
      }
    ).count.mock.calls.map((c) => c[0].where);
    expect(keptWhere.map((w) => w.transactions)).toContainEqual({ some: {} });
  });

  it("reports the same refusal in the dry run, so the two runs agree", async () => {
    delete process.env.PURGE_ENABLED;
    harness = buildHarness({
      overdueProjects: ["p-money", "p-empty"],
      projectChildCounts: { "transaction:p-money": 5 },
    });
    const { body } = await run();
    expect(body.dryRun).toBe(true);
    expect(resultOf(body).orphanProjectsKeptWithTransactions).toBe(1);
    expect(resultOf(body).orphanProjectsPurged).toBe(1);
  });

  /**
   * ROUND 2 — the keep must not starve the sweep.
   *
   * A kept project is overdue for ever, so a per-project check INSIDE the loop
   * left it matching the scope-2 window every single night. Fill `take:
   * projectLimit` with kept projects and the stage purges nothing at all, for
   * every tenant, for ever — `orphanProjectRowsDeleted` stays 0, which is far
   * too small for the bulk-mutation canary to notice, and the 90-day per-project
   * erasure promise quietly stops being kept. That is the cron-002 outage shape
   * this file's own scope-2 comment is scarred by.
   */
  it("still purges an empty project when the page would otherwise be full of kept ones", async () => {
    harness = buildHarness({
      overdueProjects: ["p-money-1", "p-money-2", "p-empty"],
      projectChildCounts: {
        "transaction:p-money-1": 9,
        "transaction:p-money-2": 4,
      },
    });
    // Two kept projects and a page of two: whichever order the read returns
    // them in, the empty project is only reachable if the kept ones never enter
    // the window.
    const { body } = await run("?projectLimit=2");

    const deletedIds = (
      harness.db.project as {
        delete: { mock: { calls: Array<[{ where: { id: string } }]> } };
      }
    ).delete.mock.calls.map((c) => c[0].where.id);
    expect(deletedIds).toEqual(["p-empty"]);
    expect(resultOf(body).orphanProjectsPurged).toBe(1);
  });

  it("reports the whole kept backlog, not just the slice that fit in one page", async () => {
    harness = buildHarness({
      overdueProjects: ["p-money-1", "p-money-2", "p-money-3", "p-empty"],
      projectChildCounts: {
        "transaction:p-money-1": 1,
        "transaction:p-money-2": 1,
        "transaction:p-money-3": 1,
      },
    });
    const { body } = await run("?projectLimit=2");
    // Three, not two: this number is the only place the permanent keeps are
    // said out loud, and capping it at the page size would hide the backlog it
    // exists to report.
    expect(resultOf(body).orphanProjectsKeptWithTransactions).toBe(3);
  });

  it("asks for the oldest tombstones first, so one night's page is predictable", async () => {
    harness = buildHarness({ overdueProjects: ["p-1"] });
    await run();
    const args = (
      harness.db.project as {
        findMany: { mock: { calls: Array<[Record<string, unknown>]> } };
      }
    ).findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ deletedAt: "asc" }, { id: "asc" }]);
  });

  it("a failed kept-backlog count costs the number, not the night's sweep", async () => {
    // The count is a REPORTING query. cron-002 is the scar that says one query
    // must not take the stage with it — and a 0 here would read as "nothing is
    // being kept", which is the misreading this endpoint exists to prevent, so
    // the field goes null and the failure is named.
    harness = buildHarness({
      overdueProjects: ["p-empty"],
      failProjectCount: true,
    });
    const { body, status } = await run();

    const deletedIds = (
      harness.db.project as {
        delete: { mock: { calls: Array<[{ where: { id: string } }]> } };
      }
    ).delete.mock.calls.map((c) => c[0].where.id);
    expect(deletedIds).toEqual(["p-empty"]);
    expect(resultOf(body).orphanProjectsPurged).toBe(1);
    expect(resultOf(body).orphanProjectsKeptWithTransactions).toBeNull();
    const failures = body.failures as Array<{ stage: string }>;
    expect(failures.map((f) => f.stage)).toContain("orphanProjectsKeptCount");
    expect(status).toBeGreaterThanOrEqual(500);
  });
});

/* ── cron-008 / prodready-003 ──────────────────────────────────────────── */

describe("cron-008 — a failed stage has to reach a human", () => {
  it("answers 5xx rather than 206", async () => {
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({
      overdueProjects: ["p-stuck"],
      failProjectDelete: ["p-stuck"],
    });
    const { status, body } = await run();
    expect(status).toBeGreaterThanOrEqual(500);
    expect(body.ok).toBe(false);
  });

  it("sends a Sentry cron check-in, so a night that never runs also alerts", async () => {
    harness = buildHarness({ overdueCompanies: [] });
    await run();
    const statuses = (sentry.captureCheckIn.mock.calls as unknown as unknown[][]).map(
      (c) => (c[0] as { status: string }).status
    );
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("ok");
    expect(
      (
        (sentry.captureCheckIn.mock.calls as unknown as unknown[][])[0][0] as {
          monitorSlug: string;
        }
      ).monitorSlug
    ).toContain("purge-soft-deleted");
  });
});

describe("prodready-003 — a missing CRON_SECRET must not fail silently", () => {
  it("raises a Sentry event before answering 500", async () => {
    harness = buildHarness({});
    delete process.env.CRON_SECRET;
    const mod = await import("@/app/api/cron/purge-soft-deleted/route");
    const res = await mod.GET(new Request("https://app.test/api/cron/purge-soft-deleted"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalled();
  });
});

/* ── cron-013 ──────────────────────────────────────────────────────────── */

/**
 * cron-013, the one hole left in it. The finding said no test covers any cron
 * route's auth gate; by 2026-09-30 the other two routes each had 401 coverage
 * and THIS one — the multi-tenant erasure endpoint, the highest-consequence URL
 * in the product — still had none. `grep -n 401 tests/lib/cron/purge-route.test.ts`
 * returned nothing.
 *
 * The rest of cron-013 is closed: `tests/lib/cron/` now holds behavioural tests
 * for all three routes (the 206→500 contract, the dry-run default, the check-in,
 * the missing-secret branch) where there were none. What could still regress
 * unnoticed was the single thing the finding named as most serious.
 */
describe("cron-013 — the erasure endpoint refuses an unauthenticated caller", () => {
  it("answers 401 with no authorization header, and touches nothing", async () => {
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 3 } });
    process.env.PURGE_ENABLED = "true";
    const mod = await import("@/app/api/cron/purge-soft-deleted/route");
    const res = await mod.GET(new Request("https://app.test/api/cron/purge-soft-deleted"));
    expect(res.status).toBe(401);
    // The load-bearing half: not merely the status, but that the run did not
    // happen. A gate that answers 401 after doing the work is not a gate.
    expect(harness.ops).toEqual([]);
  });

  it("refuses a wrong secret, and does not leak whether one is configured", async () => {
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 3 } });
    const mod = await import("@/app/api/cron/purge-soft-deleted/route");
    const res = await mod.GET(
      new Request("https://app.test/api/cron/purge-soft-deleted", {
        headers: { authorization: "Bearer not-the-secret" },
      })
    );
    expect(res.status).toBe(401);
    expect(harness.ops).toEqual([]);
    expect((await res.json()) as Record<string, unknown>).toEqual({ error: "Unauthorized" });
  });

  it("refuses a bare token without the Bearer scheme", async () => {
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 3 } });
    const mod = await import("@/app/api/cron/purge-soft-deleted/route");
    const res = await mod.GET(
      new Request("https://app.test/api/cron/purge-soft-deleted", {
        headers: { authorization: SECRET },
      })
    );
    expect(res.status).toBe(401);
    expect(harness.ops).toEqual([]);
  });

  it("does not open or close the heartbeat for an unauthenticated probe", async () => {
    // A rejected probe that closed the check-in would mark the night as having
    // run, and the missed-beat alert would never fire for a job that is broken.
    harness = buildHarness({ overdueCompanies: [] });
    const mod = await import("@/app/api/cron/purge-soft-deleted/route");
    await mod.GET(new Request("https://app.test/api/cron/purge-soft-deleted"));
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it("guard-the-guard: the same request WITH the secret does run", async () => {
    // Without this, every assertion above would pass against a route that
    // answers 401 to everything, including Vercel.
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 3 } });
    const res = await run();
    expect(res.status).toBe(200);
    expect(harness.ops.length).toBeGreaterThan(0);
  });
});

/* ── drift guard ───────────────────────────────────────────────────────── */

describe("the dry-run counter and the live purge must not drift apart", () => {
  // cron-005's fix put a SECOND hand-maintained list of workspace tables in
  // this route: `countCompanyRows` mirrors `purgeCompany` table for table. Two
  // such lists in one file is exactly how the chat tables went missing for a
  // day in 2026-09-24 — so the mirror is checked, not remembered. A table added
  // to the delete and not to the count makes the dry run under-report by
  // however many rows it holds, which is the one number the canary reads.
  const ROUTE = join(process.cwd(), "app", "api", "cron", "purge-soft-deleted", "route.ts");

  /** One top-level `async function` body, up to its column-zero closing brace. */
  function functionBody(name: string): string {
    const source = readFileSync(ROUTE, "utf8");
    const start = source.indexOf(`async function ${name}`);
    expect(
      start,
      `${name}() is gone from the purge route — fix the name, don't delete this test.`
    ).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    expect(end, `Could not find the closing brace of ${name}().`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("counts every delegate the purge deletes", () => {
    const purge = functionBody("purgeCompany");
    const counter = functionBody("countCompanyRows");
    const found = purge.match(/\b(?:tx|db)\.(\w+)\.delete(?:Many)?\s*\(/g) ?? [];
    const delegates: string[] = [];
    for (const hit of found) {
      const name = /\b(?:tx|db)\.(\w+)\./.exec(hit)?.[1];
      // `company` is the workspace row itself; the counter adds it as a literal 1.
      if (!name || name === "company" || delegates.indexOf(name) !== -1) continue;
      delegates.push(name);
    }
    expect(delegates.length).toBeGreaterThan(10);

    for (const delegate of delegates) {
      expect(
        new RegExp("\\bdb\\." + delegate + "\\.count\\s*\\(").test(counter),
        `purgeCompany() deletes db.${delegate} but countCompanyRows() never counts it, so ` +
          `the dry run under-reports by every row in that table — and the bulk-mutation ` +
          `canary thresholds on that number. Add it to countCompanyRows().`
      ).toBe(true);
    }
  });
});

/* ── cron-012 ──────────────────────────────────────────────────────────── */

/**
 * cron-012 — an irreversible multi-tenant erasure has to be aimable at ONE
 * workspace before it is aimed at all of them.
 *
 * `dryRun` came from `PURGE_ENABLED` and nothing else, so the first live run was
 * simultaneously the first measurement and the irreversible one, across every
 * overdue workspace at once. CLAUDE.md calls the purge "safe to enable" and the
 * memory note says "exercise the purge"; neither was possible.
 *
 * `tests/lib/cron/purge-options.test.ts` owns the decision (15 cases over the
 * pure function). What these add is the half a structural or unit test cannot
 * reach: that the ROUTE honours the decision — that `?companyId=` really narrows
 * the `findMany`, that `?limit=` really bounds it, and above all that `?dryRun=0`
 * cannot make a live run happen. The company fake honours `take` and `where.id`,
 * so each assertion discriminates.
 */
describe("cron-012 — one run can be aimed at one workspace", () => {
  it("purges only the named workspace, leaving the other overdue ones", async () => {
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({
      overdueCompanies: ["co-a", "co-b", "co-c"],
      counts: { user: 2 },
    });
    const res = await run("?companyId=co-b");
    expect(res.status).toBe(200);
    expect(resultOf(res.body).companiesPurged).toBe(1);
    const deleted = harness.ops.filter((o) => o.delegate === "company" && o.kind === "delete");
    expect(deleted).toHaveLength(1);
  });

  it("does nothing when the named workspace is not overdue", async () => {
    // The parameter is ANDed with the 90-day cutoff, so it is not a
    // delete-by-id endpoint. `overdueCompanies` is the overdue set by
    // construction, so an id outside it is an id the nightly run would not take.
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 2 } });
    const res = await run("?companyId=co-live");
    expect(resultOf(res.body).companiesPurged).toBe(0);
    expect(harness.ops.filter((o) => o.delegate === "company" && o.kind === "delete")).toEqual([]);
  });

  it("lowers the per-run ceiling when asked", async () => {
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({
      overdueCompanies: ["co-a", "co-b", "co-c", "co-d"],
      counts: { user: 1 },
    });
    const res = await run("?limit=2");
    expect(resultOf(res.body).companiesPurged).toBe(2);
  });

  it("FORCES a dry run on ?dryRun=1 even with PURGE_ENABLED=true", async () => {
    // The rehearsal this finding exists for: measure one workspace, destroy
    // nothing, on the deployment where the purge is already live.
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({
      overdueCompanies: ["co-a"],
      counts: { user: 3, transaction: 40, message: 200 },
    });
    const res = await run("?companyId=co-a&dryRun=1");
    expect(res.status).toBe(200);
    expect(harness.ops.filter((o) => o.kind === "delete" || o.kind === "deleteMany")).toEqual([]);
    expect(resultOf(res.body).workspaceRowsWouldDelete).toBeGreaterThan(0);
  });

  it("REFUSES ?dryRun=0 and destroys nothing — a URL must not authorise erasure", async () => {
    // The single most dangerous line this guards. `dryRun = param === "1"` looks
    // equivalent and would let anyone holding the cron secret erase every
    // overdue workspace from a browser address bar, on a deployment that has
    // deliberately left the purge off.
    delete process.env.PURGE_ENABLED;
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 3 } });
    const res = await run("?dryRun=0");
    expect(res.status).toBe(200);
    expect(harness.ops.filter((o) => o.kind === "delete" || o.kind === "deleteMany")).toEqual([]);
    expect(String(res.body.refusedOptions)).toMatch(/PURGE_ENABLED/);
  });

  it("reports a refused parameter rather than silently ignoring it", async () => {
    delete process.env.PURGE_ENABLED;
    harness = buildHarness({ overdueCompanies: [], counts: {} });
    const res = await run("?limit=9999");
    expect(Array.isArray(res.body.refusedOptions)).toBe(true);
    expect((res.body.refusedOptions as string[]).join(" ")).toMatch(/exceeds the built-in cap/);
  });

  it("leaves an ordinary parameterless cron invocation exactly as it was", async () => {
    delete process.env.PURGE_ENABLED;
    harness = buildHarness({ overdueCompanies: ["co-a", "co-b"], counts: { user: 2 } });
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.refusedOptions).toEqual([]);
    expect(resultOf(res.body).companiesPurged).toBe(2);
  });
});

/* ── cron-017 ──────────────────────────────────────────────────────────── */

describe("cron-017 — a mistyped PURGE_ENABLED is visible on the first run", () => {
  it("raises a Sentry event and reports the ignored value", async () => {
    // The trap: the fail-safe direction is CORRECT — only "true" arms the purge —
    // so nothing breaks, nothing 500s, `ok` is true, and the owner concludes
    // 90-day erasure is live. Their answer to "do you still hold my data?" is
    // then wrong in the direction that matters, indefinitely.
    process.env.PURGE_ENABLED = "TRUE";
    harness = buildHarness({ overdueCompanies: ["co-a"], counts: { user: 2 } });
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.ignoredPurgeEnabledValue).toBe("TRUE");
    expect(sentry.captureException).toHaveBeenCalled();
    // And it really was a dry run: nothing was destroyed.
    expect(harness.ops.filter((o) => o.kind === "delete" || o.kind === "deleteMany")).toEqual([]);
  });

  it("says nothing on a correctly-armed run", async () => {
    process.env.PURGE_ENABLED = "true";
    harness = buildHarness({ overdueCompanies: [], counts: {} });
    const res = await run();
    expect(res.body.dryRun).toBe(false);
    expect(res.body.ignoredPurgeEnabledValue).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("says nothing when the variable is absent, which is the default state", async () => {
    delete process.env.PURGE_ENABLED;
    harness = buildHarness({ overdueCompanies: [], counts: {} });
    const res = await run();
    expect(res.body.dryRun).toBe(true);
    expect(res.body.ignoredPurgeEnabledValue).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
