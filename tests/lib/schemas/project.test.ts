import { describe, expect, it } from "vitest";
import {
  ChangeSupervisorSchema,
  NewProjectSchema,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  UpdateProjectSchema,
} from "@/lib/schemas/project";

describe("PROJECT_COLORS", () => {
  it("exposes the expected fixed palette", () => {
    expect(PROJECT_COLORS).toEqual(["primary", "cyan", "pink", "warning", "info"]);
  });
});

describe("PROJECT_STATUSES", () => {
  it("covers the lifecycle states the UI filters on", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "on_hold", "completed", "archived"]);
  });
});

describe("NewProjectSchema", () => {
  // The form always supplies a color (default "primary"), so we omit the
  // schema-level default and require it at the field level. Every valid
  // payload includes a color.
  const minimal = {
    name: "Launch v2",
    supervisorId: "u_supervisor",
    color: "primary" as const,
  };

  it("accepts the minimal valid payload", () => {
    const r = NewProjectSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      // empty/undefined description normalises to undefined (not "")
      expect(r.data.description).toBeUndefined();
    }
  });

  it("trims and rejects an empty name", () => {
    expect(NewProjectSchema.safeParse({ ...minimal, name: "  " }).success).toBe(false);
  });

  it("rejects an off-palette color", () => {
    expect(NewProjectSchema.safeParse({ ...minimal, color: "neon" as never }).success).toBe(false);
  });

  it("rejects a missing color (no schema-level default any more)", () => {
    const { color: _omit, ...withoutColor } = minimal;
    expect(NewProjectSchema.safeParse(withoutColor).success).toBe(false);
  });

  it("accepts each allowed color", () => {
    for (const c of PROJECT_COLORS) {
      expect(NewProjectSchema.safeParse({ ...minimal, color: c }).success).toBe(true);
    }
  });

  it("coerces an empty description to undefined (so SQL stores NULL)", () => {
    const r = NewProjectSchema.safeParse({ ...minimal, description: "   " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeUndefined();
  });

  it("requires a supervisorId", () => {
    expect(NewProjectSchema.safeParse({ ...minimal, supervisorId: "" }).success).toBe(false);
  });

  it("parses targetEndDate when provided", () => {
    const r = NewProjectSchema.safeParse({ ...minimal, targetEndDate: "2026-12-31" });
    expect(r.success).toBe(true);
    if (r.success && r.data.targetEndDate) {
      expect(r.data.targetEndDate.getUTCFullYear()).toBe(2026);
    }
  });
});

describe("UpdateProjectSchema", () => {
  const base = {
    projectId: "p1",
    name: "Launch v2",
    color: "cyan" as const,
    status: "active" as const,
  };

  it("requires projectId + name + color + status", () => {
    expect(UpdateProjectSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an off-palette status", () => {
    expect(UpdateProjectSchema.safeParse({ ...base, status: "frozen" as never }).success).toBe(
      false
    );
  });

  it("accepts each lifecycle status", () => {
    for (const s of PROJECT_STATUSES) {
      expect(UpdateProjectSchema.safeParse({ ...base, status: s }).success).toBe(true);
    }
  });
});

describe("ChangeSupervisorSchema", () => {
  it("requires both projectId and supervisorId", () => {
    expect(ChangeSupervisorSchema.safeParse({ projectId: "p1", supervisorId: "u2" }).success).toBe(
      true
    );
    expect(ChangeSupervisorSchema.safeParse({ projectId: "", supervisorId: "u2" }).success).toBe(
      false
    );
    expect(ChangeSupervisorSchema.safeParse({ projectId: "p1", supervisorId: "" }).success).toBe(
      false
    );
  });
});
