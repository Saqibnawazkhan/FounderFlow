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
 * Is this `Channel.slug` a direct message's?
 *
 * The inverse of `dmSlugFor`, and it lives here for the same reason
 * `isDmKind` does: one module owns the spelling. The caller that needs it
 * is the breadcrumb trail, which has only a URL to go on — no `kind`, no
 * membership rows — and was humanising the slug into
 * "Dm-demo-ali_dmsmoke-ghost-816234" for want of this question.
 *
 * A prefix test, not a shape test: the ids after it are cuids whose format
 * is Prisma's business, and a stricter pattern here would start disagreeing
 * with `dmSlugFor` the first time that changes.
 */
export function isDmSlug(slug: string): boolean {
  return slug.startsWith(DM_SLUG_PREFIX);
}

/**
 * Is this `Channel.kind` a direct message?
 *
 * ONE SPELLING, FOR EVERY SURFACE. `Channel.kind` is a plain String column, not
 * a Prisma enum, so the casing is whatever the writer happened to store — and
 * this check had been re-spelled inline in channel-rail.tsx and
 * channel-header.tsx, which is how chat-008 came about: the rail learned that a
 * DM is a person and the header, the browser tab and the composer did not.
 *
 * Reading "DM" as a room is not cosmetic. A hash in this product means "a room",
 * and a room means other people can be in it, so a Hash in front of a
 * colleague's name misrepresents who can read the conversation — the same class
 * of mistake as drawing a Hash on a private channel.
 */
export function isDmKind(kind: string): boolean {
  return kind.toLowerCase() === "dm";
}

/**
 * Is this `Channel.kind` a private channel — a room whose membership IS its
 * access control?
 *
 * Lives here for the reason `isDmKind` does: ONE SPELLING, FOR EVERY SURFACE.
 * This predicate existed as a private copy in channel-rail.tsx and a third
 * inline re-spelling in channel-header.tsx, and both now call this function.
 *
 * `includes("private")` rather than `=== "private"`, which is the shape the
 * rail's copy already had: `Channel.kind` is a plain String column with no
 * enum behind it, and a privacy decision that flips on how a row happened to
 * be capitalised is not a decision. Substring rather than equality so a future
 * `"private-archive"` still reads as private — the safe direction for this
 * question is to over-recognise privacy, never to under-recognise it.
 */
export function isPrivateKind(kind: string): boolean {
  return kind.toLowerCase().includes("private");
}

/**
 * How a conversation is ADDRESSED in prose — the browser tab, a heading, the
 * subject of a sentence.
 *
 * `#general` for a PUBLIC room. A bare name for everything else: `Ahmed Khan`
 * for a direct message, `pvt-hiring` for a private channel. Before this
 * existed, `generateMetadata` titled every kind `#${channel.name}` and a
 * two-person conversation showed up in the tab, the history and every bookmark
 * as "#Ahmed Khan".
 *
 * ── WHY A PRIVATE CHANNEL LOSES THE HASH TOO ────────────────────────────
 *
 * THE RULE: a hash appears in prose exactly where a Hash ICON appears beside
 * the name. ChannelRail and ChannelHeader both draw a Lock for a private
 * channel and a Hash only for a public one, and ChatClient's "Add people to …"
 * dialog title already omitted the hash for a private channel, so the browser
 * tab and the send box contradicted the Lock sitting next to them in the same
 * viewport.
 *
 * THREE PROSE SURFACES DID NOT ROUTE THROUGH HERE, and an earlier version of
 * this comment claimed only the routed ones were affected. Found by adversarial
 * verification; all three now call this function:
 *   - lib/actions/chat.ts, the mention notification title — a member of
 *     pvt-hiring was told "Bilal mentioned you in #pvt-hiring";
 *   - lib/queries/search.ts, the command-palette row ("Bilal in #pvt-hiring");
 *   - components/chat/new-channel-modal.tsx, the created toast.
 * A statement about which call sites exist is a claim about the whole repo, and
 * this one was made without grepping it.
 *
 * That contradiction is not cosmetic: in this product a hash means "a room
 * other people can be in", which is the opposite of what a private channel
 * promises. It is the same class of mistake as drawing a Hash on a DM.
 *
 * A bare name rather than a padlock EMOJI in front of it, because this string
 * is also the composer's sr-only <label>, and a screen reader reads that emoji
 * aloud as "locked" — "Message locked pvt-hiring" is a worse sentence than the
 * one it replaces. The kind is signalled by the icon beside the name, which is
 * where a glyph belongs. The cost, stated rather than discovered later: in the
 * browser tab, where no icon is rendered, a private channel and a DM now read
 * alike.
 *
 * An UNRECOGNISED kind gets no hash. Fail-closed on the privacy CLAIM: a hash
 * asserts "other people can be in here", and a kind this module has never
 * heard of is not grounds to assert that on the app's behalf.
 *
 * `name` is expected to be the value lib/queries/chat.ts already resolved — for
 * a DM that is the VIEWER-RELATIVE counterpart name from `dmDisplayName`, never
 * the stored `Channel.name`. This function does not and must not re-derive it:
 * a second source of truth for "who is this DM with" is exactly how two
 * surfaces come to disagree.
 */
export function conversationTitle(kind: string, name: string): string {
  return kind.toLowerCase() === "public" ? `#${name}` : name;
}

/**
 * What the send box invites you to do: `Message #general`, or `Message Ahmed
 * Khan`.
 *
 * Its own function rather than `\`Message ${conversationTitle(...)}\`` at the
 * call site, because the composer uses this string TWICE — as the placeholder
 * and as the sr-only <label> — and the two must not be able to drift into
 * different wording for sighted and screen-reader readers.
 */
export function composerPlaceholder(kind: string, name: string): string {
  return `Message ${conversationTitle(kind, name)}`;
}

/**
 * What a DM is called when `dmDisplayName` finds nobody to name.
 *
 * WHY NOT THE STORED `Channel.name`. That is what the callers used to fall back
 * to, and `openDmAction` writes it as `"Saqib Nawaz & Ahmed Khan"` — it
 * CONTAINS THE VIEWER. So the fallback re-introduced, in the one case the
 * viewer-relative rename could not resolve, precisely the bug `dmDisplayName`
 * exists to prevent: Saqib opening a conversation headed with his own name.
 *
 * Neutral text is the honest answer. It is not "" — a blank heading reads as a
 * failed load — and it is not an error, because the conversation and its
 * history are real and still readable; it is only the label that is missing.
 * Reachable when a membership row is absent (a half-written DM) or when the
 * only counterpart's name is blank.
 */
export const DM_UNNAMED_COUNTERPART = "Unknown teammate";

/** The suffix a departed teammate's name carries. See `dmDisplayName`. */
const DEACTIVATED_SUFFIX = " (deactivated)";

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
 *
 * ── A COUNTERPART WHO HAS LEFT THE WORKSPACE ───────────────────────────────
 *
 * Tier 3 TOMBSTONES users (`User.deletedAt`) instead of deleting them, and
 * nothing clears their `ChannelMember` rows. So the counterpart of a DM with a
 * deactivated colleague still resolves perfectly, and the conversation reads
 * exactly like a live one: the reader types into a room nobody will ever open
 * again and is told nothing. `deletedAt` therefore annotates the name —
 * "Ahmed Khan (deactivated)".
 *
 * WHY THE ANNOTATION IS IN THE NAME AND NOT A SEPARATE DTO FIELD. The rail, the
 * channel header, the browser tab and the composer's placeholder all render
 * `ChannelListItem.name` / `ChannelDetail.name`. Annotating the name reaches
 * every one of them from this single decision. A `dmCounterpartDeactivated`
 * boolean on the DTO would need four independent renders instead — four chances
 * for one to ship unreached, which is the defect this codebase has produced
 * repeatedly (see the "shipped, tested, unreachable" rows in the audit).
 *
 * The name is KEPT, never blanked: the DM's history stays readable by design,
 * and a blank heading would read as a failed load rather than as a colleague who
 * has gone. `deletedAt` is OPTIONAL so every existing caller keeps compiling,
 * and absent must mean the same as null — otherwise the annotation appears at
 * random depending on which query populated the row.
 */
export function dmDisplayName(
  members: { id: string; name: string; deletedAt?: Date | string | null }[],
  viewerId: string
): string | null {
  const others = members
    .filter((member) => member.id !== viewerId)
    .map((member) => ({ name: member.name.trim(), gone: Boolean(member.deletedAt) }))
    .filter((member) => member.name.length > 0);
  if (others.length === 0) return null;
  return others
    .map((member) => (member.gone ? `${member.name}${DEACTIVATED_SUFFIX}` : member.name))
    .join(", ");
}
