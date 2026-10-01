import { describe, expect, it } from "vitest";
import { CreateManualEntrySchema, UpdateTimeEntrySchema } from "@/lib/schemas/time";
import { MAX_MANUAL_ENTRY_MS } from "@/lib/time/thresholds";

describe("CreateManualEntrySchema", () => {
  const hour = 60 * 60 * 1000;
  const start = new Date(Date.now() - 3 * hour);
  const end = new Date(Date.now() - 2 * hour);

  it("accepts a valid completed window", () => {
    const r = CreateManualEntrySchema.safeParse({ clockInAt: start, clockOutAt: end });
    expect(r.success).toBe(true);
  });

  it("coerces ISO strings to dates", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: start.toISOString(),
      clockOutAt: end.toISOString(),
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.clockInAt).toBeInstanceOf(Date);
  });

  it("rejects clock-out before clock-in", () => {
    const r = CreateManualEntrySchema.safeParse({ clockInAt: end, clockOutAt: start });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("clockOutAt"))).toBe(true);
  });

  it("rejects equal in/out (zero-length)", () => {
    const r = CreateManualEntrySchema.safeParse({ clockInAt: start, clockOutAt: start });
    expect(r.success).toBe(false);
  });

  it("rejects a clock-out in the future", () => {
    const future = new Date(Date.now() + 3 * hour);
    const r = CreateManualEntrySchema.safeParse({ clockInAt: start, clockOutAt: future });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("clockOutAt"))).toBe(true);
  });

  it("allows an optional task id and note", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: start,
      clockOutAt: end,
      taskId: "task_123",
      note: "  fixed the build  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBe("fixed the build"); // trimmed
  });

  it("rejects a note over 500 chars", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: start,
      clockOutAt: end,
      note: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });
});

/**
 * time-005 (the schema half) and time-009.
 *
 * CreateManualEntrySchema refined only "clock-out after clock-in" and "not in
 * the future", so `clockInAt: 1990-01-01` with `clockOutAt: now` parsed and was
 * stored as one 36-year session. `createManualEntryAction` is deliberately
 * ungated by role - "any member can log their own forgotten work with no
 * elevated permission" - so the lowest-privilege user in the workspace set the
 * number that /settings "Total tracked", the /time KPI and every project rollup
 * report.
 *
 * UpdateTimeEntrySchema (the admin edit) carried ONE refine and no upper bound
 * at all, on either end. A datetime-local year spinner is one scroll away from
 * 2028, and nothing downstream flags it: durationMs returns the literal
 * interval, so a single fat-fingered year adds thousands of hours to every
 * lifetime total in the product. The "you cannot log time in the future" rule
 * the manual path already enforces has to hold on the path that can edit
 * SOMEBODY ELSE's timesheet too.
 */
describe("CreateManualEntrySchema - maximum session length (time-005)", () => {
  const hour = 60 * 60 * 1000;

  it("rejects a session longer than a day", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: new Date(Date.now() - 30 * hour),
      clockOutAt: new Date(Date.now() - hour),
    });
    expect(r.success, "a 29-hour 'session' is not a session").toBe(false);
  });

  it("rejects the years-long window the finding names", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: new Date("1990-01-01T00:00:00.000Z"),
      clockOutAt: new Date(Date.now() - hour),
    });
    expect(r.success).toBe(false);
  });

  it("still accepts a long but plausible day", () => {
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: new Date(Date.now() - 14 * hour),
      clockOutAt: new Date(Date.now() - hour),
    });
    expect(r.success, "a 13-hour crunch day is real and must stay loggable").toBe(true);
  });

  it("accepts exactly the cap", () => {
    const end = new Date(Date.now() - hour);
    const r = CreateManualEntrySchema.safeParse({
      clockInAt: new Date(end.getTime() - MAX_MANUAL_ENTRY_MS),
      clockOutAt: end,
    });
    expect(r.success).toBe(true);
  });
});

describe("UpdateTimeEntrySchema - the admin edit obeys the same clock (time-009)", () => {
  const hour = 60 * 60 * 1000;
  const year = 365 * 24 * hour;

  it("accepts an ordinary correction", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 3 * hour),
      clockOutAt: new Date(Date.now() - 2 * hour),
    });
    expect(r.success).toBe(true);
  });

  it("rejects a clock-out years in the future", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 3 * hour),
      clockOutAt: new Date(Date.now() + 2 * year),
    });
    expect(r.success, "one fat-fingered year adds thousands of hours to every total").toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("clockOutAt"))).toBe(true);
  });

  it("rejects a clock-in in the future", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() + 2 * year),
      clockOutAt: null,
    });
    expect(r.success, "a session cannot start after now").toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("clockInAt"))).toBe(true);
  });

  it("rejects an edit that stretches a session past the cap", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 40 * hour),
      clockOutAt: new Date(Date.now() - hour),
    });
    expect(r.success, "the edit path needs the same ceiling as the create path").toBe(false);
  });

  it("still allows reopening an entry by clearing the clock-out", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() - 2 * hour),
      clockOutAt: null,
    });
    expect(r.success, "'leave blank if still running' is documented UI").toBe(true);
  });

  it("absorbs clock skew on the near side of now", () => {
    const r = UpdateTimeEntrySchema.safeParse({
      entryId: "e1",
      clockInAt: new Date(Date.now() - hour),
      clockOutAt: new Date(Date.now() + 30_000),
    });
    expect(r.success, "a 30s skew is the client's clock, not a fat finger").toBe(true);
  });
});
