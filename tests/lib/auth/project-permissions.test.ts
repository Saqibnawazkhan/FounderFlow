import { describe, expect, it } from "vitest";
import {
  canCreateProject,
  canManageProject,
  canReassignSupervisor,
  canSeeAllProjects,
  canSeeProject,
  canSeeProjectFinances,
} from "@/lib/auth/project-permissions";
import { canSeeFinances } from "@/lib/auth/role-gates";

const project = { supervisorId: "u_super" };

describe("canManageProject", () => {
  it("admin manages any project", () => {
    expect(canManageProject({ userId: "u_admin", role: "admin", project })).toBe(true);
  });
  it("cofounder manages any project", () => {
    expect(canManageProject({ userId: "u_co", role: "cofounder", project })).toBe(true);
  });
  it("the supervising member manages their own project", () => {
    expect(canManageProject({ userId: "u_super", role: "member", project })).toBe(true);
  });
  it("a non-supervisor member cannot manage", () => {
    expect(canManageProject({ userId: "u_other", role: "member", project })).toBe(false);
  });
});

describe("canSeeProjectFinances", () => {
  it("admin sees finances", () => {
    expect(canSeeProjectFinances({ userId: "u_admin", role: "admin", project })).toBe(true);
  });
  it("cofounder sees finances", () => {
    expect(canSeeProjectFinances({ userId: "u_co", role: "cofounder", project })).toBe(true);
  });
  it("the supervising member can see THIS project's finances", () => {
    expect(canSeeProjectFinances({ userId: "u_super", role: "member", project })).toBe(true);
  });
  it("a non-supervisor member cannot see finances", () => {
    expect(canSeeProjectFinances({ userId: "u_other", role: "member", project })).toBe(false);
  });
});

describe("canSeeAllProjects", () => {
  it("admin sees every project", () => {
    expect(canSeeAllProjects("admin")).toBe(true);
  });
  it("cofounder sees every project", () => {
    expect(canSeeAllProjects("cofounder")).toBe(true);
  });
  it("member does not", () => {
    expect(canSeeAllProjects("member")).toBe(false);
  });

  // Regression guard for CODEBASE-AUDIT.md §4.3. The three visibility gates
  // in lib/queries/projects.ts used to call `canSeeFinances` for this tier.
  // The two agree today, which is exactly what made the coupling invisible:
  // widening the FINANCE predicate for a future accountant/auditor role would
  // have silently granted that role every project in the company. If you are
  // here because this test failed, that is the point — the predicates have
  // diverged, which is allowed. Update this test; do NOT re-couple the gates.
  it("currently agrees with canSeeFinances — by coincidence, not by design", () => {
    for (const role of ["admin", "cofounder", "member"] as const) {
      expect(canSeeAllProjects(role)).toBe(canSeeFinances(role));
    }
  });
});

describe("canSeeProject", () => {
  it("admin sees every project", () => {
    expect(
      canSeeProject({
        userId: "u_admin",
        role: "admin",
        project,
        hasTaskInProject: false,
      })
    ).toBe(true);
  });

  it("cofounder sees every project", () => {
    expect(
      canSeeProject({
        userId: "u_co",
        role: "cofounder",
        project,
        hasTaskInProject: false,
      })
    ).toBe(true);
  });

  it("supervisor sees their own project even without an assigned task", () => {
    expect(
      canSeeProject({
        userId: "u_super",
        role: "member",
        project,
        hasTaskInProject: false,
      })
    ).toBe(true);
  });

  it("member with an assigned task sees the project", () => {
    expect(
      canSeeProject({
        userId: "u_other",
        role: "member",
        project,
        hasTaskInProject: true,
      })
    ).toBe(true);
  });

  it("member with no task and not the supervisor sees nothing", () => {
    expect(
      canSeeProject({
        userId: "u_other",
        role: "member",
        project,
        hasTaskInProject: false,
      })
    ).toBe(false);
  });
});

describe("canSeeProject monotonicity (the getProjectForUser probe)", () => {
  // getProjectForUser calls canSeeProject with hasTaskInProject:false to avoid
  // a task query for users the cheap clauses already admit, then re-asks with
  // the real value. That is only safe while false->true never flips an allow
  // into a deny.
  const actors = [
    { userId: "u_admin", role: "admin" as const },
    { userId: "u_co", role: "cofounder" as const },
    { userId: "u_super", role: "member" as const },
    { userId: "u_other", role: "member" as const },
  ];
  it("granting a task never revokes access", () => {
    for (const actor of actors) {
      const without = canSeeProject({ ...actor, project, hasTaskInProject: false });
      const withTask = canSeeProject({ ...actor, project, hasTaskInProject: true });
      expect(without && !withTask).toBe(false);
    }
  });
  it("the probe only under-reports for a member holding a task", () => {
    const actor = { userId: "u_other", role: "member" as const };
    expect(canSeeProject({ ...actor, project, hasTaskInProject: false })).toBe(false);
    expect(canSeeProject({ ...actor, project, hasTaskInProject: true })).toBe(true);
  });
});

describe("canCreateProject + canReassignSupervisor", () => {
  it("admin + cofounder can create", () => {
    expect(canCreateProject("admin")).toBe(true);
    expect(canCreateProject("cofounder")).toBe(true);
  });
  it("members cannot create — supervisor escape hatch doesn't apply here", () => {
    expect(canCreateProject("member")).toBe(false);
  });
  it("admin + cofounder can reassign supervisor; members cannot", () => {
    expect(canReassignSupervisor("admin")).toBe(true);
    expect(canReassignSupervisor("cofounder")).toBe(true);
    expect(canReassignSupervisor("member")).toBe(false);
  });
});
