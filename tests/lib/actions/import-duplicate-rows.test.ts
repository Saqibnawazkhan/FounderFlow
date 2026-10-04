/**
 * transactions-ledger-008 — importing the same CSV twice must not silently
 * double the ledger.
 *
 * WHAT WAS WRONG. `bulkImportTransactionsAction` handed its rows straight to
 * `transaction.createMany`, which inserts whatever it is given. Nothing else
 * could catch it: `Transaction`'s only unique key is `@@unique([ruleId, date])`
 * (prisma/schema.prisma:435) and a composite unique treats rows as distinct
 * whenever a column is NULL, so every imported row (`ruleId IS NULL`) sits
 * outside it. There is no unique index on the money fields, no import-batch
 * column, and no dedup pass in the modal — even two byte-identical lines inside
 * ONE file both inserted.
 *
 * The result is doubled burn, doubled revenue, doubled budget spend and a
 * doubled runway denominator, with nothing distinguishing the copies and no
 * remedy but deleting rows one at a time. And the trigger is not carelessness:
 * it is the retry after an import that looked like it failed.
 *
 * WHAT THIS FILE PINS. Not "a helper exists" — the contract the customer gets:
 *
 *   • a second import of a file already in the ledger writes NOTHING and says
 *     so, instead of succeeding quietly;
 *   • the overlap case — a bank re-export covering some new days — imports only
 *     the new rows;
 *   • duplicates are REPORTED AS ROWS, not swallowed, so the modal can offer
 *     "import anyway": two identical charges on one day are possible, and
 *     silently dropping a real transaction is the same class of defect as
 *     silently doubling one;
 *   • the explicit override imports everything and does not even run the
 *     lookup;
 *   • the ledger's copy counts even when it was stored by the PRE-003 importer
 *     east of UTC — i.e. 19:00Z on the day before, which is how every CSV row
 *     this product has imported in its home market is stored. That population
 *     is the one most likely to hit the finding, so it cannot be the one the
 *     guard waves through;
 *   • the lookup is scoped to the caller's company, the batch's own date window
 *     (one day either side, for the rows above), the batch's own distinct
 *     amounts and `deletedAt: null` — a row the customer deleted on purpose
 *     must not block re-importing it;
 *   • near misses are NOT duplicates (one cent, one day, a different memo), or
 *     the guard eats real rows;
 *   • `skipped` keeps meaning "bad category" and does not absorb the duplicate
 *     count, because the two need different remedies.
 *
 * The fake Prisma client is the same recorder shape as
 * tests/lib/actions/import-project-tag.test.ts: the question is likewise WHICH
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
vi.mock("@/lib/budgets/check", () => ({ checkBudgetThresholdAfterExpense: async () => {} }));

import { bulkImportTransactionsAction } from "@/lib/actions/transactions";
import { ImportTransactionsSchema } from "@/lib/schemas/transaction";
import {
  importDateWindow,
  ledgerRowKey,
  splitDuplicateImportRows,
  storedLedgerRowKeys,
  storedRowCandidateDays,
} from "@/lib/transactions/import-dedupe";

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

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

type Row = { amount: number; category: string; description: string; date: string };

/** Three expense rows on three days — the file a customer imports, then
 *  imports again after the dialog looked stuck. */
function threeRows(): Row[] {
  return [
    { amount: 25_000, category: "Office Rent", description: "June rent", date: "2026-06-01" },
    { amount: 4_500.5, category: "Marketing", description: "Ad spend", date: "2026-06-02" },
    { amount: 1_200, category: "Marketing", description: "More ad spend", date: "2026-06-03" },
  ];
}

/**
 * A live ledger row as the duplicate lookup's `select` returns it, stored at an
 * EXPLICIT instant. `amount` stands in for `Prisma.Decimal` — the action reads
 * `.toFixed(2)` off it, which is what makes `25000` and `25000.00` reduce to
 * one key.
 */
function ledgerRowAt(r: Row, storedAt: Date): unknown {
  return {
    date: storedAt,
    amount: { toFixed: (dp: number) => r.amount.toFixed(dp) },
    category: r.category,
    description: r.description,
  };
}

/** The same row as every post-fix writer stores it: UTC midnight (money-007). */
function ledgerRow(r: Row): unknown {
  return ledgerRowAt(r, new Date(`${r.date}T00:00:00.000Z`));
}

/**
 * The same row as the PRE-003 importer stored it in Karachi (UTC+5), this
 * product's home market: the cell went to `new Date(cell)`, which reads a
 * non-ISO cell — and an ISO one carrying a clock time — as LOCAL midnight, so
 * the stored instant is 19:00Z on the PREVIOUS UTC day. Verified under
 * TZ=Asia/Karachi:
 *
 *     new Date("06/01/2026").toISOString()          === "2026-05-31T19:00:00.000Z"
 *     new Date("2026-06-01 00:00:00").toISOString() === "2026-05-31T19:00:00.000Z"
 *
 * Written as a literal UTC instant rather than by parsing a local string, so
 * the test says the same thing under the suite's own TZ pin.
 */
function ledgerRowStoredEastOfUtc(r: Row): unknown {
  const localMidnight = new Date(`${r.date}T00:00:00.000Z`).getTime() - 5 * 60 * 60 * 1000;
  return ledgerRowAt(r, new Date(localMidnight));
}

/** The rows `createMany` was handed, as plain objects. */
function importedRows(): Array<Record<string, unknown>> {
  const writes = callsTo("transaction.createMany");
  expect(writes.length, "the importer wrote no rows").toBe(1);
  return (writes[0].data ?? []) as Array<Record<string, unknown>>;
}

async function importBatch(input: Record<string, unknown>) {
  const res = await bulkImportTransactionsAction(input);
  if (!res.success) throw new Error(`import failed: ${res.error}`);
  return res.data;
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = null;
  when("user.findUnique", { name: "Saqib", company: { currency: "PKR" } });
  when("transaction.createMany", (args: Record<string, unknown>) => ({
    count: ((args.data ?? []) as unknown[]).length,
  }));
  when("activity.create", {});
  // An empty ledger unless a test says otherwise.
  when("transaction.findMany", []);
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("bulkImportTransactionsAction — a second import of the same file", () => {
  it("writes nothing and hands back every row it withheld", async () => {
    signedInAs("admin");
    const rows = threeRows();
    when("transaction.findMany", rows.map(ledgerRow));

    const data = await importBatch({ type: "expense", rows });

    expect(
      callsTo("transaction.createMany"),
      "createMany inserts whatever it is given — a re-import doubles burn, revenue, " +
        "budget spend and the runway denominator with nothing marking the copies"
    ).toHaveLength(0);
    expect(data.imported).toBe(0);
    expect(
      data.duplicates.map((d) => d.description),
      "the withheld rows come back so the modal can offer 'import anyway' — a count " +
        "alone leaves the customer with no way to file a genuine repeat charge"
    ).toEqual(["June rent", "Ad spend", "More ad spend"]);
    expect(
      callsTo("activity.create"),
      "an import that wrote nothing must not log 'imported 0 entries from CSV'"
    ).toHaveLength(0);
  });

  it("catches it when the ledger's copy was stored by the PRE-003 importer, east of UTC", async () => {
    // The population this matters for is not exotic: every CSV row this product
    // has ever imported predates `lib/transactions/ledger-date.ts`, and in a
    // UTC+5 market every one of them whose cell was non-ISO — or ISO with a
    // clock time — was stored at 19:00Z on the day BEFORE the day the customer
    // meant. Re-importing that exact file is the finding's own failure mode, so
    // it cannot be the one case the guard waves through.
    //
    // This test pins the KEY. Whether such a row is even FETCHED is the lookup
    // window's job, which the next test pins — the fake client hands back
    // whatever is canned regardless of the `where`.
    signedInAs("admin");
    const rows = threeRows();
    when("transaction.findMany", rows.map(ledgerRowStoredEastOfUtc));

    const data = await importBatch({ type: "expense", rows });

    expect(
      callsTo("transaction.createMany"),
      "a pre-003 row is a duplicate the customer cannot spot by eye — its date reads " +
        "as the day before in every ledger view, so re-importing the file doubles it"
    ).toHaveLength(0);
    expect(data.imported).toBe(0);
    expect(data.duplicates.map((d) => d.description)).toEqual([
      "June rent",
      "Ad spend",
      "More ad spend",
    ]);
  });

  it("does not treat a midnight-stored row as a duplicate of the NEXT day", async () => {
    // The flip side of the test above, and the reason the widening is keyed on
    // the stored time-of-day rather than applied to every row: a row stored at
    // UTC midnight is a post-fix row whose day is exact, and a real charge on
    // the next day for the same amount, category and memo — a daily ad spend, a
    // rent correction — must still import.
    signedInAs("admin");
    const existing: Row = {
      amount: 1_200,
      category: "Marketing",
      description: "Ad spend",
      date: "2026-06-02",
    };
    when("transaction.findMany", [ledgerRow(existing)]);

    const data = await importBatch({
      type: "expense",
      rows: [{ ...existing, date: "2026-06-03" }],
    });

    expect(data.imported, "a guard that eats real rows is worse than the doubling").toBe(1);
    expect(data.duplicates).toEqual([]);
  });

  it("looks only at this company's live rows, in the batch's own date window", async () => {
    signedInAs("admin");
    await importBatch({ type: "expense", rows: threeRows() });

    const lookups = callsTo("transaction.findMany");
    expect(lookups.length, "the importer never asked what it already had").toBe(1);
    const w = whereOf(lookups[0]);
    expect(w.companyId, "an unscoped lookup reads another workspace's ledger").toBe("c1");
    expect(w.type, "an expense cannot be a duplicate of a revenue row").toBe("expense");
    expect(
      w.deletedAt,
      "a row the customer deleted on purpose must not block re-importing it"
    ).toBe(null);

    // Half-open, and a full day wider than the batch at BOTH ends, because a
    // pre-003 row for one of the batch's days is not stored on that UTC day:
    //   • west of UTC it sits later the same day (05:00Z) — a `lte maxDay`
    //     bound would miss it on the last day of the batch;
    //   • east of UTC it sits on the day BEFORE (19:00Z at UTC+5), so a
    //     `gte minDay` bound excludes it outright. That is the market this
    //     product is built in, so it is not the edge case.
    const span = w.date as { gte: Date; lt: Date };
    expect(
      span.gte.toISOString(),
      "the window must reach back a day, or the ledger's own copy of a pre-003 row " +
        "is never fetched and the duplicate cannot be seen at all"
    ).toBe("2026-05-31T00:00:00.000Z");
    expect(span.lt.toISOString()).toBe("2026-06-04T00:00:00.000Z");
  });

  it("reads only the amounts this batch could collide with", async () => {
    // The lookup had no ceiling of any kind: a customer importing five years of
    // history — which onboarding explicitly invites — pulled every row of that
    // ledger direction in those five years into memory. Filtering on the
    // batch's own amounts cannot lose a duplicate, because `amount` is part of
    // the key: a row with a different amount is not one.
    signedInAs("admin");
    await importBatch({
      type: "expense",
      rows: [
        { amount: 25_000, category: "Office Rent", description: "June rent", date: "2026-06-01" },
        { amount: 25_000, category: "Office Rent", description: "July rent", date: "2026-06-02" },
        { amount: 4_500.5, category: "Marketing", description: "Ad spend", date: "2026-06-03" },
      ],
    });

    const w = whereOf(callsTo("transaction.findMany")[0]);
    const amounts = (w.amount as { in: unknown[] }).in.map((a) => Number(String(a)));
    expect(
      amounts.length,
      "one entry per DISTINCT amount — a 1000-row file must not send 1000 bind params " +
        "when it only names two numbers"
    ).toBe(2);
    expect(amounts.sort((a, b) => a - b)).toEqual([4_500.5, 25_000]);
  });

  it("imports only the new rows when a re-export overlaps", async () => {
    signedInAs("admin");
    const rows = threeRows();
    // The customer re-exports from the bank; the first two days are already in.
    when("transaction.findMany", [ledgerRow(rows[0]), ledgerRow(rows[1])]);

    const data = await importBatch({ type: "expense", rows });

    expect(data.imported).toBe(1);
    expect(importedRows().map((r) => r.description)).toEqual(["More ad spend"]);
    expect(data.duplicates.map((d) => d.description)).toEqual(["June rent", "Ad spend"]);
    expect(
      data.skipped,
      "`skipped` means 'bad category' and needs a different remedy — folding duplicates " +
        "into it tells the customer to go fix categories that are fine"
    ).toBe(0);
  });

  it("records on the activity row how many rows were held back", async () => {
    signedInAs("admin");
    const rows = threeRows();
    when("transaction.findMany", [ledgerRow(rows[0])]);

    await importBatch({ type: "expense", rows });

    const activity = callsTo("activity.create");
    expect(activity.length).toBe(1);
    const message = String(((activity[0].data ?? {}) as Record<string, unknown>).message);
    expect(message, "the audit trail is where a double import is diagnosed afterwards").toContain(
      "imported 2"
    );
    expect(message).toContain("1");
    expect(message.toLowerCase()).toContain("duplicate");
  });
});

describe("bulkImportTransactionsAction — duplicates inside one file", () => {
  it("keeps the first of two byte-identical lines and withholds the repeat", async () => {
    signedInAs("admin");
    const row: Row = {
      amount: 25_000,
      category: "Office Rent",
      description: "June rent",
      date: "2026-06-01",
    };

    const data = await importBatch({ type: "expense", rows: [row, row] });

    expect(
      importedRows().length,
      "no database lookup can see this one — after the first import each copy makes " +
        "the other look legitimate"
    ).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.duplicates.length).toBe(1);
  });

  it("treats a re-cased, re-spaced memo as the same row", async () => {
    signedInAs("admin");
    // Only the description varies: `category` is canonicalised long before this
    // point (the modal maps it, the action drops anything outside the type's
    // set), but the memo is free text a spreadsheet round-trip can re-case or
    // re-space, and that has not produced a second transaction.
    const rows: Row[] = [
      { amount: 1_200, category: "Marketing", description: "Ad spend", date: "2026-06-02" },
      { amount: 1_200, category: "Marketing", description: "ad  spend", date: "2026-06-02" },
    ];

    const data = await importBatch({ type: "expense", rows });

    expect(data.imported).toBe(1);
    expect(data.duplicates.length).toBe(1);
    expect(data.skipped, "neither row has a bad category").toBe(0);
  });
});

describe("bulkImportTransactionsAction — what is NOT a duplicate", () => {
  it("imports rows that differ by a cent, a day, or a memo", async () => {
    signedInAs("admin");
    const existing: Row = {
      amount: 1_200,
      category: "Marketing",
      description: "Ad spend",
      date: "2026-06-02",
    };
    when("transaction.findMany", [ledgerRow(existing)]);

    const rows: Row[] = [
      { ...existing, amount: 1_200.01 },
      { ...existing, date: "2026-06-03" },
      { ...existing, description: "Ad spend (second campaign)" },
      { ...existing, category: "Office Rent" },
    ];

    const data = await importBatch({ type: "expense", rows });

    expect(
      data.imported,
      "a guard that eats real rows is worse than the doubling it prevents"
    ).toBe(4);
    expect(data.duplicates).toEqual([]);
  });

  it("imports everything, and asks the ledger nothing, when told to allow duplicates", async () => {
    signedInAs("admin");
    const rows = threeRows();
    when("transaction.findMany", rows.map(ledgerRow));

    const data = await importBatch({ type: "expense", rows, allowDuplicates: true });

    expect(
      importedRows().length,
      "'import anyway' is the escape hatch for two real identical charges — without it " +
        "the guard silently destroys a transaction"
    ).toBe(3);
    expect(data.imported).toBe(3);
    expect(data.duplicates).toEqual([]);
    expect(
      callsTo("transaction.findMany"),
      "the customer has already answered the question — asking again is a wasted read"
    ).toHaveLength(0);
  });
});

describe("ImportTransactionsSchema — the override has to be expressible", () => {
  it("defaults allowDuplicates to false and accepts an explicit true", () => {
    const rows = [{ amount: 10, category: "Marketing", description: "", date: "2026-06-01" }];

    const absent = ImportTransactionsSchema.safeParse({ type: "expense", rows });
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(
        absent.data.allowDuplicates,
        "the safe answer has to be the default — a missing flag must never mean 'yes, double it'"
      ).toBe(false);
    }

    const explicit = ImportTransactionsSchema.safeParse({
      type: "expense",
      rows,
      allowDuplicates: true,
    });
    expect(explicit.success, "the schema drops a flag the action then cannot see").toBe(true);
    if (explicit.success) expect(explicit.data.allowDuplicates).toBe(true);
  });
});

describe("splitDuplicateImportRows / importDateWindow (the pure decision)", () => {
  const row = (over: Partial<Row> = {}): Row => ({
    amount: 100,
    category: "Marketing",
    description: "Ad spend",
    date: "2026-06-02",
    ...over,
  });

  it("matches on the UTC day, not the stored instant", () => {
    // Rows written before lib/transactions/ledger-date.ts landed kept LOCAL
    // midnight, so the duplicate of exactly those rows would be missed by an
    // instant comparison.
    const existing = ledgerRowKey({
      type: "expense",
      date: new Date("2026-06-02T05:00:00.000Z"),
      amount: "100.00",
      category: "Marketing",
      description: "Ad spend",
    });
    const split = splitDuplicateImportRows("expense", [row()], [existing]);
    expect(split.fresh).toEqual([]);
    expect(split.duplicates.length).toBe(1);
  });

  it("normalises case in an existing row's category", () => {
    // Defensive, for rows already in the table: the action canonicalises an
    // INCOMING category against the type's set, but a stored row predates that
    // and only has to be compared, not corrected.
    const existing = ledgerRowKey({
      type: "expense",
      date: "2026-06-02",
      amount: "100.00",
      category: "marketing",
      description: "AD SPEND",
    });
    const split = splitDuplicateImportRows("expense", [row()], [existing]);
    expect(split.duplicates.length).toBe(1);
  });

  it("does not mutate the caller's key list", () => {
    const keys: string[] = [];
    splitDuplicateImportRows("expense", [row(), row()], keys);
    expect(keys).toEqual([]);
  });

  it("ignores the project tag, so the same file cannot land twice by re-tagging", () => {
    // The key carries no projectId on purpose: a re-import tagged to a
    // different project is still the same spend.
    const a = ledgerRowKey({
      type: "expense",
      date: "2026-06-02",
      amount: "100.00",
      category: "Marketing",
      description: "Ad spend",
    });
    const split = splitDuplicateImportRows("expense", [row()], [a]);
    expect(split.duplicates.length).toBe(1);
  });

  it("spans every instant a row for one of the batch's days could be stored at", () => {
    // One day either side of the batch, and no more: a pre-003 row for day D
    // sits anywhere in [D-1, D+1) depending on the writer's offset (19:00Z on
    // D-1 at UTC+5, 05:00Z on D at UTC-5). Narrower and the row is never
    // fetched; wider and the lookup reads days nothing in the batch can match.
    const span = importDateWindow([
      row({ date: "2026-06-10" }),
      row({ date: "2026-06-02" }),
      row({ date: "2026-06-07" }),
    ]);
    expect(span?.gte.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(span?.lt.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    expect(importDateWindow([]), "an empty batch has no window to query").toBeNull();
  });
});

describe("storedRowCandidateDays — which day a stored instant was written FOR", () => {
  // The UTC-day reduction above is not enough on its own, and the module used
  // to claim it was. `new Date(cell)` on a pre-003 import stored LOCAL
  // midnight, and which UTC day that lands on depends on the sign of the
  // offset: 05:00Z on the same day west of UTC, 19:00Z on the day BEFORE east
  // of it. The action-level test at the top of this file is the red proof;
  // these pin the boundaries of the widening, because a widening that is one
  // step too generous eats real rows.

  it("offers one day only for a row stored at UTC midnight", () => {
    expect(
      storedRowCandidateDays(new Date("2026-06-01T00:00:00.000Z")),
      "everything written since ledger-date.ts landed is exact — widening it would flag " +
        "a real next-day charge with the same amount and memo"
    ).toEqual(["2026-06-01"]);
  });

  it("offers the following day for an east-of-UTC local midnight", () => {
    // UTC+5 Karachi, UTC+5:30 India, UTC+5:45 Nepal, UTC+14 Kiritimati — the
    // furthest east there is, and the 10:00Z end of the band.
    expect(storedRowCandidateDays(new Date("2026-05-31T19:00:00.000Z"))).toEqual([
      "2026-05-31",
      "2026-06-01",
    ]);
    expect(storedRowCandidateDays(new Date("2026-05-31T18:30:00.000Z"))).toEqual([
      "2026-05-31",
      "2026-06-01",
    ]);
    expect(storedRowCandidateDays(new Date("2026-05-31T18:15:00.000Z"))).toEqual([
      "2026-05-31",
      "2026-06-01",
    ]);
    expect(storedRowCandidateDays(new Date("2026-05-31T10:00:00.000Z"))).toEqual([
      "2026-05-31",
      "2026-06-01",
    ]);
  });

  it("offers one day only for a WEST-of-UTC local midnight, which is already on it", () => {
    // 05:00Z is UTC-5 — the suite's own TZ pin, and the case the UTC-day
    // reduction always handled.
    expect(storedRowCandidateDays(new Date("2026-06-01T05:00:00.000Z"))).toEqual(["2026-06-01"]);
  });

  it("offers one day only for an instant no real offset could have produced", () => {
    // A timestamp, not somebody's midnight: zone offsets are whole quarter
    // hours, so 14:32:07 is nobody's.
    expect(storedRowCandidateDays(new Date("2026-06-01T14:32:07.000Z"))).toEqual(["2026-06-01"]);
    // 09:00Z would need UTC+15. There is no such zone.
    expect(storedRowCandidateDays(new Date("2026-06-01T09:00:00.000Z"))).toEqual(["2026-06-01"]);
  });
});

describe("storedLedgerRowKeys — the keys a stored row is compared under", () => {
  it("makes a pre-003 Karachi row collide with the file it was imported from", () => {
    const existing = storedLedgerRowKeys({
      type: "expense",
      date: new Date("2026-05-31T19:00:00.000Z"),
      amount: "100.00",
      category: "Marketing",
      description: "Ad spend",
    });
    expect(existing).toHaveLength(2);

    const split = splitDuplicateImportRows(
      "expense",
      [{ amount: 100, category: "Marketing", description: "Ad spend", date: "2026-06-01" }],
      existing
    );
    expect(split.fresh).toEqual([]);
    expect(split.duplicates).toHaveLength(1);
  });
});

describe("the import modal renders the withheld rows and the override", () => {
  // WHAT THIS PROVES, AND WHAT IT DOES NOT. A capability with no caller is
  // this repo's most documented recurrent defect, and a withheld-rows report
  // nothing renders is exactly that shape. But a source grep CANNOT detect it:
  // a tester mutated the modal's `if (duplicates.length > 0)` to `if (false)`
  // and the two assertions below still passed, because the destructure and the
  // `allowDuplicates` argument survive dead code. This is a wiring check — the
  // modal still references both halves — and nothing more.
  //
  // THE ACTUAL GUARD is tests/components/import-modal-duplicate-prompt.test.tsx,
  // which mounts the modal and drives it: 5 of its 7 cases failed under that
  // same mutation. Anything that claims reachability for this fix belongs
  // there, not here.
  const MODAL = "components/transactions/import-transactions-modal.tsx";

  it("still references the override flag and the withheld rows", () => {
    const src = read(MODAL);
    expect(
      src.indexOf("allowDuplicates") > -1,
      "the modal can never say 'import anyway', so a genuine repeat charge cannot be imported"
    ).toBe(true);
    expect(
      /duplicate/i.test(src),
      "nothing on screen tells the customer rows were held back — the import reads as a " +
        "success that quietly did less than it said"
    ).toBe(true);
  });
});
