import { describe, expect, it } from "vitest";
import {
  canCreateProject,
  canManageProject,
  canReassignSupervisor,
  canSeeProject,
  canSeeProjectFinances,
} from "@/lib/auth/project-permissions";

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
