/**
 * Read-side queries for chat. Every function here is READ ONLY — writes live
 * in lib/actions/chat.ts.
 *
 * These rules hold across the whole file:
 *
 *  1. Every entry point starts at `requireScopedSession()`. Nothing in here
 *     takes a companyId from its caller, so no page can accidentally ask for
 *     another workspace's rail.
 *  2. Every channel read goes through `visibleChannelWhere(userId, companyId)`
 *     or `canSeeChannel(...)` from lib/auth/channel-permissions.ts. That
 *     module is the ONLY place the visibility rule is written down; an
 *     `OR: [{ kind: "public" }, …]` hand-rolled in this file would be a second
 *     copy that silently stops matching the first.
 *  3. Dates leave as ISO strings and nothing returns a Prisma Decimal, so the
 *     DTOs below cross the RSC boundary without a serialization surprise —
 *     the same contract every other file in lib/queries/ keeps.
 *  4. A DM's `name` is decided HERE, per viewer, not by the row. `Channel.name`
 *     on a DM is a static "Alice & Bob" fallback written once by whoever
 *     opened it, and it reads wrong from the other end — Ayesha should not see
 *     a conversation titled "Ayesha". Both read paths REPLACE `name` with
 *     `dmDisplayName(members, viewerId)`, which is why no DTO below grew a
 *     second name field: one name, resolved for the person asking.
 *  5. Message CONTENT is redacted per VIEWER, here, before it is serialized.
 *     Chat is open to every company role — `/chat` is deliberately absent from
 *     MEMBER_BLOCKED_ROUTES — but a member may not see money. A Runway card
 *     posted into a public channel is therefore the one place in the product
 *     where a finance figure and a `member` are in the same room, and
 *     `toMessageClient` is what keeps them apart. The rule is the one the
 *     tombstone already follows: if this viewer must not see it, it never
 *     enters the DTO at all, rather than being hidden once it has arrived.
 *
 * Denial is expressed as absence, never as a throw: `getChannelBySlug`
 * returns null and the page calls `notFound()`. A 403 on a private channel
 * would confirm the channel exists, which is exactly the fact membership is
 * supposed to hide.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeChannel, visibleChannelWhere } from "@/lib/auth/channel-permissions";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { RedactedRunwayPayloadSchema, RunwayPayloadSchema } from "@/lib/schemas/chat";
import { dmDisplayName, DM_UNNAMED_COUNTERPART } from "@/lib/chat/dm";
import { tokenizeForRender, type CommentSegment, type MentionUser } from "@/lib/comments/mentions";
import { capUnread } from "@/lib/chat/unread";
import { foldReactions, type ReactionRow } from "@/lib/chat/reactions";

/** How many root messages one page of a channel timeline carries. */
const MESSAGE_PAGE_SIZE = 50;

export interface ChannelListItem {
  id: string;
  slug: string;
  name: string;
  kind: string;
  topic: string | null;
  memberCount: number;
  /** Capped at 99 by `capUnread`; the UI renders "99+" at the cap. */
  unreadCount: number;
  lastMessageAt: string | null;
  isMember: boolean;
}

export interface ChannelDetail extends ChannelListItem {
  archivedAt: string | null;
  members: { id: string; name: string; handle?: string | null }[];
  /** "owner" | "member", or null when the viewer has no membership row. */
  myChannelRole: string | null;
}

export interface MessageReactionClient {
  emoji: string;
  count: number;
  mine: boolean;
}

/**
 * A Runway card, already resolved for the viewer asking for it.
 *
 * `redacted: true` means "you are not allowed to see the figures" and is what
 * the UI keys off to render the card's frame plus an explanatory line. It is
 * an EXPLICIT flag and not something the component infers from
 * `cashOnHand === null`, because those are two different facts that need two
 * different sentences: "hidden from your role" versus "this workspace has no
 * figures yet". Conflating them would either accuse the workspace of having no
 * money or imply the member is being shown everything there is.
 *
 * Note `runwayMonths: null` is a THIRD thing again — on an unredacted card it
 * means "no burn recorded", the JSON spelling of the dashboard's `Infinity`.
 * Read it together with `redacted`, never on its own.
 */
export interface RunwayCardClient {
  /** ISO instant the snapshot was taken — always present, never a figure. */
  asOf: string;
  /** The workspace currency the figures are denominated in. */
  currency: string;
  /** null when redacted, or when there is no burn to divide by. */
  runwayMonths: number | null;
  /** null when redacted. */
  cashOnHand: number | null;
  /** null when redacted. */
  monthlyBurn: number | null;
  /** True = this viewer fails `canSeeFinances`; render the frame, no numbers. */
  redacted: boolean;
}

export interface MessageClient {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  /** "text" | "card" — MESSAGE_KINDS in lib/schemas/chat.ts. */
  kind: string;
  body: string;
  /**
   * The card's payload as JSON, ALREADY REDACTED for this viewer and
   * re-serialized from the parsed object — never the raw column value. null
   * for plain text, for tombstones, and for any card whose payload could not
   * be parsed (if it cannot be parsed it cannot be redacted, so it is not
   * shipped). `card` below is the render-ready form; both are produced by the
   * same single parse so the two can never disagree about what is allowed.
   */
  payload: string | null;
  /**
   * The parsed, viewer-resolved Runway card, or null when this message is not
   * a renderable card — plain text, a tombstone, an unparseable payload, or a
   * payload version this build does not know. `kind === "card"` with
   * `card === null` is the signal to render an "unavailable card" frame.
   */
  card: RunwayCardClient | null;
  parentId: string | null;
  replyCount: number;
  /** Pre-tokenized server-side, exactly like lib/queries/comments.ts. */
  segments: CommentSegment[];
  mentionedUserIds: string[];
  reactions: MessageReactionClient[];
  createdAt: string;
  editedAt: string | null;
  /**
   * Non-null renders a tombstone, NOT an absent row. A deleted message keeps
   * its place so a thread never rewrites its own history mid-read.
   */
  deletedAt: string | null;
}

export interface MessagePage {
  messages: MessageClient[];
  nextCursor: string | null;
}

/** The row shape the message selects produce — shared by the mappers below. */
type MessageRow = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  kind: string;
  body: string;
  payload: string | null;
  parentId: string | null;
  replyCount: number;
  mentions: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  reactions: ReactionRow[];
};

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  authorId: true,
  authorName: true,
  authorAvatar: true,
  kind: true,
  body: true,
  payload: true,
  parentId: true,
  replyCount: true,
  mentions: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  reactions: { select: { emoji: true, userId: true } },
} as const;

/** Parse the `mentions` JSON column defensively — bad JSON means no mentions,
 *  not a blown-up channel. Same treatment as Comment.mentions. */
function parseMentions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * The stored `Message.payload` → the two card fields of the DTO, resolved for
 * ONE viewer.
 *
 * Returns both `card` and `payload` together, from a single parse, on purpose:
 * two functions producing two representations of the same figures is two
 * chances for one of them to forget the redaction. There is one decision here
 * and both outputs fall out of it.
 *
 * THREE failure modes, all silent, none a throw — the same defensive treatment
 * `parseMentions` gets above, and for the same reason: a row nobody can read
 * must degrade into a quiet frame, not take down a whole channel for everyone
 * in it.
 *   - not JSON              → `{ card: null, payload: null }`
 *   - JSON, wrong shape     → same
 *   - a `v` this build does not know → same. A future v2 card is refused
 *     rather than half-rendered by a reader guessing at fields it has never
 *     seen; guessing is how a "months" field gets printed as a currency.
 * In every one of those cases `payload` goes out as null rather than as the
 * original string: if we could not parse it we could not redact it, and an
 * unredactable blob is exactly the thing that must not reach a member.
 *
 * The allowed path also re-serializes from the PARSED object, never from
 * `raw`. zod strips unknown keys, so a figure smuggled into the JSON under a
 * key this schema has never heard of is dropped on the way through instead of
 * riding along beside the fields we did think about.
 */
function toCardFields(
  raw: string | null,
  viewerRole: Role
): { card: RunwayCardClient | null; payload: string | null } {
  const none = { card: null, payload: null };
  if (raw === null) return none;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return none;
  }

  const parsed = RunwayPayloadSchema.safeParse(json);
  if (!parsed.success) return none;
  const full = parsed.data;

  if (!canSeeFinances(viewerRole)) {
    // `.pick()`-derived, so a figure added to the payload later is secret by
    // default rather than public by default. See lib/schemas/chat.ts.
    const redacted = RedactedRunwayPayloadSchema.parse(full);
    return {
      card: {
        asOf: redacted.asOf,
        currency: redacted.currency,
        runwayMonths: null,
        cashOnHand: null,
        monthlyBurn: null,
        redacted: true,
      },
      payload: JSON.stringify(redacted),
    };
  }

  return {
    card: {
      asOf: full.asOf,
      currency: full.currency,
      runwayMonths: full.runwayMonths,
      cashOnHand: full.cashOnHand,
      monthlyBurn: full.monthlyBurn,
      redacted: false,
    },
    payload: JSON.stringify(full),
  };
}

/**
 * Row → DTO. Takes the roster so `segments` resolve here rather than in the
 * client component, the viewer id so each reaction chip knows whether it's
 * mine, and the viewer's ROLE so a finance figure never reaches somebody who
 * is not allowed one.
 *
 * ─── THIS FUNCTION IS THE ONLY THING BETWEEN A MEMBER AND THE COMPANY
 * BALANCE. ───
 *
 * Chat is open to every role on purpose; the finance PAGES are not. A Runway
 * card posted into a public channel is read by the whole company, members
 * included, so the figures have to be dropped for the viewer who may not see
 * them — server-side, here, before the DTO is serialized. The acceptance
 * criterion is not "the member does not see the number"; it is that the number
 * does not appear anywhere in the RSC payload, so View Source, the network
 * tab, and a paused React tree all come up empty. Hiding it with CSS, or
 * omitting it in the component, would ship the balance to the browser and then
 * politely decline to paint it.
 *
 * The component layer must NEVER be trusted to hide a figure it was handed.
 * Components get re-used, forked into a mobile variant, wrapped in a tooltip
 * that prints its own props, and serialized into error reports. If a figure is
 * in `MessageClient`, treat it as already published.
 *
 * The same principle already governs `body` for a tombstoned message: the text
 * is blanked HERE, not left to the client to skip. Cards are that rule applied
 * to a second audience — deleted content is hidden from everyone, finance
 * content is hidden from some people, and both decisions are made in this one
 * mapper.
 *
 * NOTE the card fields are gated on `row.kind === "card"` and a non-card
 * message ships `payload: null` unconditionally, rather than passing
 * `row.payload` straight through as it used to. A row with `kind: "text"` and
 * a figure-bearing payload would otherwise walk around the redaction entirely,
 * because the redaction keys off the kind. Nothing writes such a row today;
 * this costs one branch and removes the possibility.
 */
function toMessageClient(
  row: MessageRow,
  roster: MentionUser[],
  viewerId: string,
  viewerRole: Role
): MessageClient {
  const deleted = row.deletedAt !== null;
  const body = deleted ? "" : row.body;
  // A tombstoned card is a tombstone first: no frame, no asOf, no currency.
  const { card, payload } =
    deleted || row.kind !== "card"
      ? { card: null, payload: null }
      : toCardFields(row.payload, viewerRole);
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatar: row.authorAvatar,
    kind: row.kind,
    body,
    payload,
    card,
    parentId: row.parentId,
    replyCount: row.replyCount,
    segments: deleted ? [] : tokenizeForRender(body, roster),
    mentionedUserIds: deleted ? [] : parseMentions(row.mentions),
    reactions: deleted ? [] : foldReactions(row.reactions, viewerId),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The company roster, for mention rendering. One query, reused per page. */
function loadRoster(companyId: string): Promise<MentionUser[]> {
  return db.user.findMany({
    where: { companyId, deletedAt: null },
    // `handle` is not optional here: this roster is what tokenizeForRender
    // matches against, so dropping it renders no chip for a mention that DID
    // notify someone — the inverse of tasks-and-comments-001, and a breach of
    // the "a chip renders exactly when a notification fired" contract in
    // lib/comments/mentions.ts.
    select: { id: true, name: true, handle: true },
  });
}

/**
 * The channel rail: every channel the caller can see, newest conversation
 * first, each with its unread badge.
 *
 * Archived channels are excluded. Archiving is a soft close — the history
 * stays readable by direct link (getChannelBySlug does not filter on it) —
 * but a closed channel does not belong in the live rail.
 *
 * ON N+1: the unread badge needs "messages newer than MY lastReadAt in THIS
 * channel", and the watermark differs per channel, so a `groupBy` with one
 * shared threshold cannot express it. Rather than one count per channel, the
 * per-channel `(channelId, createdAt > watermark)` pairs are folded into a
 * single OR and handed to ONE groupBy. Two queries total for the whole rail,
 * regardless of how many channels the user is in — and it rides the
 * @@index([channelId, createdAt]) that already exists for the timeline.
 *
 * ON DM NAMES: the main select scopes `members` to the caller on purpose, so
 * the rail never drags every member of every public channel across the wire —
 * on a workspace of 200 people that join loads the whole company once per
 * channel. Widening it just to learn who the other half of a DM is would pay
 * that cost on every rail render in order to relabel a handful of rows.
 * Instead the DM rows are collected afterwards and, ONLY IF there are any, a
 * single extra query fetches their non-caller members. One conditional extra
 * query beats an unbounded join, and a workspace with no DMs pays nothing.
 */
export async function listChannelsForUser(): Promise<ChannelListItem[]> {
  const { userId, companyId } = await requireScopedSession();

  const channels = await db.channel.findMany({
    where: { ...visibleChannelWhere(userId, companyId), archivedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      topic: true,
      lastMessageAt: true,
      _count: { select: { members: true } },
      // Scoped to the caller: at most one row, and it carries the watermark.
      members: { where: { userId }, select: { lastReadAt: true } },
    },
    orderBy: [
      // nulls last, so a channel nobody has posted in sinks to the bottom
      // instead of floating above live conversations.
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { name: "asc" },
    ],
  });

  // Only a membership row carries a read watermark, so only joined channels
  // can have an unread badge. That is the documented model: for a public
  // channel, membership controls the badge and nothing else.
  const watermarks = channels
    .map((c) => ({ channelId: c.id, lastReadAt: c.members[0]?.lastReadAt }))
    .filter((w): w is { channelId: string; lastReadAt: Date } => w.lastReadAt !== undefined);

  const unreadByChannel = new Map<string, number>();
  if (watermarks.length > 0) {
    const grouped = await db.message.groupBy({
      by: ["channelId"],
      where: {
        companyId,
        deletedAt: null,
        // Your own messages are never unread to you.
        authorId: { not: userId },
        OR: watermarks.map((w) => ({
          channelId: w.channelId,
          createdAt: { gt: w.lastReadAt },
        })),
      },
      _count: { _all: true },
    });
    for (const g of grouped) unreadByChannel.set(g.channelId, g._count._all);
  }

  // The viewer-relative rename for DM rows only (see ON DM NAMES above). Keyed
  // by channelId; a channel missing from the map keeps its stored name, which
  // is the documented fallback when the other side has been tombstoned away.
  const dmNameByChannel = new Map<string, string>();
  const dmChannelIds = channels.filter((c) => c.kind === "dm").map((c) => c.id);
  if (dmChannelIds.length > 0) {
    const counterparts = await db.channelMember.findMany({
      // `userId: { not: userId }` is the whole trick: the rows that come back
      // are exactly the people this rail needs names for, and never the
      // caller, so nothing here scales with public-channel membership.
      //
      // NOTE THERE IS DELIBERATELY NO `user: { deletedAt: null }` FILTER. A
      // tombstoned colleague's DM history stays readable (Tier 3 soft delete),
      // so dropping their membership row here would leave the conversation with
      // nobody to name and render it as an unlabelled row — which reads as a
      // broken rail, not as a colleague who left. `deletedAt` is SELECTED
      // instead, and `dmDisplayName` says so in the label.
      where: { channelId: { in: dmChannelIds }, userId: { not: userId } },
      select: {
        channelId: true,
        user: { select: { id: true, name: true, deletedAt: true } },
      },
    });

    const membersByChannel = new Map<
      string,
      { id: string; name: string; deletedAt: Date | null }[]
    >();
    for (const row of counterparts) {
      const bucket = membersByChannel.get(row.channelId);
      if (bucket) bucket.push(row.user);
      else membersByChannel.set(row.channelId, [row.user]);
    }
    // `.forEach` rather than `for…of` over the Map: tsconfig has no
    // downlevelIteration, so iterating a Map directly is a TS2802.
    membersByChannel.forEach((dmMembers, channelId) => {
      const label = dmDisplayName(dmMembers, userId);
      if (label !== null) dmNameByChannel.set(channelId, label);
    });
  }

  return channels.map((c) => ({
    id: c.id,
    slug: c.slug,
    // `DM_UNNAMED_COUNTERPART`, NOT `c.name`, is the fallback. The stored name
    // is `openDmAction`'s "Saqib Nawaz & Ahmed Khan" and it contains the
    // VIEWER, so falling back to it re-introduced the exact bug the
    // viewer-relative rename exists to prevent, in the one case the rename
    // could not resolve. See lib/chat/dm.ts.
    name: c.kind === "dm" ? (dmNameByChannel.get(c.id) ?? DM_UNNAMED_COUNTERPART) : c.name,
    kind: c.kind,
    topic: c.topic,
    memberCount: c._count.members,
    unreadCount: capUnread(unreadByChannel.get(c.id) ?? 0),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    isMember: c.members.length > 0,
  }));
}

/**
 * One channel by its URL segment, or null when the caller may not see it —
 * INCLUDING when it simply does not exist. Same return either way on purpose:
 * the page calls notFound() and a private channel's existence stays private.
 *
 * Archived channels DO resolve here. Reading survives archiving; only posting
 * stops, and that is canPostInChannel's business in the action layer.
 */
export async function getChannelBySlug(slug: string): Promise<ChannelDetail | null> {
  const { userId, companyId } = await requireScopedSession();

  const channel = await db.channel.findFirst({
    where: { companyId, slug },
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      topic: true,
      archivedAt: true,
      lastMessageAt: true,
    },
  });
  if (!channel) return null;

  // Cheap probe first, same shape as getProjectForUser: `canSeeChannel` is
  // monotone in `isMember`, so a grant at isMember:false can never be wrong
  // and we skip the membership round trip on the deny path for a channel the
  // caller was never going to be allowed into.
  if (!canSeeChannel({ kind: channel.kind, isMember: false })) {
    const membership = await db.channelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId } },
      select: { id: true },
    });
    if (!canSeeChannel({ kind: channel.kind, isMember: !!membership })) return null;
  }

  // Past the gate. The member roster doubles as the member list AND as the
  // source of the caller's own channel role + watermark, so the grant path
  // needs no separate membership query.
  const members = await db.channelMember.findMany({
    where: { channelId: channel.id },
    select: {
      userId: true,
      role: true,
      lastReadAt: true,
      // handle: feeds the composer's mention autocomplete, which prefers a
      // handle and falls back to a name slug — so without it a teammate whose
      // display name has no ASCII letters cannot be picked from the list.
      // deletedAt: NOT exported on the DTO — it is read only to annotate a DM
      // whose counterpart has been deactivated (see `dmDisplayName`), which is
      // the one place this surface must not pretend the room is still live.
      user: { select: { id: true, name: true, handle: true, deletedAt: true } },
    },
    orderBy: { joinedAt: "asc" },
  });

  const memberList = members.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    handle: m.user.handle,
  }));

  // The roster is already loaded here, so the DM rename costs nothing extra —
  // no second query, unlike the rail. `DM_UNNAMED_COUNTERPART` rather than the
  // stored `channel.name` when `dmDisplayName` returns null: the stored name is
  // "<me> & <them>" and naming the viewer to themselves is the bug the rename
  // exists to prevent. Driven off `members` (which carries `deletedAt`) rather
  // than `memberList` (which deliberately does not), so a deactivated
  // counterpart is labelled as one.
  const name =
    channel.kind === "dm"
      ? (dmDisplayName(
          members.map((m) => ({ id: m.user.id, name: m.user.name, deletedAt: m.user.deletedAt })),
          userId
        ) ?? DM_UNNAMED_COUNTERPART)
      : channel.name;

  const mine = members.find((m) => m.userId === userId) ?? null;
  let unreadCount = 0;
  if (mine) {
    const raw = await db.message.count({
      where: {
        channelId: channel.id,
        deletedAt: null,
        authorId: { not: userId },
        createdAt: { gt: mine.lastReadAt },
      },
    });
    unreadCount = capUnread(raw);
  }

  return {
    id: channel.id,
    slug: channel.slug,
    name,
    kind: channel.kind,
    topic: channel.topic,
    memberCount: members.length,
    unreadCount,
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    isMember: mine !== null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    members: memberList,
    myChannelRole: mine?.role ?? null,
  };
}

/**
 * One page of a channel's timeline.
 *
 * ORDER: the returned array is ASCENDING — oldest first, newest LAST — so the
 * UI maps it straight to the DOM top-to-bottom and the newest message is the
 * bottom-most element, which is where a chat log's newest message belongs.
 * Paging goes BACKWARDS: `nextCursor` is the id of the OLDEST message in this
 * page, and passing it back returns the page before it, which the UI prepends.
 * (The underlying query runs descending so the cursor walks into history; the
 * slice is reversed once, here, so no caller has to think about it.)
 *
 * Replies are excluded (`parentId: null`) — a thread's replies belong to
 * `getThread`, not inline in the timeline, or one busy thread buries the room.
 *
 * Soft-deleted messages ARE returned, with `deletedAt` set and their body
 * blanked, so the list renders a tombstone in place rather than resequencing
 * itself around a hole.
 *
 * Returns an empty page — not a throw — when the channel is invisible or
 * absent, for the same non-disclosure reason as getChannelBySlug.
 */
export async function getMessagesPage(channelId: string, cursor?: string): Promise<MessagePage> {
  // `role` is pulled from the session, NEVER from a caller argument: the
  // redaction in `toMessageClient` is only worth anything if the role it reads
  // is the server's own answer to "who is asking".
  const { userId, companyId, role } = await requireScopedSession();

  const channel = await db.channel.findFirst({
    where: { id: channelId, ...visibleChannelWhere(userId, companyId) },
    select: { id: true },
  });
  if (!channel) return { messages: [], nextCursor: null };

  const [rows, roster] = await Promise.all([
    db.message.findMany({
      where: { channelId, parentId: null },
      select: MESSAGE_SELECT,
      // Descending + id tiebreaker, the cursor shape from getActivitiesPage:
      // same-millisecond rows page deterministically.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MESSAGE_PAGE_SIZE + 1, // one extra reveals whether older pages exist
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    loadRoster(companyId),
  ]);

  const hasMore = rows.length > MESSAGE_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, MESSAGE_PAGE_SIZE) : rows;
  // The oldest row in this page is the cursor for the page before it. Read it
  // off the descending slice BEFORE reversing, where it is simply the last.
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    messages: page.reverse().map((row) => toMessageClient(row, roster, userId, role)),
    nextCursor,
  };
}

/**
 * A thread: its root message followed by every reply, oldest first.
 *
 * The root is INCLUDED as the first element — the thread panel opens on the
 * message being replied to, and making the caller stitch the root back in
 * from the timeline is how a panel ends up showing replies to nothing after
 * the root scrolls out of the loaded page.
 *
 * Unpaginated by design: a thread is bounded by the conversation that spawned
 * it, unlike a channel that accumulates for years. If threads ever grow past
 * a screenful or two this grows a cursor exactly like getMessagesPage.
 *
 * Returns [] when the root is absent or its channel is invisible.
 */
export async function getThread(rootId: string): Promise<MessageClient[]> {
  // Same as getMessagesPage: the viewer's role comes from the session. A
  // thread is a second door onto the same messages, and a redaction applied at
  // one door only is not a redaction.
  const { userId, companyId, role } = await requireScopedSession();

  // Message carries companyId, so tenancy is established without joining
  // through Channel.
  const root = await db.message.findFirst({
    where: { id: rootId, companyId },
    select: { id: true, channelId: true },
  });
  if (!root) return [];

  // Tenancy is not visibility: the message being in my company says nothing
  // about whether I am in its channel. The query-form gate answers that.
  const channel = await db.channel.findFirst({
    where: { id: root.channelId, ...visibleChannelWhere(userId, companyId) },
    select: { id: true },
  });
  if (!channel) return [];

  const [rows, roster] = await Promise.all([
    db.message.findMany({
      // The root and its direct replies in one query. Threads are one level
      // deep — the send path re-parents a reply-to-a-reply onto the root — so
      // this OR is the whole tree, not the first two levels of one.
      where: { channelId: root.channelId, OR: [{ id: rootId }, { parentId: rootId }] },
      select: MESSAGE_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    loadRoster(companyId),
  ]);

  // The root sorts first by construction (it predates its replies), but say it
  // explicitly rather than leaning on a clock: a backfilled or imported reply
  // with an earlier timestamp must not displace the root.
  rows.sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : 0));

  return rows.map((row) => toMessageClient(row, roster, userId, role));
}

/**
 * `{ id, slug, name }` for the channel pickers — the "share this to…" target,
 * the command palette, the card composer.
 *
 * Visibility-filtered like everything else, so a picker cannot offer a channel
 * the caller would be denied on submit. Archived channels are omitted: you
 * cannot post into one, so offering it would be an invitation to a rejection.
 *
 * DMs are EXCLUDED, and that is a product decision rather than a permission
 * one — the caller could post in their own DM perfectly well. This picker
 * answers "share this into…", and a DM is a conversation with one person, not
 * a place you file a runway card. Offering every DM would also put a list of
 * who you talk to privately into a dropdown that sits open on screen next to
 * colleagues. If a "send this to a person" flow is ever wanted it should be
 * its own control with its own wording, sourced from `listDmCandidates` (which
 * is people-shaped), not smuggled into the channel list.
 *
 * Excluding by `kind` rather than by slug prefix: `Channel.kind` is the fact,
 * and pattern-matching "dm-" would be a second, weaker spelling of it.
 */
export async function listChannelOptions(): Promise<{ id: string; slug: string; name: string }[]> {
  const { userId, companyId } = await requireScopedSession();
  return db.channel.findMany({
    where: { ...visibleChannelWhere(userId, companyId), archivedAt: null, kind: { not: "dm" } },
    select: { id: true, slug: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** One teammate the caller could open a direct message with. */
export interface DmCandidate {
  id: string;
  name: string;
  /** Set when a DM with this person already exists — the UI then links
   *  straight to it instead of calling openDmAction and writing nothing. */
  existingSlug: string | null;
}

/**
 * Everyone in the workspace the caller could DM: every live teammate except
 * themselves, each carrying the slug of the DM they already share, if any.
 *
 * WHY `existingSlug` rather than letting the UI always call `openDmAction`:
 * the action is idempotent (the `@@unique([companyId, dmKey])` sees to that),
 * but a picker that POSTs on every click turns "look at this conversation"
 * into a write, a rate-limit hit and a revalidate. Handing the caller the slug
 * means the common case — a pair who already talk — is a plain link.
 *
 * TWO QUERIES, NEVER N: the roster comes back in one findMany, the caller's DM
 * channels in another, and the counterparts are matched up in memory. Asking
 * "does a DM with this person exist?" per teammate would be one query per row
 * of a list that grows with the company.
 *
 * ON VISIBILITY: the DM query deliberately does NOT use `visibleChannelWhere`.
 * For a DM, `members: { some: { userId } }` IS the visibility rule — it is the
 * second arm of that very fragment — and scoping to the caller's own
 * membership is strictly narrower than the fragment, whose first arm
 * (`kind: "public"`) cannot match a row already pinned to `kind: "dm"`.
 * Layering the fragment on top would add an OR that can only widen, next to a
 * filter that already decides the question. It is not a missing filter; please
 * do not "fix" it by adding one.
 */
export async function listDmCandidates(): Promise<DmCandidate[]> {
  const { userId, companyId } = await requireScopedSession();

  const [roster, dmChannels] = await Promise.all([
    db.user.findMany({
      // `deletedAt: null` is the Tier 3 tombstone filter every roster read
      // carries: a deactivated teammate is not someone you can start talking
      // to, and their existing DM history is reached through the rail.
      where: { companyId, deletedAt: null, id: { not: userId } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.channel.findMany({
      // No `archivedAt: null` here, unlike the rail. An archived DM is still
      // the row the `@@unique([companyId, dmKey])` index is holding, so
      // hiding it would hand the UI a null `existingSlug`, send it to
      // `openDmAction`, and make it collide with a conversation it was never
      // shown. Linking to a read-only DM is the better outcome — and since
      // the rail drops archived channels, this picker is the way back to it.
      where: { companyId, kind: "dm", members: { some: { userId } } },
      // The members come back so the counterpart can be identified without
      // parsing `dmKey` or the slug — the membership rows are the fact, and
      // the key is an index, not an API.
      select: { slug: true, members: { select: { userId: true } } },
    }),
  ]);

  const slugByCounterpart = new Map<string, string>();
  for (const channel of dmChannels) {
    for (const member of channel.members) {
      if (member.userId === userId) continue;
      slugByCounterpart.set(member.userId, channel.slug);
    }
  }

  // Driven by the roster, not by the channels: a DM with someone since
  // deactivated must not resurrect them into the picker.
  return roster.map((teammate) => ({
    id: teammate.id,
    name: teammate.name,
    existingSlug: slugByCounterpart.get(teammate.id) ?? null,
  }));
}
