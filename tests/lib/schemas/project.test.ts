import { describe, expect, it } from "vitest";
import {
  ChangeSupervisorSchema,
  DuplicateProjectSchema,
  LEGACY_PROJECT_COLORS,
  MAX_DUPLICATED_TASKS,
  NewProjectSchema,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  PROJECT_SWATCHES,
  UpdateProjectSchema,
} from "@/lib/schemas/project";

// The form always supplies a color (default "emerald"), so the schema omits
// a schema-level default and requires it at the field level. Every valid
// payload therefore includes a color.
const MINIMAL_PROJECT = {
  name: "Launch v2",
  supervisorId: "u_supervisor",
  color: "emerald" as const,
};

describe("PROJECT_COLORS", () => {
  /**
   * CHANGED 2026-10-05, deliberately. This assertion used to read
   *
   *     expect(PROJECT_COLORS).toEqual(["emerald", "forest", "mint", "slate", "warning"]);
   *
   * and it was correct for the palette it was written against. The palette
   * widened: five swatches cannot tell ten projects apart, which is the same
   * counting defect the charts had with ten expense categories, so the picker
   * moved onto the ten-hue CATEGORICAL ramp shared with the charts.
   *
   * It is restated as TWO TIERS rather than loosened to a length check, because
   * the two tiers are the whole substance of the change:
   *
   *   • `PROJECT_SWATCHES` is what the picker OFFERS — the ten `cat-N` slugs.
   *   • `LEGACY_PROJECT_COLORS` is what the COLUMN already holds. Those five
   *     strings are in a live production database. Dropping one would not be a
   *     palette change; `UpdateProjectSchema` re-parses a project's own colour
   *     on every save, so it would make every project of that colour unsaveable
   *     the next time anyone edited its name. They stay valid, they keep their
   *     exact rendering, and there is deliberately NO migration.
   *
   * `PROJECT_COLORS` is the union, in that order, and nothing else.
   */
  it("exposes both tiers of the palette, in order", () => {
    expect(PROJECT_COLORS).toEqual([
      "cat-1",
      "cat-2",
      "cat-3",
      "cat-4",
      "cat-5",
      "cat-6",
      "cat-7",
      "cat-8",
      "cat-9",
      "cat-10",
      "emerald",
      "forest",
      "mint",
      "slate",
      "warning",
    ]);
    expect(PROJECT_SWATCHES.length).toBe(10);
    expect(LEGACY_PROJECT_COLORS.slice()).toEqual([
      "emerald",
      "forest",
      "mint",
      "slate",
      "warning",
    ]);
  });

  // UNCHANGED, and it still passes — which is the point of naming the ten new
  // slugs `cat-N` rather than after their hues. Two of the ten hues ARE cyan
  // and pink: the slugs `20260923000000_rebrand_project_colors` retired, whose
  // `UPDATE … WHERE "color" IN ('primary','cyan')` is documented as "idempotent
  // and safe to re-run". Had the new swatches been called `cyan` and `pink`,
  // re-running that migration would silently recolour live projects, and the
  // migration file is not editable in this change. The hue names survive as
  // labels (CATEGORICAL_LABELS), never as persisted values.
  it("rejects a retired colour slug", () => {
    for (const retired of ["cyan", "pink", "primary", "info"]) {
      expect(PROJECT_COLORS).not.toContain(retired);
      expect(
        NewProjectSchema.safeParse({ ...MINIMAL_PROJECT, color: retired as never }).success
      ).toBe(false);
    }
  });
});

describe("PROJECT_STATUSES", () => {
  it("covers the lifecycle states the UI filters on", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "on_hold", "completed", "archived"]);
  });
});

describe("NewProjectSchema", () => {
  const minimal = MINIMAL_PROJECT;

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
    color: "forest" as const,
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

describe("DuplicateProjectSchema (what a project copy is allowed to carry)", () => {
  // The two fields a caller MUST supply. Everything else is a flag with a
  // default, which is the point of most of the assertions below.
  const MINIMAL_DUPLICATE = { sourceProjectId: "p_source", name: "Launch v3" };

  it("rejects a payload with no source project", () => {
    const { sourceProjectId: _omit, ...withoutSource } = MINIMAL_DUPLICATE;
    expect(DuplicateProjectSchema.safeParse(withoutSource).success).toBe(false);
    expect(
      DuplicateProjectSchema.safeParse({ ...MINIMAL_DUPLICATE, sourceProjectId: "" }).success
    ).toBe(false);
  });

  it("requires a name and bounds it at the same length as every other project name", () => {
    expect(DuplicateProjectSchema.safeParse({ ...MINIMAL_DUPLICATE, name: "   " }).success).toBe(
      false
    );
    expect(
      DuplicateProjectSchema.safeParse({ ...MINIMAL_DUPLICATE, name: "x".repeat(120) }).success
    ).toBe(true);
    expect(
      DuplicateProjectSchema.safeParse({ ...MINIMAL_DUPLICATE, name: "x".repeat(121) }).success
    ).toBe(false);
  });

  it("copies the task list but not its assignees, and moves the deadlines, when told nothing", () => {
    const r = DuplicateProjectSchema.safeParse(MINIMAL_DUPLICATE);
    expect(r.success).toBe(true);
    if (!r.success) return;
    // These three are the product decision, argued on the schema itself.
    // Changing one here without changing the argument there is the bug this
    // test is watching for.
    expect(r.data.copyTasks).toBe(true);
    expect(r.data.keepAssignees).toBe(false);
    expect(r.data.shiftDeadlines).toBe(true);
  });

  // Iterates the schema's own shape rather than naming three flags, so a
  // fourth copy option added later is covered the day it lands.
  it("gives every copy flag a default, so an older client can't fail on one", () => {
    const flagKeys = Object.keys(DuplicateProjectSchema.shape).filter(
      (k) => k !== "sourceProjectId" && k !== "name"
    );
    expect(flagKeys.length).toBeGreaterThan(0);

    for (const key of flagKeys) {
      const omitted: Record<string, unknown> = {
        ...MINIMAL_DUPLICATE,
        copyTasks: true,
        keepAssignees: true,
        shiftDeadlines: true,
      };
      delete omitted[key];
      const r = DuplicateProjectSchema.safeParse(omitted);
      expect(r.success, `omitting "${key}" should still parse`).toBe(true);
      if (r.success) {
        expect(typeof (r.data as Record<string, unknown>)[key], `"${key}" should default`).toBe(
          "boolean"
        );
      }
    }
  });

  /**
   * THE CORRECTNESS BOUNDARY, not a preference.
   *
   * A duplicate copies a project's shape. It must never copy a record of
   * something that HAPPENED: a Transaction claims money moved, a TimeEntry
   * claims a person worked those hours, a Comment claims someone said a
   * thing. Copying any of them fabricates history — and in the money case,
   * the fabrication lands in the same sums /reports and the dashboard read.
   *
   * This test exists so that "just add a copyTransactions flag" cannot be a
   * quiet one-line change. Whoever adds one has to delete a red test and
   * argue with the comment on DuplicateProjectSchema first.
   */
  it("never offers to copy money, time or history", () => {
    const forbidden = ["transaction", "budget", "expense", "revenue", "comment", "time", "invoice"];
    const keys = Object.keys(DuplicateProjectSchema.shape);

    for (const word of forbidden) {
      for (const key of keys) {
        expect(
          key.toLowerCase().includes(word),
          `"${key}" looks like it copies ${word}s — see the correctness boundary on DuplicateProjectSchema`
        ).toBe(false);
      }
    }
  });

  it("drops a copy flag it does not know about instead of honouring it", () => {
    // Zod strips unknown keys, so even a hand-rolled client posting
    // `copyTransactions: true` gets nothing — the action only ever sees the
    // parsed output. This pins that the action reads `parsed.data`, never the
    // raw input, as its shape of truth.
    const r = DuplicateProjectSchema.safeParse({
      ...MINIMAL_DUPLICATE,
      copyTransactions: true,
      copyTimeEntries: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.data)).not.toContain("copyTransactions");
      expect(Object.keys(r.data)).not.toContain("copyTimeEntries");
    }
  });

  it("caps a single duplicate below the point where one transaction would time out", () => {
    // The action reads `take: MAX + 1` and refuses above the ceiling rather
    // than letting a 12,000-task copy roll back on Prisma's 5s interactive
    // transaction clock. An integer is load-bearing — `take` is a row count.
    expect(Number.isInteger(MAX_DUPLICATED_TASKS)).toBe(true);
    expect(MAX_DUPLICATED_TASKS).toBeGreaterThan(0);
  });
});
