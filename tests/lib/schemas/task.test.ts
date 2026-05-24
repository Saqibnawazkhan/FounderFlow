import { describe, it, expect } from "vitest";
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

  it("rejects a deadline before today (audit flaw #37)", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = NewTaskSchema.safeParse({ ...valid(), deadline: yesterday.toISOString() });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /past/i.test(i.message))).toBe(true);
    }
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
