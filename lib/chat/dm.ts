/**
 * Direct-message addressing — the URL a DM lives at, and the name it wears.
 *
 * A DM is the one channel nobody named and nobody chose a slug for, so both
 * have to be derived. `dmKeyFor` in lib/auth/channel-permissions.ts already
 * owns the pair's IDENTITY (sorted "idA:idB", the value behind
 * `@@unique([companyId, dmKey])`); this module turns that key into the two
 * things the surface needs — an addressable slug and a viewer-relative
 * heading. Pure string work, no Prisma, no session, so tests can pin every
 * edge without a database, the same way slug.ts is held down.
 *
 * Deriving the slug rather than generating a random one is the whole point:
 * the same pair must resolve to the same `/chat/<slug>` from either side,
 * forever, with no lookup table. A random slug would mean you cannot build the
 * link — or find the row — without first reading it back, and "open a DM with
 * Ayesha" would need a round trip before it could even render an href.
 *
 * Deliberately NOT reusing `slugifyChannelName` from ./slug.ts, and
 * deliberately separating the ids with "_": that function collapses every run
 * of non-[a-z0-9] to a single hyphen, so it can never emit an underscore. A
 * derived DM slug is therefore unreachable by ANY channel name a person could
 * type — "dm foo_bar" slugifies to "dm-foo-bar", not "dm-foo_bar" — which is
 * what stops a named channel from colliding with a DM inside
 * `@@unique([companyId, slug])` and taking over a private conversation's URL.
 */

/**
 * The prefix every derived DM slug carries, so `/chat/<slug>` reads as a DM at
 * a glance in logs and in the address bar. Module-private: nothing outside
 * should be pattern-matching slugs when it could ask for `Channel.kind`.
 */
const DM_SLUG_PREFIX = "dm-";

/**
 * "dm-<idA>_<idB>" derived from a sorted `dmKey`.
 *
 * Pure in the strict sense — no Date, no randomness, no I/O — so the same key
 * always yields the same URL. That is what lets a caller compute the link and
 * the lookup from the pair alone, and what makes the mapping safe to reproduce
 * on the client.
 *
 * Does NOT re-sort: `dmKeyFor` already did, and sorting again here would let
 * this function quietly disagree with the value actually stored in
 * `Channel.dmKey` if the two were ever handed different input. One module owns
 * the ordering; this one owns the spelling.
 *
 * The result is longer than MAX_CHANNEL_SLUG_LENGTH, and that is fine. That
 * constant bounds NAMES being slugified into something readable; `Channel.slug`
 * is TEXT, not a bounded varchar. Truncating a DM slug would throw away part of
 * the ids it is made of and let two different pairs land on one URL — exactly
 * the fork the dmKey unique index exists to prevent.
 */
export function dmSlugFor(dmKey: string): string {
  return `${DM_SLUG_PREFIX}${dmKey.replace(/:/g, "_")}`;
}

/**
 * The counterpart's name from the viewer's side — what the rail and the
 * channel header render INSTEAD of `Channel.name`.
 *
 * A DM's stored name is written once, by whoever opened it, and reads wrong
 * from the other end: Ayesha should not see a conversation titled "Ayesha".
 * Rather than storing two names (which then drift when somebody renames
 * themselves), the surface renames the channel per viewer. This is that
 * rename, and it is why `ChannelListItem` grew no new field — the query swaps
 * `name`, it does not add a second one.
 *
 * Returns null — never "" — when there is nobody left to name: a DM whose only
 * member is the viewer, because the other side was tombstoned or the row is
 * half-written. null is the caller's signal to fall back to the stored
 * `Channel.name`; an empty string would render as a blank heading and look
 * like a failed load. A member with a blank name is skipped for the same
 * reason instead of contributing an empty segment to the join.
 *
 * Joins with ", " rather than assuming exactly two members. A DM is a pair
 * today, but a heading that silently drops a participant is a worse failure
 * than one that is merely longer than expected.
 */
export function dmDisplayName(
  members: { id: string; name: string }[],
  viewerId: string
): string | null {
  const others = members
    .filter((member) => member.id !== viewerId)
    .map((member) => member.name.trim())
    .filter((name) => name.length > 0);
  if (others.length === 0) return null;
  return others.join(", ");
}
