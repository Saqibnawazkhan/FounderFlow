/**
 * Guards the segment→label map that the breadcrumb trail renders from.
 *
 * The map was inlined in breadcrumbs.tsx until /chat forced it out into a
 * module; these are the invariants that make the extraction worth it — the
 * NAV_ITEMS coverage check lives in tests/lib/nav.test.ts next to the list
 * it iterates.
 */

import { describe, it, expect } from "vitest";
import { breadcrumbLabels } from "@/lib/layout/breadcrumb-labels";
import { en, ur, DICTIONARIES, type Locale } from "@/lib/i18n/strings";

describe("breadcrumbLabels (segment → localized crumb)", () => {
  it("returns a non-empty label for every segment it claims to know", () => {
    for (const locale of Object.keys(DICTIONARIES) as Locale[]) {
      for (const [segment, label] of Object.entries(breadcrumbLabels(DICTIONARIES[locale]))) {
        expect(typeof label, `${locale}:${segment}`).toBe("string");
        expect(label.trim().length, `${locale}:${segment}`).toBeGreaterThan(0);
      }
    }
  });

  it("maps the same segments in every locale", () => {
    // A locale-specific hole would mean a crumb that silently humanizes its
    // slug for Urdu readers only — the hardest kind of gap to notice.
    const base = Object.keys(breadcrumbLabels(en)).sort();
    for (const locale of Object.keys(DICTIONARIES) as Locale[]) {
      expect(Object.keys(breadcrumbLabels(DICTIONARIES[locale])).sort(), locale).toEqual(base);
    }
  });

  it("actually translates rather than echoing English", () => {
    // Not every word differs across locales, but a map that came back
    // wholly identical would mean someone wired both branches to `en`.
    const enLabels = breadcrumbLabels(en);
    const urLabels = breadcrumbLabels(ur);
    const differing = Object.keys(enLabels).filter((seg) => enLabels[seg] !== urLabels[seg]);
    expect(differing.length).toBeGreaterThan(0);
  });

  it("keys on bare segments, never on paths", () => {
    // breadcrumbs.tsx looks the map up with `pathname.split("/")` parts, so
    // a key like "/tasks" would never match anything.
    for (const segment of Object.keys(breadcrumbLabels(en))) {
      expect(segment.includes("/"), segment).toBe(false);
    }
  });
});
