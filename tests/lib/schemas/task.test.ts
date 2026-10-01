import { describe, it, expect, afterEach, vi } from "vitest";
import { NewTaskSchema, TaskStatusUpdateSchema } from "@/lib/schemas/task";

describe("NewTaskSchema", () => {
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  };

  const valid = () => ({
    title: "Ship the migration",
    description: "Roll the schema change",
    status: "pending" as const,
    priority: "high" as const,
    // Required since the add_projects schema change.
    projectId: "p1",
    assignedTo: "user-1",
    deadline: tomorrow(),
  });

  it("accepts a valid task", () => {
    expect(NewTaskSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects empty title", () => {
    expect(NewTaskSchema.safeParse({ ...valid(), title: "" }).success).toBe(false);
    expect(NewTaskSchema.safeParse({ ...valid(), title: "   " }).success).toBe(false);
  });

  it("caps title at 200 chars", () => {
    expect(NewTaskSchema.safeParse({ ...valid(), title: "x".repeat(201) }).success).toBe(false);
  });

  it("rejects unknown status / priority", () => {
    expect(
      NewTaskSchema.safeParse({ ...valid(), status: "done" as unknown as "pending" }).success
    ).toBe(false);
    expect(
      NewTaskSchema.safeParse({ ...valid(), priority: "asap" as unknown as "high" }).success
    ).toBe(false);
  });

  it("rejects empty assignee", () => {
    expect(NewTaskSchema.safeParse({ ...valid(), assignedTo: "" }).success).toBe(false);
  });

  it("rejects invalid deadline strings", () => {
    expect(NewTaskSchema.safeParse({ ...valid(), deadline: "nope" }).success).toBe(false);
  });

  it("accepts a deadline of today (start-of-day)", () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0); // noon today
    expect(NewTaskSchema.safeParse({ ...valid(), deadline: today.toISOString() }).success).toBe(
      true
    );
  });

  it("accepts TODAY as the date-only value an <input type=date> actually sends", () => {
    /*
     * THE CASE THAT WAS MISSING, and its absence is why tasks-and-comments-011
     * stayed half-open. The case above passes a local-noon INSTANT, whose UTC
     * parts land on the same day in any zone — so it passed before the fix and
     * after it, and said nothing about the real input.
     *
     * The form sends `"YYYY-MM-DD"`. `new Date("2026-10-15")` is UTC midnight
     * under the ES date-only rule, and the old refine compared it against LOCAL
     * midnight — so at `TZ=America/Bogota` (UTC-5, which `npm test` pins) it was
     * five hours in the past and "due today" was refused outright. The form
     * converts the day to a noon-UTC instant in `onSubmit`, but `zodResolver` runs
     * the schema first and `handleSubmit` never reaches `onSubmit` on a failure,
     * so the conversion could not rescue it.
     */
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayDayValue = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const result = NewTaskSchema.safeParse({ ...valid(), deadline: todayDayValue });
    expect(
      result.success,
      "a customer west of Greenwich could not schedule a task for today at all"
    ).toBe(true);
  });

  it("rejects a deadline properly in the past (audit flaw #37)", () => {
    // TWO days back, not one — see the tolerance case below.
    const past = new Date();
    past.setDate(past.getDate() - 2);
    const result = NewTaskSchema.safeParse({ ...valid(), deadline: past.toISOString() });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /past/i.test(i.message))).toBe(true);
    }
  });

  it("tolerates YESTERDAY, deliberately, and this is the reason", () => {
    /*
     * A DELIBERATE RELAXATION, recorded rather than left for someone to discover.
     * This case previously asserted yesterday was REJECTED.
     *
     * The schema runs in the browser AND inside `addTaskAction`, and the action
     * runs on a UTC host. A customer at UTC-5 submitting their own "today" at
     * 23:30 local is already tomorrow in the server's frame, so a strict
     * today-bound accepts the value in the browser and then refuses it on the
     * server — a five-hour window every day in which scheduling work for today is
     * impossible, and no error copy that could explain why. No timezone is stored
     * per user yet (that column is the real fix and is out of scope), and the
     * widest real offset is under 24h, so one day of slack makes a valid "today"
     * impossible to refuse from any zone.
     *
     * The cost is that a deadline one day stale is accepted. That is a smaller
     * harm than blocking someone from scheduling today's work, which is the
     * trade this case exists to state.
     */
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(NewTaskSchema.safeParse({ ...valid(), deadline: yesterday.toISOString() }).success).toBe(
      true
    );
  });
});

describe("TaskStatusUpdateSchema", () => {
  it("accepts each of the three statuses", () => {
    for (const status of ["pending", "in_progress", "completed"] as const) {
      expect(TaskStatusUpdateSchema.safeParse({ id: "t1", status }).success).toBe(true);
    }
  });

  it("rejects empty id", () => {
    expect(TaskStatusUpdateSchema.safeParse({ id: "", status: "pending" }).success).toBe(false);
  });

  it("rejects unknown status", () => {
    expect(
      TaskStatusUpdateSchema.safeParse({ id: "t1", status: "blocked" as unknown as "pending" })
        .success
    ).toBe(false);
  });
});

/*
 * THE BOUND AND THE VALUE MUST BE READ IN THE SAME FRAME.
 *
 * Every other case in this file builds its fixture from `new Date()`, so which
 * side of a UTC-vs-local day boundary the run lands on is decided by the wall
 * clock. That is how the original bug shipped green and went red hours later
 * with no code change: at TZ=America/Bogota, after 19:00 local the UTC date has
 * already rolled over, the bound was computed from LOCAL parts and the value's
 * day from UTC parts, and the two disagreed by one — so a deadline two full days
 * in the past was accepted.
 *
 * These freeze the clock on both sides of that boundary instead of hoping. With
 * the bound back on local parts, the first case fails; it is the only test here
 * that fails deterministically rather than after 19:00.
 */
describe("NewTaskSchema deadline bound — frozen clock, both sides of the UTC boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The suite pins TZ=America/Bogota (UTC-5), so 19:03 local is 00:03 UTC the next day. */
  function freeze(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  const base = {
    title: "Ship the migration",
    description: "",
    status: "pending" as const,
    priority: "medium" as const,
    projectId: "p1",
    assignedTo: "u1",
  };

  const parse = (deadline: string) => NewTaskSchema.safeParse({ ...base, deadline });

  it("rejects two days back when UTC has rolled over and local has not", () => {
    // UTC 2026-10-01T00:03Z — local (Bogota) is still 2026-09-30 19:03.
    freeze("2026-10-01T00:03:00.000Z");
    // Two days before the UTC day: 2026-09-29. The bound is 2026-09-30.
    expect(
      parse("2026-09-29T12:00:00.000Z").success,
      "a local-parts bound reads 2026-09-29 here and accepts this"
    ).toBe(false);
  });

  it("still tolerates yesterday at that same instant", () => {
    freeze("2026-10-01T00:03:00.000Z");
    expect(parse("2026-09-30T12:00:00.000Z").success).toBe(true);
  });

  it("rejects two days back at midday, when local and UTC agree", () => {
    freeze("2026-10-01T17:00:00.000Z");
    expect(parse("2026-09-29T12:00:00.000Z").success).toBe(false);
  });

  it("accepts today at that same instant", () => {
    freeze("2026-10-01T17:00:00.000Z");
    expect(parse("2026-10-01T12:00:00.000Z").success).toBe(true);
  });

  it("walks back over a month boundary without special-casing", () => {
    // The 1st: yesterday is the last day of the previous month, and Date.UTC
    // normalises day 0 rather than producing "2026-10-00".
    freeze("2026-10-01T17:00:00.000Z");
    expect(parse("2026-09-30T12:00:00.000Z").success, "yesterday is 30 September").toBe(true);
    expect(parse("2026-09-29T12:00:00.000Z").success).toBe(false);
  });
});
