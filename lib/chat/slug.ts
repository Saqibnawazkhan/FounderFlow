/**
 * Channel slug derivation.
 *
 * A channel's slug is its URL segment (`/chat/<slug>`) and half of the
 * `@@unique([companyId, slug])` key in prisma/schema.prisma. Deriving it is
 * pure string work with a surprising number of edge cases — an all-emoji
 * name, a name that collides with an existing channel, a name that slugifies
 * to the empty string — so it lives here, out of the action, where
 * tests/lib/chat/slug.test.ts can hold every one of those cases down.
 *
 * Deliberately NOT reusing `slugifyName` from lib/comments/mentions.ts: that
 * one exists to match an @mention token against a person's name and is
 * allowed to collapse to "" for a non-ASCII name (an unmatchable mention is
 * harmless). A channel slug that collapses to "" is a broken URL and a unique
 * constraint magnet, so this one always yields something addressable.
 */

/** Reserved by the chat routes themselves — a channel may not take these. */
const RESERVED_SLUGS: readonly string[] = ["new", "api", "_next"];

/** The fallback stem for a name with no ASCII alphanumerics at all. */
export const FALLBACK_CHANNEL_SLUG = "channel";

/** Slugs are capped so the URL (and the unique index entry) stays sane. */
export const MAX_CHANNEL_SLUG_LENGTH = 48;

/**
 * Lowercase, ASCII, hyphen-separated. Runs of anything else collapse to a
 * single hyphen and the ends are trimmed, so "  Q3 // Growth!!  " becomes
 * "q3-growth" rather than "-q3--growth-".
 *
 * Never returns "": a name that carries no ASCII alphanumerics (an all-emoji
 * or all-Urdu channel name — see the non-ASCII caveat in mentions.ts) falls
 * back to FALLBACK_CHANNEL_SLUG, which `uniqueChannelSlug` then numbers. The
 * display name keeps the original text; only the URL is transliterated away.
 */
export function slugifyChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_SLUG_LENGTH)
    // The slice can land mid-separator and leave a trailing hyphen.
    .replace(/-+$/g, "");
  if (!slug) return FALLBACK_CHANNEL_SLUG;
  return slug;
}

/**
 * The first slug in the `base`, `base-2`, `base-3`, … series that is not
 * already `taken`, so two channels called "Growth" become /chat/growth and
 * /chat/growth-2 instead of one insert failing the unique index.
 *
 * `taken` is the set of slugs ALREADY IN THE WORKSPACE — the caller loads it
 * scoped to its companyId, because slugs are per-workspace (two companies may
 * both have #general). Reserved route segments are treated as taken.
 *
 * This is a best-effort de-collision, not a lock: two people creating
 * "Growth" in the same millisecond can still both compute "growth-2". The
 * unique index is the real guarantee and the caller handles its P2002.
 */
export function uniqueChannelSlug(base: string, taken: Iterable<string>): string {
  const used = new Set<string>(taken);
  for (const reserved of RESERVED_SLUGS) used.add(reserved);

  if (!used.has(base)) return base;
  // Bounded rather than `while (true)`: a workspace with 1,000 channels named
  // "Growth" is a bug or an attack, and either way an unbounded loop here is
  // the wrong way to find out.
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Past that, fall through to something random and let the unique index
  // arbitrate. Still deterministic in shape, so the URL stays readable.
  return `${base}-${Date.now().toString(36)}`;
}
