/**
 * Read-side queries for transactions. Mirrors lib/actions/transactions.ts
 * `listTransactionsAction` but for direct calls from async server components
 * — no ActionResult wrapper, no `"use server"` round-trip, just data.
 *
 * Writes still live in lib/actions/transactions.ts (server actions).
 *
 * ── WHO MAY ASK (sec-002) ──────────────────────────────────────────────────
 * Every read below starts at `requireFinanceSession()`, not
 * `requireScopedSession()`. `requireScopedSession` proves only that SOMEBODY is
 * signed in; the finance predicate was left to `authorized()` in auth.config.ts,
 * which reads `role` out of the caller's own cookie, and the Edge `jwt` callback
 * refreshes nothing — so a demoted co-founder who blocks the one
 * /api/auth/session request kept reading the full company ledger for the JWT
 * lifetime (30 days). The gate lives HERE, where the rows are fetched, so it
 * covers every route and every server action that reaches the same query rather
 * than only the one page that remembered (/reports).
 *
 * EVERY CALLER OF THIS MODULE IS A FINANCE SURFACE, which is what makes a
 * redirect safe. /dashboard, /expenses, /revenue, /investments and /reports are
 * all in `MEMBER_BLOCKED_ROUTES`. The two callers that are NOT blocked routes
 * both ask the predicate before they call: app/(app)/team/page.tsx passes
 * `canSeeFin ? getTransactions() : Promise.resolve([])`, and
 * `postRunwayCardAction` refuses on `canPostRunwayCard` (which delegates to
 * `canSeeFinances`) three steps before it reads. So no member reaches these
 * functions on a legitimate path, and the redirect only ever fires for the stale
 * cookie it exists to stop. Pinned in tests/lib/queries/finance-reader-gates.test.ts.
 *
 * ── TWO KINDS OF READ, AND WHY THE DIFFERENCE MATTERS (money-008) ───────────
 *
 * ROW READS (`getTransactions`) are for rendering a LIST. They are windowed:
 * bounded by type, optionally by date, and always by a row ceiling.
 *
 * ROLL-UPS (`getTransactionTotals`, `getMonthlyTotals`,
 * `getExpenseTotalsByCategory`) are for rendering a NUMBER. They run as
 * `groupBy` in SQL and have no ceiling at all, because an aggregate with a
 * `take` is an aggregate that is quietly wrong.
 *
 * That split is the whole point of this file's shape. Before it, every finance
 * surface — /dashboard, /expenses, /revenue, /investments, /reports, /team and
 * the chat runway card — received ONE capped, untyped `findMany` of 5,000 rows
 * and reduced it client-side. Two failures followed, and the second is the
 * nastier:
 *
 *   • Totals understated past the ceiling, silently. The dropped rows are the
 *     OLDEST, which for a startup are the seed investments, so
 *     `balance = investments + revenue − expenses` loses money-IN first: balance
 *     and runway both fell as the workspace grew. No error, no banner, no log
 *     line. The customer's only clue was that their own numbers stopped
 *     matching their bank.
 *   • One ceiling spanned all three types, so a workspace whose 5,000 newest
 *     rows are expenses rendered /revenue as literally empty ("No revenue yet")
 *     while its income rows sat untouched in the table.
 *     `bulkImportTransactionsAction` accepts 1,000 rows per import — five
 *     imports reach it.
 *
 * The header comment that used to sit here filed this as a performance
 * follow-up. It was a correctness bug with a performance cause, which is why it
 * survived: nobody reviews a perf TODO for wrong money.
 *
 * ── WHAT IS STILL OWED ─────────────────────────────────────────────────────
 * The roll-ups exist and are correct, and NOTHING CALLS THEM YET. Every one of
 * the seven finance surfaces still calls `getTransactions()` with no type and no
 * date window, and reduces the windowed array client-side:
 *
 *   app/(app)/dashboard/page.tsx   app/(app)/expenses/page.tsx
 *   app/(app)/revenue/page.tsx     app/(app)/investments/page.tsx
 *   app/(app)/reports/page.tsx     app/(app)/team/page.tsx
 *   lib/actions/chat.ts:1294 (the runway card)
 *
 * So a workspace past the per-type ceiling still sees understated all-time
 * totals — just no longer an EMPTY page, and no longer without a warning in the
 * ops feed. Worth stating plainly because a correct-and-unreached roll-up looks
 * exactly like a fix from inside this file: it is the shape of six previous bugs
 * in this repo (see tests/lib/actions/reachability.test.ts). Wiring is one prop
 * per surface; those page files are owned elsewhere in this wave.
 *
 * `getContributionTotalsByUser` was the last MISSING roll-up, not just an
 * unwired one: /dashboard's founder-contribution card and /team's per-member
 * "contributed / spent" cells aggregate PER PERSON, and no per-person aggregate
 * existed, so neither could be wired at all. It is the figure most likely to be
 * wrong, because the rows a ceiling drops are the oldest and a startup's oldest
 * rows are its seed investments.
 *
 * Tested in tests/lib/queries/transaction-rollups.test.ts and
 * tests/lib/queries/transaction-contributions.test.ts.
 */

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import { requireFinanceSession } from "@/lib/queries/session";
import { startOfUtcMonth, utcMonthShortLabel, utcMonthWindow } from "@/lib/date-range";
import type { Transaction } from "@/lib/types";

export type TransactionWithCount = Transaction & { commentCount: number };

/**
 * The three ledger types, as stored in `Transaction.type`. Enumerated rather
 * than inferred so a roll-up always reports every type — a type with no rows
 * this month has to come back as 0, not as a missing key that renders "NaN".
 */
export const TRANSACTION_TYPES = ["expense", "income", "investment"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).indexOf(value) !== -1;
}

/**
 * Row ceiling, applied PER TYPE rather than across all three.
 *
 * Per type is the load-bearing word. A shared ceiling let one noisy type starve
 * the others, which is how /revenue rendered empty for a workspace that had
 * revenue. A per-type window cannot do that: the worst case is three full
 * windows, and the worst case is bounded and visible (see `noteReadCeiling`).
 *
 * 5,000 still covers years of a normal startup's activity. It exists because a
 * list read is unbounded otherwise: a high-volume workspace would ship its
 * entire history in the RSC payload on every page load. It is NOT a limit on
 * any total — totals go through the roll-ups, which have none.
 */
export const MAX_TRANSACTIONS_PER_TYPE = 5000;

/** How many months `getMonthlyTotals` will chart. One aggregate per month, so
 *  the bound keeps "all time" on a five-year-old workspace from fanning out
 *  into sixty queries. */
export const MAX_SERIES_MONTHS = 24;

/** A half-open date window, `[from, to)`, matching lib/date-range.ts and the
 *  `gte`/`lt` every server query already passes Prisma. */
export interface DateWindow {
  from?: Date;
  to?: Date;
}

export interface TransactionQuery extends DateWindow {
  /** Omit to read every type (one windowed query each). */
  type?: TransactionType;
  /** Clamped to `MAX_TRANSACTIONS_PER_TYPE`; a caller cannot lift the ceiling. */
  take?: number;
}

function toClient(
  t: {
    id: string;
    companyId: string;
    type: string;
    // Prisma.Decimal on read (P0-4). RSC/client boundary needs a plain
    // number for JSON serialization, so we convert here.
    amount: Prisma.Decimal;
    category: string;
    description: string;
    date: Date;
    addedBy: string;
    addedByName: string;
    createdAt: Date;
  },
  commentCount = 0
): TransactionWithCount {
  return {
    id: t.id,
    companyId: t.companyId,
    type: t.type as Transaction["type"],
    amount: t.amount.toNumber(),
    category: t.category,
    description: t.description,
    date: t.date.toISOString(),
    addedBy: t.addedBy,
    addedByName: t.addedByName,
    createdAt: t.createdAt.toISOString(),
    commentCount,
  };
}

/** `{ date: { gte, lt } }`, or nothing when the caller passed no window.
 *  Half-open on purpose — see lib/date-range.ts for why an inclusive end is a
 *  bug waiting to happen. */
function dateFilter(window: DateWindow): { date?: { gte?: Date; lt?: Date } } {
  if (!window.from && !window.to) return {};
  return {
    date: {
      ...(window.from ? { gte: window.from } : {}),
      ...(window.to ? { lt: window.to } : {}),
    },
  };
}

/**
 * Say out loud that a window filled up.
 *
 * "No error, no banner, no log line" was half of money-008: the ceiling was
 * reached silently, so the first person to learn the numbers were short was the
 * customer. This is the same fire-and-continue telemetry shape as
 * lib/safety/bulk-mutation-guard.ts — a warning, never a throw, because the
 * rows we DID read are fine and the page must still render.
 *
 * A full window is only suspicious, not proof: a workspace with exactly 5,000
 * expenses trips it too. That is the right side to err on. The alert tag
 * `boundary: read-ceiling` is what an ops rule can page on.
 */
function noteReadCeiling(type: TransactionType, count: number, companyId: string): void {
  if (count < MAX_TRANSACTIONS_PER_TYPE) return;
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[getTransactions] ${type} window is full at ${count} rows for company ${companyId} — list views are truncated; totals must come from the roll-ups, not this array.`
    );
    Sentry.captureMessage(`Transaction read ceiling reached for ${type}`, {
      level: "warning",
      tags: { boundary: "read-ceiling", transactionType: type, companyId },
      extra: { rowCount: count, ceiling: MAX_TRANSACTIONS_PER_TYPE },
    });
  } catch (err) {
    // Telemetry must never take a finance page down.
    captureServerError(err, { action: "noteReadCeiling", companyId });
  }
}

/**
 * Windowed row read for LIST rendering.
 *
 * With no `type`, this runs one query per type in parallel and merges — see
 * `MAX_TRANSACTIONS_PER_TYPE` for why the ceiling is per type. Pass the `type`
 * (and, where the surface has one, the date window) and the filter is done in
 * SQL instead of in JavaScript over rows the page then throws away.
 *
 * DO NOT SUM THE RESULT. It is a window; the totals live in
 * `getTransactionTotals` / `getMonthlyTotals` / `getExpenseTotalsByCategory`.
 */
export async function getTransactions(
  query: TransactionQuery = {}
): Promise<TransactionWithCount[]> {
  const { companyId } = await requireFinanceSession();
  // A caller cannot lift the ceiling, only lower it: an unbounded `take` from a
  // page is the original unbounded read with extra steps.
  const take = Math.min(
    Math.max(1, query.take ?? MAX_TRANSACTIONS_PER_TYPE),
    MAX_TRANSACTIONS_PER_TYPE
  );
  const types: readonly TransactionType[] = query.type ? [query.type] : TRANSACTION_TYPES;

  const pages = await Promise.all(
    types.map((type) =>
      db.transaction.findMany({
        // deletedAt:null so a tombstoned workspace's rows never render (and a
        // stale session in a soft-deleted workspace can't read them back).
        where: { companyId, deletedAt: null, type, ...dateFilter(query) },
        // createdAt breaks the tie: `date` is a DATE-ONLY value (see
        // lib/date-range.ts), so same-day rows are the norm, and merging three
        // windows below needs a total order or the list reshuffles per render.
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take,
        include: { _count: { select: { comments: true } } },
      })
    )
  );

  types.forEach((type, i) => noteReadCeiling(type, pages[i].length, companyId));

  const merged = pages.length === 1 ? pages[0] : ([] as (typeof pages)[number]).concat(...pages);
  // Re-sort only when we merged: one type came back ordered by Postgres.
  if (pages.length > 1) {
    merged.sort(
      (a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime()
    );
  }
  return merged.map((r) => toClient(r, r._count.comments));
}

export interface TypeTotal {
  total: number;
  count: number;
}

export interface TransactionTotals {
  byType: Record<TransactionType, TypeTotal>;
  /** Cash in (founder capital + earned revenue) − cash out, the definition the
   *  dashboard's Balance card has always used. */
  balance: number;
  /** Every non-deleted row in the window — lets a caller print "showing N of M". */
  rowCount: number;
}

function emptyTotals(): Record<TransactionType, TypeTotal> {
  return {
    expense: { total: 0, count: 0 },
    income: { total: 0, count: 0 },
    investment: { total: 0, count: 0 },
  };
}

/**
 * Whole-ledger (or whole-window) sums and counts per type, in ONE `groupBy`.
 *
 * This is the roll-up that replaces `transactions.filter(…).reduce(…)` over a
 * capped array. No `take`, so no row can be excluded from a total no matter how
 * large the workspace gets — which is the actual fix for money-008.
 */
export async function getTransactionTotals(window: DateWindow = {}): Promise<TransactionTotals> {
  const { companyId } = await requireFinanceSession();
  const rows = await db.transaction.groupBy({
    by: ["type"],
    where: { companyId, deletedAt: null, ...dateFilter(window) },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const byType = emptyTotals();
  for (const r of rows) {
    // A type outside the enum means a writer invented one; skipping keeps the
    // rest of the figures right instead of throwing on a finance page.
    if (!isTransactionType(r.type)) continue;
    byType[r.type] = {
      total: r._sum.amount ? r._sum.amount.toNumber() : 0,
      count: r._count._all,
    };
  }

  return {
    byType,
    balance: byType.investment.total + byType.income.total - byType.expense.total,
    rowCount: byType.expense.count + byType.income.count + byType.investment.count,
  };
}

export interface MonthTotals {
  /** Short UTC month label, e.g. "Oct" — chart axis ready. */
  month: string;
  /** ISO start of the UTC month, so a caller can key/sort without re-deriving. */
  monthStart: string;
  expense: number;
  income: number;
  investment: number;
}

/**
 * The cash-flow series, oldest bucket first, aggregated per month in SQL.
 *
 * ON THE FAN-OUT: this is one `groupBy` per month rather than a single
 * `date_trunc('month', …)` raw query. `Transaction.date` is `TIMESTAMP(3)`
 * holding a UTC wall clock, so `date_trunc` would in fact be correct and would
 * be one round trip instead of `months`. It is not used here because the
 * windows have to agree, to the millisecond, with the boundary every other
 * surface uses (lib/date-range.ts) — and a typed Prisma aggregate over an
 * explicit `[start, endExclusive)` cannot drift from that, while a hand-written
 * date_trunc can and cannot be verified without a database. `months` is capped
 * so the fan-out stays small; the `(companyId, date)` index serves each window.
 */
export async function getMonthlyTotals(months = 6, ref: Date = new Date()): Promise<MonthTotals[]> {
  const { companyId } = await requireFinanceSession();
  const span = Math.min(Math.max(1, Math.floor(months)), MAX_SERIES_MONTHS);

  // Oldest → newest: offset -(span-1) … 0, inclusive of the current month.
  const windows: { offset: number; start: Date; endExclusive: Date }[] = [];
  for (let i = 0; i < span; i++) {
    const offset = i - (span - 1);
    const window = utcMonthWindow(ref, offset);
    windows.push({ offset, start: window.start, endExclusive: window.endExclusive });
  }

  const buckets = await Promise.all(
    windows.map((w) =>
      db.transaction.groupBy({
        by: ["type"],
        where: { companyId, deletedAt: null, date: { gte: w.start, lt: w.endExclusive } },
        _sum: { amount: true },
      })
    )
  );

  return windows.map((w, i) => {
    const totals = { expense: 0, income: 0, investment: 0 };
    for (const r of buckets[i]) {
      if (!isTransactionType(r.type)) continue;
      totals[r.type] = r._sum.amount ? r._sum.amount.toNumber() : 0;
    }
    return {
      // UTC label, not `format(start, "MMM")`: that renders a UTC-midnight Date
      // in the viewer's zone and prints "Sep" for the October bucket west of
      // UTC (money-007).
      month: utcMonthShortLabel(w.start),
      monthStart: w.start.toISOString(),
      expense: totals.expense,
      income: totals.income,
      investment: totals.investment,
    };
  });
}

/**
 * Expense spend per category, biggest first — the /dashboard pie and the
 * /expenses breakdown bar. Aggregated in SQL for the same reason as the rest:
 * the chart used to be built from the capped array, so a large workspace's
 * oldest categories simply vanished from it.
 */
export async function getExpenseTotalsByCategory(
  window: DateWindow = {}
): Promise<{ category: string; amount: number }[]> {
  const { companyId } = await requireFinanceSession();
  const rows = await db.transaction.groupBy({
    by: ["category"],
    where: { companyId, deletedAt: null, type: "expense", ...dateFilter(window) },
    _sum: { amount: true },
  });
  return rows
    .map((r) => ({
      category: r.category,
      amount: r._sum.amount ? r._sum.amount.toNumber() : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** Per-type totals for one person. Every type present, so a page can print a
 *  figure without a `?? 0` at every call site. */
export type UserContribution = Record<TransactionType, number>;

/**
 * Money in and money out PER PERSON, in ONE `groupBy` — `userId → { expense,
 * income, investment }`.
 *
 * WHAT IT REPLACES. /dashboard's "founder contributions" card and /team's
 * per-member "contributed / spent" cells both did this, per user, over the
 * windowed array:
 *
 *     transactions.filter(t => t.addedBy === u.id && t.type === "investment")
 *                 .reduce((s, t) => s + t.amount, 0)
 *
 * which is money-008 at its sharpest. The rows a ceiling drops are the OLDEST,
 * and a startup's oldest rows are its seed investments — so the founder whose
 * capital started the company is the one whose contribution figure silently
 * shrinks as the workspace grows. No `take`, so no row can be excluded from
 * anyone's total.
 *
 * Keyed by `Transaction.addedBy`, which is who RECORDED the row, matching what
 * both surfaces already display. A user with no rows is absent from the map
 * rather than present with zeros — the caller iterates its own user list.
 */
export async function getContributionTotalsByUser(
  window: DateWindow = {}
): Promise<Record<string, UserContribution>> {
  const { companyId } = await requireFinanceSession();
  const rows = await db.transaction.groupBy({
    by: ["addedBy", "type"],
    where: { companyId, deletedAt: null, ...dateFilter(window) },
    _sum: { amount: true },
  });

  const byUser: Record<string, UserContribution> = {};
  for (const r of rows) {
    // A type outside the enum means a writer invented one; skipping keeps the
    // rest of the figures right instead of throwing on a finance page.
    if (!isTransactionType(r.type)) continue;
    if (!byUser[r.addedBy]) byUser[r.addedBy] = { expense: 0, income: 0, investment: 0 };
    byUser[r.addedBy][r.type] = r._sum.amount ? r._sum.amount.toNumber() : 0;
  }
  return byUser;
}

/**
 * Month-to-date expense total, in the UTC calendar month — the "This month"
 * card on /dashboard and /expenses, and the same window lib/queries/budgets.ts
 * and lib/budgets/check.ts charge a cap against.
 */
export async function getMonthToDateExpense(ref: Date = new Date()): Promise<number> {
  const totals = await getTransactionTotals({
    from: startOfUtcMonth(ref),
    to: startOfUtcMonth(ref, 1),
  });
  return totals.byType.expense.total;
}

/**
 * The date of the workspace's EARLIEST surviving ledger row, or `null` for a
 * ledger with no rows — i.e. how much history the company actually has.
 *
 * THE DIVISOR BEHIND BURN (money-017). Average monthly burn is the burn window's
 * spend over the months that window actually covers, and for a workspace younger
 * than the window that is fewer than `BURN_WINDOW_MONTHS` months. Dividing by a
 * constant 3 reported a one-month-old workspace's 100,000 of spend as a burn of
 * 33,333 and about three times its real runway. `lib/finance/runway.ts`
 * `burnMonthsCovered` turns this date into the divisor.
 *
 * EARLIEST ROW OF ANY TYPE, not earliest expense: a company that existed for
 * three months and only started paying salaries last month really does have a
 * three-month average with two quiet months in it. The seed investment is
 * normally the first row either way.
 *
 * An aggregate rather than `getTransactions()[last].date`: that read is capped at
 * `MAX_TRANSACTIONS_PER_TYPE` and the rows a ceiling drops are the OLDEST, so the
 * list's earliest date is exactly the figure a large workspace cannot supply
 * (money-008). `_min` over the indexed `(companyId, date)` pair is one cheap row.
 */
export async function getLedgerStart(): Promise<string | null> {
  const { companyId } = await requireFinanceSession();
  const row = await db.transaction.aggregate({
    where: { companyId, deletedAt: null },
    _min: { date: true },
  });
  return row._min.date ? row._min.date.toISOString() : null;
}
