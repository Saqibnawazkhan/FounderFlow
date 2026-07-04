import { describe, expect, it } from "vitest";
import { CreateManualEntrySchema } from "@/lib/schemas/time";

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
