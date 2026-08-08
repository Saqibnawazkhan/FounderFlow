import { describe, it, expect } from "vitest";
import { NAV_ITEMS } from "@/lib/nav";

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
});
