/**
 * Structural guard: ONE categorical palette, defined once, in both themes,
 * long enough for the data it has to colour.
 *
 * ── THE DEFECT CLASS THIS CLOSES (audit ui-016 and what was under it) ──
 *
 * `EXPENSE_CATEGORIES` has ten entries. The dashboard pie's palette had six, so
 * four categories were drawn in a colour another category IN THE SAME PIE was
 * already using — two slices, identical fill, nothing to separate them. Of the
 * six, four were one hue at four lightnesses (emerald-500/700/300/800), which
 * is one band under deuteranopia and four greys in greyscale. And the colours
 * were hex literals in FIVE separate files — three `*-charts.tsx` plus the two
 * `*-client.tsx` that paint the legend dots beside them — each with its own
 * near-duplicate set, none of them responding to the theme toggle.
 *
 * Every one of those is a counting or copying mistake, which is to say every
 * one of them is testable. The assertions below are deliberately structural
 * rather than a list of expected colours:
 *
 *   • the palette is at least as long as `EXPENSE_CATEGORIES`, so adding an
 *     eleventh category fails HERE instead of shipping a repeated slice;
 *   • a bare hex literal in a chart file is a failure, so a fourth private
 *     copy cannot be started;
 *   • no file anywhere in app/ or components/ may carry a cluster of hex
 *     literals, which is what a private palette looks like wherever it lands;
 *   • every `--cat-N` in the light block has a `.dark` counterpart, so the
 *     theme response cannot be half-finished;
 *   • the hexes DOCUMENTED in lib/colors/categorical.ts are parsed back out of
 *     app/globals.css and compared, so the documentation cannot become a lie.
 *
 * Modelled on tests/lib/db/staging-guard.test.ts and
 * tests/lib/env/no-prod-credentials.test.ts, including their rule that an
 * exemption list must be pinned so it cannot grow silently.
 *
 * ── WHAT IS VERIFIED ELSEWHERE, BECAUSE IT CANNOT BE VERIFIED HERE ──
 *
 * That `rgb(var(--cat-N))` actually PAINTS is a browser question, and jsdom
 * does not resolve `var()` at all — it would answer "yes" to anything, which is
 * the worst kind of passing test. It was checked instead by rendering real
 * recharts 2.15.4 from node_modules, through React 18 `createRoot`, in real
 * headless Chrome, and reading `getComputedStyle` off the SVG nodes:
 *
 *   `<Cell fill="rgb(var(--cat-1))">`  -> fill       rgb(16, 185, 129)
 *   `<stop stopColor="rgb(var(--cat-1))">` -> stop-color rgb(16, 185, 129)
 *   `<CartesianGrid stroke="rgb(var(--fg-muted))">` -> stroke rgb(100, 116, 139)
 *
 * then adding `.dark` to <html> with NO re-render and re-reading the same nodes:
 * rgb(52, 211, 153) / rgb(52, 211, 153) / rgb(156, 175, 195). So `var()` does
 * resolve inside SVG presentation attributes, Recharts does pass the string
 * through untouched, and the theme flip re-paints with no JavaScript. What this
 * file can and does assert is the half that keeps that true: that the chart
 * files still route through the tokens.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  CATEGORICAL_COLORS,
  CATEGORICAL_LABELS,
  CATEGORICAL_SLUGS,
  CHART_CATEGORICAL,
  CHART_SERIES,
  categoricalAt,
} from "@/lib/colors/categorical";
import { COLOR_CLASSES } from "@/components/projects/project-card";
import {
  DEFAULT_PROJECT_COLOR,
  LEGACY_PROJECT_COLORS,
  PROJECT_COLORS,
  PROJECT_SWATCHES,
  NewProjectSchema,
  UpdateProjectSchema,
} from "@/lib/schemas/project";
import { EXPENSE_CATEGORIES } from "@/lib/types";
// ONE scanner for every structural guard in this suite. Writing a local
// `stripComments` here was the first attempt, and
// tests/lib/harness/source-scan.test.ts went red for it immediately — which is
// the system working: two silent-failure defects (A40, A49) once lived in
// private copies of exactly this helper. The `"css"` dialect matters for
// globals.css specifically, because a stylesheet is full of `/` characters that
// a TS scanner would read as the start of a regex literal.
import { stripComments } from "../harness/source-scan";

const REPO_ROOT = process.cwd();
const GLOBALS_CSS = join(REPO_ROOT, "app", "globals.css");

/* ───────────────────────────────────────────────────────────────────────── */
/* CSS parsing helpers                                                      */
/* ───────────────────────────────────────────────────────────────────────── */

/** The declaration block for a selector, by brace matching. */
function blockFor(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `app/globals.css has no "${selector}" block`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated "${selector}" block in app/globals.css`);
}

/**
 * Custom properties declared in a block, as name -> value.
 *
 * NOTE ON STYLE: exec loops and numbered capture groups, never `matchAll` or
 * `(?<name>…)`. tsconfig.json sets no `target`, so tsc defaults to ES5 where
 * both are compile errors (TS2802 / TS1503) that vitest does not reproduce —
 * and `npm run typecheck` is part of the pre-push gate. Same note as
 * tests/lib/env/no-prod-credentials.test.ts.
 */
function customProperties(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /(--[A-Za-z0-9-]+)[ \t]*:[ \t]*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block)) !== null) out[m[1]] = m[2].trim().replace(/\s+/g, " ");
  return out;
}

/** "#10b981" -> "16 185 129", the space-separated-channels form the tokens use. */
function hexToChannels(hex: string): string {
  const h = hex.replace("#", "");
  const parts: number[] = [];
  for (let i = 0; i < 6; i += 2) parts.push(parseInt(h.slice(i, i + 2), 16));
  return parts.join(" ");
}

/** Every `--cat-*` name in a token map, sorted by index so messages read in order. */
function catNames(tokens: Record<string, string>): string[] {
  return Object.keys(tokens)
    .filter((k) => /^--cat-\d+(-strong)?$/.test(k))
    .sort();
}

/**
 * Comments are blanked FIRST and that is not cosmetic: globals.css documents
 * each token with its hex in a trailing comment, so a parser that kept them
 * would read `#10b981` as part of the value and end up comparing the
 * documentation against itself.
 */
const CSS_SOURCE = stripComments(readFileSync(GLOBALS_CSS, "utf8"), "css");
const LIGHT = customProperties(blockFor(CSS_SOURCE, ":root,"));
const DARK = customProperties(blockFor(CSS_SOURCE, ".dark,"));

/* ───────────────────────────────────────────────────────────────────────── */
/* Source-tree helpers                                                      */
/* ───────────────────────────────────────────────────────────────────────── */

const SKIP_DIRS = ["node_modules", ".next", ".git", "coverage", "dist", "build", ".vercel"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".css"];

function collectFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.indexOf(entry.name) !== -1) continue;
        walk(join(current, entry.name));
        continue;
      }
      if (predicate(entry.name)) found.push(join(current, entry.name));
    }
  };
  walk(dir);
  return found.sort();
}

/** Repo-relative, forward slashes, so a failure message is copy-pasteable. */
function rel(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join("/");
}

/**
 * Bare colour hex literals in a source file. Three- and six-digit both, because
 * `#fff` is as much a hardcoded colour as `#ffffff`. Gradient references
 * (`url(#g-invest)`) are not matched: `g` is not a hex digit, and the trailing
 * boundary stops `#abcdef12` style ids from counting.
 */
function hexLiterals(source: string): string[] {
  const out: string[] = [];
  const rx = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) out.push(m[0]);
  return out;
}

/* ───────────────────────────────────────────────────────────────────────── */
/* The module itself                                                        */
/* ───────────────────────────────────────────────────────────────────────── */

describe("the categorical ramp (lib/colors/categorical.ts)", () => {
  it("keeps CATEGORICAL_SLUGS element-for-element with CATEGORICAL_COLORS", () => {
    // The slug tuple is spelled out separately because `z.enum` needs the
    // literal tuple type and `.map()` only gives `string[]`. Two lists means
    // they can drift, and a drift hands the picker a slug the schema rejects.
    expect(CATEGORICAL_SLUGS.slice()).toEqual(CATEGORICAL_COLORS.map((c) => c.slug));
  });

  it("is the owner-approved ramp, in the owner-approved order", () => {
    // Pinned verbatim. The ORDER is load-bearing — each neighbour differs in
    // hue AND lightness so a chart survives greyscale and deuteranopia — so a
    // reorder has to come and argue with this assertion.
    expect(CATEGORICAL_COLORS.map((c) => [c.slug, c.label, c.light])).toEqual([
      ["cat-1", "emerald", "#10b981"],
      ["cat-2", "blue", "#3b82f6"],
      ["cat-3", "amber", "#f59e0b"],
      ["cat-4", "violet", "#8b5cf6"],
      ["cat-5", "red", "#ef4444"],
      ["cat-6", "cyan", "#06b6d4"],
      ["cat-7", "pink", "#ec4899"],
      ["cat-8", "lime", "#84cc16"],
      ["cat-9", "orange", "#f97316"],
      ["cat-10", "slate", "#64748b"],
    ]);
  });

  // THE ONE THAT MATTERS. This is the repeat-colour bug, stated as arithmetic.
  it("has at least as many colours as there are EXPENSE_CATEGORIES", () => {
    expect(
      CATEGORICAL_COLORS.length,
      `There are ${EXPENSE_CATEGORIES.length} EXPENSE_CATEGORIES and only ` +
        `${CATEGORICAL_COLORS.length} categorical colours, so at least one category is ` +
        `drawn in a colour another category in the SAME chart is already using. ` +
        `categoricalAt() wraps silently, which is why nothing else notices. ` +
        `Add a --cat-N (globals.css, BOTH themes) + a tailwind entry + a COLOR_CLASSES ` +
        `row, or do not add the category.`
    ).toBeGreaterThanOrEqual(EXPENSE_CATEGORIES.length);
  });

  it("gives every chart colour as a token reference, never a hex", () => {
    const all = CHART_CATEGORICAL.concat([
      CHART_SERIES.investments,
      CHART_SERIES.revenue,
      CHART_SERIES.expenses,
    ]);
    for (const value of all) {
      expect(value, `${value} is not a token reference`).toMatch(/^rgb\(var\(--[a-z0-9-]+\)\)$/);
    }
    expect(CHART_CATEGORICAL.length).toBe(CATEGORICAL_COLORS.length);
  });

  it("wraps categoricalAt without ever returning undefined", () => {
    const n = CATEGORICAL_COLORS.length;
    expect(categoricalAt(0)).toBe(CHART_CATEGORICAL[0]);
    expect(categoricalAt(n)).toBe(CHART_CATEGORICAL[0]);
    expect(categoricalAt(n + 3)).toBe(CHART_CATEGORICAL[3]);
    // Negative index: `i % n` is negative in JS, which would index past the
    // start of the array and hand Recharts `undefined` as a fill.
    expect(categoricalAt(-1)).toBe(CHART_CATEGORICAL[n - 1]);
    for (let i = -25; i < 50; i += 1) expect(typeof categoricalAt(i)).toBe("string");
  });

  it("labels every slug, for the picker's aria-label", () => {
    for (const slug of CATEGORICAL_SLUGS) {
      expect(CATEGORICAL_LABELS[slug], `no label for ${slug}`).toBeTruthy();
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* The tokens, in BOTH themes                                               */
/* ───────────────────────────────────────────────────────────────────────── */

describe("app/globals.css defines the ramp in both themes", () => {
  it("defines a --cat-N and a --cat-N-strong per entry in the light block", () => {
    const missing: string[] = [];
    for (const c of CATEGORICAL_COLORS) {
      if (LIGHT[c.token] === undefined) missing.push(c.token);
      if (LIGHT[c.strongToken] === undefined) missing.push(c.strongToken);
    }
    expect(missing, `light block is missing: ${missing.join(", ")}`).toEqual([]);
  });

  // THE DARK-MODE ASSERTION. A categorical token that exists only on light is
  // the old bug in a new spelling: the chart reads a var, the var never
  // re-lights, and a light-theme hue sits on a charcoal card.
  it("re-lights EVERY --cat-* from the light block in .dark", () => {
    const light = catNames(LIGHT);
    const unlit = light.filter((name) => DARK[name] === undefined);
    expect(
      unlit,
      `these categorical tokens are defined on light but NOT in .dark: ${unlit.join(", ")}.\n` +
        `The whole point of routing the charts through var() was that the theme toggle ` +
        `re-paints them. A token missing from .dark inherits the light value, so that mark ` +
        `stays a light-theme colour on a #1f2933 card — the exact bug the hex literals had.`
    ).toEqual([]);
    expect(light.length).toBe(CATEGORICAL_COLORS.length * 2);
  });

  it("declares no orphan --cat-* that the module does not know about", () => {
    // The other direction: a `--cat-11` in CSS with no palette entry is dead
    // weight that looks like an available colour.
    const known: string[] = [];
    for (const c of CATEGORICAL_COLORS) known.push(c.token, c.strongToken);
    for (const block of [
      { name: "light", tokens: LIGHT },
      { name: ".dark", tokens: DARK },
    ]) {
      const orphans = catNames(block.tokens).filter((n) => known.indexOf(n) === -1);
      expect(orphans, `${block.name} declares unknown ${orphans.join(", ")}`).toEqual([]);
    }
  });

  it("matches the hexes lib/colors/categorical.ts documents, channel for channel", () => {
    // This is what makes the module's hex column a CHECKED copy rather than a
    // second source of truth. The runtime values are the CSS ones.
    const mismatches: string[] = [];
    for (const c of CATEGORICAL_COLORS) {
      const expectations: Array<[string, string, string]> = [
        [`light ${c.token}`, LIGHT[c.token], hexToChannels(c.light)],
        [`light ${c.strongToken}`, LIGHT[c.strongToken], hexToChannels(c.lightStrong)],
        [`dark ${c.token}`, DARK[c.token], hexToChannels(c.dark)],
        [`dark ${c.strongToken}`, DARK[c.strongToken], hexToChannels(c.darkStrong)],
      ];
      for (const [what, actual, wanted] of expectations) {
        if (actual !== wanted) mismatches.push(`${what}: css "${actual}" vs module "${wanted}"`);
      }
    }
    expect(
      mismatches,
      `globals.css and the module disagree:\n  ${mismatches.join("\n  ")}`
    ).toEqual([]);
  });
});

/**
 * Requirement (e) of the change that introduced this file: the brand and
 * semantic tokens carry MEANING — amber means over budget, red means
 * destructive — and widening them destroys it. The categorical ramp reusing
 * similar hues is fine; REDEFINING these is not. Pinned so a future "let's just
 * make --warning one of the ten" has to delete an assertion with a reason
 * attached.
 */
describe("the brand and semantic tokens are untouched by the widening", () => {
  it("keeps the light-block values the rest of the product is tuned against", () => {
    expect({
      primary: LIGHT["--primary"],
      success: LIGHT["--success"],
      warning: LIGHT["--warning"],
      danger: LIGHT["--danger"],
      info: LIGHT["--info"],
      "primary-strong": LIGHT["--primary-strong"],
      "success-strong": LIGHT["--success-strong"],
      "warning-strong": LIGHT["--warning-strong"],
      "danger-strong": LIGHT["--danger-strong"],
      "info-strong": LIGHT["--info-strong"],
    }).toEqual({
      primary: "16 185 129",
      success: "16 185 129",
      warning: "245 158 11",
      danger: "220 38 38",
      info: "59 130 246",
      "primary-strong": "4 120 87",
      "success-strong": "4 120 87",
      "warning-strong": "180 83 9",
      "danger-strong": "185 28 28",
      "info-strong": "29 78 216",
    });
  });

  it("keeps the dark-block -strong values contrast.test.ts measured", () => {
    expect({
      "primary-strong": DARK["--primary-strong"],
      "success-strong": DARK["--success-strong"],
      "warning-strong": DARK["--warning-strong"],
      "danger-strong": DARK["--danger-strong"],
      "info-strong": DARK["--info-strong"],
    }).toEqual({
      "primary-strong": "52 211 153",
      "success-strong": "52 211 153",
      "warning-strong": "251 191 36",
      "danger-strong": "252 165 165",
      "info-strong": "96 165 250",
    });
  });
});

describe("tailwind exposes every categorical token as a utility", () => {
  const config = readFileSync(join(REPO_ROOT, "tailwind.config.ts"), "utf8");

  it("declares a DEFAULT and a strong colour per entry", () => {
    // Without this, `bg-cat-7` compiles to nothing and the swatch renders
    // transparent — a silent failure with no console warning anywhere.
    const missing: string[] = [];
    for (const c of CATEGORICAL_COLORS) {
      if (config.indexOf(`rgb(var(${c.token}) / <alpha-value>)`) === -1) {
        missing.push(`${c.slug} DEFAULT`);
      }
      if (config.indexOf(`rgb(var(${c.strongToken}) / <alpha-value>)`) === -1) {
        missing.push(`${c.slug} strong`);
      }
    }
    expect(missing, `tailwind.config.ts is missing: ${missing.join(", ")}`).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* Project swatches                                                         */
/* ───────────────────────────────────────────────────────────────────────── */

describe("every project colour slug is renderable", () => {
  // Guard the guard: an empty or truncated tuple makes every loop below
  // vacuous, which is how this repo's structural tests have failed before.
  it("covers both tiers, with nothing lost in the join", () => {
    expect(PROJECT_COLORS.length).toBe(PROJECT_SWATCHES.length + LEGACY_PROJECT_COLORS.length);
    expect(PROJECT_SWATCHES.length).toBe(CATEGORICAL_COLORS.length);
    expect(PROJECT_COLORS.length).toBeGreaterThanOrEqual(15);
  });

  it("gives every accepted slug a COLOR_CLASSES trio", () => {
    const unmapped = PROJECT_COLORS.filter((slug) => COLOR_CLASSES[slug] === undefined);
    expect(
      unmapped,
      `PROJECT_COLORS slugs with no COLOR_CLASSES entry: ${unmapped.join(", ")}. ` +
        `A slug without one renders the ?? emerald fallback, so the project card, the ` +
        `detail header and both pickers all paint the wrong colour and nothing errors.`
    ).toEqual([]);

    for (const slug of PROJECT_COLORS) {
      const classes = COLOR_CLASSES[slug];
      expect(classes.stripe, `${slug} stripe class`).toBeTruthy();
      expect(classes.text, `${slug} text class`).toBeTruthy();
      expect(classes.chipBg, `${slug} chip background class`).toBeTruthy();
    }
  });

  it("gives every OFFERED slug a palette entry as well as a class trio", () => {
    const paletteSlugs = CATEGORICAL_COLORS.map((c) => c.slug);
    const orphans = PROJECT_SWATCHES.filter((slug) => paletteSlugs.indexOf(slug) === -1);
    expect(
      orphans,
      `the picker offers ${orphans.join(", ")}, which has no entry in CATEGORICAL_COLORS — ` +
        `so there is no --cat-N behind it and no documented light/dark pair`
    ).toEqual([]);
  });

  it("points each categorical slug's classes at its OWN token", () => {
    // Catches the copy-paste slip that a per-slug existence check cannot: a
    // `cat-7` row wired to `bg-cat-6` is present, truthy, and wrong.
    for (const c of CATEGORICAL_COLORS) {
      const classes = COLOR_CLASSES[c.slug];
      expect(classes.stripe, `${c.slug} stripe`).toBe(`bg-${c.slug}`);
      expect(classes.text, `${c.slug} text`).toBe(`text-${c.slug}-strong`);
      expect(classes.chipBg, `${c.slug} chipBg`).toBe(`bg-${c.slug}/10`);
    }
  });

  /**
   * The legacy tier, pinned. These five strings are in the `Project.color` TEXT
   * column of a live production database. Removing one from the enum is not a
   * palette change — `UpdateProjectSchema` re-parses a project's own colour on
   * every save, so it would make every existing project of that colour
   * unsaveable the next time someone renamed it.
   */
  it("keeps the five persisted legacy slugs valid, and does not let the list drift", () => {
    expect(LEGACY_PROJECT_COLORS.slice()).toEqual([
      "emerald",
      "forest",
      "mint",
      "slate",
      "warning",
    ]);

    for (const slug of LEGACY_PROJECT_COLORS) {
      expect(
        NewProjectSchema.safeParse({
          name: "Launch v2",
          supervisorId: "u_supervisor",
          color: slug,
        }).success,
        `legacy slug "${slug}" no longer parses — every project holding it just became ` +
          `unsaveable, and there is no migration in this change by design`
      ).toBe(true);

      expect(
        UpdateProjectSchema.safeParse({
          projectId: "p_1",
          name: "Launch v2",
          color: slug,
          status: "active",
        }).success,
        `legacy slug "${slug}" fails UpdateProjectSchema, which is the one that runs when ` +
          `someone edits an EXISTING project`
      ).toBe(true);
    }
  });

  /**
   * A NEW project must start on a colour the picker actually shows.
   *
   * This failed when it was written, which is why it exists. The new-project
   * modal hardcoded `color: "emerald"` — correct for the old palette, and now a
   * LEGACY slug its picker no longer offers. The dialog opened with ten
   * swatches and none of them highlighted, and anyone who did not touch the
   * picker created a project on a retired slug, so the legacy tier would have
   * kept GROWING after a change whose whole point was to drain it.
   */
  it("starts a new project on an OFFERED colour, never a legacy one", () => {
    expect(
      PROJECT_SWATCHES as readonly string[],
      `a new project defaults to "${DEFAULT_PROJECT_COLOR}", which the picker does not offer — ` +
        `so the dialog opens with nothing selected and an untouched form writes a retired slug`
    ).toContain(DEFAULT_PROJECT_COLOR);
    expect(LEGACY_PROJECT_COLORS as readonly string[]).not.toContain(DEFAULT_PROJECT_COLOR);
    // Emerald still leads, so the default colour is visually unchanged.
    expect(DEFAULT_PROJECT_COLOR).toBe(CATEGORICAL_COLORS[0].slug);
  });

  it("accepts every offered slug too", () => {
    for (const slug of PROJECT_SWATCHES) {
      expect(
        NewProjectSchema.safeParse({
          name: "Launch v2",
          supervisorId: "u_supervisor",
          color: slug,
        }).success,
        `the picker offers "${slug}" but the schema rejects it`
      ).toBe(true);
    }
    expect(
      NewProjectSchema.safeParse({
        name: "Launch v2",
        supervisorId: "u_supervisor",
        color: "cat-11",
      }).success
    ).toBe(false);
  });

  /**
   * The new slugs are `cat-N` precisely so they cannot collide with the slugs
   * `20260923000000_rebrand_project_colors` retired. Two of the ten hues are
   * NAMED cyan and pink; that migration's `UPDATE … WHERE "color" IN
   * ('primary','cyan')` is documented as "idempotent and safe to re-run", and
   * making `cyan` writable again would quietly falsify that. prisma/** is not
   * editable in this change, so the collision is avoided rather than managed.
   */
  it("reintroduces no retired slug, whatever the hues are called", () => {
    for (const retired of ["primary", "cyan", "pink", "info"]) {
      expect(
        PROJECT_COLORS as readonly string[],
        `retired slug "${retired}" is writable again — the rebrand migration rewrites that ` +
          `value and calls itself safe to re-run, so a re-run would now recolour live projects`
      ).not.toContain(retired);
    }
    // The hue names still exist — just as labels, never as persisted values.
    expect(Object.keys(CATEGORICAL_LABELS).indexOf("cyan")).toBe(-1);
    expect(CATEGORICAL_LABELS["cat-6"]).toBe("cyan");
  });
});

/* ───────────────────────────────────────────────────────────────────────── */
/* No private palettes                                                      */
/* ───────────────────────────────────────────────────────────────────────── */

describe("no chart file defines its own palette", () => {
  const CHART_FILES = collectFiles(join(REPO_ROOT, "app"), (name) => name.endsWith("-charts.tsx"));

  /**
   * Discovered by walking `app/`, then compared against the known list. Both
   * directions matter: a NEW chart file is covered the day it lands without
   * anyone remembering to extend a list, and a chart file that is RENAMED or
   * moved out of the sweep fails here instead of silently going unscanned.
   */
  it("knows about every chart file, so none can be silently exempt", () => {
    expect(CHART_FILES.map(rel)).toEqual([
      "app/(app)/dashboard/dashboard-charts.tsx",
      "app/(app)/expenses/expenses-charts.tsx",
      "app/(app)/reports/reports-charts.tsx",
    ]);
  });

  it.each(CHART_FILES.map((f) => [rel(f), f]))(
    "%s contains no hex colour at all",
    (_name, file) => {
      const found = hexLiterals(readFileSync(file, "utf8"));
      expect(
        found,
        `${rel(file)} hardcodes ${found.join(", ")}.\n` +
          `A hex in a chart file is the ui-016 defect: it is private to this file (so the ` +
          `other charts drift from it), and it does not respond to the theme (so it stays a ` +
          `light-theme colour on a charcoal card). Import from lib/colors/categorical.ts.\n` +
          `This includes hexes inside COMMENTS — deliberately. An explanation is free to ` +
          `name "emerald-700" instead, and allowing comments would mean stripping them ` +
          `first, which is one exemption away from stripping the code too.`
      ).toEqual([]);
    }
  );

  it.each(CHART_FILES.map((f) => [rel(f), f]))("%s reads the shared palette", (_name, file) => {
    // A chart file with no hex AND no import would be a chart with no colours;
    // this is what stops the assertion above being satisfiable by deletion.
    //
    // Matched as a whole import specifier, with the closing quote. A
    // `toContain("@/lib/colors/categorical")` was the first attempt and it was
    // wrong in the specific way this repo keeps getting caught by: it is a
    // SUBSTRING check, so `from "@/lib/colors/categorical-renamed"` satisfied
    // it, and the red run for this very assertion came back green. Seen to
    // fail, then fixed — not assumed.
    expect(readFileSync(file, "utf8")).toMatch(/from "@\/lib\/colors\/categorical"/);
  });
});

/**
 * The same rule, one level broader: a private palette is a CLUSTER of hex
 * literals, and it is just as wrong in a `*-client.tsx` that paints the legend
 * dots beside a chart. Both of those really did hold byte-for-byte copies of
 * the chart palettes — pasted there because importing a constant out of a
 * `*-charts.tsx` would have pulled recharts into the initial chunk — so the
 * dots could disagree with the marks they labelled, and did.
 *
 * Three files are exempt and each has a reason, pinned so the list cannot grow
 * silently (the pattern from tests/lib/db/staging-guard.test.ts).
 */
describe("no file anywhere carries a private palette", () => {
  /** More than this many distinct hexes in one file is a palette, not a colour. */
  const CLUSTER = 3;

  const EXEMPT: Record<string, string> = {
    // The token DEFINITIONS. This is the one place a colour is allowed to be a
    // literal, because it is what every var() resolves to.
    "app/globals.css": "defines the design tokens; every hex here is a token value or its doc",
    // Rendered by next/og (satori) into a PNG at the edge. It never loads the
    // stylesheet, so a var() would resolve to nothing at all.
    "app/opengraph-image.tsx":
      "rendered to a PNG by next/og outside the CSS cascade — var() cannot resolve there",
    // The global error boundary renders when the app shell (and its
    // stylesheet) may have failed to load. Inline hex is the point.
    "app/global-error.tsx":
      "last-resort boundary that must paint without the app stylesheet having loaded",
  };

  const SOURCE_FILES = ["app", "components"]
    .map((d) => join(REPO_ROOT, d))
    .reduce<
      string[]
    >((all, dir) => all.concat(collectFiles(dir, (name) => SOURCE_EXTENSIONS.indexOf(extname(name)) !== -1)), []);

  it("finds files to scan, so a passing sweep is never a vacuous one", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
  });

  it("flags any un-exempt file with a cluster of hex literals", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const name = rel(file);
      if (EXEMPT[name] !== undefined) continue;
      const distinct: string[] = [];
      for (const hex of hexLiterals(readFileSync(file, "utf8"))) {
        const lower = hex.toLowerCase();
        if (distinct.indexOf(lower) === -1) distinct.push(lower);
      }
      if (distinct.length >= CLUSTER) {
        offenders.push(`${name} has ${distinct.length} distinct hexes: ${distinct.join(", ")}`);
      }
    }
    expect(
      offenders,
      `a cluster of hex literals is a private palette:\n  ${offenders.join("\n  ")}\n\n` +
        `This is the shape the bug took five times over — three *-charts.tsx and the two ` +
        `*-client.tsx that paint the legend dots beside them, each with its own ` +
        `near-duplicate set, none responding to the theme. Import from ` +
        `lib/colors/categorical.ts, or add a token to app/globals.css in BOTH themes.`
    ).toEqual([]);
  });

  it("cannot grow its exemption list silently", () => {
    // Each exemption is a file that legitimately cannot read a CSS variable.
    // Adding a fourth means editing this assertion and saying why.
    expect(Object.keys(EXEMPT).sort()).toEqual([
      "app/global-error.tsx",
      "app/globals.css",
      "app/opengraph-image.tsx",
    ]);
    for (const reason of Object.keys(EXEMPT)) {
      expect(EXEMPT[reason].length, `${reason} has no stated reason`).toBeGreaterThan(20);
    }
  });

  it("confirms the two legend-dot clients now read the shared module", () => {
    // Named explicitly because the cluster rule alone would be satisfied by a
    // file that simply has no colours; these two must have the right ones.
    for (const name of [
      "app/(app)/dashboard/dashboard-client.tsx",
      "app/(app)/reports/reports-client.tsx",
    ]) {
      const source = readFileSync(join(REPO_ROOT, name), "utf8");
      expect(source, `${name} no longer reads the shared palette`).toContain(
        "@/lib/colors/categorical"
      );
      expect(hexLiterals(source), `${name} still hardcodes a colour`).toEqual([]);
    }
  });
});
