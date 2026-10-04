/**
 * transactions-ledger-004 — imported spend must be able to belong to a project,
 * or budgets do nothing for anyone who onboards by importing.
 *
 * WHAT WAS WRONG. `bulkImportTransactionsAction` hardcoded `projectId: null` in
 * its `createMany` payload, and `ImportTransactionsSchema` had no `projectId`
 * field at all, so the importer could not express a project even if the modal
 * had offered a picker (it did not). Every Budget belongs to a project
 * (`Budget.projectId` is NOT NULL) and `lib/queries/budgets.ts` deliberately
 * counts untagged spend against no cap — so 100% of imported spend was outside
 * 100% of budget tracking. A customer who onboarded by importing their spend
 * history, which is exactly what the "Import CSV" button invites, saw every
 * budget read 0 spent and never received a single over-budget alert.
 *
 * WHAT THIS FILE PINS. Not "the schema has a field" — that would pass against
 * a field the action ignores, or one no surface can set. Each test names a
 * property the behaviour has to have:
 *
 *   • every row of the batch carries the chosen project, so the project's
 *     month-to-date spend moves and `getBudgetsWithSpend` counts it;
 *   • the tag is VERIFIED against the caller's company and against
 *     `deletedAt: null`, exactly as `addTransactionAction` verifies it — a
 *     server action is a public POST endpoint, so an unverified id here files
 *     another company's project into this company's ledger;
 *   • the 80%/100% threshold is judged once per distinct category after the
 *     batch, not per row, so an import that genuinely puts a project over its
 *     cap says so instead of waiting for the next hand-typed expense to
 *     attribute the crossing to the wrong event;
 *   • an untagged import still works and still crosses nothing — the picker is
 *     optional, and "no project" has to stay a legal answer;
 *   • a revenue or investment import may carry the tag (the project ledger
 *     shows money in as well as out) but judges no budget, matching the add
 *     path's "expenses only" rule;
 *   • the picker is REACHABLE. A capability with no caller is this repo's most
 *     documented recurrent defect, and a projectId the import modal cannot set
 *     is exactly that shape.
 *
 * The fake Prisma client is the same recorder shape as
 * tests/lib/actions/transaction-edit.test.ts: the question is likewise WHICH
 * operation the action reaches for and with WHICH arguments, which a `success`
 * assertion cannot answer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** The threshold hook, recorded rather than silenced: which (project, category)
 *  pairs an import re-judges is one of the properties under test. */
const thresholdCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: async (input: Record<string, unknown>) => {
    thresholdCalls.push(input);
  },
}));

import { bulkImportTransactionsAction } from "@/lib/actions/transactions";
import { ImportTransactionsSchema } from "@/lib/schemas/transaction";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const ROOT = process.cwd();

function read(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

function when(p: string, value: unknown): void {
  H.results.set(p, value);
}

function callsTo(p: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === p).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

/** The rows `createMany` was handed, as plain objects. */
function importedRows(): Array<Record<string, unknown>> {
  const writes = callsTo("transaction.createMany");
  expect(writes.length, "the importer wrote no rows").toBe(1);
  return (writes[0].data ?? []) as Array<Record<string, unknown>>;
}

/** Two expense rows in two different categories, both in the current month so
 *  the threshold's month-to-date window would actually see them. */
function twoExpenseRows() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { amount: 25_000, category: "Office Rent", description: "Rent", date: today },
    { amount: 4_500.5, category: "Marketing", description: "Ad spend", date: today },
    { amount: 1_200, category: "Marketing", description: "More ad spend", date: today },
  ];
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  thresholdCalls.length = 0;
  H.session.value = null;
  // The importer always reads the actor (name + workspace currency) and always
  // reports how many rows landed.
  when("user.findUnique", { name: "Saqib", company: { currency: "PKR" } });
  when("transaction.createMany", (args: Record<string, unknown>) => ({
    count: ((args.data ?? []) as unknown[]).length,
  }));
  when("activity.create", {});
  // The importer also asks which of these rows the ledger already holds
  // (transactions-ledger-008). An empty ledger here, so nothing is withheld and
  // the project-tag assertions below see the whole batch;
  // tests/lib/actions/import-duplicate-rows.test.ts is where that read is
  // exercised.
  when("transaction.findMany", []);
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("bulkImportTransactionsAction (imported spend has to reach budgets)", () => {
  it("tags every row of the batch with the chosen project", async () => {
    signedInAs("admin");
    when("project.findFirst", { id: "p1" });

    const res = await bulkImportTransactionsAction({
      type: "expense",
      projectId: "p1",
      rows: twoExpenseRows(),
    });
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const rows = importedRows();
    expect(rows.length).toBe(3);
    for (let i = 0; i < rows.length; i++) {
      expect(
        rows[i].projectId,
        "an imported expense with no projectId counts against no cap — lib/queries/budgets.ts " +
          "scopes spend to the projects that HAVE budgets, and lib/budgets/check.ts returns " +
          "early for a project-less expense, so this row is invisible to every budget"
      ).toBe("p1");
    }
  });

  it("verifies the project against the caller's company before writing anything", async () => {
    signedInAs("admin");
    // No such project in THIS company (another workspace's id, or a deleted one).
    when("project.findFirst", null);

    const res = await bulkImportTransactionsAction({
      type: "expense",
      projectId: "p-other-company",
      rows: twoExpenseRows(),
    });

    expect(res.success).toBe(false);
    expect(
      callsTo("transaction.createMany"),
      "a server action is a public POST endpoint — an unverified projectId files " +
        "spend into another company's project"
    ).toHaveLength(0);

    const lookups = callsTo("project.findFirst");
    expect(lookups.length, "the importer never looked the project up").toBe(1);
    const w = whereOf(lookups[0]);
    expect(w.id).toBe("p-other-company");
    expect(w.companyId, "the lookup must be scoped to the caller's company").toBe("c1");
    expect(
      w.deletedAt,
      "deletedAt:null, exactly as addTransactionAction does it — otherwise a stale " +
        "import modal files spend against a project that was deleted while it was open"
    ).toBe(null);
  });

  it("judges the budget threshold once per distinct category, not once per row", async () => {
    signedInAs("admin");
    when("project.findFirst", { id: "p1" });

    const res = await bulkImportTransactionsAction({
      type: "expense",
      projectId: "p1",
      rows: twoExpenseRows(),
    });
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    // Three rows, two categories → two checks. The sentinel in
    // lib/budgets/check.ts already makes a repeat harmless, but a per-row call
    // is 1,000 aggregates for a 1,000-row import.
    expect(
      thresholdCalls.length,
      "an import that puts a project over its cap has to say so — otherwise the " +
        "crossing surfaces on the next hand-typed expense and is attributed to it"
    ).toBe(2);
    const pairs = thresholdCalls.map((c) => `${String(c.projectId)}/${String(c.category)}`).sort();
    expect(pairs).toEqual(["p1/Marketing", "p1/Office Rent"]);
    for (let i = 0; i < thresholdCalls.length; i++) {
      expect(thresholdCalls[i].companyId).toBe("c1");
    }
  });

  it("still imports with no project, and crosses nothing", async () => {
    signedInAs("admin");

    const res = await bulkImportTransactionsAction({
      type: "expense",
      rows: twoExpenseRows(),
    });
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    const rows = importedRows();
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].projectId, "'no project' has to stay a legal answer").toBe(null);
    }
    expect(
      callsTo("project.findFirst"),
      "nothing to verify when no project was chosen"
    ).toHaveLength(0);
    expect(
      thresholdCalls,
      "every Budget belongs to a project, so untagged spend crosses nothing"
    ).toHaveLength(0);
  });

  it("tags a revenue import too, but judges no budget", async () => {
    signedInAs("admin");
    when("project.findFirst", { id: "p1" });
    const today = new Date().toISOString().slice(0, 10);

    const res = await bulkImportTransactionsAction({
      type: "income",
      projectId: "p1",
      rows: [{ amount: 90_000, category: "Product Sales", description: "June", date: today }],
    });
    expect(res.success, `error was: ${res.success ? "" : res.error}`).toBe(true);

    expect(importedRows()[0].projectId).toBe("p1");
    expect(
      thresholdCalls,
      "money IN counts against no cap — same rule as addTransactionAction"
    ).toHaveLength(0);
  });

  it("carries the project onto the summary activity row", async () => {
    signedInAs("admin");
    when("project.findFirst", { id: "p1" });

    await bulkImportTransactionsAction({
      type: "expense",
      projectId: "p1",
      rows: twoExpenseRows(),
    });

    const activity = callsTo("activity.create");
    expect(activity.length).toBe(1);
    expect(
      ((activity[0].data ?? {}) as Record<string, unknown>).projectId,
      "the per-project Activity tab has to show the import that moved its spend"
    ).toBe("p1");
  });
});

describe("ImportTransactionsSchema (the importer can express a project)", () => {
  it("accepts an optional projectId and treats the empty string as 'none'", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [{ amount: 10, category: "Marketing", description: "", date: today }];

    const tagged = ImportTransactionsSchema.safeParse({
      type: "expense",
      projectId: "p1",
      rows,
    });
    expect(tagged.success, "the schema drops a projectId the action then cannot see").toBe(true);
    if (tagged.success) expect(tagged.data.projectId).toBe("p1");

    // The "no project" option of a <select> submits "", which has to round-trip
    // to a SQL NULL rather than to a project id of zero length.
    const none = ImportTransactionsSchema.safeParse({ type: "expense", projectId: "", rows });
    expect(none.success).toBe(true);
    if (none.success) expect(none.data.projectId).toBeUndefined();

    const absent = ImportTransactionsSchema.safeParse({ type: "expense", rows });
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.projectId).toBeUndefined();
  });
});

describe("the import modal can actually set it (reachability)", () => {
  const MODAL = "components/transactions/import-transactions-modal.tsx";

  it("offers a project picker and sends the choice", () => {
    const src = read(MODAL);
    expect(
      /projects\??:/.test(src),
      "the modal takes no projects prop, so the schema field below it is a capability with no caller"
    ).toBe(true);
    expect(
      src.indexOf("projectId") > -1,
      "the modal never sends a projectId, so imported spend still reaches no budget"
    ).toBe(true);
    expect(
      /<select/.test(src),
      "nothing on screen lets the customer choose the project — the picker is the half " +
        "that makes the server change reachable"
    ).toBe(true);
  });

  it("takes `projects` as a REQUIRED prop, so a fourth render site cannot omit it", () => {
    // The test below enumerates the three clients that exist TODAY, so it is
    // blind to a fourth. The compiler is not. While the prop was
    // `projects?: …` with a `[]` default, a new render site could leave it out
    // with no error and silently revert that page to "an import can never be
    // tagged" — the finding itself, in the shape this repo keeps hitting
    // (shipped, tested, unreachable). A required prop asks every present and
    // future caller. `[]` is still a legal answer; omitting it is not.
    const src = read(MODAL);
    expect(
      /\bprojects\?:/.test(src),
      "`projects` is optional again — the one thing that makes the action's projectId " +
        "reachable can be dropped by a caller without a compiler error"
    ).toBe(false);
    expect(
      /\bprojects: \{ id: string; name: string \}\[\];/.test(src),
      "the modal no longer declares a required `projects` array"
    ).toBe(true);
    expect(
      /\bprojects = \[\]/.test(src),
      "a `[]` default in the destructuring makes the prop optional at the call site again"
    ).toBe(false);
  });

  it("is handed the workspace's projects by all three ledger clients", () => {
    // Pinned from the caller side: every one of these already receives a
    // `projects` array for TransactionForm, so an import modal that does not
    // get it is a page that silently cannot tag its import.
    const clients = [
      "app/(app)/expenses/expenses-client.tsx",
      "app/(app)/revenue/revenue-client.tsx",
      "app/(app)/investments/investments-client.tsx",
    ];
    for (let i = 0; i < clients.length; i++) {
      const src = read(clients[i]);
      const at = src.indexOf("<ImportTransactionsModal");
      expect(at, `${clients[i]} no longer renders the import modal`).toBeGreaterThan(-1);
      const tag = src.slice(at, src.indexOf("/>", at));
      expect(
        tag.indexOf("projects=") > -1,
        `${clients[i]} renders the import modal without projects, so its import cannot be tagged`
      ).toBe(true);
    }
  });
});
