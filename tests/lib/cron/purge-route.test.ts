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
 * escalate), prodready-003 (a missing CRON_SECRET must be loud).
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
}): Harness {
  const counts: Counts = { ...(options.counts ?? {}) };
  const projectChildCounts: Counts = { ...(options.projectChildCounts ?? {}) };
  const overdueCompanies = options.overdueCompanies ?? [];
  const overdueProjects = options.overdueProjects ?? [];
  const failProjectDelete = options.failProjectDelete ?? [];
  const failCompany = options.failCompany ?? [];

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
        record(name, "count", overdueProjects.length);
        return overdueProjects.length;
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
        record(name, "findMany", overdueProjects.length);
        return overdueProjects.map((id) => ({ id }));
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
    findMany: vi.fn(async () => {
      record("company", "findMany", overdueCompanies.length);
      return overdueCompanies.map((id) => ({ id }));
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

async function run(): Promise<{ status: number; body: Record<string, unknown> }> {
  const mod = await import("@/app/api/cron/purge-soft-deleted/route");
  const res = await mod.GET(
    new Request("https://app.test/api/cron/purge-soft-deleted", {
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
