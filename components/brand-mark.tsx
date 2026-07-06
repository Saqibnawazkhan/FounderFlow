/**
 * BrandMark — the FounderFlow logo, inlined from founderflow-favicons/favicon.svg
 * so the in-app mark matches the browser-tab favicon exactly (a bold geometric
 * "F" with a teal flow-bar on an indigo rounded square).
 *
 * Replaces the old lucide `Sparkles`-in-a-lime-square placeholder. The rounded
 * corners live in the artwork (rect rx), so callers just size it with a
 * className (e.g. `h-9 w-9`) — no wrapper background/radius needed. Pure SVG,
 * no hooks, so it renders in both Server and Client Components.
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
    <svg
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id="ffBrandBg"
          x1="0"
          y1="0"
          x2="512"
          y2="512"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#1E1B4B" />
          <stop offset="100%" stopColor="#312E81" />
        </linearGradient>
        <linearGradient id="ffBrandFlow" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#14B8A6" />
          <stop offset="100%" stopColor="#2DD4BF" />
        </linearGradient>
      </defs>
      {/* Rounded square */}
      <rect width="512" height="512" rx="108" fill="url(#ffBrandBg)" />
      {/* F — vertical stem + top crossbar (white) */}
      <rect x="128" y="112" width="64" height="288" rx="10" fill="white" />
      <rect x="128" y="112" width="256" height="58" rx="10" fill="white" />
      {/* Middle "flow" crossbar (teal) + pulse dot */}
      <rect x="128" y="230" width="200" height="52" rx="10" fill="url(#ffBrandFlow)" />
      <circle cx="340" cy="256" r="14" fill="#2DD4BF" opacity="0.6" />
      <circle cx="340" cy="256" r="8" fill="#2DD4BF" />
    </svg>
  );
}
