import { describe, it, expect } from "vitest";
import {
  buildMonthGrid,
  MAX_CHIPS_PER_DAY,
  WEEK_OPTS,
  type CalendarCell,
} from "@/lib/tasks/calendar";
import { agendaDays } from "@/components/tasks/task-calendar";
import type { Task } from "@/lib/types";

/**
 * THIS SUITE'S TIMEZONE IS PART OF THE TEST.
 *
 * The day-edge cases below exist to catch one bug: bucketing a task on its
 * deadline's UTC calendar day instead of the viewer's local one. An instant
 * can only tell those two implementations apart when its local date and its
 * UTC date actually differ — and under TZ=UTC they never do. So when this file
 * ran in UTC (which is what `ubuntu-latest` gives you, and what CI used), the
 * test named "one minute before local midnight" passed identically against the
 * correct code and against the bug it was named for. It could not fail.
 *
 * The fix is a pinned zone, set by `cross-env TZ=...` in package.json's vitest
 * scripts rather than by vitest config: the process environment has to be right
 * before the worker starts, because `test.env` is applied after module code may
 * already have constructed Dates. America/Bogota is a fixed −05:00 with no DST
 * — no test in the repo then straddles a clock change — and it is the exact
 * mirror of the product's own PKT (+05:00), so the day-edge arithmetic has the
 * same magnitude as a real user's, pointed at the other edge of the day.
 *
 * `assertPinned` below is the tripwire's tripwire. Delete the TZ pin and it
 * fails loudly instead of letting the day-edge cases go quietly vacuous again.
 */
const UTC_PIN_MESSAGE =
  "This suite must NOT run in UTC. In UTC a local calendar day and a UTC " +
  "calendar day are the same day, so the day-edge cases below pass against " +
  "correct code and against UTC-day bucketing alike — they prove nothing. " +
  "Two ways to land here: you ran `npx vitest` directly instead of `npm test` " +
  "(the TZ is pinned on the npm script, so run it that way), or the " +
  "`cross-env TZ=America/Bogota` prefix was removed from the vitest scripts " +
  "in package.json and needs restoring.";

// Helper: a task is only ever read for its deadline, priority and order here,
// so the factory fills the rest with values the grid never looks at. Deadlines
// are built from LOCAL components and then serialised, which is what the app
// stores — see the local-day describe block for why that matters.
function task(overrides: Partial<Task> & { deadline: string }): Task {
  return {
    id: "t_" + overrides.deadline,
    companyId: "c1",
    projectId: "p1",
    title: "Task",
    description: "",
    status: "pending",
    priority: "medium",
    assignedTo: "u1",
    assignedToName: "Ali",
    assignedBy: "u2",
    assignedByName: "Sara",
    createdAt: "2026-09-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

/** Local wall-clock -> the ISO instant the DB would hold. */
function localIso(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m, d, h, min).toISOString();
}

/**
 * True when this instant sits on one calendar day locally and a different one
 * in UTC — i.e. when it is capable of failing against a `getUTCDate()`
 * implementation. Every day-edge assertion is guarded by this.
 */
function crossesUtcDay(iso: string): boolean {
  return new Date(iso).getDate() !== new Date(iso).getUTCDate();
}

describe("TZ (the pin the day-edge cases stand on)", () => {
  it("runs the suite outside UTC", () => {
    // getTimezoneOffset is read at the date under test rather than "now", so a
    // DST-observing zone can't pass here in January and lie in July.
    expect(new Date(2026, 8, 23).getTimezoneOffset(), UTC_PIN_MESSAGE).not.toBe(0);
  });
});

describe("buildMonthGrid (the month view behind the /tasks Calendar tab)", () => {
  // September 2026 starts on a Tuesday and has 30 days -> Mon 31 Aug through
  // Sun 4 Oct = 5 weeks.
  const SEPT = new Date(2026, 8, 1);
  const NOW = new Date(2026, 8, 23, 10, 0);

  it("always returns whole weeks starting on Monday", () => {
    const cells = buildMonthGrid(SEPT, [], NOW);
    expect(cells.length % 7).toBe(0);
    // getDay(): 0 = Sunday, 1 = Monday.
    expect(cells[0]!.date.getDay()).toBe(1);
    expect(cells[cells.length - 1]!.date.getDay()).toBe(0);
  });

  it("agrees with the weekly timesheet on where a week starts", () => {
    // The timesheet and the calendar both read WEEK_OPTS. If someone changes
    // one to Sunday-start, a product showing Mon-start timesheets beside
    // Sun-start tasks is the bug that follows.
    expect(WEEK_OPTS.weekStartsOn).toBe(1);
  });

  it("returns thirty-five cells for a month that fits in five weeks", () => {
    expect(buildMonthGrid(SEPT, [], NOW)).toHaveLength(35);
  });

  it("returns forty-two cells for a month that spans six", () => {
    // August 2026: 31 days starting on a Saturday -> Mon 27 Jul .. Sun 6 Sep.
    expect(buildMonthGrid(new Date(2026, 7, 1), [], NOW)).toHaveLength(42);
  });

  it("marks the padding days that fall outside the target month", () => {
    const cells = buildMonthGrid(SEPT, [], NOW);
    expect(cells[0]!.inMonth).toBe(false); // 31 Aug
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it("marks exactly one day as today, and only when it is in view", () => {
    const inView = buildMonthGrid(SEPT, [], NOW).filter((c) => c.isToday);
    expect(inView).toHaveLength(1);
    expect(inView[0]!.date.getDate()).toBe(23);
    // Page a long way away and nothing is today.
    expect(buildMonthGrid(new Date(2027, 0, 1), [], NOW).some((c) => c.isToday)).toBe(false);
  });
});

describe("buildMonthGrid buckets by the day a deadline NAMES", () => {
  const SEPT = new Date(2026, 8, 1);
  const NOW = new Date(2026, 8, 23, 10, 0);

  function dayOf(cells: CalendarCell<Task>[], id: string) {
    const cell = cells.find((c) => c.tasks.some((t) => t.id === id));
    return cell ? cell.date.getDate() : null;
  }

  /*
   * THESE TWO CASES WERE REWRITTEN, AND THE MODEL THEY DEFENDED WAS OVERRULED.
   * Recording it, because deleting an argued guard quietly is how a product ends
   * up with two answers to one question.
   *
   * They asserted LOCAL-day bucketing, on the premise that "Task.deadline is an
   * ISO instant in UTC", and built their fixtures with `localIso(…, 23, 59)` —
   * 23:59 in the viewer's zone. That premise is the one tasks-and-comments-011
   * rejected: a deadline is a CALENDAR DAY (see lib/tasks/deadline.ts), the server
   * has always read it from UTC parts, and the four client surfaces that read it
   * in the viewer's zone were the bug, not the contract.
   *
   * What settles it is that the fixtures were unreachable. Nothing in the product
   * writes 23:59 local: `deadlineInstantForDay` writes NOON UTC, and legacy rows
   * are MIDNIGHT UTC. So those cases pinned the grid's behaviour for instants the
   * product cannot produce, while leaving the two it does produce untested — and
   * the grid is PAGED by `startOfMonth(deadlineDay(...))`, so local-day bucketing
   * made one component read the day two different ways: the card said Oct 15 and
   * the chip sat in the Oct 14 cell.
   *
   * The cases below use the two instants that really exist, and the UTC pin still
   * earns its keep: at −05:00 a midnight-UTC row is the PREVIOUS local day, so a
   * local-day implementation lands it on the 22nd and fails.
   */
  it("buckets a NOON-UTC deadline — what the picker writes — on the day it names", () => {
    const deadline = "2026-09-23T12:00:00.000Z";
    const t = task({ id: "noon", deadline });
    expect(dayOf(buildMonthGrid(SEPT, [t], NOW), "noon")).toBe(23);
  });

  it("buckets a legacy MIDNIGHT-UTC deadline on the day it names, not the day before", () => {
    // The row shape that predates tasks-and-comments-011, and the one a viewer
    // west of Greenwich saw shifted. At −05:00 this instant is 22 Sep 19:00
    // locally, so a local-day implementation puts it in the 22nd cell.
    const deadline = "2026-09-23T00:00:00.000Z";
    expect(crossesUtcDay(deadline), UTC_PIN_MESSAGE).toBe(true);
    const t = task({ id: "legacy", deadline });
    expect(
      dayOf(buildMonthGrid(SEPT, [t], NOW), "legacy"),
      "the chip must sit in the cell the card's own text names"
    ).toBe(23);
  });

  it("agrees with the card text for every hour of a stored day", () => {
    // Swept across the UTC day rather than picking two instants, so the grid and
    // `deadlineDayValue` — which is what the card renders — cannot diverge at any
    // hour. This is the assertion that makes "one component, one reading of the
    // day" a property rather than a claim.
    const instants = Array.from(
      { length: 24 },
      (_, h) => `2026-09-23T${String(h).padStart(2, "0")}:00:00.000Z`
    );
    const tasks = instants.map((deadline, i) => task({ id: `hour-${i}`, deadline }));
    const cells = buildMonthGrid(SEPT, tasks, NOW);
    tasks.forEach((t) => {
      expect(dayOf(cells, t.id), `${t.deadline} did not bucket on the day it names`).toBe(23);
    });
  });

  it("drops a task whose deadline falls in a padding day onto that padding day", () => {
    // 31 Aug renders as a leading pad cell of September; work due then should
    // still be visible rather than silently vanishing.
    const t = task({ id: "pad", deadline: localIso(2026, 7, 31) });
    const cells = buildMonthGrid(SEPT, [t], NOW);
    const cell = cells.find((c) => c.tasks.some((x) => x.id === "pad"));
    expect(cell?.inMonth).toBe(false);
    expect(cell?.date.getDate()).toBe(31);
  });

  it("leaves a task outside the rendered range out of every cell", () => {
    const t = task({ id: "far", deadline: localIso(2026, 11, 25) });
    const cells = buildMonthGrid(SEPT, [t], NOW);
    expect(cells.some((c) => c.tasks.length > 0)).toBe(false);
  });
});

describe("buildMonthGrid ordering within a day", () => {
  const SEPT = new Date(2026, 8, 1);
  const NOW = new Date(2026, 8, 23, 10, 0);

  it("puts the worst priority first, then falls back to the board's manual order", () => {
    // Deliberately inserted best-first so a stable-sort no-op would fail.
    const same = localIso(2026, 8, 15);
    const cells = buildMonthGrid(
      SEPT,
      [
        task({ id: "low", priority: "low", order: 1, deadline: same }),
        task({ id: "med-b", priority: "medium", order: 2, deadline: same }),
        task({ id: "med-a", priority: "medium", order: 1, deadline: same }),
        task({ id: "urgent", priority: "urgent", order: 9, deadline: same }),
        task({ id: "high", priority: "high", order: 0, deadline: same }),
      ],
      NOW
    );
    const day = cells.find((c) => c.date.getDate() === 15 && c.inMonth)!;
    expect(day.tasks.map((t) => t.id)).toEqual(["urgent", "high", "med-a", "med-b", "low"]);
  });

  it("does not mutate the caller's array", () => {
    // The grid sorts per cell; doing it in place would reorder the board.
    const same = localIso(2026, 8, 15);
    const input = [
      task({ id: "low", priority: "low", deadline: same }),
      task({ id: "urgent", priority: "urgent", deadline: same }),
    ];
    buildMonthGrid(SEPT, input, NOW);
    expect(input.map((t) => t.id)).toEqual(["low", "urgent"]);
  });
});

describe("agendaDays (what the narrow calendar layout lists)", () => {
  const SEPT = new Date(2026, 8, 1);
  const NOW = new Date(2026, 8, 23, 10, 0);

  const idsIn = (cells: CalendarCell<Task>[]) =>
    cells
      .flatMap((c) => c.tasks.map((t) => t.id))
      .slice()
      .sort();

  it("surfaces exactly the tasks the desktop grid does, padding days included", () => {
    // The desktop grid maps EVERY cell; the agenda used to filter on `inMonth`
    // as well as on having work, so a task due on a leading/trailing padding
    // day rendered on a laptop and vanished on a phone. Same data, two
    // layouts — they are not allowed to disagree about what exists.
    const tasks = [
      task({ id: "lead-pad", deadline: localIso(2026, 7, 31) }), // Mon 31 Aug
      task({ id: "in-month", deadline: localIso(2026, 8, 15) }), // Tue 15 Sep
      task({ id: "trail-pad", deadline: localIso(2026, 9, 1) }), // Thu 1 Oct
    ];
    const cells = buildMonthGrid(SEPT, tasks, NOW);

    // The comparison is only worth anything if the grid really is carrying
    // padding-day work — assert that first, or an agenda that drops everything
    // would still "agree" with a grid that never had anything.
    expect(idsIn(cells)).toEqual(["in-month", "lead-pad", "trail-pad"]);
    expect(idsIn(agendaDays(cells))).toEqual(idsIn(cells));
  });

  it("keeps only the days that carry work, so a phone is not thirty-five empty headers", () => {
    const cells = buildMonthGrid(SEPT, [task({ id: "one", deadline: localIso(2026, 8, 15) })], NOW);
    const days = agendaDays(cells);
    expect(days).toHaveLength(1);
    days.forEach((d) => expect(d.tasks.length).toBeGreaterThan(0));
  });

  it("preserves the grid's ordering so the two layouts read the same way", () => {
    const tasks = [
      task({ id: "later", deadline: localIso(2026, 8, 17) }),
      task({ id: "earlier", deadline: localIso(2026, 8, 15) }),
    ];
    const cells = buildMonthGrid(SEPT, tasks, NOW);
    const days = agendaDays(cells);
    expect(days.map((d) => d.date.getDate())).toEqual([15, 17]);
  });
});

describe("MAX_CHIPS_PER_DAY", () => {
  it("leaves room for a plus-N control rather than filling the cell", () => {
    // A day cell is min-h-[7.5rem]; four chips plus the date overflow it.
    // If this grows, re-check the cell height in task-calendar.tsx.
    expect(MAX_CHIPS_PER_DAY).toBeLessThanOrEqual(3);
  });
});
