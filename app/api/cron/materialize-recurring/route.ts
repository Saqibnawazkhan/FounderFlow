/**
 * Daily cron endpoint — Vercel hits this at the schedule in vercel.json
 * (00:05 UTC) and we materialize any active recurring rule that's due today.
 *
 * Security: protected by CRON_SECRET. Vercel automatically sends an
 * `Authorization: Bearer <CRON_SECRET>` header on cron requests; if we
 * don't see one (or it's wrong), we 401 so this can't be triggered by
 * random visitors hitting the URL.
 *
 * Idempotency: the materializer skips rules whose lastMaterializedAt is
 * already inside today's UTC window, so a duplicate cron run in the same
 * day is safe.
 *
 * Failure mode: per-rule errors are logged + Sentry-captured but don't
 * abort the whole run; one bad rule shouldn't block the other 99.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { materialize } from "@/lib/recurring/materialize";
import { captureServerError } from "@/lib/sentry-server";

export const runtime = "nodejs"; // Prisma needs Node, not Edge
export const dynamic = "force-dynamic"; // never cache the cron result

export async function GET(request: Request) {
  // Auth: Vercel's cron sends Authorization: Bearer <CRON_SECRET>.
  // In local dev you can hit it with the same header for testing.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed so a missing env var doesn't silently expose the endpoint.
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  try {
    // Pull only active rules — paused ones are skipped server-side.
    const rules = await db.recurringRule.findMany({ where: { active: true } });
    const toCreate = materialize(rules, now);

    if (toCreate.length === 0) {
      return NextResponse.json({
        ok: true,
        ranAt: now.toISOString(),
        rulesChecked: rules.length,
        transactionsCreated: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // Per-rule: create the transaction + stamp lastMaterializedAt + log
    // activity. Wrapped in a $transaction so a partial failure doesn't
    // leave a transaction without its activity row (or vice versa).
    const created: string[] = [];
    const failed: Array<{ ruleId: string; error: string }> = [];

    for (const m of toCreate) {
      try {
        await db.$transaction(async (tx) => {
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
            },
          });
          await tx.recurringRule.update({
            where: { id: m.ruleId },
            data: { lastMaterializedAt: now },
          });
          await tx.activity.create({
            data: {
              companyId: m.companyId,
              type: m.type === "expense" ? "expense_added" : "investment_added",
              message: `Recurring ${m.type}: ${m.description || m.category} (${m.amount.toLocaleString()})`,
              userId: m.addedBy,
              userName: m.addedByName,
              metadata: JSON.stringify({
                kind: m.type === "expense" ? "expense" : "investment",
                amount: m.amount,
                category: m.category,
                description: m.description,
                recurring: true,
              }),
            },
          });
          created.push(txn.id);
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown materializer error";
        failed.push({ ruleId: m.ruleId, error: msg });
        // Capture with full context: companyId so triage knows whose
        // recurring rule failed, and a running count so a partial-success
        // pattern is visible in the Sentry breadcrumb trail. Previous
        // capture had only ruleId — opaque when an issue lands.
        captureServerError(e, {
          action: "materializeRecurring",
          extra: {
            ruleId: m.ruleId,
            companyId: m.companyId,
            succeededSoFar: created.length,
            failedSoFar: failed.length,
          },
        });
      }
    }

    // Return 206 when some rules failed — Vercel cron monitoring escalates
    // on 5xx, but a 206 still shows up in dashboards + makes it possible
    // to alert externally on partial drops without false-firing on full
    // success runs.
    const status = failed.length > 0 ? 206 : 200;
    return NextResponse.json(
      {
        ok: failed.length === 0,
        ranAt: now.toISOString(),
        rulesChecked: rules.length,
        transactionsCreated: created.length,
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
