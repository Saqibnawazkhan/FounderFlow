/**
 * Daily cron endpoint — Vercel hits this at the schedule in vercel.json
 * (00:05 UTC) and we materialize every occurrence each active recurring rule
 * owes, not just today's.
 *
 * Security: protected by CRON_SECRET. Vercel automatically sends an
 * `Authorization: Bearer <CRON_SECRET>` header on cron requests; if we don't
 * see one (or it's wrong), we 401 so this can't be triggered by random visitors
 * hitting the URL. A MISSING secret is a misconfiguration, not an attack, so it
 * raises a Sentry event before answering 500 (prodready-003) — it used to
 * return in silence, and a production deploy that forgot the var meant all
 * three nightly jobs 500'd every night with nothing but a Vercel log line.
 *
 * IDEMPOTENCY — TWO LAYERS, NEITHER OF THEM TIMING (cron-003, fixed
 * 2026-09-28). This used to be a read-then-write with nothing behind it: the
 * route read every due rule, filtered in memory on `lastMaterializedAt`, and
 * only then inserted. Two invocations that overlapped anywhere before the stamp
 * both saw the stale timestamp and both inserted, so a customer's books showed
 * a rent charge they were billed for once twice — and every derived figure the
 * product sells (burn, runway, budget alerts, reports, CSV export) was silently
 * wrong. A plain GET has many ways to overlap: the scheduled fire, a manual
 * re-trigger, an uptime check, a double delivery. Now:
 *
 *   1. Each rule is CLAIMED inside the same transaction that writes its rows:
 *      `updateMany({ where: { id, lastMaterializedAt: <the value we read> } })`.
 *      Under READ COMMITTED the second writer blocks on the row lock, re-checks
 *      the predicate after the first commits, matches zero rows, and rolls its
 *      whole transaction back. It is reported as a skipped claim, not an error.
 *   2. `@@unique([ruleId, date])` on Transaction is the backstop for anything
 *      that bypasses the claim, and it is only meaningful because `date` is now
 *      the occurrence's UTC midnight rather than the instant the job ran.
 *
 * CATCH-UP (cron-004). Vercel cron does not retry, so a single failed night
 * used to delete a month of a customer's recurring rent from their books
 * permanently. `planRecurring` walks every due date after `lastMaterializedAt`,
 * and this route stamps the rule forward only as far as it actually wrote — so
 * a capped run resumes tomorrow instead of losing the tail.
 *
 * BUDGET ALERTS (money-005). Every materialized expense now goes through
 * `checkBudgetThresholdAfterExpense`, the same hook the manual path uses. It
 * ran on hand-typed expenses only, which are the minority of a real startup's
 * spend: rent, salaries and subscriptions could run 5x over every cap for
 * months with the /budgets page showing red and the alerting saying nothing.
 * Called once per (project, category) AFTER the writes, because the check
 * aggregates month-to-date and must see the rows it is judging, and outside the
 * transaction, because an alerting failure must never roll back money.
 *
 * FAILURE MODE (cron-008). Per-rule errors don't abort the run — one bad rule
 * shouldn't block the other 99 — but a run with any failure now answers 500,
 * not 206, so Vercel's own cron escalation fires. The whole handler sits inside
 * a Sentry cron check-in so a night that never runs at all also alerts.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { planRecurring, type MaterializedTransaction } from "@/lib/recurring/materialize";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { withCronCheckIn } from "@/lib/cron/monitor";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { LIVE_WORKSPACE_SCOPE } from "@/lib/cron/live-scope";
import { captureServerError } from "@/lib/sentry-server";
import { safeEqual } from "@/lib/safe-compare";

export const runtime = "nodejs"; // Prisma needs Node, not Edge
export const dynamic = "force-dynamic"; // never cache the cron result
export const maxDuration = 60;

/** Must match the crontab in vercel.json for the missed-beat alert to be right. */
const MONITOR = { slug: "materialize-recurring", schedule: "5 0 * * *" } as const;

/**
 * Per-rule transaction budget. Comfortably inside `maxDuration = 60` and well
 * above Prisma's 5s default, which is the ceiling that actually applies when no
 * options are passed (see the same note in the purge cron — cron-006). A rule
 * writes at most MAX_CATCHUP_OCCURRENCES × 2 rows, so this is generous.
 */
const TX_OPTIONS = { timeout: 20_000, maxWait: 5_000 };

/** Sentinel: this rule was taken by a concurrent run. Not an error. */
class RuleAlreadyClaimed extends Error {
  constructor(ruleId: string) {
    super(`Rule ${ruleId} was claimed by a concurrent run`);
    this.name = "RuleAlreadyClaimed";
  }
}

export async function GET(request: Request) {
  // Auth: Vercel's cron sends Authorization: Bearer <CRON_SECRET>.
  // In local dev you can hit it with the same header for testing.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed so a missing env var doesn't silently expose the endpoint —
    // and make the misconfiguration LOUD. `scripts/vercel-build.mjs` now fails
    // a production build without CRON_SECRET, so this is the belt to that
    // brace: it catches the var being removed after a green build.
    captureServerError(
      new Error("CRON_SECRET is not configured — materialize-recurring cannot run"),
      { action: "materializeRecurring.config" }
    );
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Inside the secret check on purpose: an unauthenticated probe of this URL is
  // not a run of the job, and must not close the heartbeat either way.
  return withCronCheckIn(MONITOR, () => materializeRun());
}

async function materializeRun(): Promise<NextResponse> {
  const startedAt = Date.now();
  const now = new Date();

  try {
    // Pull only active rules whose workspace is still live — paused rules and
    // rules in a soft-deleted workspace are skipped. Without the company filter
    // a tombstoned workspace keeps minting brand-new LIVE transactions every
    // night for the full 90-day retention window, resurrecting "deleted" data.
    //
    // cron-010: that reasoning now lives in lib/cron/live-scope.ts, because it
    // is the rule for EVERY nightly job and this was the only job that had it.
    // `sweepAutoCloseEntries` had no filter at all. RecurringRule carries no
    // `deletedAt` of its own, so it takes the workspace-only scope.
    const rules = await db.recurringRule.findMany({
      where: { active: true, ...LIVE_WORKSPACE_SCOPE },
    });
    const plans = planRecurring(rules, now);

    const created: string[] = [];
    const failed: Array<{ ruleId: string; error: string }> = [];
    /** (project, category) pairs whose budget needs re-checking after the writes. */
    const budgetTargets: Array<{ companyId: string; projectId: string | null; category: string }> =
      [];
    const seenBudgetTarget: Record<string, true> = {};
    let skippedConcurrent = 0;
    let occurrencesDeferred = 0;
    const truncatedRules: string[] = [];

    for (const plan of plans) {
      occurrencesDeferred += plan.deferred;
      if (plan.truncatedLookback) truncatedRules.push(plan.ruleId);

      // Stamp the rule forward to the LAST occurrence we are about to write,
      // never to `now`: anything the cap deferred is then still owed, and
      // tomorrow's run picks it up instead of it vanishing.
      const stampAt = plan.occurrences[plan.occurrences.length - 1].date;

      try {
        const madeIds = await db.$transaction(async (tx) => {
          // THE CLAIM. Conditional on the value we planned from, so exactly one
          // of two overlapping runs proceeds. In the same transaction as the
          // inserts, so a failure rolls the claim back with them and the rule
          // stays retryable.
          const claim = await tx.recurringRule.updateMany({
            where: { id: plan.ruleId, lastMaterializedAt: plan.claimToken },
            data: { lastMaterializedAt: stampAt },
          });
          if (claim.count === 0) throw new RuleAlreadyClaimed(plan.ruleId);

          const ids: string[] = [];
          for (const m of plan.occurrences) {
            const txn = await tx.transaction.create({
              data: {
                companyId: m.companyId,
                type: m.type,
                amount: m.amount,
                category: m.category,
                description: m.description,
                date: m.date,
                addedBy: m.addedBy,
                addedByName: m.addedByName,
                ruleId: m.ruleId,
                projectId: m.projectId,
              },
            });
            await tx.activity.create({
              data: {
                companyId: m.companyId,
                projectId: m.projectId,
                type: m.type === "expense" ? "expense_added" : "investment_added",
                message: activityMessage(m, now),
                userId: m.addedBy,
                userName: m.addedByName,
                metadata: JSON.stringify({
                  kind: m.type === "expense" ? "expense" : "investment",
                  amount: m.amount,
                  category: m.category,
                  description: m.description,
                  recurring: true,
                  dueDate: m.date.toISOString(),
                }),
              },
            });
            ids.push(txn.id);
          }
          return ids;
        }, TX_OPTIONS);

        for (const id of madeIds) created.push(id);

        // Queue the budget checks; they run after every write has landed.
        for (const m of plan.occurrences) {
          if (m.type !== "expense") continue;
          const key = `${m.companyId}|${m.projectId ?? ""}|${m.category}`;
          if (seenBudgetTarget[key]) continue;
          seenBudgetTarget[key] = true;
          budgetTargets.push({
            companyId: m.companyId,
            projectId: m.projectId,
            category: m.category,
          });
        }
      } catch (e) {
        if (e instanceof RuleAlreadyClaimed) {
          // Another run got there first. The expected outcome of a race, not a
          // failure: reporting it as one would answer 500 on a healthy night.
          skippedConcurrent += 1;
          continue;
        }
        const msg = e instanceof Error ? e.message : "Unknown materializer error";
        failed.push({ ruleId: plan.ruleId, error: msg });
        // Capture with full context: companyId so triage knows whose
        // recurring rule failed, and a running count so a partial-success
        // pattern is visible in the Sentry breadcrumb trail. Previous
        // capture had only ruleId — opaque when an issue lands.
        captureServerError(e, {
          action: "materializeRecurring",
          extra: {
            ruleId: plan.ruleId,
            companyId: plan.occurrences[0]?.companyId,
            occurrences: plan.occurrences.length,
            succeededSoFar: created.length,
            failedSoFar: failed.length,
          },
        });
      }
    }

    // Budget thresholds, after the money is in. Swallow-and-log per target:
    // this is the same contract as the manual path (lib/budgets/check.ts) —
    // an alerting error must NEVER undo a customer's transaction, and it must
    // not turn a successful materialization run into a 500 either.
    let budgetChecks = 0;
    for (const target of budgetTargets) {
      try {
        await checkBudgetThresholdAfterExpense(target);
        budgetChecks += 1;
      } catch (e) {
        captureServerError(e, {
          action: "materializeRecurring.budgetCheck",
          companyId: target.companyId,
          extra: { projectId: target.projectId, category: target.category },
        });
      }
    }

    // A failed rule answers 5xx so Vercel's cron escalation fires (cron-008).
    // This used to be 206, which is a 2xx — Vercel read it as a clean run, and
    // the "alert externally on a 206" half was never built.
    const status = failed.length > 0 ? 500 : 200;
    // cron-011. These are REAL MONEY ROWS, written across every tenant, with no
    // ceiling on the loop above — and the project's own 100-row canary had nine
    // call sites and not this one. A bad rule set, a clock problem or a bug in
    // `isRuleDueOn` could post thousands of transactions overnight across every
    // customer, and the only way anyone would find out is a founder reading
    // their own ledger. It reports rather than blocks, deliberately: a genuine
    // catch-up night after an outage IS large, and refusing to post a
    // customer's rent is worse than posting it loudly.
    warnBulkMutation(created.length, {
      action: "materializeRecurring",
      extra: {
        rulesChecked: rules.length,
        rulesWithWork: plans.length,
        occurrencesDeferred,
        truncatedRules,
      },
    });
    return NextResponse.json(
      {
        ok: failed.length === 0,
        ranAt: now.toISOString(),
        rulesChecked: rules.length,
        rulesWithWork: plans.length,
        transactionsCreated: created.length,
        // Occurrences a per-rule cap left for the next run. Non-zero is not an
        // error — it is the reconciler pacing itself — but a number that never
        // reaches zero means a rule is falling behind faster than it catches up.
        occurrencesDeferred,
        // Rules whose backlog reached past the lookback window; those
        // occurrences are gone for good and this is the only place that says so.
        truncatedRules,
        // Rules a concurrent run had already claimed. Healthy in small numbers.
        rulesSkippedConcurrent: skippedConcurrent,
        budgetChecksRun: budgetChecks,
        failures: failed,
        durationMs: Date.now() - startedAt,
      },
      { status }
    );
  } catch (e) {
    captureServerError(e, {
      action: "materializeRecurring:outer",
      extra: { durationMs: Date.now() - startedAt },
    });
    return NextResponse.json(
      {
        error: "Materialization run failed",
        durationMs: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }
}

/**
 * Activity line for one occurrence. A back-posted occurrence names the day it
 * was due: without it a June rent appearing in today's feed reads as a
 * duplicate charge to the person looking at it.
 */
function activityMessage(m: MaterializedTransaction, now: Date): string {
  const label = m.description || m.category;
  const base = `Recurring ${m.type}: ${label} (${m.amount.toLocaleString()})`;
  const due = m.date.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return due === today ? base : `${base} — due ${due}`;
}
