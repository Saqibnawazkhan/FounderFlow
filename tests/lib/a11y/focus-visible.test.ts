import { describe, expect, it } from "vitest";
import { readGlobalsCss, stripCssComments, sweepSource } from "./wcag";

/**
 * The global focus ring has to survive the utilities that try to remove it
 * (a11y-001 · a11y-002).
 *
 * WHAT THIS PROVES: a11y-001 is not "the focus rule is missing" — the rule at
 * app/globals.css is correct, emerald, 2px and theme-aware. It is *outranked*.
 * Tailwind compiles `focus:outline-none` to `.focus\:outline-none:focus`, one
 * class plus one pseudo-class = specificity (0,2,0), against a bare
 * `:focus-visible` at (0,1,0) — so the utility wins REGARDLESS of source order,
 * and Tailwind 3 emits plain CSS with no real cascade layers to change that.
 * Specificity is arithmetic, so it is checkable here: this test computes both
 * sides and asserts the global rule actually wins.
 *
 * WHAT IT CANNOT PROVE, and is therefore a MANUAL CHECK: jsdom implements no
 * cascade and does not support `:focus-visible` at all, so nothing here can show
 * a browser painting the ring. And it cannot judge the result aesthetically —
 * seven call sites deliberately replace the outline with their own
 * `focus-visible:ring-*`, and after this fix they render BOTH. Tab through the
 * auth forms and the delete-workspace modal and look at it.
 */

/**
 * Selector specificity as (id, class, type). `:focus-visible` and `:focus` are
 * pseudo-CLASSES and count in the class column; `::placeholder` would be a
 * pseudo-ELEMENT and count as a type. Escaped colons in a Tailwind class name
 * (`.focus\:outline-none`) are part of the class, not a pseudo-class, which is
 * the one subtlety that makes this arithmetic easy to get wrong by eye.
 */
export function specificity(selector: string): [number, number, number] {
  const normalized = selector.replace(/\\./g, "\u0000");
  const ids = (normalized.match(/#[\w\u0000-]+/g) || []).length;
  const classes =
    (normalized.match(/\.[\w\u0000-]+/g) || []).length +
    (normalized.match(/\[[^\]]*\]/g) || []).length +
    (normalized.match(/(^|[^:])::?(?!:)[a-z-]+(\([^)]*\))?/g) || []).filter(
      (m) => !m.includes("::")
    ).length;
  const types = (normalized.match(/(^|[\s>+~,])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, types];
}

function beats(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

type Rule = { selector: string; body: string };

/** The `:focus-visible` rule (the global one, not a variant utility). */
function globalFocusRule(css: string): Rule {
  const re = /(^|\})\s*([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g;
  let m = re.exec(css);
  while (m !== null) {
    const selector = m[2].trim();
    if (/^:focus-visible$/.test(selector) || /^:focus-visible\s*,/.test(selector)) {
      return { selector, body: m[3] };
    }
    m = re.exec(css);
  }
  throw new Error("app/globals.css has no global `:focus-visible` rule");
}

function declaration(body: string, property: string): string | null {
  const re = new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;]+)");
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

describe("global focus ring (a11y-001, a11y-002)", () => {
  const css = stripCssComments(readGlobalsCss());
  const rule = globalFocusRule(css);

  it("draws a >= 2px outline in the themed --ring token", () => {
    const outline = declaration(rule.body, "outline");
    expect(outline, "`:focus-visible` declares no `outline`").not.toBeNull();

    const width = /(\d+(?:\.\d+)?)px/.exec(outline as string);
    expect(width, `cannot read an outline width from \`${outline}\``).not.toBeNull();
    expect(Number((width as RegExpExecArray)[1])).toBeGreaterThanOrEqual(2);

    expect(
      outline as string,
      "the ring must come from --ring so it re-lights per theme, not a literal"
    ).toContain("rgb(var(--ring))");

    // Regression: a `border-radius` here once reshaped the focused ELEMENT
    // instead of rounding the ring, so every input visibly snapped to a
    // near-square on focus. Browsers already follow the element's own radius.
    expect(
      declaration(rule.body, "border-radius"),
      "border-radius reshapes the element"
    ).toBeNull();
  });

  it("offsets the ring so it is not swallowed by the element's own 1px border", () => {
    const offset = declaration(rule.body, "outline-offset");
    expect(offset, "`:focus-visible` declares no `outline-offset`").not.toBeNull();
    expect(Number(/(-?\d+(?:\.\d+)?)px/.exec(offset as string)?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it("wins against every utility in the codebase that removes an outline on focus", () => {
    // The competitors, as Tailwind actually compiles them. `outline-none` is not
    // `outline: none` — it is `outline: 2px solid transparent`, i.e. a real
    // declaration that replaces ours rather than being ignored.
    const variants: Record<string, true> = {};
    for (const hit of sweepSource(/[a-z-]+:outline-none/)) {
      variants[hit.text] = true;
    }
    const competitors = Object.keys(variants).map((utility) => {
      const colon = utility.indexOf(":");
      const variant = utility.slice(0, colon);
      // e.g. `focus:outline-none` -> `.focus\:outline-none:focus`
      return `.${variant}\\:outline-none:${variant}`;
    });

    if (competitors.length === 0) {
      // Nothing to beat: no `!important` needed, and demanding one would be
      // cargo cult. This branch is the test retiring itself honestly.
      return;
    }

    const ours = specificity(rule.selector.split(",")[0].trim());
    const outlineImportant = /outline\s*:[^;]*!important/.test(rule.body);
    const offsetImportant = /outline-offset\s*:[^;]*!important/.test(rule.body);

    const losing: string[] = [];
    for (const competitor of competitors) {
      const theirs = specificity(competitor);
      const outranked = !beats(ours, theirs);
      if (outranked && !(outlineImportant && offsetImportant)) {
        losing.push(
          `\`${competitor}\` has specificity (${theirs.join(",")}) and \`${rule.selector}\` has ` +
            `(${ours.join(",")}) — the utility wins, so focus renders as ` +
            `\`outline: 2px solid transparent\` (invisible). Either out-specify it or mark ` +
            `both \`outline\` and \`outline-offset\` !important.`
        );
      }
    }

    expect(
      losing,
      `the global focus ring is defeated by ${competitors.length} compiled utility ` +
        `selector(s) across ${sweepSource(/[a-z-]+:outline-none/).length} call sites:\n  ` +
        losing.join("\n  ")
    ).toEqual([]);
  });
});

describe("specificity arithmetic (the thing the fix turns on)", () => {
  it("counts pseudo-classes in the class column and escaped colons as part of the class", () => {
    expect(specificity(":focus-visible")).toEqual([0, 1, 0]);
    expect(specificity(".focus\\:outline-none:focus")).toEqual([0, 2, 0]);
    expect(specificity(".focus-visible\\:outline-none:focus-visible")).toEqual([0, 2, 0]);
    expect(beats([0, 2, 0], [0, 1, 0])).toBe(true);
    expect(beats([0, 1, 0], [0, 2, 0])).toBe(false);
  });
});
