import { describe, expect, it } from "vitest";
import {
  AUTO_CLOSE_MS,
  WARN_AFTER_MS,
  canEditEntryTimes,
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
