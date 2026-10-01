/**
 * <WeeklyTimesheet> — time-018, the overnight shift.
 *
 * THE BUG. The grid bucketed with `entries.filter(e => isSameDay(clockInAt, day))`
 * and then summed each matched row's FULL duration. So a session that crosses
 * local midnight was credited entirely to the day it STARTED, while the day it
 * mostly happened on showed "No entries / —". Two consequences, both of which
 * look authoritative on screen:
 *
 *   • A Sunday 22:00 → Monday 02:00 session puts four hours into the previous
 *     week's Sunday cell and nothing into the week that contains most of it, so
 *     the new week's "Week total" is understated with no indication at all.
 *   • Within one week, the start day over-reports by exactly the part that
 *     happened after midnight and the next day under-reports by the same amount,
 *     while the column headers read as "hours worked on this date".
 *
 * WHY THESE ASSERTIONS AND NOT A SNAPSHOT. The fix is `clippedDurationMs`, which
 * has its own property test in tests/lib/time/thresholds.test.ts (summing a
 * session's per-day shares returns the session). That proves the arithmetic. It
 * proves nothing about whether the grid CALLS it — this repo has shipped nine
 * instances of complete, tested code with no caller — so this file drives the real
 * component and reads the numbers out of the rendered cells.
 *
 * ON THE DOM QUERY. The seven day cells are the children of the one `div.grid`,
 * in Monday-first order, and each cell's header holds its total in its only
 * `<span>`. That is walked rather than hooked with a test-only attribute, so the
 * test breaks if the markup stops presenting a per-day total — which is the thing
 * being asserted.
 *
 * TIMEZONE. `npm test` pins TZ=America/Bogota. Every fixture below is built with
 * the local `new Date(y, m, d, h)` constructor and handed to the component as the
 * ISO string the RSC boundary would carry, so "midnight" here means the same
 * midnight the component's date-fns calls mean. A bare `npx vitest run` in another
 * zone will move the day boundaries and these assertions with them.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { WeeklyTimesheet } from "@/components/time/weekly-timesheet";
import type { TimeEntryClient } from "@/lib/queries/time";

/** Wednesday 27 May 2026, midday local — so the grid opens on Mon 25 – Sun 31. */
const RENDERED_AT = new Date(2026, 4, 27, 12, 0, 0);

function entry(clockIn: Date, clockOut: Date | null, over: Partial<TimeEntryClient> = {}) {
  return {
    id: `e_${clockIn.getTime()}`,
    companyId: "c_nimbus",
    userId: "u_admin",
    userName: "Ayesha",
    taskId: null,
    taskTitle: "Night deploy",
    note: null,
    clockInAt: clockIn.toISOString(),
    clockOutAt: clockOut ? clockOut.toISOString() : null,
    lastActivityAt: (clockOut ?? clockIn).toISOString(),
    autoClosed: false,
    editedBy: null,
    editedByName: null,
    editedAt: null,
    createdAt: clockIn.toISOString(),
    ...over,
  } satisfies TimeEntryClient;
}

function draw(entries: TimeEntryClient[]) {
  const { container } = render(
    <WeeklyTimesheet entries={entries} showPerson={false} renderedAt={RENDERED_AT} />
  );
  const grid = container.querySelector("div.grid");
  if (!grid) throw new Error("the weekly grid did not render");
  const cells = Array.from(grid.children);
  if (cells.length !== 7) throw new Error(`expected 7 day cells, got ${cells.length}`);
  return {
    container,
    /** Mon = 0 … Sun = 6. The rendered per-day total, e.g. "2h 00m" or "—". */
    dayTotal(index: number): string {
      const header = cells[index].firstElementChild;
      return header?.querySelector("span")?.textContent?.trim() ?? "";
    },
    weekTotal(): string {
      const label = Array.from(container.querySelectorAll("span")).find((s) =>
        s.textContent?.startsWith("Week total")
      );
      return label?.querySelector("span")?.textContent?.trim() ?? "";
    },
  };
}

describe("WeeklyTimesheet — a session that crosses midnight", () => {
  it("gives each day only the hours that happened on it", () => {
    // Mon 25 May 22:00 → Tue 26 May 02:00: two hours on each side of midnight.
    const view = draw([entry(new Date(2026, 4, 25, 22, 0), new Date(2026, 4, 26, 2, 0))]);

    expect(view.dayTotal(0), "Monday was credited the whole session").toBe("2h 00m");
    expect(view.dayTotal(1), "Tuesday's two real hours were missing").toBe("2h 00m");
  });

  it("shows the Tuesday-morning half as a row on Tuesday, not only on Monday", () => {
    const view = draw([entry(new Date(2026, 4, 25, 22, 0), new Date(2026, 4, 26, 2, 0))]);
    const tuesday = view.container.querySelector("div.grid")!.children[1];
    expect(
      tuesday.textContent,
      "the day that contains half the session said 'No entries'"
    ).not.toContain("No entries");
  });

  it("counts a Sunday-night session in the week that contains most of it", () => {
    // The finding's sharpest case: Sun 24 May 22:00 → Mon 25 May 02:00 starts in
    // the PREVIOUS week, so bucketing on clock-in dropped it out of this week's
    // grid and out of this week's total altogether.
    const view = draw([entry(new Date(2026, 4, 24, 22, 0), new Date(2026, 4, 25, 2, 0))]);

    expect(view.dayTotal(0), "Monday's two hours were in last week's Sunday cell").toBe("2h 00m");
    expect(view.weekTotal(), "the week total denied hours the list view counted").toBe("2h 00m");
  });

  it("leaves an ordinary same-day session exactly as it was", () => {
    // Guard-the-guard: this passed before the fix and must keep passing, or the
    // fix has moved the common case.
    const view = draw([entry(new Date(2026, 4, 27, 9, 0), new Date(2026, 4, 27, 17, 30))]);

    expect(view.dayTotal(2)).toBe("8h 30m");
    expect(view.weekTotal()).toBe("8h 30m");
    expect(view.dayTotal(0)).toBe("—");
  });

  it("marks a row that carried over from the day before", () => {
    // Without a label the Tuesday row reads "22:00–02:00, 2h" on a day it did not
    // start, which is its own kind of wrong number. The cell has to say the row
    // is a continuation.
    const view = draw([entry(new Date(2026, 4, 25, 22, 0), new Date(2026, 4, 26, 2, 0))]);
    const tuesday = view.container.querySelector("div.grid")!.children[1];
    expect(tuesday.textContent?.toLowerCase()).toContain("cont");
  });
});
