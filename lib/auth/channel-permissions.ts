/**
 * Per-channel permission helpers. Pure — no I/O, no Prisma client, no session
 * lookup — so they're safe in the Edge runtime (middleware), the Node runtime
 * (server actions), and the client (rail filtering), exactly like
 * role-gates.ts and project-permissions.ts.
 *
 * This module carries EVERY chat access decision on purpose. The chat server
 * actions have no tests of their own; that gap is only acceptable because
 * nothing about who-can-see-what is decided inline inside an action. If you
 * find yourself writing `if (role === "admin")` in lib/actions/chat.ts, the
 * rule belongs here instead.
 *
 * Permission model:
 *   - public channel  — every company member can read and post, joined or not.
 *                       Membership only controls the unread badge.
 *   - private channel — membership IS the permission. Company role grants
 *                       nothing extra (see canSeeChannel).
 *   - dm              — same as private, with exactly two members.
 *   - archived        — everyone who could read still can; nobody can post.
 */

import { canSeeFinances, type Role } from "./role-gates";

export type ChannelActor = {
  userId: string;
  role: Role;
};

export type ChannelFacts = {
  /** A CHANNEL_KINDS value — "public" | "private" | "dm". */
  kind: string;
  /** Does the actor have a ChannelMember row for this channel? */
  isMember: boolean;
  /** Set = the channel is archived (soft-closed). */
  archivedAt?: Date | string | null;
};

/**
 * True when the actor can READ the channel at all — see it in the rail, open
 * it, load its history.
 *
 * A public channel is visible to any company member without joining: that is
 * what makes it public, and the caller has already established company scope
 * before asking. Private channels and DMs are membership-only.
 *
 * NOTE: an admin does NOT get a back door into a private channel they were not
 * invited to. This is deliberate and there is a test for it. Company role
 * governs the company's RECORDS — finances, team, projects; it does not
 * govern private conversations between colleagues. A founder who silently
 * reads a private channel is a different product with a different promise, and
 * "admins can read everything" is exactly the kind of rule that gets added by
 * accident because it looked like consistency. If the business ever needs
 * legal/compliance export, that is an explicit, auditable, logged path — not a
 * quiet `|| role === "admin"` here.
 *
 * Deliberately ignores `archivedAt`: archiving closes posting, not reading.
 *
 * Kept in lock step with `visibleChannelWhere` below — the two answer the same
 * question in two languages, and a test asserts they agree over the full
 * fixture matrix.
 */
export function canSeeChannel({
  kind,
  isMember,
}: Pick<ChannelFacts, "kind" | "isMember">): boolean {
  if (kind === "public") return true;
  // private + dm — and any unknown kind, which fails closed.
  return isMember;
}

/**
 * The Prisma `where` fragment expressing `canSeeChannel` as a query, for the
 * list paths that can't evaluate a predicate per row.
 *
 * Callers add `companyId` (always) and `archivedAt` (usually `null`)
 * themselves — this fragment answers visibility ONLY, so the rail and the
 * archive view can share it.
 *
 *   db.channel.findMany({
 *     where: { companyId, archivedAt: null, ...visibleChannelWhere(userId) },
 *   })
 *
 * If this and `canSeeChannel` ever disagree, the QUERY is the one that leaks —
 * it runs without a per-row predicate behind it. Change them together.
 *
 * No `as const` on the return: a readonly tuple is not assignable to Prisma's
 * `ChannelWhereInput[]`, so freezing it here would force every caller to cast.
 */
export function visibleChannelWhere(
  userId: string,
  companyId: string
): {
  companyId: string;
  OR: Array<{ kind: string } | { members: { some: { userId: string } } }>;
} {
  // companyId is a REQUIRED parameter, not something callers remember to add.
  // Without it this fragment matches every public channel in every workspace,
  // and the cross-tenant boundary would live in lib/queries/** rather than in
  // this audited module — the one way chat could leak between companies, and
  // the one thing the coincidence-guard test below cannot catch. Making it an
  // argument means a caller cannot forget it; TypeScript refuses.
  return {
    companyId,
    OR: [{ kind: "public" }, { members: { some: { userId } } }],
  };
}

/**
 * True when the actor can POST a message (or a reply, or a reaction) in the
 * channel.
 *
 * Archived channels are read-only for everyone — including admins and the
 * channel's own owner. Un-archiving is the way back in, and that is
 * `canManageChannel`'s business.
 */
export function canPostInChannel({ kind, isMember, archivedAt }: ChannelFacts): boolean {
  if (archivedAt) return false;
  if (!canSeeChannel({ kind, isMember })) return false;
  // Public: anyone who can see it can post. Private/DM: members only — which
  // canSeeChannel has already established, but stating it keeps the rule
  // legible if the visibility predicate ever widens.
  return kind === "public" || isMember;
}

/**
 * True when the actor can delete a message.
 *
 * The author always can. Admin and cofounder can delete anyone's — moderation
 * has to live somewhere, and cofounder tracks admin in every other predicate
 * in this codebase (`canSeeFinances`, `canManageProject`,
 * `canReassignSupervisor`, and `canManageChannel` directly below). A cofounder
 * who can delete an entire project but not an off-colour message would be an
 * asymmetry with no product reasoning behind it. Members are the restricted
 * tier here, not cofounders.
 *
 * Deleting tombstones the row (`Message.deletedAt`) rather than erasing it, so
 * a thread never silently rewrites its own history mid-conversation.
 */
export function canDeleteMessage({
  userId,
  role,
  authorId,
}: ChannelActor & { authorId: string }): boolean {
  if (userId === authorId) return true;
  return role === "admin" || role === "cofounder";
}

/**
 * True when the actor can manage the channel itself — rename it, set the
 * topic, archive or un-archive it.
 *
 * Admin and cofounder manage any channel in the company; this is workspace
 * housekeeping, not conversation access, so cofounder is included here even
 * though it is excluded from `canDeleteMessage`. The channel's own owner (the
 * creator, or whoever inherited the "owner" ChannelMember role) manages theirs
 * without needing a company role.
 *
 * Note this says nothing about VISIBILITY: an admin can archive a private
 * channel they're not in only if some UI ever shows it to them, and
 * `canSeeChannel` says it doesn't. The two gates compose; neither one is a
 * substitute for the other.
 */
export function canManageChannel({
  role,
  channelRole,
}: {
  role: Role;
  /** The actor's CHANNEL_ROLES value, or null/undefined if not a member. */
  channelRole?: string | null;
}): boolean {
  if (role === "admin" || role === "cofounder") return true;
  return channelRole === "owner";
}

/**
 * The canonical key for a direct message between two users: their ids sorted
 * and joined with ":".
 *
 * Sorting is the entire point. Without it "alice opens a DM with bob" and "bob
 * opens a DM with alice" produce two different keys, the unique index doesn't
 * catch it, and the pair ends up with two parallel conversations that each
 * hold half the history — the kind of bug nobody reports because each person
 * only sees their own half. Channel.dmKey carries this value and
 * @@unique([companyId, dmKey]) enforces it at the database.
 */
export function dmKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

/**
 * True when the actor may POST a Runway card — a message whose payload carries
 * the company's cash position, monthly burn and months of runway — into a
 * channel they can already post in.
 *
 * DELEGATES to `canSeeFinances` instead of restating `admin || cofounder`, and
 * the delegation is the whole point of the function. A Runway card IS a
 * finance figure. "Who may publish the balance" and "who may look at the
 * balance" are not two questions that happen to share an answer today; they
 * are the same question asked twice. Spell the roles out a second time here
 * and the day somebody adds a finance-capable role — the read-only auditor /
 * accountant sketched in CODEBASE-AUDIT.md §4.3 — they edit one list, ship,
 * and get one of two bugs: the new role cannot post the number it is staring
 * at, or, the direction that actually hurts, a role REMOVED from
 * `canSeeFinances` keeps publishing the company balance into a public channel
 * because nobody remembered there was a second copy of the rule down here.
 *
 * Contrast `canSeeAllProjects` in project-permissions.ts, which deliberately
 * does NOT delegate even though it currently duplicates `canSeeFinances`
 * exactly. The test for which pattern applies is whether a future divergence
 * would be a feature or a bug: "sees every project" drifting away from "sees
 * money" is a feature, so it forks; "may post the balance" drifting away from
 * "may read the balance" is a bug, so it delegates.
 *
 * SCOPE — this is the weaker half of the rule. It gates the AUTHOR. It says
 * nothing about who READS the card, and reading is where the real exposure
 * is: chat is open to every role on purpose (`/chat` is deliberately absent
 * from MEMBER_BLOCKED_ROUTES), so a card posted in a public channel lands in
 * front of every member in the company. The gate that answers that is the
 * per-viewer redaction inside `toMessageClient` in lib/queries/chat.ts — read
 * the comment there before changing either. The two compose; neither is a
 * substitute for the other, exactly like `canSeeChannel` and
 * `canManageChannel` above.
 *
 * Composes with `canPostInChannel` rather than replacing it: an admin still
 * cannot post a card into an archived channel, or into a private channel they
 * were never invited to. Callers must pass BOTH gates.
 */
export function canPostRunwayCard(role: Role): boolean {
  return canSeeFinances(role);
}
