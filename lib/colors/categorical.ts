/**
 * The CATEGORICAL colour ramp — ten hues for CATEGORICAL DATA.
 *
 * ── WHY THIS MODULE EXISTS (audit ui-016 and the bug under it) ──
 *
 * Three things were wrong at once, and only the first was "not enough colours":
 *
 *  1. `EXPENSE_CATEGORIES` (lib/types.ts) has TEN entries; the dashboard's
 *     `CATEGORY_PALETTE` had SIX. Four categories were therefore drawn in a
 *     colour already used by another category IN THE SAME PIE — two slices,
 *     identical fill, nothing in the chart to tell them apart.
 *  2. Of the six, four were one hue at four lightnesses (#10B981 emerald,
 *     #047857 forest, #6EE7B7 mint, #065F46 deep). Under deuteranopia (~8% of
 *     men) they collapse into one band, and in greyscale they are four greys.
 *  3. The colours were hardcoded hex literals in FIVE files — the three
 *     `*-charts.tsx` plus the two `*-client.tsx` that paint the legend dots
 *     beside them — each with its own near-duplicate set. /expenses used an
 *     amber gradient while /dashboard and /reports used the emerald ramp, which
 *     is ui-016 itself. And being fixed hex, none of them responded to the theme
 *     toggle: #047857 stayed a dark forest green on a #1f2933 charcoal card.
 *
 * ── WHAT THIS IS NOT ──
 *
 * This ramp is deliberately SEPARATE from two other colour families, and
 * merging it into either would reintroduce a bug:
 *
 *  • The BRAND ramp (`--primary`, `--forest`, `--mint`, `--slate`). The
 *    `20260923000000_rebrand_project_colors` migration narrowed the brand to
 *    "the emerald ramp plus a neutral" ON PURPOSE. That was right for brand
 *    surfaces — buttons, gradients, the focus ring — and wrong for categorical
 *    data, which needs maximum separation rather than family resemblance. Both
 *    are now true at once because they are different token sets.
 *  • The SEMANTIC tokens (`--warning`, `--danger`, `--success`, `--info`).
 *    Those carry MEANING: amber means over budget, red means destructive. A
 *    categorical hue that happens to look amber means nothing at all, which is
 *    exactly why it must not be spelled `--warning`.
 *
 * ── ORDER IS LOAD-BEARING ──
 *
 * Emerald leads so the brand colour starts every chart. After that, each
 * neighbour differs in BOTH hue and lightness, so a chart still reads in
 * greyscale and under deuteranopia. Do not reorder to "group the warm ones":
 * that is precisely how you get two adjacent slices nobody can separate.
 *
 * The one pair that nearly matches in luminance is 4 violet (#8b5cf6, relative
 * luminance 0.198) and 5 red (#ef4444, 0.229) — 1.13:1, below the ~1.2:1 that
 * survives greyscale. They separate by hue instead, and they separate well
 * under deuteranopia specifically (violet keeps its blue channel; red does
 * not), so the order stands. It is recorded here rather than silently "fixed"
 * because a future reorder should know which pair is the tight one.
 *
 * ── WHERE THE VALUES ACTUALLY LIVE ──
 *
 * The RUNTIME values are the CSS custom properties `--cat-1 … --cat-10` in
 * app/globals.css, which have a light value and a DIFFERENT dark value. The
 * hexes recorded below are documentation of those two blocks, and
 * `tests/lib/colors/categorical-palette.test.ts` parses globals.css and fails
 * if the two ever disagree — so this is a checked copy, not a second source of
 * truth. Charts consume `CHART_CATEGORICAL` (which is `rgb(var(--cat-N))`, not
 * a hex) and therefore respond to the theme for free.
 */

import type { CSSProperties } from "react";

export type CategoricalColor = {
  /**
   * The PERSISTED identifier — this is what lands in `Project.color`.
   *
   * Named by POSITION, not by hue, and both halves of that are deliberate:
   *
   *  • Position, because a stored "pink" is a promise about a hue that a future
   *    retune breaks. `rebrand_project_colors` exists because the previous
   *    palette made exactly that promise and then had to rewrite live rows to
   *    get out of it. "cat-7" only claims to be the seventh categorical colour,
   *    which stays true however #ec4899 is tuned.
   *  • Not a hue name, because two of the ten hues ARE named `cyan` and `pink`
   *    — the two slugs `rebrand_project_colors` RETIRED and rewrote away. Those
   *    `UPDATE … WHERE "color" IN ('primary','cyan')` statements are documented
   *    as "idempotent and safe to re-run". Re-introducing `cyan` as a writable
   *    slug would quietly make that claim false and arm a re-run to recolour
   *    live projects. `cat-N` can never match those WHERE clauses, so the
   *    migration stays safe and prisma/ needs no edit.
   */
  readonly slug: string;
  /** Human hue name. Used for the swatch picker's `aria-label` and nothing else. */
  readonly label: string;
  /** The CSS custom property holding the fill value, per theme. */
  readonly token: string;
  /** The TEXT-SAFE variant's custom property (see the `-strong` note below). */
  readonly strongToken: string;
  /** Documentation of the `:root` value in app/globals.css. */
  readonly light: string;
  /** Documentation of the `.dark` value in app/globals.css. */
  readonly dark: string;
  /** Documentation of the `:root` `-strong` value. */
  readonly lightStrong: string;
  /** Documentation of the `.dark` `-strong` value. */
  readonly darkStrong: string;
};

/**
 * The ramp. Index + 1 is the token number: entry 0 is `--cat-1`.
 *
 * ── THE `-strong` COLUMN ──
 *
 * Same split the brand and semantic tokens already use (`--primary` /
 * `--primary-strong`): the bare token is for FILLS, `-strong` is the TEXT-ONLY
 * variant that clears WCAG AA 4.5:1 on its own theme's surfaces. A pie slice
 * does not need 4.5:1; the project card's accent glyph sitting next to a label,
 * and any text drawn on top of a fill, do.
 *
 * Light `-strong` is the Tailwind 700 step; dark `-strong` is the 300 step.
 * Both are uniform across all ten ON PURPOSE, and the dark step is chosen by
 * the WORST case rather than per hue: at the 400 step, five of the ten
 * (blue 3.87, violet 3.61, red 3.55, pink 3.71, orange 4.34, slate 3.84) fail
 * AA against `--surface-hover` (#374552), and a card or a modal is exactly
 * where these labels render. That is the same measurement that already forced
 * `--danger-strong` from red-400 down to red-300 — see the long comment on it
 * in app/globals.css. Measured minima are recorded per line in globals.css.
 *
 * Five of the ten light `-strong` values are tokens this stylesheet already
 * ships (`--primary-strong` #047857, `--info-strong` #1d4ed8,
 * `--warning-strong` #b45309, `--danger-strong` #b91c1c, `--slate-strong`
 * #334155). That is a coincidence worth keeping: the categorical ramp lands on
 * the same text-safe steps the rest of the product already uses.
 */
export const CATEGORICAL_COLORS: readonly CategoricalColor[] = [
  {
    slug: "cat-1",
    label: "emerald",
    token: "--cat-1",
    strongToken: "--cat-1-strong",
    light: "#10b981",
    dark: "#34d399",
    lightStrong: "#047857",
    darkStrong: "#6ee7b7",
  },
  {
    slug: "cat-2",
    label: "blue",
    token: "--cat-2",
    strongToken: "--cat-2-strong",
    light: "#3b82f6",
    dark: "#60a5fa",
    lightStrong: "#1d4ed8",
    darkStrong: "#93c5fd",
  },
  {
    slug: "cat-3",
    label: "amber",
    token: "--cat-3",
    strongToken: "--cat-3-strong",
    light: "#f59e0b",
    dark: "#fbbf24",
    lightStrong: "#b45309",
    darkStrong: "#fcd34d",
  },
  {
    slug: "cat-4",
    label: "violet",
    token: "--cat-4",
    strongToken: "--cat-4-strong",
    light: "#8b5cf6",
    dark: "#a78bfa",
    lightStrong: "#6d28d9",
    darkStrong: "#c4b5fd",
  },
  {
    slug: "cat-5",
    label: "red",
    token: "--cat-5",
    strongToken: "--cat-5-strong",
    light: "#ef4444",
    dark: "#f87171",
    lightStrong: "#b91c1c",
    darkStrong: "#fca5a5",
  },
  {
    slug: "cat-6",
    label: "cyan",
    token: "--cat-6",
    strongToken: "--cat-6-strong",
    light: "#06b6d4",
    dark: "#22d3ee",
    lightStrong: "#0e7490",
    darkStrong: "#67e8f9",
  },
  {
    slug: "cat-7",
    label: "pink",
    token: "--cat-7",
    strongToken: "--cat-7-strong",
    light: "#ec4899",
    dark: "#f472b6",
    lightStrong: "#be185d",
    darkStrong: "#f9a8d4",
  },
  {
    slug: "cat-8",
    label: "lime",
    token: "--cat-8",
    strongToken: "--cat-8-strong",
    light: "#84cc16",
    dark: "#a3e635",
    lightStrong: "#4d7c0f",
    darkStrong: "#bef264",
  },
  {
    slug: "cat-9",
    label: "orange",
    token: "--cat-9",
    strongToken: "--cat-9-strong",
    light: "#f97316",
    dark: "#fb923c",
    lightStrong: "#c2410c",
    darkStrong: "#fdba74",
  },
  {
    slug: "cat-10",
    label: "slate",
    token: "--cat-10",
    strongToken: "--cat-10-strong",
    light: "#64748b",
    dark: "#94a3b8",
    lightStrong: "#334155",
    darkStrong: "#cbd5e1",
  },
];

/**
 * The ten slugs as a const tuple, so `z.enum()` in lib/schemas/project.ts gets
 * a literal union rather than `string`.
 *
 * Spelled out instead of `CATEGORICAL_COLORS.map(c => c.slug)` because that
 * returns `string[]`, and `z.enum` needs the tuple type. The two lists are kept
 * in step by `tests/lib/colors/categorical-palette.test.ts`, which asserts they
 * are element-for-element identical — a drift here would hand the picker a slug
 * the schema rejects.
 */
export const CATEGORICAL_SLUGS = [
  "cat-1",
  "cat-2",
  "cat-3",
  "cat-4",
  "cat-5",
  "cat-6",
  "cat-7",
  "cat-8",
  "cat-9",
  "cat-10",
] as const;

export type CategoricalSlug = (typeof CATEGORICAL_SLUGS)[number];

/** Hue name for a slug, for `aria-label` on a colour swatch. */
export const CATEGORICAL_LABELS: Record<string, string> = {
  "cat-1": "emerald",
  "cat-2": "blue",
  "cat-3": "amber",
  "cat-4": "violet",
  "cat-5": "red",
  "cat-6": "cyan",
  "cat-7": "pink",
  "cat-8": "lime",
  "cat-9": "orange",
  "cat-10": "slate",
};

/* ───────────────────────────────────────────────────────────────────────── */
/* Chart consumption                                                        */
/* ───────────────────────────────────────────────────────────────────────── */

/**
 * The ramp as CSS colour strings, in order, for Recharts `fill` / `stroke` /
 * `stopColor` and for inline `style={{ backgroundColor }}` on legend dots.
 *
 * `rgb(var(--cat-N))` rather than a hex IS the dark-mode fix. Recharts writes
 * these straight through to the SVG presentation attribute, presentation
 * attributes are parsed as CSS property values, and `var()` resolves there — so
 * flipping `.dark` on <html> re-paints every mark with no JS and no re-render.
 * Verified in a real browser, not assumed; see the test file's header.
 *
 * `--cat-N` is `R G B` with no `rgb()` wrapper precisely so the same token also
 * feeds Tailwind's `rgb(var(--x) / <alpha-value>)` for `bg-cat-1/10`.
 */
export const CHART_CATEGORICAL: readonly string[] = [
  "rgb(var(--cat-1))",
  "rgb(var(--cat-2))",
  "rgb(var(--cat-3))",
  "rgb(var(--cat-4))",
  "rgb(var(--cat-5))",
  "rgb(var(--cat-6))",
  "rgb(var(--cat-7))",
  "rgb(var(--cat-8))",
  "rgb(var(--cat-9))",
  "rgb(var(--cat-10))",
];

/**
 * Colour for the Nth item of a categorical series, wrapping at the end of the
 * ramp. One function so the `i % PALETTE.length` that used to be written out at
 * four call sites cannot be got wrong at one of them.
 *
 * The wrap is a last resort, not a plan: the palette is asserted to be at least
 * as long as `EXPENSE_CATEGORIES`, so no chart in the product reaches it.
 */
export function categoricalAt(index: number): string {
  const n = CHART_CATEGORICAL.length;
  return CHART_CATEGORICAL[((index % n) + n) % n];
}

/**
 * The three cash-flow series, named rather than positional.
 *
 * /dashboard and /reports both draw these and each ALSO draws its own legend
 * dots in a separate `*-client.tsx` file, so four places have to agree on three
 * colours. They used emerald / forest / mint — one hue at three lightnesses,
 * i.e. defect 2 above, in the chart a founder looks at first.
 *
 * Hue-separated now: money in splits emerald / blue, money out is amber. Amber
 * for expenses reads as "money leaving" without the alarm of red, and it is the
 * CATEGORICAL amber (`--cat-3`), not `--warning` — nothing here is a warning.
 */
export const CHART_SERIES = {
  investments: "rgb(var(--cat-1))",
  revenue: "rgb(var(--cat-2))",
  expenses: "rgb(var(--cat-3))",
} as const;

/**
 * Axis ticks, axis lines and grid lines.
 *
 * `--fg-muted`, not a categorical hue: an axis is chrome, not data. It also
 * fixes a contrast bug in passing — the hardcoded #94a3b8 (slate-400) these
 * replace measured 2.6:1 against a white card, and axis ticks are text.
 * `--fg-muted` is 4.76:1 on light and 5.47:1 on a dark card.
 */
export const CHART_AXIS = "rgb(var(--fg-muted))";

/**
 * Recharts tooltip surface. Was copy-pasted identically into all three
 * `*-charts.tsx`; the properties are already theme tokens, so the only defect
 * was the triplication. Mirrors `.recharts-default-tooltip` in app/globals.css,
 * which covers the tooltips that do not take `contentStyle`.
 */
export const CHART_TOOLTIP_STYLE: CSSProperties = {
  borderRadius: 12,
  border: "1px solid rgb(var(--border))",
  background: "rgb(var(--card))",
  color: "rgb(var(--fg))",
  boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
};
