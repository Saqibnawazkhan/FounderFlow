import { describe, expect, it } from "vitest";
import {
  canSeeFinances,
  homeRouteForRole,
  isMemberBlockedRoute,
  MEMBER_BLOCKED_ROUTES,
} from "@/lib/auth/role-gates";

describe("canSeeFinances", () => {
  it("allows admin + cofounder", () => {
    expect(canSeeFinances("admin")).toBe(true);
    expect(canSeeFinances("cofounder")).toBe(true);
  });
  it("blocks member", () => {
    expect(canSeeFinances("member")).toBe(false);
  });
});

describe("isMemberBlockedRoute", () => {
  it.each(MEMBER_BLOCKED_ROUTES)("blocks %s exactly", (route) => {
    expect(isMemberBlockedRoute(route)).toBe(true);
  });

  it("blocks nested paths under a blocked route", () => {
    expect(isMemberBlockedRoute("/expenses/123")).toBe(true);
    expect(isMemberBlockedRoute("/reports/quarterly")).toBe(true);
  });

  it("doesn't block member-allowed surfaces", () => {
    expect(isMemberBlockedRoute("/tasks")).toBe(false);
    expect(isMemberBlockedRoute("/time")).toBe(false);
    expect(isMemberBlockedRoute("/team")).toBe(false);
    expect(isMemberBlockedRoute("/notifications")).toBe(false);
    expect(isMemberBlockedRoute("/settings")).toBe(false);
  });

  it("doesn't block the public landing or auth routes", () => {
    expect(isMemberBlockedRoute("/")).toBe(false);
    expect(isMemberBlockedRoute("/login")).toBe(false);
    expect(isMemberBlockedRoute("/signup")).toBe(false);
  });

  it("doesn't false-match a non-blocked route that shares a prefix string", () => {
    // "/expenses-archive" must NOT be treated as nested under "/expenses".
    expect(isMemberBlockedRoute("/expenses-archive")).toBe(false);
    expect(isMemberBlockedRoute("/reports2")).toBe(false);
  });
});

describe("homeRouteForRole", () => {
  it("sends admin + cofounder to /dashboard", () => {
    expect(homeRouteForRole("admin")).toBe("/dashboard");
    expect(homeRouteForRole("cofounder")).toBe("/dashboard");
  });
  it("sends member to /tasks", () => {
    expect(homeRouteForRole("member")).toBe("/tasks");
  });
});
