/**
 * i18n-001 — `<html lang>` vs `<html dir>`: one locale, two decisions.
 *
 * `components/providers.tsx` set both from the same value:
 *
 *     document.documentElement.lang = locale;
 *     document.documentElement.dir  = getDirForLocale(locale);
 *
 * `dir` is presentation and the locale is the right input for it. `lang` is a
 * factual claim about the text that follows, and Urdu coverage is partial — 282
 * dictionary strings over seven namespaces (common, nav, breadcrumb, auth,
 * topbar, projects, settings) against 559 hardcoded English literals still live
 * in 56 files, including 38 aria-labels and 45 toast messages. So `lang="ur"`
 * made a screen reader read a predominantly English document through Urdu
 * grapheme-to-phoneme rules, and suppressed its own language auto-detection
 * while doing it. Picking اردو in Settings made the product less usable than
 * leaving it untranslated, and `User.locale` persisted that across devices.
 *
 * These cases are about the DECISION, not the dictionary. The DOM half — that
 * Providers actually applies this to <html>, and that `dir` still flips to rtl —
 * is in tests/components/providers.test.tsx.
 *
 * WHY THIS IS NOT A DICTIONARY-COMPLETENESS TEST. `Strings = typeof en` already
 * makes a missing Urdu key a TypeScript error, so every dictionary-derived
 * measure of coverage reads 100% while most of the product is hardcoded English
 * JSX. Coverage therefore has to be declared (LOCALE_TRANSLATION_STATUS) and
 * these cases pin what the declaration is allowed to mean.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCALE_TRANSLATION_STATUS,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  documentLangForLocale,
  getDirForLocale,
  type Locale,
} from "@/lib/i18n/strings";

const ROOT_LAYOUT = join(process.cwd(), "app", "layout.tsx");

/**
 * Blanks out comments while preserving length, so prose *discussing*
 * PARTIAL_LOCALES — which app/layout.tsx does, in three places — cannot be
 * mistaken for the declaration. Same helper shape as tests/lib/layout/rtl.test.ts.
 * The (?<!:) guard keeps https:// intact.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("documentLangForLocale", () => {
  it("does not claim Urdu for a document that is mostly English", () => {
    expect(
      documentLangForLocale("ur"),
      "559 untranslated English literals across 56 files means the document's " +
        "predominant language is English (WCAG 3.1.1). Tagging it ur applies Urdu " +
        "phonemes to all of them."
    ).toBe("en");
  });

  it("returns the locale itself once that locale is complete", () => {
    // English is the source language, so it is the one locale that is complete
    // by construction — and it must not be redirected anywhere.
    expect(documentLangForLocale("en")).toBe("en");
  });

  it("falls back to the source locale, not to a hardcoded string", () => {
    // The fallback has to be the locale the dictionary is authored in. If a
    // future locale became the source, an inlined "en" here would silently
    // mislabel every partially translated document.
    const partial = (Object.keys(LOCALE_TRANSLATION_STATUS) as Locale[]).filter(
      (l) => LOCALE_TRANSLATION_STATUS[l] === "partial"
    );
    expect(partial.length, "if nothing is partial this guard has stopped guarding").toBeGreaterThan(
      0
    );
    partial.forEach((l) => {
      expect(documentLangForLocale(l)).toBe(SOURCE_LOCALE);
    });
  });

  it("returns a supported locale for every supported locale", () => {
    const codes = SUPPORTED_LOCALES.map((l) => l.code);
    codes.forEach((code) => {
      expect(codes).toContain(documentLangForLocale(code));
    });
  });

  it("covers every supported locale, so adding one cannot skip the decision", () => {
    // LOCALE_TRANSLATION_STATUS is a Record<Locale, …>, which makes a missing
    // entry a type error — but only for locales that exist in the Locale union.
    // This is the runtime half: a third locale added to SUPPORTED_LOCALES has to
    // declare its coverage rather than inherit someone else's.
    SUPPORTED_LOCALES.forEach(({ code }) => {
      expect(LOCALE_TRANSLATION_STATUS[code], `no coverage declared for "${code}"`).toMatch(
        /^(complete|partial)$/
      );
    });
  });

  it("marks the source locale complete", () => {
    expect(LOCALE_TRANSLATION_STATUS[SOURCE_LOCALE]).toBe("complete");
  });
});

describe("language and direction are independent", () => {
  it("keeps the RTL mirror for Urdu even though the document is tagged en", () => {
    // This is the whole point of splitting the two. A "fix" that stopped
    // flipping dir would hide the finding and cost the RTL user the mirrored
    // shell they can actually read — the nav, topbar, breadcrumbs, command
    // palette, settings and auth screens ARE translated.
    expect(getDirForLocale("ur")).toBe("rtl");
    expect(documentLangForLocale("ur")).toBe("en");
  });

  it("does not derive direction from the document language", () => {
    // Pinned as a pair: if someone later writes
    // `getDirForLocale(documentLangForLocale(locale))` the Urdu shell silently
    // un-mirrors, and nothing else in the suite would notice.
    const langForUr = documentLangForLocale("ur");
    expect(getDirForLocale(langForUr)).toBe("ltr");
    expect(getDirForLocale("ur")).not.toBe(getDirForLocale(langForUr));
  });
});

/**
 * The pre-paint half of i18n-001, and the drift risk it creates.
 *
 * `documentLangForLocale` only runs after hydration. An Urdu user's FIRST PAINT
 * is governed by the inline `shellBootstrap` script in app/layout.tsx, which
 * cannot `import` — so it restates the coverage decision as a literal,
 * `var PARTIAL_LOCALES`. Two copies of one fact is exactly the shape of bug this
 * repo keeps shipping, so the copy is parsed back out here and held against
 * `LOCALE_TRANSLATION_STATUS`. Flipping one without the other fails.
 *
 * BOTH DIRECTIONS are checked on purpose. Dropping a locale from the array while
 * the module still calls it partial gives an Urdu user a `lang="ur"` first paint
 * — the original bug, reintroduced in the one place no component test renders.
 * Leaving it in the array after the module says "complete" is the opposite:
 * translated Urdu that never gets announced as Urdu, and a coverage milestone
 * that silently did nothing.
 *
 * `app/layout.tsx` belongs to another agent; this test only reads it.
 * `shellBootstrap` is a template literal, so nothing in it — comments included —
 * may contain a backtick; that is noted at its own site and is not this file's
 * business beyond not asking for one.
 */
describe("shellBootstrap's copy of the coverage decision (i18n-001, pre-paint)", () => {
  const rootLayout = stripComments(readFileSync(ROOT_LAYOUT, "utf8"));

  /** The locales shellBootstrap declares as partially translated. */
  function declaredPartialLocales(): string[] {
    const all = rootLayout.match(/var PARTIAL_LOCALES = \[([^\]]*)\]/g) ?? [];
    // Assert-not-assume: three prose mentions and two sibling arrays
    // (`var LOCALES`, `var RTL_LOCALES`) live within a few lines of this one, and
    // a regex that quietly matched two of them would read the wrong array.
    expect(
      all.length,
      "expected exactly one `var PARTIAL_LOCALES = [...]` in app/layout.tsx, found " + all.length
    ).toBe(1);

    const declared = rootLayout.match(/var PARTIAL_LOCALES = \[([^\]]*)\]/);
    return (declared?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter((entry) => entry.length > 0);
  }

  it("declares the array at all", () => {
    expect(
      rootLayout,
      "shellBootstrap no longer declares `var PARTIAL_LOCALES = [...]`, so the " +
        "pre-paint lang is unguarded and an Urdu user's first paint can claim a " +
        "language the document is not in"
    ).toMatch(/var PARTIAL_LOCALES = \[/);
  });

  it("lists every locale the module calls partial", () => {
    const partial = (Object.keys(LOCALE_TRANSLATION_STATUS) as Locale[]).filter(
      (l) => LOCALE_TRANSLATION_STATUS[l] === "partial"
    );
    const declared = declaredPartialLocales();

    partial.forEach((code) => {
      expect(
        declared,
        `LOCALE_TRANSLATION_STATUS marks "${code}" partial, so shellBootstrap must ` +
          `keep lang="${SOURCE_LOCALE}" for it pre-paint too — otherwise the first ` +
          "paint tags a predominantly English document as " +
          code
      ).toContain(code);
    });
  });

  it("lists nothing the module calls complete", () => {
    declaredPartialLocales().forEach((code) => {
      expect(
        LOCALE_TRANSLATION_STATUS[code as Locale],
        `shellBootstrap suppresses lang="${code}" pre-paint, but ` +
          "LOCALE_TRANSLATION_STATUS no longer calls it partial. Delete it from " +
          "PARTIAL_LOCALES in app/layout.tsx, or the coverage milestone that " +
          "flipped it did nothing for the first paint."
      ).toBe("partial");
    });
  });

  it("actually uses the array for lang, and not for dir", () => {
    // The array can be perfectly in sync and still be decoration if the
    // assignment stops consulting it. And `dir` must NOT consult it: direction
    // follows the locale outright, which is the whole point of the split.
    const langLine = rootLayout
      .split("\n")
      .find((l) => l.includes("documentElement.lang") && l.includes("="));
    expect(langLine, "shellBootstrap no longer assigns documentElement.lang").toBeTruthy();
    expect(
      langLine,
      "the pre-paint lang assignment must consult PARTIAL_LOCALES, not the raw locale"
    ).toContain("PARTIAL_LOCALES");

    const dirLine = rootLayout
      .split("\n")
      .find((l) => l.includes("documentElement.dir") && l.includes("="));
    expect(dirLine, "shellBootstrap no longer assigns documentElement.dir").toBeTruthy();
    expect(
      dirLine,
      "direction is a separate axis: gating dir on translation coverage would " +
        "un-mirror the Urdu shell, which IS translated"
    ).not.toContain("PARTIAL_LOCALES");
  });
});
