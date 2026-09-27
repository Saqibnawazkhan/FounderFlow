import { describe, it, expect } from "vitest";
import { FINANCE_GROUP, NAV_ITEMS, NAV_TREE, isNavGroup } from "@/lib/nav";
import { isMemberBlockedRoute } from "@/lib/auth/role-gates";
import { en, ur } from "@/lib/i18n/strings";
import { breadcrumbLabels } from "@/lib/layout/breadcrumb-labels";

describe("NAV_ITEMS (single source of truth for sidebar + command palette)", () => {
  it("has unique hrefs (a dupe would shadow a route in the palette)", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("every href is an absolute app path", () => {
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
    }
  });

  it("every item carries an icon and a label key", () => {
    for (const item of NAV_ITEMS) {
      expect(item.icon).toBeTruthy();
      expect(typeof item.labelKey).toBe("string");
      expect(item.labelKey.length).toBeGreaterThan(0);
    }
  });

  it("includes the core destinations (incl. the newer /revenue surface)", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/revenue");
    expect(hrefs).toContain("/settings");
  });

  it("resolves every label key in both dictionaries", () => {
    // `ur` is typed `typeof en`, so a missing key is already a type error —
    // this catches the other half: a key present but left as an empty string.
    for (const item of NAV_ITEMS) {
      expect(en.nav[item.labelKey]).toBeTruthy();
      expect(ur.nav[item.labelKey]).toBeTruthy();
    }
  });

  it("chat is deliberately not a member-blocked route", () => {
    // This encodes a PRODUCT DECISION, not an oversight: chat is open to
    // every company role because a channel's sensitivity is governed by its
    // own membership, not by whether someone can see the finance pages.
    // If this fails, someone changed that policy — go re-decide it on
    // purpose (and check the middleware gate agrees) rather than editing
    // the assertion to match.
    expect(isMemberBlockedRoute("/chat")).toBe(false);
    expect(isMemberBlockedRoute("/chat/general")).toBe(false);
  });
});

describe("breadcrumbLabels (the hand-maintained segment map behind the crumb trail)", () => {
  it("every NAV_ITEMS href's first segment has a breadcrumb label", () => {
    // The map is written by hand and the nav list grows without it; that
    // drift is invisible in English (the crumb silently humanizes the slug)
    // and visibly broken in Urdu. Iterate instead of pinning a count so a
    // new route fails here the moment it's added.
    const labels = breadcrumbLabels(en);
    for (const item of NAV_ITEMS) {
      const segment = item.href.split("/")[1];
      expect(labels[segment], `no breadcrumb label for "/${segment}"`).toBeTruthy();
    }
  });
});

describe("NAV_TREE (sidebar shape — finance folded into one group)", () => {
  const flattened = NAV_TREE.flatMap((node) => (isNavGroup(node) ? node.children : [node]));

  it("contains every flat NAV_ITEM exactly once", () => {
    const treeHrefs = flattened.map((i) => i.href).sort();
    const flatHrefs = NAV_ITEMS.map((i) => i.href).sort();
    expect(treeHrefs).toEqual(flatHrefs);
  });

  it("reuses the NAV_ITEMS objects rather than re-declaring them", () => {
    // Identity, not equality: NAV_TREE is built by lookup, so a route can't
    // end up with a different icon or label in the sidebar than in Cmd-K.
    for (const item of flattened) {
      expect(NAV_ITEMS).toContain(item);
    }
  });

  it("shows fewer top-level rows than the flat list", () => {
    expect(NAV_TREE.length).toBeLessThan(NAV_ITEMS.length);
  });

  it("has exactly one group, and its label resolves", () => {
    const groups = NAV_TREE.filter(isNavGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBe(FINANCE_GROUP);
    expect(en.nav[FINANCE_GROUP.labelKey]).toBeTruthy();
  });
});

describe("FINANCE_GROUP", () => {
  it("falls back to one of its own children in the icon rail", () => {
    // The collapsed sidebar has no room for a submenu, so the group row
    // links to `href` directly — it must be a real destination inside it.
    expect(FINANCE_GROUP.children.map((c) => c.href)).toContain(FINANCE_GROUP.href);
  });

  it("is all-or-nothing for members", () => {
    // The sidebar drops a group once every child is filtered out. If someone
    // later adds a member-visible route here, the group would render for
    // members with a single child — fine, but decide it deliberately.
    const blocked = FINANCE_GROUP.children.filter((c) => isMemberBlockedRoute(c.href));
    expect(blocked).toHaveLength(FINANCE_GROUP.children.length);
  });

  it("groups the five money surfaces", () => {
    expect(FINANCE_GROUP.children.map((c) => c.href)).toEqual([
      "/expenses",
      "/revenue",
      "/investments",
      "/recurring",
      "/budgets",
    ]);
  });
});
