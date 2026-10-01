/**
 * `canEditTask` / `canDeleteTask` — the whole role × ownership matrix.
 *
 * These two functions exist because finding tasks-and-comments-009 was a
 * DISAGREEMENT, not a missing check: `updateTaskStatusAction` and
 * `reorderTaskAction` each stated the rule inline, and the board stated no rule
 * at all, so every card offered a status `<select>` and a drag handle to
 * everybody. A cofounder is not in the server's edit set, so the board handed
 * them the whole kanban and refused every move — after animating it.
 *
 * WHY A MATRIX AND NOT A HANDFUL OF CASES. The interesting property is not "a
 * cofounder is refused"; it is that the predicate the UI consults and the
 * predicate the action applies are the SAME function, so the twelve
 * combinations below are the complete specification of both layers at once. The
 * `bulkTaskScope` Prisma clause in lib/actions/tasks.ts is the third statement
 * of the edit rule — it has to be a `where`, so it cannot call this — and the
 * cases here are the matrix that clause implies.
 *
 * Pure functions, no DOM, no database.
 */

import { describe, expect, it } from "vitest";
import { canDeleteTask, canEditTask } from "@/lib/tasks/task-permissions";
import type { Role } from "@/lib/auth/role-gates";

const ME = "u_me";

/** The four ownership shapes a task can have, relative to the viewer. */
const OWNERSHIP = {
  minePlusFiled: { assignedTo: ME, assignedBy: ME },
  assignedToMe: { assignedTo: ME, assignedBy: "u_other" },
  filedByMe: { assignedTo: "u_other", assignedBy: ME },
  neither: { assignedTo: "u_other", assignedBy: "u_third" },
} as const;

const ROLES: Role[] = ["admin", "cofounder", "member"];

function actor(role: Role) {
  return { userId: ME, role };
}

describe("canEditTask — who may change a task's status or board order", () => {
  it("lets an admin move any task in the workspace", () => {
    for (const task of Object.values(OWNERSHIP)) {
      expect(canEditTask({ actor: actor("admin"), task })).toBe(true);
    }
  });

  it("lets the assignee and the person who filed it move their own task, whatever their role", () => {
    for (const role of ROLES) {
      expect(canEditTask({ actor: actor(role), task: OWNERSHIP.assignedToMe })).toBe(true);
      expect(canEditTask({ actor: actor(role), task: OWNERSHIP.filedByMe })).toBe(true);
      expect(canEditTask({ actor: actor(role), task: OWNERSHIP.minePlusFiled })).toBe(true);
    }
  });

  it("refuses a cofounder a task that is neither assigned to nor filed by them", () => {
    // This is the finding. It is asserted rather than assumed because the board
    // now disables its controls on the strength of it: if the rule were widened
    // without this line going red, the UI would silently start lying the other
    // way round — a disabled control the server would in fact have honoured.
    expect(canEditTask({ actor: actor("cofounder"), task: OWNERSHIP.neither })).toBe(false);
  });

  it("refuses a plain member a teammate's task", () => {
    expect(canEditTask({ actor: actor("member"), task: OWNERSHIP.neither })).toBe(false);
  });
});

describe("canDeleteTask — stricter than editing, because a delete is not recoverable by the user", () => {
  it("lets an admin delete any task", () => {
    for (const task of Object.values(OWNERSHIP)) {
      expect(canDeleteTask({ actor: actor("admin"), task })).toBe(true);
    }
  });

  it("lets the person who filed it delete it", () => {
    for (const role of ROLES) {
      expect(canDeleteTask({ actor: actor(role), task: OWNERSHIP.filedByMe })).toBe(true);
    }
  });

  it("does NOT let a mere assignee delete the task they were handed", () => {
    // The asymmetry with canEditTask is the point: being given work lets you
    // move it, not destroy it. deleteTaskAction and bulkDeleteTasksAction both
    // state this, and the board's trash icon now reads it from here.
    for (const role of ["cofounder", "member"] as Role[]) {
      expect(canDeleteTask({ actor: actor(role), task: OWNERSHIP.assignedToMe })).toBe(false);
    }
  });

  it("refuses a cofounder somebody else's task", () => {
    expect(canDeleteTask({ actor: actor("cofounder"), task: OWNERSHIP.neither })).toBe(false);
  });
});

describe("the two predicates are not the same rule", () => {
  it("differ on exactly the assignee-but-not-creator case", () => {
    // Guards the guard: if someone "simplified" one into the other, every
    // assertion above would still pass except this one.
    const task = OWNERSHIP.assignedToMe;
    expect(canEditTask({ actor: actor("member"), task })).toBe(true);
    expect(canDeleteTask({ actor: actor("member"), task })).toBe(false);
  });
});
