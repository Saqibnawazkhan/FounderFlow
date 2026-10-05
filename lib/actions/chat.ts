"use server";

/**
 * Chat server actions: send, create channel, open a DM, react, delete, mark
 * read, mute, post a Runway card.
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

import { z } from "zod";
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
  SetChannelMuteSchema,
  ToggleReactionSchema,
  MarkChannelReadSchema,
  DeleteMessageSchema,
  type RunwayPayload,
} from "@/lib/schemas/chat";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import {
  canDeleteMessage,
  canManageChannel,
  canPostInChannel,
  canPostRunwayCard,
  canSeeChannel,
  dmKeyFor,
} from "@/lib/auth/channel-permissions";
import { getLedgerStart, getTransactionTotals } from "@/lib/queries/transactions";
import { unreadChatTotal } from "@/lib/queries/chat";
// The runway card's burn / runway arithmetic, shared with /dashboard's Balance
// card so the two surfaces cannot quote different runways (money-017).
import { averageMonthlyBurn, burnWindowStart, runwayMonths } from "@/lib/finance/runway";
import { extractMentions } from "@/lib/comments/mentions";
import { slugifyChannelName, uniqueChannelSlug } from "@/lib/chat/slug";
import { conversationTitle, dmSlugFor } from "@/lib/chat/dm";
import type { Role } from "@/lib/auth/role-gates";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/**
 * The payload of `addChannelMembersAction`.
 *
 * LOCAL, unlike every other chat schema, and the same shape of decision
 * `lib/actions/appearance.ts` already makes: lib/schemas/chat.ts exists so a
 * FORM and its action validate identically through `zodResolver`, and this
 * payload has no form — the picker sends a list of ids it was handed by the
 * server. Move it there the day a client wants to pre-validate it.
 *
 * Ids are `min(1).max(64)` rather than `.cuid()`, for the reason that file's
 * `IdField` comment gives at length: this system mints at least three id shapes
 * (`cuid()`, the chat migration's `chmem_…`, and the seed's `demo-ahmed`) and
 * asserting cuid once broke every DM in the demo workspace. Well-formed is not
 * authorised; the action re-verifies each id against its own companyId.
 *
 * Capped at 50 per call: a workspace-sized invite is a legitimate gesture
 * ("add the whole team"), an unbounded array is a way to make one request write
 * a million rows.
 */
const AddChannelMembersSchema = z.object({
  channelId: z.string().trim().min(1, "Pick a channel").max(64, "Pick a channel"),
  userIds: z
    .array(z.string().trim().min(1, "Pick a teammate").max(64, "Pick a teammate"))
    .min(1, "Pick at least one teammate")
    .max(50, "Add up to 50 people at a time"),
});

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
  /**
   * The caller's own read watermark, as a message id (chat-014).
   *
   * Carried so `markChannelReadAction` can tell "the reader has seen the newest
   * message" from "the reader has just caught up", and skip the UPDATE plus two
   * `revalidatePath` calls in the first case. It rides along on the membership
   * row this function already selects, so it costs no round trip. Null for a
   * non-member, and for a member who has never read anything here.
   */
  lastReadMessageId: string | null;
  /**
   * The denormalized recency `sendMessageAction` maintains. Carried here so
   * `pollChannelActivityAction` is ONE query — the liveness probe runs every
   * few seconds per open tab, and a second round trip to fetch a single
   * timestamp is exactly the cost that probe exists to avoid. Every other
   * caller ignores it.
   */
  lastMessageAt: Date | null;
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
      lastMessageAt: true,
      members: {
        where: { userId },
        select: { role: true, mutedAt: true, lastReadMessageId: true },
      },
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
    // `?? null` rather than passing `undefined` through: this value is compared
    // against "the newest message id, or null for an empty channel", and
    // `undefined === null` is false — an absent column would read as "the
    // watermark moved" every single time.
    lastReadMessageId: mine?.lastReadMessageId ?? null,
    lastMessageAt: channel.lastMessageAt,
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
    /**
     * How many distinct people the fan-out SENT something to — in chat, that
     * means an in-app row or a push, never an email: neither `chat_mention` nor
     * `dm` is deliverable by email (lib/notify/events.ts), which is the
     * chat-volume fix of 2026-10-05.
     * Dispatch, not delivery: a push to an unsubscribed device counts, because
     * nothing synchronous can know otherwise (see `dispatched` in
     * lib/notify/fan-out.ts). Lower than `mentionedUserIds` when someone muted the
     * channel, is not in it, has the event switched off on every channel, or
     * the fan-out threw.
     *
     * NOT the in-app row count, which is what this was until the DM fan-out
     * stopped writing rows: an ordinary message now announces itself on the
     * sidebar's Chat badge instead of under the bell. @mentions still write a
     * row (they name a person; a badge cannot), so this number is a mix of both
     * and the row count alone would under-report it. It reports the fan-out's
     * `dispatched` — see the composer, which turns this into "pinged N".
     */
    notifiedCount: number;
    /**
     * How many people the mention fan-out was actually ASKED to notify —
     * `mentionedUserIds` AFTER the membership and mute filters (chat-005).
     *
     * The composer needs the difference between this and `mentionedUserIds` to
     * tell a delivery failure from a deliberate suppression. It had only the
     * parsed list, so in a private channel — where the membership filter empties
     * the recipients — every @-mention drew "couldn't send mention pings (1
     * attempted)" over a send in which nothing was attempted and nothing failed.
     */
    mentionAttempted: number;
    /**
     * Did the mention fan-out THROW, and get reported to Sentry? (chat-005)
     *
     * A count cannot answer this. `notifyUsers` returns `notified: 0` without
     * throwing whenever every recipient has in-app notifications switched off —
     * they may well have had a push or an email — so `notifiedCount === 0` does
     * not imply an incident. The composer's warning claims "The team has been
     * notified", and the only thing that makes that sentence true is the
     * `captureServerError` in the fan-out's catch. This flag is set in the same
     * place, so the copy cannot outlive the report.
     *
     * Scoped to the MENTION fan-out, not the DM one: the toast this feeds says
     * "mention pings". A DM fan-out failure is still captured for on-call, and
     * still leaves the message itself delivered.
     */
    mentionPingsFailed: boolean;
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
      // `handle: true` IS LOAD-BEARING (finding tasks-and-comments-001). It
      // was missing, and `MentionUser.handle` is optional in the TYPE, so this
      // compiled and failed silently: pass 1 of `buildMentionIndex` indexed
      // nothing, `@ali` resolved to nobody, `mentions` was stored as "[]" and
      // zero notifications fanned out. For a teammate whose display name
      // carries no ASCII letters the handle is their ONLY address, so they
      // could not be mentioned at all.
      //
      // CORRECTION to what this comment said when it was first written: it
      // claimed lib/queries/chat.ts "DOES select handle", so that a chat
      // mention rendered a chip while notifying nobody. That was wrong.
      // `loadRoster` there used to select `{ id, name }`, so for a while CHAT's
      // render path was handle-blind too and fixing this select alone INVERTED
      // the asymmetry rather than closing it: the notification fired and the
      // `@ali` token still rendered as plain text. Both halves are now in place —
      // lib/queries/chat.ts adds `handle` to that select — so the parser and the
      // renderer see the same roster. (Comments were never in that state:
      // lib/queries/comments.ts:170 does select handle, which is why the finding
      // was spotted from the chip.)
      //
      // tests/lib/comments/mention-roster.test.ts pins this select and sweeps
      // every other whole-company roster that feeds the parser; it is red on
      // lib/queries/chat.ts by design until that line lands.
      db.user.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true, name: true, handle: true },
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
    // Set in the mention fan-out's catch, beside the `captureServerError` that
    // makes "The team has been notified" a true sentence. See
    // `mentionPingsFailed` on the return type.
    let mentionPingsFailed = false;
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
          const { dispatched } = await notifyUsers({
            // `chat_mention`, NOT `mention`, and the distinction is the fix for
            // the owner's report of 2026-10-05: "each chat message gets emailed
            // too […] a user in a busy channel will receive 100s of emails just
            // from chat."
            //
            // This site used to raise `mention`, which is deliverable on all
            // three channels and defaults to email ON — correctly, for the
            // OTHER site that raises it (`createCommentAction`, a mention in a
            // comment on a task or a money row, where an email is the point of
            // the feature). The two gestures are identical and their volumes
            // are not: a comment mention is occasional, a chat mention arrives
            // as fast as someone types. Dropping email from `mention` to fix
            // chat would have silenced a teammate tagged in a task comment,
            // which nobody asked for, so chat got its own event instead —
            // deliverable on in-app and push only (lib/notify/events.ts), with
            // email refused by `notifyUsers` rather than merely defaulted off.
            //
            // Keep this value and `createCommentAction`'s apart. The structural
            // test tests/lib/notify/fan-out-sites.test.ts fails if chat raises
            // `mention` again, or if comments raise `chat_mention`.
            event: "chat_mention",
            // NO `skipInApp` here, deliberately, and this is the one place in
            // chat that still writes a notification row.
            //
            // The DM path below suppresses it, because ordinary conversation
            // belongs on the Chat badge and not in a list beside budget alerts
            // and role changes. An @mention is a different event: it names one
            // person and waits for them. The badge cannot carry that — it says
            // "3 unread" whether those three messages named you or not — so
            // suppressing this one too would leave someone whose only enabled
            // channel is in-app with no way to learn they had been addressed.
            // The durable row is the only surface that distinguishes being
            // named from being present.
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
                : // `conversationTitle`, not `#${name}`: a hash in this product
                  // means "a room other people can be in", and this line was
                  // telling a member of a PRIVATE channel they were mentioned in
                  // "#pvt-hiring" while every icon beside that name is a Lock.
                  `${author.name} mentioned you in ${conversationTitle(channel.kind, channel.name)}`,
            message: truncated,
            // Chat is a people surface, not a money or task one. "team" is the
            // category a member is allowed to see; "finance" would be stripped
            // from members by lib/queries/notifications.ts.
            category: "team",
            link: `/chat/${channel.slug}?message=${created.id}`,
          });
          // `dispatched`, not `notified`: with the in-app row suppressed, the
          // number of ROWS WRITTEN is now always zero, and reporting that to
          // the composer would have every successful mention draw "pinged 0".
          // `dispatched` counts distinct people this call SENT to — see its
          // definition in lib/notify/fan-out.ts for why that is dispatch and
          // not delivery, and why no synchronous number here could be delivery.
          notifiedCount = dispatched;
        } catch (notifyErr) {
          mentionPingsFailed = true;
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
          const { dispatched } = await notifyUsers({
            event: "dm",
            // THE SITE THE CHANGE WAS REPORTED FOR: every DM wrote a
            // notification row, so a two-line exchange put two entries under
            // the bell and nothing at all next to the word "Chat". Unlike the
            // mention path above, nothing here needs a durable row — a DM's
            // unread count IS the fact that someone messaged you, and the Chat
            // badge carries it.
            skipInApp: true,
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
          // message was sent to", and in a DM that was also an @mention both
          // paths can legitimately contribute.
          notifiedCount += dispatched;
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

    return {
      success: true,
      data: {
        id: created.id,
        mentionedUserIds,
        notifiedCount,
        mentionAttempted: mentionRecipients.length,
        mentionPingsFailed,
      },
    };
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
 * How many unread chat messages the caller has, in total.
 *
 * Exists because the sidebar is a client component and cannot call a query
 * module directly. It is a thin pass-through to `unreadChatTotal()`, which
 * owns the counting rules — a second copy of "what counts as unread" is how
 * the nav badge and the channel rail would come to disagree.
 *
 * DELIBERATELY NOT RATE LIMITED, for the reason `markChannelReadAction` gives
 * below at greater length: this is a 30-second poll in every open tab, and
 * putting it under `limiters.write` (shared across all of a user's writes)
 * would make the badge's own polling reject the user's next real message. It
 * is two indexed reads and returns one integer.
 */
export async function unreadChatCountAction(): Promise<ActionResult<{ count: number }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  try {
    const count = await unreadChatTotal();
    return { success: true, data: { count } };
  } catch (e) {
    captureServerError(e, { action: "unreadChatCountAction" });
    // A failed poll must not surface as a toast — the sidebar simply keeps the
    // number it has and tries again in thirty seconds.
    return { success: false, error: "Couldn't read your unread count right now." };
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
 *
 * ── chat-014: AND IT IS BOUNDED BY DOING LESS, NOT BY BEING PRICED ────────
 *
 * The finding asked for `limiters.read` instead of nothing. That would have
 * been the wrong budget as well as the wrong shape: `limiters.read` is
 * 120/min/user and is ALREADY carrying `pollChannelActivityAction` (a tick
 * every five seconds per open tab) and the command palette. Exhausting it does
 * not fail loudly — the liveness probe swallows its own errors on purpose, so
 * the symptom would be "chat stops updating sometimes", which is the exact
 * class of undiagnosable bug the paragraph above is written to avoid.
 *
 * So the cost is removed rather than rationed, in two places:
 *   • HERE: if the watermark would not move — the caller is not a member, or
 *     `lastReadMessageId` is already the newest message — nothing is written
 *     and NEITHER path is revalidated. That is the whole of the amplification
 *     the finding is about: two `revalidatePath` calls on a shared tag per
 *     scroll-to-bottom.
 *   • IN THE CLIENT: <MessageList> sends one receipt per watermark rather than
 *     one per transition into the at-bottom state, so the repeat calls mostly
 *     never happen at all. The guard here is for every OTHER caller — a second
 *     tab, an older client, anything that posts the endpoint directly.
 *
 * `moved` is returned for the client's sake and is not a courtesy: the
 * `ff-chat-read` event makes the sidebar's Chat badge refetch its total, and
 * firing it after a no-op spent a round trip to learn nothing (audit row A54,
 * where the non-member branch reported a bare success).
 */
export async function markChannelReadAction(
  input: unknown
): Promise<ActionResult<{ moved: boolean }>> {
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
    //
    // `moved: false` rather than a bare success (chat-014 / audit A54): the
    // client reads a plain success as "tell the sidebar its total changed", so
    // this branch had the unread badge refetching on every message in a public
    // channel nobody had joined.
    if (!channel.isMember) return { success: true, data: { moved: false } };

    // Record WHICH message was read as well as when. lastReadAt is the
    // authoritative comparison for the badge (see the schema comment); the id
    // is for the "new messages" divider, which needs an anchor rather than a
    // timestamp.
    const newest = await db.message.findFirst({
      where: { channelId, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });

    // chat-014: ALREADY CAUGHT UP. The two columns are written together, so
    // `lastReadAt` is never behind the message `lastReadMessageId` names — if
    // that is still the newest message, this UPDATE would write the same
    // watermark again and the two revalidations would evict a shared cache tag
    // for nothing. An empty channel lands here too (`null === null`), which is
    // correct: there is nothing to have read.
    const newestId = newest?.id ?? null;
    if (newestId === channel.lastReadMessageId) return { success: true, data: { moved: false } };

    await db.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { lastReadAt: new Date(), lastReadMessageId: newestId },
    });

    // BOTH paths, matching every other write in this file (chat-007). The
    // unread badge is drawn by <ChannelRail>, which is rendered from
    // `listChannelsForUser()` inside app/(app)/chat/[slug]/page.tsx — so the
    // cached render that has to go is the one for the channel the reader is
    // LOOKING AT. Revalidating "/chat" alone moved the watermark in the database
    // and left the badge beside their own cursor still claiming unread messages
    // until they navigated away and back, which teaches people to ignore the one
    // signal the rail exists to carry.
    revalidatePath("/chat");
    revalidatePath(`/chat/${channel.slug}`);
    return { success: true, data: { moved: true } };
  } catch (e) {
    captureServerError(e, { action: "markChannelReadAction" });
    return { success: false, error: "Couldn't update your read position right now." };
  }
}

/**
 * Silence one conversation's notifications, or let them back in (chat-012).
 *
 * WHY THIS HAD TO EXIST. `ChannelMember.mutedAt` has been in the schema since
 * the chat migration, documented as "Muted = still a member, still sees the
 * channel, just no notification fan-out", and BOTH fan-outs in this file
 * already honour it — `sendMessageAction` drops `mutedAt: { not: null }`
 * members from the mention recipients, and `postRunwayCardAction` does the
 * same. A repo-wide grep for a WRITE to that column found nothing: no action,
 * no route, no control. So the suppression was complete, correct, tested and
 * unreachable, and a member of a noisy channel had exactly one way to stop its
 * pings — the workspace-wide notification preferences, which turn mentions off
 * everywhere. That shape (finished server path, no entry point) is this repo's
 * signature defect, and the lever is the whole of the fix.
 *
 * NO ROLE GATE, and that is not an oversight. This touches one column on ONE
 * row: the caller's own membership. There is no version of "may I decide
 * whether my phone buzzes" that an admin should be answering, and
 * `canManageChannel` is about renaming and archiving a room for everyone.
 * `canSeeChannel` still applies, because a channel the caller cannot see must
 * not even confirm it exists.
 *
 * MEMBERSHIP IS REQUIRED, and this is the one real limitation. `mutedAt` is a
 * column on `ChannelMember`, so there is nothing to write for somebody who has
 * no membership row — which in a PUBLIC channel is a real reader: they can post
 * and be @-mentioned without ever joining, and the mention fan-out skips the
 * membership filter for public channels precisely so that works. Upserting a
 * row here would silence them, and would ALSO subscribe them to that channel's
 * unread badge forever, which is the exact stealth-join `markChannelReadAction`
 * refuses above for the same reason. So they are refused in words instead, and
 * the honest answer for them remains the workspace notification preferences.
 *
 * ARCHIVED CHANNELS ARE ALLOWED. Muting one is pointless rather than harmful
 * (nothing can be posted, so nothing can fan out), but a reader tidying up
 * after an archive should not be told no by a control that is sitting there.
 *
 * `limiters.write`, like every other write in this file: a human pressing a
 * bell is nowhere near 60/min, and it is a real database write.
 */
export async function setChannelMuteAction(
  input: unknown
): Promise<ActionResult<{ muted: boolean }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = SetChannelMuteSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { channelId, muted } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const channel = await loadChannelContext(channelId, companyId, userId);
    if (!channel) return { success: false, error: "Channel not found" };
    if (!canSeeChannel(channel)) {
      return { success: false, error: "You do not have access to this channel" };
    }
    if (!channel.isMember) {
      return { success: false, error: "Only members of this conversation can mute it" };
    }

    // ALREADY THERE: nothing to write, so nothing to invalidate either. The
    // payload is an absolute state rather than a toggle (see the schema), which
    // is what makes this safe to short-circuit — a double tap or a second tab
    // asking for the state the row already holds is success, not a second write
    // and two cache evictions. This is also `ChannelContext.muted`'s first
    // reader: it was computed by `loadChannelContext` and used by nothing.
    if (channel.muted === muted) return { success: true, data: { muted } };

    await db.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      // The timestamp is the mute: there is no separate boolean to disagree
      // with it. `new Date()` here and never from the payload — see the
      // schema's note.
      data: { mutedAt: muted ? new Date() : null },
    });

    // BOTH paths, matching every other write in this file (chat-007). The
    // header's bell is rendered from `getChannelBySlug` inside
    // app/(app)/chat/[slug]/page.tsx, so the cached render that has to go is
    // the one for the channel the reader is looking at; "/chat" goes too
    // because the index renders from the same query family.
    revalidatePath("/chat");
    revalidatePath(`/chat/${channel.slug}`);
    // The state that was actually written, echoed back rather than assumed, so
    // the control flips on the server's answer and not on the click.
    return { success: true, data: { muted } };
  } catch (e) {
    captureServerError(e, { action: "setChannelMuteAction" });
    return { success: false, error: "Couldn't change your notifications right now." };
  }
}

/**
 * "Has anything been said in here since the watermark I'm holding?" — the cheap
 * half of making chat live (finding chat-004).
 *
 * WHY A PROBE AND NOT A PUSH. Chat had no liveness at all: the only refetch in
 * the whole surface was the composer's own `onSent`, so two people in a DM each
 * saw a one-sided conversation until one of them reloaded. The honest options
 * for this deploy are polling or nothing. This app runs on Vercel serverless
 * functions, where a WebSocket has nowhere to live and an SSE stream costs a
 * function invocation held open per reader per channel (and is capped by the
 * platform's max duration, so it would disconnect on a timer anyway). Both
 * routes to real push — a hosted realtime service, or Supabase Realtime with a
 * second client and RLS policies this app does not have — are infrastructure
 * decisions, not a patch. Polling that works beats realtime that cannot ship.
 *
 * WHY IT RETURNS A WATERMARK INSTEAD OF MESSAGES. A poll that returned the page
 * would cost a full render per tick per reader whether or not anything
 * happened, and idle is the common case. This is ONE indexed read of ONE column
 * on a row the caller is already authorised for — `loadChannelContext` selects
 * `lastMessageAt` for exactly this reason, so there is no second round trip —
 * and the client only spends a `router.refresh()` when the answer moved. An
 * idle channel therefore costs a session decode and a single-row select.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE. `Channel.lastMessageAt` is bumped by
 * `sendMessageAction` only (in the same transaction as the message, so it can
 * never advance past a rolled-back write). A reaction, an edit or a delete does
 * not move it, so those still land on the reader's next refresh rather than
 * within a poll interval. That is the trade this cheapness buys, and it is the
 * right way round: a message nobody saw is the bug customers reported, an emoji
 * arriving a moment late is not.
 *
 * `MarkChannelReadSchema` is reused rather than copied: the payload is one
 * `channelId` and that schema is already exactly `z.object({ channelId })`. A
 * second identical schema would be a second place for the id rules to drift.
 *
 * `limiters.read`, not `limiters.write` — it writes nothing, and spending the
 * write budget on a timer would make sending a message fail for a reader who
 * had simply left a tab open. Same reasoning the bucket's own comment gives.
 */
export async function pollChannelActivityAction(
  input: unknown
): Promise<ActionResult<{ lastMessageAt: string | null }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.read.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = MarkChannelReadSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { channelId } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const channel = await loadChannelContext(channelId, companyId, userId);
    // Absent, another workspace's, or one this reader may not see — all one
    // answer, so the probe cannot be used to discover that a private channel
    // called #acquisition exists. Same rule as `getChannelBySlug`.
    if (!channel || !canSeeChannel(channel)) {
      return { success: false, error: "Channel not found" };
    }
    return {
      success: true,
      data: { lastMessageAt: channel.lastMessageAt?.toISOString() ?? null },
    };
  } catch (e) {
    captureServerError(e, { action: "pollChannelActivityAction" });
    return { success: false, error: "Couldn't check for new messages right now." };
  }
}

/**
 * Add teammates to a channel (finding chat-003).
 *
 * WHY THIS HAD TO EXIST. `createChannelAction` wrote exactly one
 * `ChannelMember` — the creator, role `owner` — and a repo-wide grep for
 * `channelMember.create|createMany|upsert` found only that line, `openDmAction`'s
 * two-row pair and `lib/chat/bootstrap.ts`'s #general. So a PRIVATE channel
 * could never hold a second person, while the dialog that creates one promises
 * "Only people you add can see this channel" and the schema calls the kind
 * "invite-only; membership IS the permission". A founder picking Private to
 * discuss a raise with their cofounder got a room the cofounder could not see,
 * with no error and nothing to click. Compounding it, the mention fan-out
 * intersects recipients against the member list in a non-public channel, so
 * @-mentioning anyone in a private channel notified nobody — silently.
 *
 * `canManageChannel` is the gate, and this is its FIRST caller: it had twelve
 * green test cases and nothing invoking it (audit row 5 in
 * tests/lib/actions/reachability.test.ts). Admin/cofounder or the channel's own
 * owner, exactly as that predicate says.
 *
 * BOTH GATES, because they compose and neither substitutes for the other.
 * `canManageChannel` says nothing about visibility — an admin manages any
 * channel in the company, so without `canSeeChannel` an admin could add
 * themselves to a private channel they were never invited to and read it, which
 * is precisely the back door `canSeeChannel`'s own comment refuses to open.
 *
 * NOT FOR A DM, ever. A DM's identity IS its pair: `dmKeyFor` sorts two ids,
 * `@@unique([companyId, dmKey])` holds one row per pair, and `dmDisplayName`
 * resolves the counterpart from the membership rows. A third member would make
 * the key a lie and the name ambiguous. Adding people to a two-person
 * conversation is a "start a group channel" feature, not a membership write.
 *
 * ARCHIVED IS REFUSED for the reason `canPostInChannel` refuses a post: an
 * archived channel is closed. Re-opening it is `canManageChannel`'s other,
 * still-unwired job.
 *
 * ONE WRITE, IDEMPOTENT. `skipDuplicates` against `@@unique([channelId,
 * userId])` means the same person added twice is a no-op rather than a P2002,
 * so a double-clicked picker cannot fail. Everyone arrives as `member`: handing
 * out `owner` would let an invitee archive the channel that invited them.
 *
 * NO NOTIFICATION, deliberately. `notifyUsers` fans out on a closed set of
 * event types wired to per-user preferences; "you were added to a channel" is
 * not one of them, and inventing a type here would ship an event nobody can opt
 * out of. The channel appears in the invitee's rail on their next load, which
 * is how #general already arrives. A `channel_invite` preference is a follow-up.
 */
export async function addChannelMembersAction(
  input: unknown
): Promise<ActionResult<{ added: number }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = AddChannelMembersSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Pick someone to add" };
  }
  const { channelId, userIds } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    const channel = await loadChannelContext(channelId, companyId, userId);
    if (!channel || !canSeeChannel(channel)) {
      return { success: false, error: "Channel not found" };
    }
    if (!canManageChannel({ role: role as Role, channelRole: channel.channelRole })) {
      return { success: false, error: "Only a channel's owner or an admin can add people" };
    }
    if (channel.kind === "dm") {
      return {
        success: false,
        error: "A direct message is between two people — start a channel instead.",
      };
    }
    if (channel.archivedAt) {
      return { success: false, error: "This channel is archived — un-archive it first." };
    }

    // Re-verification, the step of the house template this action exists to get
    // right: every id in `userIds` arrived from the client. Without the
    // companyId here, a forged cuid would plant a stranger from another
    // workspace into this channel's member list — which for a private channel
    // is a read grant. `deletedAt: null` keeps a tombstoned teammate out: their
    // row still exists for the soft-delete restore, and re-adding them would
    // resurrect them into a rail they are not supposed to be in.
    const found = await db.user.findMany({
      where: { id: { in: userIds }, companyId, deletedAt: null },
      select: { id: true },
    });
    if (found.length === 0) {
      return { success: false, error: "Nobody on that list is in this workspace" };
    }

    const result = await db.channelMember.createMany({
      // `role: "member"` for everyone — see the header.
      data: found.map((u) => ({ channelId, userId: u.id, role: "member" })),
      // Already a member → skipped, not a unique-index error. Adding someone
      // twice is an ordinary double click, not an incident.
      skipDuplicates: true,
    });

    revalidatePath("/chat");
    revalidatePath(`/chat/${channel.slug}`);
    return { success: true, data: { added: result.count } };
  } catch (e) {
    captureServerError(e, { action: "addChannelMembersAction", companyId, userId });
    return { success: false, error: "Couldn't add anyone to that channel right now." };
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
 * The dashboard's runway arithmetic, over the dashboard's own aggregates.
 *
 * SHARES THE ARITHMETIC ITSELF with /dashboard — `lib/finance/runway.ts`, which
 * both this and app/(app)/dashboard/dashboard-client.tsx import. That used to be
 * two hand-mirrored copies plus a comment asking the next reader to keep them in
 * step, and the mirroring is load-bearing: a card quoting a second,
 * independently derived runway would let /chat and /dashboard disagree about the
 * same word on the same afternoon, with no way to tell from the outside which
 * one was lying. That is a worse bug than shipping no card at all. (money-017
 * was both copies being wrong in the same way, which is the only reason the two
 * surfaces still agreed.)
 *
 * THE INPUTS ARE AGGREGATES, NOT ROWS (transactions-ledger-001). Until this
 * change the card summed `getTransactions()`, a LIST window capped at
 * `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) whose own docstring ends "DO NOT
 * SUM THE RESULT". Two consequences, and the second is why this mattered more
 * here than anywhere else:
 *
 *   • The rows a ceiling drops are the OLDEST, which for a startup are the seed
 *     investments — so `cashOnHand` lost money-IN first and both the balance and
 *     the runway shrank as the workspace grew.
 *   • /dashboard moved onto the unbounded roll-ups (money-008) and this card did
 *     not, so the two surfaces could print different runways for the same
 *     workspace on the same afternoon — the exact drift lib/finance/runway.ts
 *     exists to prevent, arriving by a second route.
 *
 * And the card is a SNAPSHOT: it is never recomputed on read, so a wrong figure
 * here is a permanent row in a channel the whole team reads, not a page that
 * comes out right on the next refresh.
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
 */
function runwayFigures(
  input: {
    /** `getTransactionTotals().balance` — capital + revenue − spend, every row. */
    cashOnHand: number;
    /** `getTransactionTotals({ from: burnWindowStart(now) }).byType.expense.total`
     *  — the window is built in UTC, not with date-fns `subMonths` (which
     *  subtracts in the runtime's LOCAL calendar while `Transaction.date` is a
     *  date-only value stored at UTC midnight — money-007). */
    burnWindowExpense: number;
    /** `getLedgerStart()` — the earliest ledger row of ANY type, which is what
     *  the window's spend is averaged over (money-017). A company that existed
     *  for three months and only started paying salaries last month really does
     *  have a three-month average with two quiet months in it. `null` on an empty
     *  ledger. */
    ledgerStartsAt: string | null;
  },
  now: Date
): RunwayFigures {
  const { cashOnHand } = input;
  const monthlyBurn = averageMonthlyBurn(input.burnWindowExpense, input.ledgerStartsAt, now);
  return {
    cashOnHand,
    monthlyBurn,
    // The dashboard's own figure, from the same function: null, not Infinity.
    runwayMonths: runwayMonths(cashOnHand, monthlyBurn),
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
 * through the same unbounded aggregates the dashboard uses.
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
    const [author, company, totals, burnWindow, ledgerStartsAt] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { name: true, avatar: true } }),
      // `deletedAt: null`, like every scoped read in the codebase: a
      // tombstoned workspace does not get to publish its balance into its own
      // chat on the strength of a session minted before the delete.
      db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { currency: true },
      }),
      // Company-scoped internally, from this same session — the caller cannot
      // name a workspace — and these are the dashboard's own three aggregates,
      // not the capped row window the card used to sum (see runwayFigures).
      getTransactionTotals(),
      getTransactionTotals({ from: burnWindowStart(now) }),
      getLedgerStart(),
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
      ...runwayFigures(
        {
          cashOnHand: totals.balance,
          burnWindowExpense: burnWindow.byType.expense.total,
          ledgerStartsAt,
        },
        now
      ),
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
            // As the send path: the card shows up as an unread message on the
            // Chat badge. A row under the bell would be a second, duplicate
            // announcement of the same thing.
            skipInApp: true,
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
