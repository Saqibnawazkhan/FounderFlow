import { describe, expect, it } from "vitest";
import {
  AUTO_CLOSE_MS,
  WARN_AFTER_MS,
  canEditEntryTimes,
  clippedDurationMs,
  durationMs,
  entryState,
  formatDuration,
  sumDurations,
} from "@/lib/time/thresholds";

const MIN = 60_000;
const HR = 60 * MIN;

const baseNow = new Date("2026-05-24T10:00:00Z");

describe("entryState", () => {
  it("is 'active' when the heartbeat is fresh", () => {
    expect(entryState(new Date(baseNow.getTime() - 5 * MIN), baseNow)).toBe("active");
  });

  it("flips to 'warn' once idle hits WARN_AFTER_MS", () => {
    expect(entryState(new Date(baseNow.getTime() - WARN_AFTER_MS), baseNow)).toBe("warn");
  });

  it("stays 'warn' through the 30-min response window", () => {
    expect(entryState(new Date(baseNow.getTime() - WARN_AFTER_MS - 15 * MIN), baseNow)).toBe(
      "warn"
    );
  });

  it("flips to 'auto-close' at the AUTO_CLOSE_MS cutoff", () => {
    expect(entryState(new Date(baseNow.getTime() - AUTO_CLOSE_MS), baseNow)).toBe("auto-close");
  });

  it("stays 'auto-close' past the cutoff", () => {
    expect(entryState(new Date(baseNow.getTime() - 24 * HR), baseNow)).toBe("auto-close");
  });
});

describe("durationMs", () => {
  const start = new Date("2026-05-24T09:00:00Z");

  it("uses now() for open entries", () => {
    expect(durationMs(start, null, new Date(start.getTime() + 90 * MIN))).toBe(90 * MIN);
  });

  it("uses clockOutAt for closed entries", () => {
    const end = new Date(start.getTime() + 3 * HR);
    // `now` should be ignored when entry is closed
    expect(durationMs(start, end, new Date(start.getTime() + 99 * HR))).toBe(3 * HR);
  });

  it("returns 0 (not negative) when clockOutAt is before clockInAt", () => {
    expect(durationMs(start, new Date(start.getTime() - 10 * MIN))).toBe(0);
  });
});

describe("formatDuration", () => {
  it("renders minutes only under 1h", () => {
    expect(formatDuration(45 * MIN)).toBe("45m");
  });

  it("renders zero for 0ms", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("zero-pads the minutes part once >= 1h", () => {
    expect(formatDuration(1 * HR + 4 * MIN)).toBe("1h 04m");
    expect(formatDuration(8 * HR + 30 * MIN)).toBe("8h 30m");
  });

  it("clamps negative inputs to 0m", () => {
    expect(formatDuration(-5)).toBe("0m");
  });
});

describe("sumDurations", () => {
  it("totals open + closed entries against the same now", () => {
    const now = new Date("2026-05-24T15:00:00Z");
    const total = sumDurations(
      [
        // 2h closed
        {
          clockInAt: new Date("2026-05-24T08:00:00Z"),
          clockOutAt: new Date("2026-05-24T10:00:00Z"),
        },
        // open, 1h since
        { clockInAt: new Date("2026-05-24T14:00:00Z"), clockOutAt: null },
      ],
      now
    );
    expect(total).toBe(3 * HR);
  });

  it("returns 0 for an empty list", () => {
    expect(sumDurations([])).toBe(0);
  });
});

describe("canEditEntryTimes", () => {
  it("allows admin + cofounder", () => {
    expect(canEditEntryTimes("admin")).toBe(true);
    expect(canEditEntryTimes("cofounder")).toBe(true);
  });
  it("blocks members", () => {
    expect(canEditEntryTimes("member")).toBe(false);
  });
});

/**
 * time-015 - durationMs documents a cap it does not have.
 *
 * Its own docstring says "Elapsed working time in milliseconds, capped at the
 * auto-close horizon while the entry is still open", and the body is
 * `Math.max(0, now - clockInAt)`. Nothing caps anything. The auto-close is driven
 * by IDLE time, not elapsed time, and components/time/clock-widget.tsx heartbeats
 * every 5 minutes whenever `document.hidden` is false - so a tab parked on a
 * second monitor resets lastActivityAt for ever, entryState() never leaves
 * "active", and the sweep's `lastActivityAt: { lt: cutoff }` never matches. A
 * timer started Friday afternoon is still counting on Monday and reads 70h+, and
 * because the entry was never auto-closed there is no badge anywhere warning that
 * the number is junk. That figure flows into /time "Total tracked", /settings, and
 * getClockedInPeers.
 */
describe("durationMs - the documented cap on an open entry (time-015)", () => {
  const start = new Date("2026-05-24T09:00:00Z");

  it("does not credit a tab left open over a weekend with 40 hours", () => {
    expect(durationMs(start, null, new Date(start.getTime() + 40 * HR))).toBeLessThanOrEqual(
      AUTO_CLOSE_MS
    );
  });

  it("caps at exactly the auto-close horizon", () => {
    expect(durationMs(start, null, new Date(start.getTime() + 70 * HR))).toBe(AUTO_CLOSE_MS);
  });

  it("leaves a normal open session alone", () => {
    expect(durationMs(start, null, new Date(start.getTime() + 3 * HR))).toBe(3 * HR);
  });

  it("does NOT cap a closed entry - a recorded 26h session is a fact, not an estimate", () => {
    // The cap answers "how long has this been running", which is a guess about
    // an unattended tab. Once someone (or the sweep) wrote clockOutAt, the
    // interval is recorded history and clamping it would silently rewrite a
    // customer's timesheet.
    const end = new Date(start.getTime() + 26 * HR);
    expect(durationMs(start, end, new Date(start.getTime() + 99 * HR))).toBe(26 * HR);
  });
});

/**
 * time-018 - an overnight shift is credited entirely to the day it started.
 *
 * components/time/weekly-timesheet.tsx buckets with
 * `isSameDay(new Date(e.clockInAt), day)` and then sums each matched row's FULL
 * duration, so a Sunday 22:00 -> Monday 02:00 session puts 4h into the previous
 * week's Sunday cell and 0h into the week that contains most of it. The two
 * adjacent weeks then disagree with the list view's own total, and the per-day
 * numbers read as "hours worked on this date" when they are not.
 *
 * This is the pure half: clip the interval to the day and sum the clipped
 * length. It also carries the DST case, which is inert in Pakistan (no DST) and
 * is not inert for a customer in a zone that has it - a clipped interval is
 * correct there because both bounds come from date-fns' local-day arithmetic
 * rather than from a 24h constant.
 */
describe("clippedDurationMs - splitting a session at the day boundary (time-018)", () => {
  const dayStart = new Date(2026, 4, 25, 0, 0, 0, 0); // Mon 25 May, local
  const dayEnd = new Date(2026, 4, 26, 0, 0, 0, 0); // Tue 26 May, local
  const prevStart = new Date(2026, 4, 24, 0, 0, 0, 0);

  it("gives the start day only the part before midnight", () => {
    const clockIn = new Date(2026, 4, 24, 22, 0, 0); // Sun 22:00
    const clockOut = new Date(2026, 4, 25, 2, 0, 0); // Mon 02:00
    expect(clippedDurationMs(clockIn, clockOut, prevStart, dayStart)).toBe(2 * HR);
  });

  it("gives the following day the part after midnight", () => {
    const clockIn = new Date(2026, 4, 24, 22, 0, 0);
    const clockOut = new Date(2026, 4, 25, 2, 0, 0);
    expect(clippedDurationMs(clockIn, clockOut, dayStart, dayEnd)).toBe(2 * HR);
  });

  it("gives an unrelated day nothing", () => {
    const clockIn = new Date(2026, 4, 24, 22, 0, 0);
    const clockOut = new Date(2026, 4, 25, 2, 0, 0);
    const laterStart = new Date(2026, 4, 27, 0, 0, 0, 0);
    const laterEnd = new Date(2026, 4, 28, 0, 0, 0, 0);
    expect(clippedDurationMs(clockIn, clockOut, laterStart, laterEnd)).toBe(0);
  });

  it("leaves a session wholly inside one day untouched", () => {
    const clockIn = new Date(2026, 4, 25, 9, 0, 0);
    const clockOut = new Date(2026, 4, 25, 17, 30, 0);
    expect(clippedDurationMs(clockIn, clockOut, dayStart, dayEnd)).toBe(8 * HR + 30 * MIN);
  });

  it("credits a whole day to a session that spans it end to end", () => {
    const clockIn = new Date(2026, 4, 24, 20, 0, 0);
    const clockOut = new Date(2026, 4, 26, 4, 0, 0);
    expect(clippedDurationMs(clockIn, clockOut, dayStart, dayEnd)).toBe(24 * HR);
  });

  it("clips a still-running session at `now`, and caps it like durationMs does", () => {
    const clockIn = new Date(2026, 4, 25, 23, 0, 0);
    const now = new Date(2026, 4, 26, 1, 0, 0);
    // 23:00 -> midnight is the Monday share; the Tuesday share is 00:00 -> now.
    expect(clippedDurationMs(clockIn, null, dayStart, dayEnd, now)).toBe(1 * HR);
    const nextEnd = new Date(2026, 4, 27, 0, 0, 0, 0);
    expect(clippedDurationMs(clockIn, null, dayEnd, nextEnd, now)).toBe(1 * HR);
  });

  it("never returns a negative share for a reversed interval", () => {
    const clockIn = new Date(2026, 4, 25, 12, 0, 0);
    const clockOut = new Date(2026, 4, 25, 9, 0, 0);
    expect(clippedDurationMs(clockIn, clockOut, dayStart, dayEnd)).toBe(0);
  });

  it("sums to the whole session across the days it touches", () => {
    // The property the grid needs: no hour is lost and none is counted twice.
    const clockIn = new Date(2026, 4, 24, 22, 0, 0);
    const clockOut = new Date(2026, 4, 26, 3, 0, 0);
    const days = [
      [prevStart, dayStart],
      [dayStart, dayEnd],
      [dayEnd, new Date(2026, 4, 27, 0, 0, 0, 0)],
    ] as const;
    const summed = days.reduce(
      (acc, [s, e]) => acc + clippedDurationMs(clockIn, clockOut, s, e),
      0
    );
    expect(summed).toBe(durationMs(clockIn, clockOut));
  });
});
