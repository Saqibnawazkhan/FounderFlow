/**
 * Pure materializer for recurring transactions. Given a list of rules + a
 * timestamp, returns the list of new transactions that should be created.
 *
 * Pulled out into a pure function so we can unit-test edge cases (month
 * boundaries, dayOfMonth=31 in February, idempotency on same-day reruns,
 * catch-up after a missed night) without spinning up Prisma or a
 * clock-mock-friendly server action.
 *
 * IT IS A RECONCILER, NOT A TRIGGER (cron-004, fixed 2026-09-28). It used to
 * answer one question — "is this rule due TODAY?" — and Vercel cron does not
 * retry a failed invocation. So any night the job 500'd (a DB blip, a deploy
 * window, a missing CRON_SECRET) permanently skipped that rule's period: the
 * customer's rent or salary for that month simply never appeared, and because
 * no row was ever written there was nothing in the UI to notice.
 * `dueDatesFor` now walks every due date strictly after `lastMaterializedAt`
 * up to today, so running late costs a day of latency instead of a month of a
 * founder's books.
 *
 * Callers (cron route, manual trigger) are responsible for:
 *   1. Loading active rules from DB — and clearing the `projectId` of any rule
 *      whose project has been soft-deleted, because this module copies the tag
 *      verbatim and cannot see a tombstone (R1-money-013-cron)
 *   2. Passing them in
 *   3. Persisting the returned transactions, and advancing the rule's
 *      `lastMaterializedAt` to the LAST occurrence they actually wrote — not
 *      to `now`. Stamping `now` would swallow any occurrence the cap deferred;
 *      stamping the last written occurrence means the next run picks the tail
 *      up. See `RulePlan.claimToken` for the concurrency half.
 */

import type { RecurringRule } from "@prisma/client";

/**
 * The fields the calendar predicates actually read — the schedule, with none of
 * the money or the ownership.
 *
 * Stated as its own interface rather than taking `RecurringRule` because
 * /recurring now asks the same questions from the BROWSER (finance-planning-020),
 * and what reaches the browser is `RecurringRuleClient`: `amount` is a `number`
 * rather than a `Prisma.Decimal` and the dates are ISO strings, because a
 * Decimal cannot cross the server/client boundary. A `RecurringRule` is
 * structurally assignable to this, so every existing caller is unaffected.
 */
export interface RuleSchedule {
  active: boolean;
  /** `"monthly" | "weekly"`; anything else never fires. */
  frequency: string;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  startDate: Date;
}

/** A schedule plus how far through it the materializer has already got. */
export interface RuleScheduleProgress extends RuleSchedule {
  lastMaterializedAt: Date | null;
}

export interface MaterializedTransaction {
  ruleId: string;
  companyId: string;
  type: "expense" | "investment";
  amount: number;
  category: string;
  description: string;
  addedBy: string;
  addedByName: string;
  /**
   * The project this spend is attributed to, carried from the rule (money-005).
   * Null for company-wide rules. Without it, recurring spend — rent, salaries,
   * subscriptions, i.e. most of a real startup's outgoings — could never trip a
   * budget cap, because every Budget belongs to a project and
   * `checkBudgetThresholdAfterExpense` returns early on a null projectId.
   *
   * Carried VERBATIM, tombstone and all: nothing here can tell a live project
   * from a deleted one, so the caller owns that check (see the header, and the
   * `include` in the cron route).
   */
  projectId: string | null;
  /**
   * UTC midnight of the occurrence this row represents — the day the money was
   * DUE, not the day the job happened to run. A June rent posted with a July
   * date leaves June's burn, runway and budget figures wrong for ever, and it
   * is also what makes `@@unique([ruleId, date])` on Transaction a usable
   * idempotency key (cron-003).
   */
  date: Date;
}

/** One rule's worth of work, with everything the writer needs to claim it. */
export interface RulePlan {
  ruleId: string;
  /**
   * The `lastMaterializedAt` value this plan was computed from. The writer
   * claims the rule with `updateMany({ where: { id, lastMaterializedAt:
   * claimToken } })` and skips the rule when that matches 0 rows — which is how
   * two overlapping runs stop posting the same expense twice (cron-003).
   */
  claimToken: Date | null;
  /** Oldest first. Never empty: a rule with nothing owed produces no plan. */
  occurrences: MaterializedTransaction[];
  /** Due occurrences left for the next run because of the per-run cap. */
  deferred: number;
  /** True when occurrences older than the lookback window were dropped. */
  truncatedLookback: boolean;
}

/**
 * How many occurrences one run will post for one rule. The cap exists so a
 * rule that has been asleep for a year cannot mint a year of history in one
 * night; the remainder is reported as `deferred` and picked up by the next run,
 * because the writer only advances `lastMaterializedAt` as far as it got.
 */
export const MAX_CATCHUP_OCCURRENCES = 12;

/**
 * How far back the walk reconciles at all. Anything older is dropped for good
 * and flagged as `truncatedLookback` — deliberately: back-posting three years
 * of rent into a live ledger is a worse outcome than not posting it, and it has
 * to be visible rather than silent either way. Also bounds the day-by-day walk
 * to ~400 iterations per rule.
 */
export const MAX_CATCHUP_LOOKBACK_DAYS = 400;

/**
 * How far FORWARD `nextDueDateFor` will look before giving up and saying
 * nothing is scheduled.
 *
 * The longest gap between two consecutive occurrences of either frequency is 31
 * days (a monthly rule on the 1st, materialized on 1 December, next due 1
 * January), so 45 answers every real schedule with a fortnight of margin. Its
 * other job is to terminate the walk for a rule that can NEVER fire — a monthly
 * row with a null `dayOfMonth`, an unknown frequency — which would otherwise
 * walk to the end of time looking for a day that does not exist.
 */
export const NEXT_DUE_HORIZON_DAYS = 45;

/**
 * Decide whether a single rule should fire on the given date.
 *
 * Monthly rule:
 *   - Fires when today's day-of-month matches rule.dayOfMonth, OR
 *   - today is the LAST day of the month AND rule.dayOfMonth > daysInMonth
 *     (clamps Jan-31 / Feb-30 / Apr-31 etc. to the last available day)
 *
 * Weekly rule:
 *   - Fires when today's day-of-week matches rule.dayOfWeek (0=Sun..6=Sat)
 *
 * This is a pure per-day predicate: it knows nothing about whether the rule has
 * already fired. `dueDatesFor` owns that, and calls this once per candidate
 * day, which is what makes catch-up possible without a second calendar.
 *
 * Takes `RuleSchedule`, not `RecurringRule`, so the card can share this exact
 * calendar rather than restate it — see that interface.
 */
export function isRuleDueOn(rule: RuleSchedule, when: Date): boolean {
  if (!rule.active) return false;
  // Don't fire before the rule's start date (avoids backfilling history).
  if (when < startOfDayUTC(rule.startDate)) return false;

  if (rule.frequency === "monthly") {
    if (rule.dayOfMonth == null) return false;
    const today = when.getUTCDate();
    const daysInMonth = new Date(
      Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 0)
    ).getUTCDate();
    // Exact match, OR clamp-to-last-day for the short-month case.
    return today === rule.dayOfMonth || (rule.dayOfMonth > daysInMonth && today === daysInMonth);
  }

  if (rule.frequency === "weekly") {
    if (rule.dayOfWeek == null) return false;
    return when.getUTCDay() === rule.dayOfWeek;
  }

  return false;
}

/**
 * Idempotency check: did this rule already fire today?
 *
 * Retained for the smoke scripts and for reading old Sentry breadcrumbs.
 * `dueDatesFor` no longer uses it: "already fired today" is just the special
 * case of "already fired on this candidate day", and a materializer that could
 * only ever ask about today was cron-004.
 */
export function alreadyFiredToday(rule: RecurringRule, when: Date): boolean {
  if (!rule.lastMaterializedAt) return false;
  return sameUTCDay(rule.lastMaterializedAt, when);
}

export interface CatchUpOptions {
  maxOccurrences?: number;
  maxLookbackDays?: number;
}

/**
 * Every date this rule owes, oldest first.
 *
 * The window is (lastMaterializedAt, today] — strictly after the last day that
 * materialized, so a same-day rerun owes nothing, and inclusive of today, so an
 * on-time run still fires. A rule that has never materialized reconciles from
 * its own `startDate` (inclusive), never earlier.
 */
export function dueDatesFor(
  rule: RecurringRule,
  when: Date,
  opts: CatchUpOptions = {}
): { dates: Date[]; deferred: number; truncatedLookback: boolean } {
  const maxOccurrences = opts.maxOccurrences ?? MAX_CATCHUP_OCCURRENCES;
  const maxLookbackDays = opts.maxLookbackDays ?? MAX_CATCHUP_LOOKBACK_DAYS;

  const today = startOfDayUTC(when);
  const startDay = startOfDayUTC(rule.startDate);
  // First day we may consider: the day after the last one that materialized,
  // floored at the rule's own startDate.
  const firstCandidate = rule.lastMaterializedAt
    ? laterOf(addDaysUTC(startOfDayUTC(rule.lastMaterializedAt), 1), startDay)
    : startDay;
  const windowFloor = addDaysUTC(today, -maxLookbackDays);
  const truncatedLookback = firstCandidate.getTime() < windowFloor.getTime();
  const walkFrom = truncatedLookback ? windowFloor : firstCandidate;

  const dates: Date[] = [];
  let deferred = 0;
  for (let day = walkFrom; day.getTime() <= today.getTime(); day = addDaysUTC(day, 1)) {
    if (!isRuleDueOn(rule, day)) continue;
    if (dates.length < maxOccurrences) dates.push(day);
    else deferred += 1;
  }
  return { dates, deferred, truncatedLookback };
}

/**
 * The single date this rule will post next, or null if it will not post at all.
 *
 * finance-planning-020 — THE CARD HAD NO ANSWER TO THE ONLY QUESTION ASKED OF
 * IT. /recurring promises that rules "post on their own", and showed Frequency,
 * Created, Generated N txns and the raw `lastMaterializedAt` stamp. None of
 * those says when the money leaves, so a rule that had missed a month, a rule
 * suspended because its author left, and a rule that had just double-posted all
 * rendered identically.
 *
 * It is `dueDatesFor`'s read-only twin and MUST stay the same calendar: same
 * `(lastMaterializedAt, …]` window floored at `startDate`, same
 * `MAX_CATCHUP_LOOKBACK_DAYS` floor, same `isRuleDueOn` (so the same
 * short-month clamp). A card with its own date arithmetic would be a second
 * calendar, and the first month the two disagreed the customer would be
 * trusting a date nothing is going to honour.
 * `tests/lib/recurring/next-due.test.ts` asserts the agreement directly.
 *
 * A DATE IN THE PAST IS A CORRECT ANSWER, and the reason this is worth
 * rendering. If the job has not run since August, what it will post next is
 * September's occurrence, so September is what this returns — on the card, a
 * past date is the only visible evidence that the automation stopped. Skipping
 * ahead to the next future occurrence would hide exactly that.
 *
 * It does not know about the two suspensions that live outside the schedule: a
 * rule whose author was deactivated is left untouched by the cron (`active`
 * stays true) and a rule in a soft-deleted workspace is never loaded. Callers
 * own those, because neither fact is on the row this reads.
 */
export function nextDueDateFor(rule: RuleScheduleProgress, when: Date): Date | null {
  const today = startOfDayUTC(when);
  const startDay = startOfDayUTC(rule.startDate);
  // Identical to `dueDatesFor`'s `walkFrom`, deliberately duplicated in shape
  // rather than shared, because that function also builds the list and reports
  // truncation and neither is wanted here.
  const firstCandidate = rule.lastMaterializedAt
    ? laterOf(addDaysUTC(startOfDayUTC(rule.lastMaterializedAt), 1), startDay)
    : startDay;
  const walkFrom = laterOf(firstCandidate, addDaysUTC(today, -MAX_CATCHUP_LOOKBACK_DAYS));
  // Measured from whichever of the two is later: a rule whose first candidate
  // is already in the future (a future `startDate`) needs the horizon ahead of
  // THAT, not ahead of today.
  const horizon = addDaysUTC(laterOf(walkFrom, today), NEXT_DUE_HORIZON_DAYS);

  for (let day = walkFrom; day.getTime() <= horizon.getTime(); day = addDaysUTC(day, 1)) {
    if (isRuleDueOn(rule, day)) return day;
  }
  return null;
}

/**
 * Per-rule plans for everything owed right now. Rules with nothing owed are
 * omitted entirely rather than returned empty, so the writer never takes a row
 * lock or bumps a timestamp for a rule it has no work for.
 */
export function planRecurring(
  rules: RecurringRule[],
  when: Date,
  opts: CatchUpOptions = {}
): RulePlan[] {
  const plans: RulePlan[] = [];
  for (const rule of rules) {
    const { dates, deferred, truncatedLookback } = dueDatesFor(rule, when, opts);
    if (dates.length === 0) continue;
    plans.push({
      ruleId: rule.id,
      claimToken: rule.lastMaterializedAt,
      occurrences: dates.map((date) => occurrence(rule, date)),
      deferred,
      truncatedLookback,
    });
  }
  return plans;
}

/**
 * Flat view of `planRecurring` — every transaction to create, across all rules.
 * Kept because it is the shape the unit tests and the QA scripts read; the cron
 * route uses `planRecurring` because it needs the per-rule claim token.
 */
export function materialize(
  rules: RecurringRule[],
  when: Date,
  opts: CatchUpOptions = {}
): MaterializedTransaction[] {
  const out: MaterializedTransaction[] = [];
  for (const plan of planRecurring(rules, when, opts)) {
    for (const occ of plan.occurrences) out.push(occ);
  }
  return out;
}

function occurrence(rule: RecurringRule, date: Date): MaterializedTransaction {
  return {
    ruleId: rule.id,
    companyId: rule.companyId,
    type: rule.type as "expense" | "investment",
    // FaultsAudit.md P0-4: RecurringRule.amount is Prisma.Decimal after Float→Decimal.
    // The MaterializedTransaction shape stays `number` so downstream JSON
    // paths and tests don't have to know about Decimal.
    amount: rule.amount.toNumber(),
    category: rule.category,
    description: rule.description,
    addedBy: rule.addedBy,
    addedByName: rule.addedByName,
    projectId: rule.projectId ?? null,
    date,
  };
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function sameUTCDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * The instant to stamp `lastMaterializedAt` with after SEEDING a brand-new rule.
 *
 * finance-planning-004 — A MONTHLY RULE CHARGED TWICE IN THE MONTH IT WAS
 * CREATED. `createRecurringAction` posts a seed transaction immediately (the
 * comment there explains why: "The seed IS the first month of this recurring
 * cost", and it is what makes the new rule visible to its budget) and stamped
 * `lastMaterializedAt: now`. `dueDatesFor` then walks (lastMaterializedAt, today],
 * so a rule created on the 3rd with `dayOfMonth: 15` was due again on the 15th —
 * of the same month. The customer set up one monthly rent charge and got two, and
 * both rows carry the same rule badge, so neither looks like the mistake.
 *
 * Created ON or AFTER the due day it was already correct, which is exactly why
 * this survived: whoever tried it on the 20th saw one charge.
 *
 * THE FIX IS TO STAMP PAST THE CURRENT PERIOD'S OCCURRENCE, not to drop the seed.
 * Dropping it would leave the first month of a recurring cost invisible to the
 * budget it belongs to — the half of money-005 that was hardest to find — and
 * would make a brand-new rule show nothing at all until its day came round.
 *
 * So: look forward through the remainder of the CURRENT period only. If the rule
 * has a scheduled occurrence in there, the seed has already paid for it, and the
 * stamp becomes that date so the scheduler resumes at the NEXT period. If it does
 * not (created on or after the due day), `when` is already correct and is
 * returned unchanged.
 *
 * "Remainder of the current period" is the rest of the UTC month for a monthly
 * rule and the next six days for a weekly one — deliberately not a week-start
 * convention, because a weekly rule has no notion of which day a week begins on;
 * six days is precisely "there is exactly one more of these coming".
 *
 * Pure, so `tests/lib/recurring/seed-stamp.test.ts` can walk a whole calendar
 * without a database.
 */
export function seedStampFor(rule: RecurringRule, when: Date): Date {
  const today = startOfDayUTC(when);
  let lookahead: number;
  if (rule.frequency === "monthly") {
    const daysInMonth = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)
    ).getUTCDate();
    lookahead = daysInMonth - today.getUTCDate();
  } else {
    lookahead = 6;
  }
  // Strictly after today: `lastMaterializedAt = when` already excludes today,
  // because `dueDatesFor` opens its window at lastMaterializedAt + 1 day.
  for (let d = 1; d <= lookahead; d += 1) {
    const candidate = addDaysUTC(today, d);
    if (isRuleDueOn(rule, candidate)) return candidate;
  }
  return when;
}
