"use server";

/**
 * Chat server actions: send, create channel, open a DM, react, delete, mark
 * read, post a Runway card.
 *
 * Every access decision defers to lib/auth/channel-permissions.ts. There is
 * deliberately no `if (role === "admin")` anywhere in this file — that module
 * says so in its own header, and it is the reason these actions can ship
 * without unit tests of their own (the predicates have them; the plumbing is
 * covered by scripts/smoke-*.mjs).
 *
 * ── Activity rows: one per CHANNEL, none per MESSAGE ──────────────────────
 * A message does NOT write an Activity row, and that is a decision rather
 * than an oversight. /activities is the workspace's ledger of things that
 * changed — money moved, a task was assigned, someone joined. A busy chat
 * produces hundreds of messages a day; feeding them into that feed would bury
 * every expense and every task hand-off under small talk within a week, and
 * the feed would have to grow per-type filtering to become readable again.
 * Chat already has its own durable, ordered, searchable record: the channel.
 * Mentions still reach people, through notifyUsers, which is the path that
 * respects each person's notification preferences.
 *
 * Channel LIFECYCLE (created / archived) is the opposite case — it happens
 * rarely, it changes the shape of the workspace, and it is exactly what the
 * feed is for. That row is not written yet: `ActivityType` in lib/types.ts is
 * a closed union and `ACTIVITY_META` in the activities page is a
 * `Record<ActivityType, …>` that is indexed without a fallback, so emitting a
 * `channel_created` type from here would throw in the activities UI the first
 * time someone made a channel. Landing it needs one line in each of those two
 * files, both owned by another workstream.
 * TODO(chat): add "channel_created" / "channel_archived" to ActivityType +
 * ACTIVITY_META, then write the lifecycle row in createChannelAction.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  NewChannelSchema,
  OpenDmSchema,
  PostRunwayCardSchema,
  RUNWAY_CARD_VERSION,
  RunwayPayloadSchema,
  SendMessageSchema,
  ToggleReactionSchema,
  MarkChannelReadSchema,
  DeleteMessageSchema,
  type RunwayPayload,
} from "@/lib/schemas/chat";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import {
  canDeleteMessage,
  canPostInChannel,
  canPostRunwayCard,
  canSeeChannel,
  dmKeyFor,
} from "@/lib/auth/channel-permissions";
import { getTransactions } from "@/lib/queries/transactions";
import { subMonths } from "date-fns";
import { extractMentions } from "@/lib/comments/mentions";
import { slugifyChannelName, uniqueChannelSlug } from "@/lib/chat/slug";
import { dmSlugFor } from "@/lib/chat/dm";
import type { Role } from "@/lib/auth/role-gates";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/** The facts `channel-permissions` needs, loaded once per action. */
type ChannelContext = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  archivedAt: Date | null;
  isMember: boolean;
  channelRole: string | null;
  muted: boolean;
};

/**
 * Load a channel plus the caller's membership, scoped to the caller's
 * company.
 *
 * The `companyId` in the where clause is the re-verification step of the
 * house template: a channelId arriving in `input` is attacker-controlled, and
 * this is the only thing standing between a forged cuid and a write into
 * another workspace. Returns null when the channel is absent OR belongs to
 * someone else — the caller turns both into the same "Channel not found", so
 * a probe cannot tell them apart.
 *
 * Visibility is NOT decided here. This returns facts; the pure predicates
 * decide.
 */
async function loadChannelContext(
  channelId: string,
  companyId: string,
  userId: string
): Promise<ChannelContext | null> {
  const channel = await db.channel.findFirst({
    where: { id: channelId, companyId },
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      archivedAt: true,
      members: { where: { userId }, select: { role: true, mutedAt: true } },
    },
  });
  if (!channel) return null;
  const mine = channel.members[0] ?? null;
  return {
    id: channel.id,
    slug: channel.slug,
    name: channel.name,
    kind: channel.kind,
    archivedAt: channel.archivedAt,
    isMember: mine !== null,
    channelRole: mine?.role ?? null,
    muted: mine?.mutedAt != null,
  };
}

/**
 * Post a message, or a threaded reply.
 *
 * Mentions are re-parsed SERVER-SIDE against the company roster. The client
 * never gets to say who it pinged — that would let anyone fan a notification
 * out to the whole company by hand-crafting the payload.
 */
export async function sendMessageAction(input: unknown): Promise<
  ActionResult<{
    id: string;
    /** Who the parser RESOLVED from the body — "we tried to ping these". */
    mentionedUserIds: string[];
    /** Who was ACTUALLY notified. Lower when someone muted the channel, opted
     *  out of mention notifications, or the fan-out threw. */
    notifiedCount: number;
  }>
> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = SendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid message" };
  }
  const { channelId, body, parentId } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    // The permission predicate needs facts from the database, so unlike the
    // role-only gates in lib/actions/projects.ts it cannot run before the
    // lookup. The lookup IS the foreign-id re-verification, so the two steps
    // of the template collapse into one here, in that order.
    const channel = await loadChannelContext(channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canPostInChannel(channel)) {
      return {
        success: false,
        error: channel.archivedAt
          ? "This channel is archived — nobody can post in it."
          : "You do not have access to this channel",
      };
    }

    // A reply's parent must live in THIS channel. Without the channelId in
    // this where clause, a forged parentId would stitch a reply from one
    // channel onto a thread in another — including one the author cannot see.
    let rootId: string | null = null;
    if (parentId) {
      const parent = await db.message.findFirst({
        where: { id: parentId, channelId, companyId },
        select: { id: true, parentId: true },
      });
      if (!parent) return { success: false, error: "That message is no longer here" };
      // Threads are ONE level deep. Replying to a reply attaches to the same
      // root rather than nesting, so `replyCount` counts one thing and
      // getThread stays a two-query read instead of a recursive walk.
      rootId = parent.parentId ?? parent.id;
    }

    const [author, roster] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { name: true, avatar: true } }),
      db.user.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    if (!author) return { success: false, error: "User no longer exists" };

    const mentionedUserIds = extractMentions(body, roster, userId);

    const created = await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          companyId,
          channelId,
          authorId: userId,
          authorName: author.name,
          authorAvatar: author.avatar,
          kind: "text",
          body,
          payload: null,
          parentId: rootId,
          mentions: JSON.stringify(mentionedUserIds),
        },
        select: { id: true, createdAt: true },
      });

      // Denormalized recency for the rail's ORDER BY. Inside the transaction
      // so the rail can never sort by a timestamp whose message rolled back.
      await tx.channel.update({
        where: { id: channelId },
        data: { lastMessageAt: message.createdAt },
      });

      if (rootId) {
        await tx.message.update({
          where: { id: rootId },
          data: { replyCount: { increment: 1 } },
        });
      }

      return message;
    });

    // ── Fan-out, OUTSIDE the transaction and inside its own try/catch ──
    // A missing ping is recoverable; a missing message is not. Mirrors
    // createCommentAction, down to reporting the honest notified count rather
    // than the parsed mention count.
    //
    // Recipients are narrowed twice before they get here:
    //  1. In a private channel or a DM, only members are notified. A mention
    //     of an outsider would deliver a notification about a conversation
    //     they cannot open, on a link that 404s — and it would leak both the
    //     channel's name and a fragment of its contents to someone membership
    //     was supposed to exclude. Public channels skip this: anyone in the
    //     company can already read them.
    //  2. Anyone who muted the channel is dropped. `ChannelMember.mutedAt`
    //     means "still a member, no fan-out", and a mention is fan-out.
    // The stored + returned `mentionedUserIds` stays the full parsed list, so
    // the rendered body still highlights every name the author typed.

    // The preview BOTH fan-outs carry, hoisted so the mention ping and the DM
    // ping below cannot drift into quoting the same message differently.
    const truncated = body.length > 140 ? body.slice(0, 137) + "…" : body;

    let notifiedCount = 0;
    // The mention path's FINAL recipients — after the membership and mute
    // filters, NOT the parsed `mentionedUserIds`. Hoisted out of the block
    // because the DM fan-out has to subtract it: in a two-person conversation
    // an @mention and the DM itself are the same event, and someone who was
    // just mentioned in a DM should hear about it once, not twice. Subtracting
    // the parsed list instead would silence people the mention path had
    // already dropped (muted, or not a member), which is the opposite bug.
    let mentionRecipients: string[] = [];
    if (mentionedUserIds.length > 0) {
      let recipients = mentionedUserIds;
      if (channel.kind !== "public") {
        const members = await db.channelMember.findMany({
          where: { channelId, userId: { in: mentionedUserIds } },
          select: { userId: true },
        });
        const memberIds = new Set(members.map((m) => m.userId));
        recipients = recipients.filter((id) => memberIds.has(id));
      }
      if (recipients.length > 0) {
        const muted = await db.channelMember.findMany({
          where: { channelId, userId: { in: recipients }, mutedAt: { not: null } },
          select: { userId: true },
        });
        const mutedIds = new Set(muted.map((m) => m.userId));
        recipients = recipients.filter((id) => !mutedIds.has(id));
      }
      mentionRecipients = recipients;

      if (recipients.length > 0) {
        try {
          const { notified } = await notifyUsers({
            event: "mention",
            userIds: recipients,
            exclude: userId,
            companyId,
            // A DM has no "#", and its stored `Channel.name` is the static
            // both-names fallback openDmAction wrote — so the hash form reads
            // as "mentioned you in #Ayesha & Bilal" to Ayesha, naming her to
            // herself. The viewer-relative name is resolved at read time by
            // the query layer and is not in hand here; inside a two-person
            // conversation "a direct message" is unambiguous anyway.
            title:
              channel.kind === "dm"
                ? `${author.name} mentioned you in a direct message`
                : `${author.name} mentioned you in #${channel.name}`,
            message: truncated,
            // Chat is a people surface, not a money or task one. "team" is the
            // category a member is allowed to see; "finance" would be stripped
            // from members by lib/queries/notifications.ts.
            category: "team",
            link: `/chat/${channel.slug}?message=${created.id}`,
          });
          notifiedCount = notified;
        } catch (notifyErr) {
          captureServerError(notifyErr, {
            action: "sendMessageAction.fanout",
            companyId,
            userId,
            extra: { messageId: created.id, attempted: recipients.length },
          });
        }
      }
    }

    // ── DM fan-out, on the same terms as the mention fan-out ───────────────
    // Without this a direct message is SILENT. The only ping chat raises is
    // for @mentions, and nobody types "@bilal" in a conversation that has
    // exactly one other person in it — so the one place where a message is
    // unambiguously addressed at a named human was the one place nothing was
    // delivered. Addressing IS the event here: the channel is the mention.
    //
    // Own try/catch, outside the transaction, for the reason the mention
    // fan-out gives: a missing ping is recoverable, a missing message is not.
    if (channel.kind === "dm") {
      try {
        const alreadyPinged = new Set(mentionRecipients);
        // Membership is the recipient list — a DM's members ARE its audience,
        // so there is nothing to intersect the way the mention path has to.
        // `mutedAt: null` in the query rather than a second pass: same rule as
        // the mention path ("still a member, no fan-out"), one round trip.
        // Tombstoned accounts are excluded because the roster the mention path
        // parses against already excludes them, and a deactivated teammate
        // should not keep accruing notifications for a workspace they are out
        // of.
        const others = await db.channelMember.findMany({
          where: {
            channelId,
            userId: { not: userId },
            mutedAt: null,
            user: { deletedAt: null },
          },
          select: { userId: true },
        });
        const dmRecipients = others.map((m) => m.userId).filter((id) => !alreadyPinged.has(id));

        if (dmRecipients.length > 0) {
          const { notified } = await notifyUsers({
            event: "dm",
            userIds: dmRecipients,
            exclude: userId,
            companyId,
            // No "#" and no channel name: from the recipient's side the only
            // thing worth naming is who is talking to them.
            title: `${author.name} sent you a message`,
            message: truncated,
            // "team", like the mention ping — chat is a people surface, and
            // "finance" would be stripped from members downstream.
            category: "team",
            link: `/chat/${channel.slug}?message=${created.id}`,
          });
          // Added, not assigned: the returned count is "how many people this
          // message actually reached", and in a DM that was also an @mention
          // both paths can legitimately contribute.
          notifiedCount += notified;
        }
      } catch (notifyErr) {
        captureServerError(notifyErr, {
          action: "sendMessageAction.dmFanout",
          companyId,
          userId,
          extra: { messageId: created.id, channelId },
        });
      }
    }

    revalidatePath("/chat");
    revalidatePath(`/chat/${channel.slug}`);

    return { success: true, data: { id: created.id, mentionedUserIds, notifiedCount } };
  } catch (e) {
    captureServerError(e, { action: "sendMessageAction" });
    return { success: false, error: "Couldn't send that message right now." };
  }
}

/**
 * Create a public or private channel. The creator becomes its owner, which is
 * what lets them rename and archive it without a company role
 * (`canManageChannel`).
 *
 * No role gate: every member of the workspace can start a conversation.
 * Restricting channel creation to admins would make chat a broadcast channel
 * rather than a workplace, and the private kind already means a channel is
 * only as visible as its members list.
 *
 * DMs are not creatable here — `CREATABLE_CHANNEL_KINDS` in the schema
 * excludes them, because a DM without its second participant is a private
 * channel wearing a DM's unique key.
 */
export async function createChannelAction(input: unknown): Promise<ActionResult<{ slug: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewChannelSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid channel" };
  }
  const { name, kind, topic } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const base = slugifyChannelName(name);
    // Slugs are per-workspace, so only this company's are in the way. The
    // `startsWith` narrows to the collision family — "growth", "growth-2" —
    // instead of loading every channel in the workspace.
    const siblings = await db.channel.findMany({
      where: { companyId, slug: { startsWith: base } },
      select: { slug: true },
    });
    const slug = uniqueChannelSlug(
      base,
      siblings.map((s) => s.slug)
    );

    await db.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: {
          companyId,
          kind,
          slug,
          name,
          topic: topic ?? null,
          createdBy: userId,
        },
        select: { id: true },
      });
      // The creator's membership is what makes a private channel reachable by
      // anyone at all, so it belongs in the same transaction: a channel that
      // committed without its owner row would be invisible to everyone,
      // including the person who just made it, and unreachable forever.
      await tx.channelMember.create({
        data: { channelId: channel.id, userId, role: "owner" },
      });
    });

    revalidatePath("/chat");
    return { success: true, data: { slug } };
  } catch (e) {
    // The unique index — not the de-collision above — is the real guarantee,
    // and two people naming a channel the same thing in the same instant is
    // an ordinary race, not an incident. Answer it plainly instead of logging
    // it as a server error.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      return { success: false, error: "A channel with that name already exists." };
    }
    captureServerError(e, { action: "createChannelAction" });
    return { success: false, error: "Couldn't create the channel right now." };
  }
}

/**
 * Open the direct message between me and one teammate — creating it the first
 * time, finding it every time after.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the whole design. "Message Bilal" is
 * a navigation gesture, not a creation gesture: the person clicking it does not
 * know or care whether the conversation already exists, and it may be clicked
 * from the rail, from a profile, and from a teammate list within the same
 * minute. So the pair's identity is DERIVED rather than generated —
 * `dmKeyFor` sorts the two ids (see its header: unsorted keys fork a pair into
 * two half-conversations neither person can see the whole of), and
 * `dmSlugFor` spells that key as the URL. The same pair therefore resolves to
 * the same row and the same `/chat/<slug>` from either side, forever, with no
 * lookup table.
 *
 * Three layers keep it that way, deliberately overlapping: the lookup below
 * catches the ordinary case, `@@unique([companyId, dmKey])` catches the race
 * the lookup cannot, and the catch turns that collision back into a successful
 * open. Only the last one is a guarantee; the first is just the cheap path.
 *
 * No role gate — same reasoning as `createChannelAction`. Anyone in the
 * workspace can address anyone else in it; a DM nobody is allowed to start is
 * an org chart, not a chat product. Company scope is the only boundary, and it
 * is re-verified below rather than trusted from the payload.
 */
export async function openDmAction(input: unknown): Promise<ActionResult<{ slug: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = OpenDmSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Pick a teammate" };
  }
  const { userId: targetId } = parsed.data;
  const { id: userId, companyId } = session.user;

  // Note-to-self is a real feature in other products; it is out of scope here,
  // and refusing it plainly beats the alternative — `dmKeyFor(me, me)` folds to
  // a single id, which would create a ONE-member DM that `dmDisplayName`
  // reports as nameless and the rail has no story for.
  if (targetId === userId) {
    return { success: false, error: "You can't start a conversation with yourself" };
  }

  // Derived before the try only so the P2002 catch can re-read by the same key
  // (a `const` inside the try would be out of scope there). Pure string work
  // over ids that have already passed `safeParse` — it writes nothing, and the
  // company-scoped load below is still what authorises everything that does.
  const dmKey = dmKeyFor(userId, targetId);
  const slug = dmSlugFor(dmKey);

  try {
    // Re-verification, the step of the house template this action exists to
    // get right: `targetId` arrives from the client and nothing before this
    // line has established that it belongs to THIS workspace. `companyId` plus
    // `deletedAt: null` means a stranger's id, a tombstoned colleague's id and
    // a hand-typed cuid all produce the identical answer, so the failure
    // cannot be read as a membership oracle for other companies.
    //
    // My own row is loaded the same way (not taken from the session) because
    // the DM's fallback name is built from both names, and a name read from a
    // token minted before a rename would be stored permanently.
    const [me, them] = await Promise.all([
      db.user.findFirst({
        where: { id: userId, companyId, deletedAt: null },
        select: { id: true, name: true },
      }),
      db.user.findFirst({
        where: { id: targetId, companyId, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    if (!me) return { success: false, error: "User no longer exists" };
    if (!them) return { success: false, error: "That teammate is no longer here" };

    // The cheap path: the pair almost always already has a conversation, and
    // re-opening it must write NOTHING — no second row, no fresh `createdAt`,
    // no membership churn that would reset either side's read watermark.
    const existing = await db.channel.findFirst({
      where: { companyId, dmKey },
      select: { slug: true },
    });
    // Its stored slug, not the derived one: they agree today, and if some older
    // row ever disagreed, the truth is what the router can actually resolve.
    // Nothing changed, so there is nothing to revalidate either.
    if (existing) return { success: true, data: { slug: existing.slug } };

    await db.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: {
          companyId,
          kind: "dm",
          slug,
          // A STATIC fallback only. The rail and the channel header render the
          // viewer-relative name that the query layer resolves through
          // `dmDisplayName`, because the right label for a DM depends on who
          // is looking — Bilal should not open a conversation titled "Bilal".
          // This value is what is left when there is nobody else to name.
          name: `${me.name} & ${them.name}`,
          dmKey,
          createdBy: userId,
        },
        select: { id: true },
      });
      // Both membership rows belong in the same transaction as the channel,
      // for a sharper version of `createChannelAction`'s reason: a DM is
      // membership-only (`canSeeChannel`), so one that committed without them
      // would be unreachable by EITHER participant forever — and the unique
      // dmKey would then block every later attempt to open it properly.
      //
      // Both sides are "member", never "owner": `canManageChannel` hands an
      // owner archive and rename rights, and neither half of a two-person
      // conversation should be able to close the other one out of it
      // unilaterally.
      await tx.channelMember.createMany({
        data: [
          { channelId: channel.id, userId, role: "member" },
          { channelId: channel.id, userId: targetId, role: "member" },
        ],
      });
    });

    revalidatePath("/chat");
    return { success: true, data: { slug } };
  } catch (e) {
    // P2002 here is SUCCESS, not failure. Two people clicking "message Bilal"
    // in the same instant is an ordinary race, and the unique index rejecting
    // the loser is the index doing precisely the job it was added for: one
    // conversation per pair. Surfacing an error would tell the loser their
    // message failed while their own DM sat there waiting — so re-read by the
    // key the winner just committed and hand back the same conversation. That
    // is the anti-fork guarantee, end to end: both clicks land in one room.
    //
    // Either unique index can be the one that fires (`companyId, dmKey` or
    // `companyId, slug`) because both values are derived from the same pair;
    // re-reading by dmKey answers both.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      const raced = await db.channel.findFirst({
        where: { companyId, dmKey },
        select: { slug: true },
      });
      if (raced) {
        // Unlike the cheap path above, this row appeared DURING this request,
        // so this request's view of /chat can already be stale. Revalidate.
        revalidatePath("/chat");
        return { success: true, data: { slug: raced.slug } };
      }
      // A P2002 with no row behind it is not the race — fall through and
      // report it rather than inventing a conversation that is not there.
    }
    captureServerError(e, { action: "openDmAction", companyId, userId });
    return { success: false, error: "Couldn't open that conversation right now." };
  }
}

/**
 * Add or remove one of my reactions. `@@unique([messageId, userId, emoji])`
 * makes this a create-or-delete rather than a counter, so a double-click
 * cannot leave a message with 2 of my 👍 and nothing to subtract them with.
 *
 * Reacting is posting: the same `canPostInChannel` gate applies, which means
 * an archived channel's reaction rail is frozen along with its composer.
 */
export async function toggleReactionAction(
  input: unknown
): Promise<ActionResult<{ reacted: boolean }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ToggleReactionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid reaction" };
  }
  const { messageId, emoji } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const message = await db.message.findFirst({
      where: { id: messageId, companyId },
      select: { id: true, channelId: true, deletedAt: true },
    });
    if (!message) return { success: false, error: "That message is no longer here" };
    if (message.deletedAt) {
      return { success: false, error: "You can't react to a deleted message." };
    }

    const channel = await loadChannelContext(message.channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canPostInChannel(channel)) {
      return {
        success: false,
        error: channel.archivedAt
          ? "This channel is archived — nobody can react in it."
          : "You do not have access to this channel",
      };
    }

    const reacted = await db.$transaction(async (tx) => {
      const existing = await tx.messageReaction.findUnique({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
        select: { id: true },
      });
      if (existing) {
        await tx.messageReaction.delete({ where: { id: existing.id } });
        return false;
      }
      await tx.messageReaction.create({ data: { messageId, userId, emoji } });
      return true;
    });

    revalidatePath(`/chat/${channel.slug}`);
    return { success: true, data: { reacted } };
  } catch (e) {
    captureServerError(e, { action: "toggleReactionAction" });
    return { success: false, error: "Couldn't update that reaction right now." };
  }
}

/**
 * Tombstone a message. Never a hard delete: replies keep their parent, the
 * thread still reads in order, and the UI renders "message deleted" where the
 * text used to be. `lib/queries/chat.ts` blanks the body on the way out, so
 * the deleted text stops reaching the client immediately.
 *
 * TWO gates, composed, because neither implies the other: channel visibility
 * first (an admin has no back door into a private channel they are not in —
 * see canSeeChannel's header), then `canDeleteMessage` for the author-or-
 * moderator rule.
 */
export async function deleteMessageAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DeleteMessageSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { messageId } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    const message = await db.message.findFirst({
      where: { id: messageId, companyId },
      select: {
        id: true,
        channelId: true,
        authorId: true,
        parentId: true,
        deletedAt: true,
      },
    });
    if (!message) return { success: false, error: "That message is no longer here" };
    // Already a tombstone: succeed rather than erroring, so a double-submit
    // or a retry from an offline queue is a no-op instead of a scary toast.
    if (message.deletedAt) return { success: true, data: undefined };

    const channel = await loadChannelContext(message.channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canSeeChannel(channel)) {
      return { success: false, error: "You do not have access to this channel" };
    }
    if (!canDeleteMessage({ userId, role: role as Role, authorId: message.authorId })) {
      return { success: false, error: "Only the author or an admin can delete this message" };
    }

    await db.$transaction(async (tx) => {
      await tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date() },
      });
      // `Message.replyCount` counts LIVE replies — the schema says the delete
      // path maintains it. The tombstone still renders inside the thread for
      // continuity, so a thread can legitimately show more rows than its
      // count; the count is "how much is left to read", not "how many rows".
      // Floor at 0 so a double-decrement from a legacy row can't go negative.
      if (message.parentId) {
        const parent = await tx.message.findUnique({
          where: { id: message.parentId },
          select: { replyCount: true },
        });
        if (parent && parent.replyCount > 0) {
          await tx.message.update({
            where: { id: message.parentId },
            data: { replyCount: { decrement: 1 } },
          });
        }
      }
    });

    revalidatePath(`/chat/${channel.slug}`);
    revalidatePath("/chat");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteMessageAction" });
    return { success: false, error: "Couldn't delete that message right now." };
  }
}

/**
 * Move my read watermark to now.
 *
 * DELIBERATELY NOT RATE LIMITED. This fires on every channel open and every
 * scroll-to-bottom — the most frequent write in the product by an order of
 * magnitude. Under `limiters.write` (60/min, shared across ALL writes by that
 * user) a few minutes of ordinary channel-hopping would burn the budget and
 * the next thing to be rejected would be the user's actual message. The
 * resulting bug report is "sometimes my messages won't send, but only when
 * I'm busy", which is close to undiagnosable from the outside: the failure
 * lands on a different action from the one that caused it, and it never
 * reproduces on a quiet account.
 *
 * The write it guards is a single UPDATE of two columns on a row the caller
 * already owns, with no fan-out and no cascade, so there is nothing here
 * worth protecting at the cost of that failure mode. The generic abuse
 * protection is still upstream: a session is required, and the row must
 * already exist.
 */
export async function markChannelReadAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = MarkChannelReadSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { channelId } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const channel = await loadChannelContext(channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canSeeChannel(channel)) {
      return { success: false, error: "You do not have access to this channel" };
    }

    // No membership row → nothing to mark. Reading a public channel you never
    // joined does NOT silently join you: membership is what turns the unread
    // badge on, and auto-joining on open would subscribe people to every room
    // they ever glanced at. An upsert here would look harmless and do exactly
    // that.
    if (!channel.isMember) return { success: true, data: undefined };

    // Record WHICH message was read as well as when. lastReadAt is the
    // authoritative comparison for the badge (see the schema comment); the id
    // is for the "new messages" divider, which needs an anchor rather than a
    // timestamp.
    const newest = await db.message.findFirst({
      where: { channelId, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });

    await db.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { lastReadAt: new Date(), lastReadMessageId: newest?.id ?? null },
    });

    revalidatePath("/chat");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "markChannelReadAction" });
    return { success: false, error: "Couldn't update your read position right now." };
  }
}

/**
 * The plain-text `body` stored on every Runway card. FIXED, and deliberately
 * FIGURE-FREE.
 *
 * `body` is NOT redacted. `toMessageClient` in lib/queries/chat.ts blanks it
 * only for a tombstone; for a live message it ships verbatim to every viewer
 * who can see the channel, members included, while the payload beside it is
 * stripped field by field. So a single number in this string walks straight
 * around the entire redaction layer — the card frame would say "hidden" while
 * the line above it quoted the balance. The same applies to anything derived
 * from it: the DM fan-out below quotes this constant as its preview, and a
 * notification body is the one place a figure leaves the app altogether, into
 * an email and a push payload on a lock screen.
 *
 * WHY NOT the empty string, the obvious spelling of "cards have no text":
 *   1. `Message.searchVector` is a Postgres generated column over `body`
 *      alone. An empty body makes a card permanently unfindable; this one
 *      makes it findable by the word "runway" without indexing a figure.
 *   2. The DM ping quotes it, and a notification with a blank preview reads
 *      as broken rather than as terse.
 *   3. Any reader that does not know `kind: "card"` — a stale client bundle,
 *      a future export, a plain-text digest — falls back to `body` and gets a
 *      true sentence instead of a blank line.
 * Third-person, because every surface that renders it already has the
 * author's name beside it: "Sara — shared a runway snapshot".
 */
const RUNWAY_CARD_BODY = "shared a runway snapshot";

/** The three figures a card carries, in the payload's own vocabulary. */
type RunwayFigures = Pick<RunwayPayload, "cashOnHand" | "monthlyBurn" | "runwayMonths">;

/**
 * The dashboard's runway arithmetic, over the dashboard's own rows.
 *
 * MIRRORS app/(app)/dashboard/dashboard-client.tsx:78-91 line for line, and
 * the mirroring is load-bearing: a card quoting a second, independently
 * derived runway would let /chat and /dashboard disagree about the same word
 * on the same afternoon, with no way to tell from the outside which one was
 * lying. That is a worse bug than shipping no card at all.
 *
 * Hence the input is whatever `getTransactions()` returns, NOT a Prisma
 * aggregate. A `groupBy` would be cheaper and would also drift on the first
 * workspace to cross that query's MAX_TRANSACTIONS ceiling — the dashboard
 * sums the capped 5,000 most recent rows, an aggregate would sum all of them,
 * and the two numbers would part company silently on exactly the accounts
 * busy enough to care. Sharing the query means the card is wrong in the same
 * direction, by the same amount, on the same day, and one fix corrects both.
 *
 * `now` is a PARAMETER rather than a second `new Date()` so the three-month
 * cutoff and the `asOf` stamp on the stored card are the same instant. The
 * dashboard reads the clock twice and gets away with it because nothing
 * persists; here the snapshot claims a moment, and a burn window measured a
 * few milliseconds either side of the moment it is labelled with would be a
 * small, permanent lie in a row that is never recomputed.
 *
 * `runwayMonths` is null, not Infinity, when nothing has been spent —
 * `RunwayPayloadSchema` carries the reasoning (JSON has no Infinity, and
 * `.finite()` would reject it anyway). It means "no burn recorded".
 *
 * TODO(finance): when the dashboard moves off its client-side reduction,
 * hoist this into a shared pure helper under lib/finance/ and have both call
 * it, so the mirroring stops depending on somebody reading this comment. Both
 * call sites have to move in the same commit — a helper adopted by only one
 * of them is precisely the drift this function exists to prevent.
 */
function runwayFigures(
  transactions: { type: string; amount: number; date: string }[],
  now: Date
): RunwayFigures {
  const cutoff = subMonths(now, 3);
  let investments = 0;
  let revenue = 0;
  let expenses = 0;
  let last3MoExpenses = 0;

  // One pass instead of the dashboard's four `.filter().reduce()` chains. The
  // three types are disjoint, so this ladder sums exactly what those chains
  // sum; only the number of walks over the array differs.
  for (const t of transactions) {
    if (t.type === "investment") {
      investments += t.amount;
    } else if (t.type === "income") {
      revenue += t.amount;
    } else if (t.type === "expense") {
      expenses += t.amount;
      if (new Date(t.date) >= cutoff) last3MoExpenses += t.amount;
    }
  }

  const cashOnHand = investments + revenue - expenses;
  const monthlyBurn = last3MoExpenses / 3;
  return {
    cashOnHand,
    monthlyBurn,
    // The dashboard's `Infinity`, spelled the way JSON can carry it.
    runwayMonths: monthlyBurn > 0 ? cashOnHand / monthlyBurn : null,
  };
}

/**
 * Post a Runway card — the workspace's cash on hand, monthly burn and months
 * of runway — into a channel, as a SNAPSHOT frozen at this instant.
 *
 * ── TWO GATES, COMPOSED ───────────────────────────────────────────────────
 * `canPostRunwayCard(role)` answers "may you disclose money";
 * `canPostInChannel(channel)` answers "may you write here". Neither implies
 * the other in either direction: an admin still cannot post into an archived
 * channel or a private one they were never invited to, and a member who owns
 * a channel still cannot publish the balance in it. Both must pass — exactly
 * like `canSeeChannel` + `canDeleteMessage` in deleteMessageAction above.
 *
 * The role gate runs second overall and first of the two — before the rate
 * limit, before the channel lookup, before a single figure is read out of the
 * database. That ordering is the house 7-step template (auth → pure predicate
 * → rate limit → parse → re-verify → transaction → revalidate); it differs
 * from `sendMessageAction`'s only because that action has no role-only
 * predicate to run. Assembling the cash position first and discarding it on a
 * denial would mean the number had been computed inside a request the caller
 * was never entitled to make.
 *
 * ── THE FIGURES ARE COMPUTED HERE, NEVER SUPPLIED ─────────────────────────
 * `PostRunwayCardSchema` accepts a channelId and nothing else, and its header
 * says why: a schema that took the numbers would let any client publish any
 * numbers it liked, over the company's name, into a room the whole team
 * reads. Every figure below is derived from the caller's OWN `companyId`,
 * through the same query the dashboard uses.
 *
 * ── WHY `asOf` EXISTS ─────────────────────────────────────────────────────
 * The landing page labels this card "Runway · live". A stored snapshot is not
 * live, and the rebuild plan names that as something the product says but
 * does not do. The card never recomputes on read (see the Runway section
 * header in lib/schemas/chat.ts), so `asOf` is the one field that makes it
 * honest: it records what the runway looked like when somebody put it in
 * front of the room — the thing actually worth keeping — and says so on its
 * face rather than implying a freshness it does not have.
 *
 * ── THE PAYLOAD IS PARSED BEFORE IT IS STORED ─────────────────────────────
 * `RunwayPayloadSchema.parse` (throwing, not `safeParse`) runs on the way IN.
 * A payload that cannot be parsed is dropped silently on the way OUT by
 * `toCardFields`, for every viewer, forever — so validating only on read
 * turns one bad write into an unreadable card sitting in a channel with no
 * error anywhere and nothing to point at. Failing here makes it one failed
 * click plus a Sentry event: a bug report rather than a mystery.
 *
 * Returns the new message's id and NOTHING ELSE — deliberately not the
 * figures. The client re-reads through `getMessagesPage`, which is where the
 * per-viewer redaction lives. Handing the numbers back for an optimistic
 * render would hand them to whoever called the action, and the author is not
 * always the only person whose browser ends up holding the result.
 */
export async function postRunwayCardAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  // (1) Authenticate. `auth()` rather than `requireScopedSession()` — the
  // latter throws, and every sibling in this file answers a missing session
  // with a result the caller can render instead of an exception the error
  // boundary has to catch.
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const { id: userId, companyId, role } = session.user;

  // (2) The pure predicate, before anything is read or written. Phrased
  // without naming roles: `canPostRunwayCard` delegates to `canSeeFinances`,
  // and a message listing "admin and cofounder" would be a second copy of
  // that list, stale the day a finance-capable role is added.
  if (!canPostRunwayCard(role as Role)) {
    return {
      success: false,
      error: "Only people who can see the company's finances can share the runway.",
    };
  }

  // (3) Rate limit.
  const gate = limiters.write.consume(userId);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  // (4) Parse.
  const parsed = PostRunwayCardSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Pick a channel" };
  }
  const { channelId } = parsed.data;

  try {
    // (5) Re-verify the client-supplied channelId against the caller's own
    // companyId, then the second gate. Same collapse of two template steps
    // into one lookup that `sendMessageAction` documents: the predicate needs
    // facts, and fetching them IS the re-verification.
    const channel = await loadChannelContext(channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canPostInChannel(channel)) {
      return {
        success: false,
        error: channel.archivedAt
          ? "This channel is archived — nobody can post in it."
          : "You do not have access to this channel",
      };
    }

    // (6) Compute. One clock read for the whole snapshot — see runwayFigures.
    const now = new Date();
    const [author, company, transactions] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { name: true, avatar: true } }),
      // `deletedAt: null`, like every scoped read in the codebase: a
      // tombstoned workspace does not get to publish its balance into its own
      // chat on the strength of a session minted before the delete.
      db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { currency: true },
      }),
      // Company-scoped internally, from this same session — the caller cannot
      // name a workspace — and it is the dashboard's own query.
      getTransactions(),
    ]);
    if (!author) return { success: false, error: "User no longer exists" };
    if (!company) return { success: false, error: "Workspace not found" };

    // Parsed on the way in, so a malformed card can never reach the column.
    const payload = RunwayPayloadSchema.parse({
      v: RUNWAY_CARD_VERSION,
      type: "runway",
      asOf: now.toISOString(),
      // The workspace's chosen currency, never a client's idea of it and
      // never a hardcoded default — `formatCurrency` would otherwise print a
      // PKR balance with a dollar sign in front of it.
      currency: company.currency,
      ...runwayFigures(transactions, now),
    });

    const created = await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          companyId,
          channelId,
          authorId: userId,
          authorName: author.name,
          authorAvatar: author.avatar,
          kind: "card",
          body: RUNWAY_CARD_BODY,
          payload: JSON.stringify(payload),
          // A card is always a channel root. `PostRunwayCardSchema` carries no
          // parentId on purpose — threading a snapshot into somebody else's
          // conversation is a product decision nobody has taken.
          parentId: null,
          // Nothing here is authored text, so there is nothing to parse
          // mentions out of and nobody to ping by name.
          mentions: "[]",
        },
        select: { id: true, createdAt: true },
      });

      // Same reasoning as the send path: inside the transaction so the rail
      // can never sort by a timestamp whose message rolled back. No
      // replyCount bump — a card has no parent.
      await tx.channel.update({
        where: { id: channelId },
        data: { lastMessageAt: message.createdAt },
      });

      return message;
    });

    // ── Notifications: NO channel-wide ping ───────────────────────────────
    // The case FOR one is real and worth stating. A runway snapshot is not
    // small talk: it is posted precisely because the author wants the room to
    // look at it, it is rare enough that the volume argument that keeps
    // ordinary messages out of /activities does not apply, and an unread
    // badge is a weak signal for the one message in a channel that might
    // change what the team does this week.
    //
    // It loses anyway, on four counts:
    //   1. There is no `runway_card` in NOTIFY_EVENTS, so there would be no
    //      row for it in the preferences matrix and therefore no way to turn
    //      it off. A ping with no switch is a ping people learn to ignore,
    //      and it takes the switchable ones down with it. Adding the event is
    //      a deliberate edit to lib/notify/events.ts + EVENT_COPY, not
    //      something to smuggle in from here.
    //   2. Every fan-out chat has today is ADDRESSED — a mention names you, a
    //      DM is sent to you. "Everyone in this room" would be the product's
    //      first broadcast notification, and in a 30-person public channel it
    //      is 29 pings from one click.
    //   3. Most of those 29 are members, who receive the REDACTED card. A
    //      notification inviting somebody to go and look at figures they are
    //      not allowed to read is worse than silence.
    //   4. Whatever the ping quoted would have to stay figure-free forever,
    //      which is one more place the redaction can be walked around by
    //      somebody making the copy more useful.
    //
    // The DM case below is the exception, and it is not a broadcast: a DM has
    // exactly one recipient and addressing IS the event there, which is the
    // whole reason sendMessageAction grew a DM fan-out at all. Posting a card
    // into a DM and staying silent would re-open that same hole for the one
    // message type most likely to be sent to a single cofounder on purpose.
    // Mirrors that path deliberately — same mute and tombstone filters, same
    // copy — and quotes the figure-free constant as its preview.
    //
    // Outside the transaction, in its own try/catch: a missing ping is
    // recoverable, a missing message is not.
    if (channel.kind === "dm") {
      try {
        const others = await db.channelMember.findMany({
          where: {
            channelId,
            userId: { not: userId },
            mutedAt: null,
            user: { deletedAt: null },
          },
          select: { userId: true },
        });
        if (others.length > 0) {
          await notifyUsers({
            event: "dm",
            userIds: others.map((m) => m.userId),
            exclude: userId,
            companyId,
            title: `${author.name} sent you a message`,
            message: RUNWAY_CARD_BODY,
            // "team", not "finance", for the reason the send path gives: chat
            // is a people surface, and lib/queries/notifications.ts strips
            // "finance" rows from members — who can legitimately receive this
            // notification, because the card they open will be redacted.
            category: "team",
            link: `/chat/${channel.slug}?message=${created.id}`,
          });
        }
      } catch (notifyErr) {
        captureServerError(notifyErr, {
          action: "postRunwayCardAction.dmFanout",
          companyId,
          userId,
          extra: { messageId: created.id, channelId },
        });
      }
    }

    // (7) Revalidate both paths: the rail's ordering just changed too.
    revalidatePath("/chat");
    revalidatePath(`/chat/${channel.slug}`);

    return { success: true, data: { id: created.id } };
  } catch (e) {
    captureServerError(e, { action: "postRunwayCardAction", companyId, userId });
    return { success: false, error: "Couldn't post that runway card right now." };
  }
}
