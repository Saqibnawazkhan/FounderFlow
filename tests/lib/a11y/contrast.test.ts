import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AA_NON_TEXT,
  AA_TEXT,
  GLOBALS_CSS,
  REPO_ROOT,
  TAILWIND_CONFIG,
  composite,
  contrastRatio,
  hex,
  readGlobalsCss,
  readThemes,
  stripCssComments,
  round2,
  sweepSource,
  token,
  type Rgb,
  type TokenMap,
} from "./wcag";

/**
 * Colour-contrast floor for the pairs the product actually renders
 * (a11y-001 · a11y-003 · a11y-004).
 *
 * WHAT THIS PROVES: every colour in FounderFlow comes from a token triple in
 * app/globals.css, so the real WCAG ratio of a rendered pair is computable from
 * the stylesheet alone. Each `it` below names a pair a user looks at — an error
 * message on a card, a placeholder in an input, the focus ring against the
 * surface beside it — and computes the ratio rather than trusting a hex to look
 * right. That is deliberately NOT a walk of every possible token pair: a sweep
 * of all pairs flags combinations the product never renders, and the next person
 * to hit a false failure deletes the test.
 *
 * WHAT IT CANNOT PROVE, and is therefore a MANUAL CHECK: that the pair really is
 * the pair — that error text sits on `--card` and not on top of a `bg-danger/15`
 * tint that shifts the effective background, and that nothing overlaps or
 * anti-aliases the glyph into something thinner than the ratio assumes. Open the
 * app in both themes and look at a rejected form.
 */

const SURFACES_TEXT_RESTS_ON = ["card", "surface", "bg"];

/** The families whose bare `text-*` utility carries validation/status copy. */
const SEMANTIC_FAMILIES = ["danger", "warning", "success", "info"];

/* ------------------------------------------------------------------------- */
/* Which token does `text-<family>` actually resolve to?                      */
/* ------------------------------------------------------------------------- */

/** Brace-matched value of `key: { ... }` inside the Tailwind config text. */
function objectBlock(text: string, key: string): string {
  const opener = new RegExp("\\b" + key + "\\s*:\\s*\\{");
  const at = text.search(opener);
  if (at === -1) return "";
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** The `--token` behind `<family>.DEFAULT` in a colour map, if declared there. */
function defaultTokenOf(block: string, family: string): string | null {
  const familyBlock = objectBlock(block, family);
  if (!familyBlock) return null;
  const m = /DEFAULT\s*:\s*"rgb\(var\(--([a-z][a-z0-9-]*)\)/.exec(familyBlock);
  return m ? m[1] : null;
}

/**
 * Tailwind resolves `text-<family>` from `theme.textColor`, which defaults to
 * `theme.colors`. Declaring `textColor` therefore re-points the TEXT utility
 * without touching `bg-*` / `border-*` / `ring-*`, which is exactly the split
 * the `-strong` ramp was invented for.
 */
function textColorTokenFor(family: string, configText: string): string {
  const fromTextColor = defaultTokenOf(objectBlock(configText, "textColor"), family);
  if (fromTextColor) return fromTextColor;
  const fromColors = defaultTokenOf(objectBlock(configText, "colors"), family);
  if (!fromColors) throw new Error(`tailwind.config.ts declares no colour for \`${family}\``);
  return fromColors;
}

const configText = fs.readFileSync(TAILWIND_CONFIG, "utf8");
const themes = readThemes();
const THEME_NAMES: Array<keyof typeof themes> = ["light", "dark"];

function describeFail(
  label: string,
  fg: Rgb,
  bg: Rgb,
  actual: number,
  floor: number,
  theme: string
): string {
  return `${theme}: ${label} — ${hex(fg)} on ${hex(bg)} is ${round2(actual)}:1, needs ${floor}:1`;
}

/* ------------------------------------------------------------------------- */

describe("semantic text tokens (a11y-003)", () => {
  // The defect this guards: `.dark` redefines `--danger-strong` but silently
  // inherits `--danger` from `:root`, and `--danger` is red-600 — a value picked
  // so that WHITE text on a solid danger fill clears AA. Used as a foreground
  // it paints red-600 on a charcoal card. The fill ramp and the text ramp are
  // different jobs; the utility has to resolve to the text one.
  it("bare `text-{danger,warning,success,info}` resolves to the text-safe ramp, not the fill ramp", () => {
    const wrong: string[] = [];
    for (const family of SEMANTIC_FAMILIES) {
      const resolved = textColorTokenFor(family, configText);
      if (resolved !== `${family}-strong`) {
        wrong.push(`text-${family} resolves to --${resolved}, expected --${family}-strong`);
      }
    }
    expect(
      wrong,
      `the bare text utility must not resolve to a fill token:\n  ${wrong.join("\n  ")}`
    ).toEqual([]);
  });

  it("validation text clears AA 4.5:1 on every resting surface, in both themes", () => {
    const failures: string[] = [];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      for (const family of SEMANTIC_FAMILIES) {
        const fg = token(theme, textColorTokenFor(family, configText));
        for (const surface of SURFACES_TEXT_RESTS_ON) {
          const bg = token(theme, surface);
          const ratio = contrastRatio(fg, bg);
          if (ratio < AA_TEXT) {
            failures.push(
              describeFail(`text-${family} on --${surface}`, fg, bg, ratio, AA_TEXT, themeName)
            );
          }
        }
      }
    }
    expect(failures, `unreadable validation text:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  // `text-*-strong` is spelled out at 24 call sites already. Those must clear AA
  // on their own account, independently of what the bare utility resolves to.
  it("every `-strong` token clears AA on every resting surface, in both themes", () => {
    const failures: string[] = [];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      for (const family of SEMANTIC_FAMILIES) {
        const fg = token(theme, `${family}-strong`);
        for (const surface of SURFACES_TEXT_RESTS_ON) {
          const bg = token(theme, surface);
          const ratio = contrastRatio(fg, bg);
          if (ratio < AA_TEXT) {
            failures.push(
              describeFail(
                `text-${family}-strong on --${surface}`,
                fg,
                bg,
                ratio,
                AA_TEXT,
                themeName
              )
            );
          }
        }
      }
    }
    expect(
      failures,
      `\`-strong\` is the text ramp and must be readable:\n  ${failures.join("\n  ")}`
    ).toEqual([]);
  });

  it("solid semantic fills still carry their own foreground text", () => {
    // Guards the other direction: the fix for a11y-003 must not be "lighten
    // --danger", because red-600 is what lets `bg-danger` + `text-white` (the
    // delete-account / delete-workspace confirm buttons) clear AA.
    const failures: string[] = [];
    const white: Rgb = [255, 255, 255];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      const pairs: Array<[string, Rgb, Rgb]> = [
        ["white text on a solid bg-danger button", white, token(theme, "danger")],
        [
          "text-primary-fg on a solid bg-primary button",
          token(theme, "primary-fg"),
          token(theme, "primary"),
        ],
      ];
      for (const [label, fg, bg] of pairs) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < AA_TEXT) {
          failures.push(describeFail(label, fg, bg, ratio, AA_TEXT, themeName));
        }
      }
    }
    expect(failures, `solid fill lost its foreground:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});

describe("muted body text", () => {
  it("--fg-muted clears AA on the page background and on a card, in both themes", () => {
    const failures: string[] = [];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      const fg = token(theme, "fg-muted");
      for (const surface of ["bg", "card", "surface"]) {
        const bg = token(theme, surface);
        const ratio = contrastRatio(fg, bg);
        if (ratio < AA_TEXT) {
          failures.push(
            describeFail(`text-fg-muted on --${surface}`, fg, bg, ratio, AA_TEXT, themeName)
          );
        }
      }
    }
    expect(failures, `unreadable secondary copy:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});

describe("placeholder text (a11y-004)", () => {
  /**
   * Alphas the call sites ask for. `placeholder:text-fg-muted/60` does not dim
   * the glyph — it emits `color: rgb(var(--fg-muted) / 0.6)`, which the
   * compositor blends against the field behind it, so the contrast that reaches
   * the eye is the contrast of the BLEND.
   */
  function alphasUsedAtCallSites(): number[] {
    const seen: Record<string, true> = {};
    for (const hit of sweepSource(/placeholder:text-fg-muted(\/\d{1,3})?/)) {
      const slash = hit.text.indexOf("/");
      seen[slash === -1 ? "100" : hit.text.slice(slash + 1)] = true;
    }
    return Object.keys(seen)
      .map((pct) => Number(pct) / 100)
      .sort();
  }

  /**
   * An unconditional `::placeholder` rule with an `!important` colour is a floor
   * no call site can dim, so it collapses every call-site alpha to 1. Returns
   * the token it forces, or null if there is no such floor.
   */
  function placeholderFloorToken(css: string): string | null {
    const re = /(^|\})\s*([^{}]*::placeholder[^{}]*)\{([^}]*)\}/g;
    let m = re.exec(css);
    while (m !== null) {
      const selector = m[2].trim();
      const body = m[3];
      const unconditional = selector
        .split(",")
        .every((s) => /^(input|textarea|\*)?::(-\w+-)?(input-)?placeholder$/.test(s.trim()));
      const forced = /color\s*:\s*rgb\(var\(--([a-z][a-z0-9-]*)\)\s*\)\s*!important/.exec(body);
      if (unconditional && forced) return forced[1];
      m = re.exec(css);
    }
    return null;
  }

  it("the faintest placeholder the product can render clears AA 4.5:1, in both themes", () => {
    const css = stripCssComments(readGlobalsCss());
    const floor = placeholderFloorToken(css);
    const alphas = floor === null ? alphasUsedAtCallSites() : [1];
    const tokenName = floor === null ? "fg-muted" : floor;

    expect(alphas.length, "no placeholder utilities found — did the sweep break?").toBeGreaterThan(
      0
    );

    const failures: string[] = [];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      const base = token(theme, tokenName);
      for (const surface of SURFACES_TEXT_RESTS_ON) {
        const bg = token(theme, surface);
        for (const alpha of alphas) {
          const effective = composite(base, bg, alpha);
          const ratio = contrastRatio(effective, bg);
          if (ratio < AA_TEXT) {
            failures.push(
              describeFail(
                `placeholder:text-${tokenName}${alpha === 1 ? "" : `/${Math.round(alpha * 100)}`} on --${surface}`,
                effective,
                bg,
                ratio,
                AA_TEXT,
                themeName
              )
            );
          }
        }
      }
    }
    expect(
      failures,
      `the only format hint on money and date fields is unreadable:\n  ${failures.join("\n  ")}`
    ).toEqual([]);
  });
});

describe("focus ring colour (a11y-001)", () => {
  it("--ring clears the 3:1 non-text floor against every surface it can border", () => {
    // 1.4.11: the thing that identifies a component's state needs 3:1. The ring
    // is drawn 2px outside the element, so it lands on whatever surface the
    // field sits in — and its 2px offset exposes the element's own border too.
    const failures: string[] = [];
    for (const themeName of THEME_NAMES) {
      const theme: TokenMap = themes[themeName];
      const ring = token(theme, "ring");
      for (const surface of ["bg", "surface", "card", "surface-hover", "border"]) {
        const bg = token(theme, surface);
        const ratio = contrastRatio(ring, bg);
        if (ratio < AA_NON_TEXT) {
          failures.push(
            describeFail(`focus ring on --${surface}`, ring, bg, ratio, AA_NON_TEXT, themeName)
          );
        }
      }
    }
    expect(failures, `focus ring not distinguishable:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it("globals.css and the Tailwind config are the only colour sources this test reads", () => {
    // Cheap guard so the test cannot silently stop covering the product: if
    // either file moves, every assertion above would pass vacuously.
    expect(fs.existsSync(GLOBALS_CSS), `${path.relative(REPO_ROOT, GLOBALS_CSS)} is missing`).toBe(
      true
    );
    expect(Object.keys(themes.light).length).toBeGreaterThan(20);
    expect(Object.keys(themes.dark).length).toBeGreaterThan(20);
  });
});
