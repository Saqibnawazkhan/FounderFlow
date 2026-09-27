/**
 * BrandMark — the FounderFlow logo: a lowercase "f" mark knocked out of an
 * emerald (#10B981) rounded square, matching the browser-tab favicon and the
 * installed-PWA icon exactly (all of them come from the same artwork via
 * `scripts/_gen-brand-assets.mjs`).
 *
 * Replaces the old inline-SVG indigo/teal "F". It renders an <img> rather than
 * inline SVG because the rebrand artwork we were handed is raster, not vector —
 * there is no path to inline, so tracing it would only invent a shape that
 * drifts from the real mark. The <img> ships at two densities
 * (brand-mark.png 96px / brand-mark@2x.png 192px) so it stays crisp on retina.
 *
 * The emerald tile (rather than the black-on-transparent variant, also supplied)
 * is the one we standardised on: it holds its contrast on the charcoal dark
 * theme *and* on white surfaces, so a single asset works everywhere the mark
 * appears — sidebar, topbar, auth screens, emails.
 *
 * The rounded corners live in the artwork, so callers just size it with a
 * className (e.g. `h-9 w-9`) — no wrapper background/radius needed. No hooks,
 * so it renders in both Server and Client Components.
 */

export function BrandMark({
  className,
  title = "FounderFlow",
}: {
  className?: string;
  /** Accessible name; pass "" and add your own label on a parent when decorative. */
  title?: string;
}) {
  return (
    // A fixed-size static icon: next/image would add a wrapper for no win.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand-mark.png"
      srcSet="/brand-mark.png 1x, /brand-mark@2x.png 2x"
      alt={title || ""}
      aria-hidden={title ? undefined : true}
      className={className}
    />
  );
}
