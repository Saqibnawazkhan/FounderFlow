// @vitest-environment node

/**
 * finance-planning-020 — a recurring rule never told you when it would next charge.
 *
 * /recurring promises "set them up once and they post on their own. A daily job
 * creates the next instance when it's due". The next due date is the one fact
 * that makes that promise checkable, and the card had no field for it: Frequency,
 * Created, Generated N txns, and "Last fired <date>".
 *
 * Worse, since the finance-planning-004 fix that one date field is no longer the
 * last firing at all. `seedStampFor` stamps `lastMaterializedAt` FORWARD to the
 * current period's due day, so a rule created on 3 October for day 15 carries
 * `2026-10-15` while its only posted row is dated 3 October — the card labelled a
 * FUTURE date "Last fired".
 *
 * WHY THESE CASES ARE THE BOUNDARIES, not one example. The card must agree with
 * the scheduler or it is a second calendar, and two calendars is how a customer
 * ends up trusting a date nothing will honour. So the load-bearing block here is
 * "agrees with the reconciler": for every state where `dueDatesFor` owes
 * something, `nextDueDateFor` must return exactly its first date — the same
 * `(lastMaterializedAt, …]` window, the same short-month clamp, the same
 * 400-day lookback floor. The rest pin the states where nothing is owed yet and
 * the walk has to look FORWARD instead, which is the half `dueDatesFor` cannot
 * answer at all.
 *
 * An OVERDUE date is a feature, not a bug, and the third case block is where it
 * is pinned: if the nightly job has missed a month, the honest answer to "when
 * does this next charge me" is a date in the past, because that is what the next
 * run will post. A function that skipped ahead to the next future occurrence
 * would hide exactly the missed month the card exists to reveal.
 *
 * Pure, so this walks a calendar with no database and no clock.
 */

import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import type { RecurringRule } from "@prisma/client";
import {
  MAX_CATCHUP_LOOKBACK_DAYS,
  dueDatesFor,
  nextDueDateFor,
} from "@/lib/recurring/materialize";
import { readSource } from "../harness/source-scan";

function rule(over: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: "r_rent",
    companyId: "c_nimbus",
    projectId: null,
    type: "expense",
    amount: new Prisma.Decimal(50000),
    category: "Office Rent",
    description: "Rent",
    addedBy: "u_ayesha",
    addedByName: "Ayesha",
    frequency: "monthly",
    dayOfMonth: 15,
    dayOfWeek: null,
    active: true,
    startDate: new Date(Date.UTC(2026, 0, 1)),
    lastMaterializedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    ...over,
  } as RecurringRule;
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const iso = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));

describe("nextDueDateFor — a brand-new rule, the case the filing opens with", () => {
  it("answers November for a 3 October rule whose seed already paid for October", () => {
    // Exactly the state `seedStampFor` leaves behind (tests/lib/recurring/
    // seed-stamp.test.ts: a day-15 rule created 3 Oct is stamped 2026-10-15).
    // The card used to render that stamp as "Last fired 15 Oct" — a future date,
    // under a past-tense label, with no answer to the only question asked.
    const r = rule({ startDate: utc(2026, 9, 3), lastMaterializedAt: utc(2026, 9, 15) });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 3)))).toBe("2026-11-15");
  });

  it("answers this month when the rule was created before its day and not yet seeded", () => {
    const r = rule({ startDate: utc(2026, 9, 3), lastMaterializedAt: null });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 3)))).toBe("2026-10-15");
  });

  it("never answers earlier than the rule's own startDate", () => {
    // startDate is always "today" in `createRecurringRuleAction`, but the column
    // permits a future one and `isRuleDueOn` refuses to fire before it. The card
    // must not promise a charge the scheduler would decline to post.
    const r = rule({ startDate: utc(2026, 10, 1), lastMaterializedAt: null });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 3)))).toBe("2026-11-15");
  });
});

describe("nextDueDateFor — a rule that is running normally", () => {
  it("looks a month ahead of the stamp", () => {
    const r = rule({ lastMaterializedAt: utc(2026, 8, 15) });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 3)))).toBe("2026-10-15");
  });

  it("answers today at every hour of the due day, not just before the job runs", () => {
    // Day granularity, start to finish. The materializer's slot is 00:05 UTC
    // (`vercel.json`), so 02:00 is already AFTER it — and the answer is still
    // today, because the walk floors `when` to the UTC day and knows nothing
    // about the clock. That is the behaviour the card needs: a run that failed
    // to post today's occurrence must keep reading "not posted yet" all day
    // instead of silently rolling to next month five minutes past midnight.
    const r = rule({ lastMaterializedAt: utc(2026, 8, 15) });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 15)))).toBe("2026-10-15");
    expect(iso(nextDueDateFor(r, new Date(Date.UTC(2026, 9, 15, 2, 0))))).toBe("2026-10-15");
  });

  it("clamps a day-31 rule to the last day of a short month, as the scheduler does", () => {
    const r = rule({ dayOfMonth: 31, lastMaterializedAt: utc(2026, 0, 31) });
    expect(iso(nextDueDateFor(r, utc(2026, 1, 1)))).toBe("2026-02-28");
  });

  it("clamps to 29 February in a leap year", () => {
    const r = rule({ dayOfMonth: 31, lastMaterializedAt: utc(2028, 0, 31) });
    expect(iso(nextDueDateFor(r, utc(2028, 1, 1)))).toBe("2028-02-29");
  });

  it("walks a week for a weekly rule", () => {
    // 2026-10-05 is a Monday.
    const r = rule({
      frequency: "weekly",
      dayOfMonth: null,
      dayOfWeek: 1,
      lastMaterializedAt: utc(2026, 9, 5),
    });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 5)))).toBe("2026-10-12");
    expect(iso(nextDueDateFor(r, utc(2026, 9, 9)))).toBe("2026-10-12");
  });
});

describe("nextDueDateFor — a date in the PAST is the signal, not a bug", () => {
  it("reports the missed occurrence a broken job still owes", () => {
    // Two months since the last stamp on a monthly rule: September was never
    // posted. The next run posts September, so September is the answer — and a
    // card reading "due 15 Sep" in October is the only place a customer can see
    // that the automation stopped.
    const r = rule({ lastMaterializedAt: utc(2026, 7, 15) });
    expect(iso(nextDueDateFor(r, utc(2026, 9, 3)))).toBe("2026-09-15");
  });

  it("stops at the same 400-day lookback floor the reconciler stops at", () => {
    // A rule asleep for three years: anything older than the window is dropped
    // for good (`truncatedLookback`), so the card must not name a date the
    // scheduler has written off.
    const today = utc(2026, 9, 3);
    const r = rule({ startDate: utc(2020, 0, 1), lastMaterializedAt: utc(2023, 0, 15) });
    const answer = nextDueDateFor(r, today);
    const floor = Date.UTC(2026, 9, 3) - MAX_CATCHUP_LOOKBACK_DAYS * 86_400_000;
    expect(answer).not.toBeNull();
    expect(answer!.getTime()).toBeGreaterThanOrEqual(floor);
    expect(iso(answer)).toBe(iso(dueDatesFor(r, today).dates[0]));
  });
});

describe("nextDueDateFor — nothing is scheduled", () => {
  it("returns null for a paused rule", () => {
    // Pause means nothing posts. A date here would be a promise the scheduler
    // has been told not to keep.
    const r = rule({ active: false, lastMaterializedAt: utc(2026, 8, 15) });
    expect(nextDueDateFor(r, utc(2026, 9, 3))).toBeNull();
  });

  it("returns null for a monthly rule with no dayOfMonth", () => {
    // Unreachable through the zod union, pinned so the walk is known to
    // terminate rather than assumed to.
    const r = rule({ dayOfMonth: null, lastMaterializedAt: utc(2026, 8, 15) });
    expect(nextDueDateFor(r, utc(2026, 9, 3))).toBeNull();
  });

  it("returns null for an unknown frequency", () => {
    const r = rule({ frequency: "yearly" as never, lastMaterializedAt: utc(2026, 8, 15) });
    expect(nextDueDateFor(r, utc(2026, 9, 3))).toBeNull();
  });
});

describe("nextDueDateFor agrees with the reconciler, or it is a second calendar", () => {
  const states: { label: string; r: RecurringRule; today: Date }[] = [
    {
      label: "monthly, one month owed",
      r: rule({ lastMaterializedAt: utc(2026, 8, 15) }),
      today: utc(2026, 9, 15),
    },
    {
      label: "monthly, two months owed",
      r: rule({ lastMaterializedAt: utc(2026, 7, 15) }),
      today: utc(2026, 9, 20),
    },
    {
      label: "monthly day 31, February owed",
      r: rule({ dayOfMonth: 31, lastMaterializedAt: utc(2026, 0, 31) }),
      today: utc(2026, 2, 1),
    },
    {
      label: "monthly, never materialized, startDate inside the window",
      r: rule({ startDate: utc(2026, 9, 1), lastMaterializedAt: null }),
      today: utc(2026, 9, 20),
    },
    {
      label: "weekly, three weeks owed",
      r: rule({
        frequency: "weekly",
        dayOfMonth: null,
        dayOfWeek: 1,
        lastMaterializedAt: utc(2026, 8, 21),
      }),
      today: utc(2026, 9, 12),
    },
  ];

  for (const { label, r, today } of states) {
    it(`matches dueDatesFor's first owed date — ${label}`, () => {
      const owed = dueDatesFor(r, today).dates;
      expect(owed.length).toBeGreaterThan(0);
      expect(iso(nextDueDateFor(r, today))).toBe(iso(owed[0]));
    });
  }

  it("looks forward exactly when the reconciler owes nothing", () => {
    // The complement of the block above: with nothing owed, `dueDatesFor` is
    // empty and has no answer to give, so the only check available is that the
    // date is in the future and is a day the predicate would fire on.
    const today = utc(2026, 9, 16);
    const r = rule({ lastMaterializedAt: utc(2026, 9, 15) });
    expect(dueDatesFor(r, today).dates).toEqual([]);
    expect(iso(nextDueDateFor(r, today))).toBe("2026-11-15");
    // And the scheduler does fire there, once the clock reaches it.
    expect(dueDatesFor(r, utc(2026, 10, 15)).dates.map(iso)).toEqual(["2026-11-15"]);
  });
});

/* ── The one block below reads the tree instead of walking the calendar ─────── *
 * It is here because the card's TONE decision is defended by the cron's slot,
 * and the first version of this fix defended it with the PURGE cron's slot:
 * both this file and `recurring-client.tsx` attached the purge's small-hours
 * time to the materializer, a figure lifted from CLAUDE.md, while line 3 of
 * the module the fix is built against already said 00:05. Nothing was red — a
 * wrong figure in a comment never is — and the next person to tune the
 * red/neutral threshold, or to add a staleness warning, would have reasoned
 * from a schedule three hours out.
 *
 * So the figure is now checked rather than remembered, against `vercel.json`
 * itself. The sweep includes THIS FILE, which is why the purge's own time is
 * nowhere written out in it — not in a comment and not in an assertion, which
 * is why `utcTimeOf` derives it from the schedule instead. In a file about the
 * materializer, writing that figure down IS the mistake being guarded.
 */

describe("the materialize cron's slot, as the prose quotes it", () => {
  const source = (...parts: string[]) => readSource(join(process.cwd(), ...parts));

  const QUOTERS = [
    ["app", "(app)", "recurring", "recurring-client.tsx"],
    ["app", "api", "cron", "materialize-recurring", "route.ts"],
    ["tests", "lib", "recurring", "next-due.test.ts"],
  ];

  /** `"5 0 * * *"` -> `"00:05"`. Derived, so no forbidden figure is written. */
  function utcTimeOf(schedule: string): string {
    const [minute, hour] = schedule.split(" ");
    return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }

  const slots = (() => {
    const { crons } = JSON.parse(source("vercel.json")) as {
      crons: { path: string; schedule: string }[];
    };
    const at = (path: string) => {
      const found = crons.find((c) => c.path === path);
      if (!found) throw new Error(`vercel.json has no cron for ${path}`);
      return found.schedule;
    };
    return {
      materialize: at("/api/cron/materialize-recurring"),
      purge: at("/api/cron/purge-soft-deleted"),
    };
  })();

  it("is 00:05 UTC in vercel.json, three hours before the purge's", () => {
    expect(utcTimeOf(slots.materialize)).toBe("00:05");
    expect(utcTimeOf(slots.purge)).not.toBe("00:05");
  });

  /**
   * Every `HH:MM` figure in the text, in order. Asserting on this list rather
   * than on the file keeps a failure readable: the diff of a 800-line component
   * against a five-character string tells the reader nothing.
   *
   * An exec loop, not `String.matchAll`: tsconfig sets no `target`, so it is
   * ES5, and spreading the iterator `matchAll` returns is a typecheck error
   * that vitest does not reproduce.
   */
  function timesIn(text: string): string[] {
    const re = /\d{2}:\d{2}/g;
    const found: string[] = [];
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      found.push(m[0]);
      m = re.exec(text);
    }
    return found;
  }

  for (const parts of QUOTERS) {
    const rel = parts.join("/");
    it(`${rel} quotes 00:05 and not the purge's time`, () => {
      const quoted = timesIn(source(...parts));
      expect(quoted).toContain(utcTimeOf(slots.materialize));
      expect(quoted).not.toContain(utcTimeOf(slots.purge));
    });
  }
});
