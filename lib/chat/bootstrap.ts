/**
 * The runtime birth of a workspace's chat — the #general channel, and the
 * membership rows that put people in it.
 *
 * WHY THIS EXISTS: until now, exactly one thing had ever created a #general
 * channel — the one-shot backfill in
 * `prisma/migrations/20260924100000_add_chat/migration.sql`, which ran once,
 * against the workspaces that existed on 2026-09-24, and then never again. A
 * migration is a statement about the past. Nothing said anything about the
 * future, so every workspace created since that date has ZERO channels: the
 * founder signs up, clicks Chat, and lands on the empty state of a feature the
 * landing page sells. The same gap on the other side of the door: an invitee
 * accepted their invite and got no `ChannelMember` row anywhere, because
 * `createChannelAction` is the only other place in the codebase that writes
 * one and `markChannelReadAction` deliberately refuses to auto-join on open
 * ("an upsert here would look harmless and do exactly that"). So there was no
 * runtime path at all by which a new teammate could end up in a channel.
 *
 * The symptom is asymmetric between the two, which is why this module is two
 * functions rather than one:
 *
 *   - A workspace with no #general is BROKEN. Chat is empty, and nothing in
 *     the product offers to fix it.
 *   - An invitee with no membership is DEGRADED, not broken. `canSeeChannel`
 *     and `canPostInChannel` both return true for a public channel without
 *     membership, so they can read and post from day one. What they lose is
 *     the unread badge (only a membership row carries the `lastReadAt`
 *     watermark the rail counts against) and their seat in the member list
 *     and count.
 *
 * SHAPE: both take the caller's transaction client FIRST, typed structurally
 * as a `Pick<typeof db, …>` exactly the way `lib/notify/fan-out.ts` types its
 * `tx` option, so a `$transaction` callback's `tx` and the base `db` client
 * both satisfy it without a cast. Taking it is not optional here, and that is
 * the point: the bug being fixed is a workspace that COMMITTED without its
 * channel, so the channel has to be able to land or roll back with the rest of
 * the signup rather than trailing it on a second connection.
 *
 * NO ACTIVITY ROW is written for a bootstrap channel, and that is deliberate
 * rather than forgotten — see the long header of `lib/actions/chat.ts`.
 * `ActivityType` in lib/types.ts is a closed union and `ACTIVITY_META` is a
 * `Record<ActivityType, …>` indexed with no fallback, so emitting a
 * `channel_created` type would throw in the /activities UI the first time
 * anyone loaded it. Both files are owned by another workstream. A silent
 * bootstrap is also the honest reading: nobody performed this action.
 *
 * STILL OWED: the workspaces created between 2026-09-24 and this fix are
 * already channel-less, and nothing here heals them retroactively —
 * `joinDefaultChannels` joins, it does not create (see its own note on why an
 * invitee must not become the owner of a workspace-wide channel). That repair
 * is a NEW migration re-running section 2 + 3 of the add_chat backfill, never
 * an edit to the applied one.
 */

import type { db } from "@/lib/db";

/**
 * The workspace-wide channel, by the slug the add_chat backfill used. Both
 * halves of the rollout have to agree on this string or a healed workspace
 * ends up with `general` AND `general-2`, so it is exported rather than
 * spelled out at each call site.
 */
export const GENERAL_CHANNEL_SLUG = "general";

/** Matches the backfill's display name, which the rail renders after a `#`. */
const GENERAL_CHANNEL_NAME = "general";

/** Shown under the channel header until someone edits it. */
const GENERAL_CHANNEL_TOPIC = "Company-wide channel. Everyone lands here.";

/**
 * The channels a newcomer is enrolled in automatically, by slug.
 *
 * ONLY #general, and the restraint is the decision. Public channels are
 * already visible to the whole workspace WITHOUT membership —
 * `visibleChannelWhere` ORs `{ kind: "public" }` in, so the rail lists every
 * one of them for everybody. Joining a new hire to all of them therefore adds
 * no discoverability whatsoever; the rows are already on their screen. The
 * only thing it adds is unread badges — on a workspace with thirty public
 * channels, thirty of them, every morning, for rooms the person has no reason
 * to follow. A badge that is always lit is a badge nobody reads, and it would
 * take #general's badge down with it.
 *
 * The inverse worry does not apply: `lastReadAt` defaults to `now()`
 * (schema.prisma, and the backfill sets it explicitly for the same reason), so
 * joining never fabricates unread history for messages posted before you
 * arrived. Day one is quiet either way. The cost of over-joining is paid on
 * day thirty.
 *
 * A list rather than a single slug because the answer is a policy, not a
 * constant — an "#announcements" default would be one entry here and no
 * change to the code below.
 */
const DEFAULT_CHANNEL_SLUGS: readonly string[] = [GENERAL_CHANNEL_SLUG];

/**
 * The slice of the Prisma client chat bootstrap touches.
 *
 * Structural, not `Prisma.TransactionClient`: that type names the full client
 * minus its `$` methods, which would let any of these functions quietly start
 * writing a User or a Company. Narrowing it to two models is a readable
 * statement of blast radius, and it is what lets the tests hand in a plain
 * object literal instead of standing up a database.
 */
export type ChatBootstrapClient = Pick<typeof db, "channel" | "channelMember">;

/**
 * Prisma's unique-constraint violation. Spelled out locally, the same way
 * `createChannelAction` and `openDmAction` do it, rather than importing
 * `Prisma.PrismaClientKnownRequestError` — the `instanceof` check against that
 * class is worthless in a unit test, where the error is a plain object with a
 * `code`, and a race that only the integration suite can reach is a race
 * nobody verifies.
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** The lookup behind both the cheap path and the post-race re-read. */
async function findGeneralChannelId(
  tx: ChatBootstrapClient,
  companyId: string
): Promise<string | null> {
  const found = await tx.channel.findFirst({
    // Deliberately NOT filtered by `archivedAt` or by `kind`. This lookup
    // stands in for the `@@unique([companyId, slug])` index, and that index
    // does not care either: if #general has been archived, or somehow exists
    // as a private channel, the slug is still taken and creating a second one
    // would fail. Returning the row we found is the only answer that does not
    // end in `general-2`.
    where: { companyId, slug: GENERAL_CHANNEL_SLUG },
    select: { id: true },
  });
  return found?.id ?? null;
}

/**
 * Guarantee this workspace has a #general channel, and return its id.
 *
 * IDEMPOTENT, and it has to be for three separate reasons, only one of which
 * is a race: the add_chat migration already backfilled a #general for every
 * workspace that existed before it, a retried signup must not leave behind a
 * `general-2`, and two callers can collide on the unique index. The lookup
 * below answers the first two cheaply; the index answers the third, and the
 * catch turns its rejection back into a successful resolve — the same
 * three-layer shape `openDmAction` uses for its dmKey, and for the same
 * reason: only the index is a guarantee, the lookup is just the fast path.
 *
 * `creatorId` is used ONLY when this call is the one that creates the channel.
 * They become its `createdBy` and get `role: "owner"`, which is what hands
 * them rename/archive rights through `canManageChannel` without requiring a
 * company-admin check — the same split the backfill made when it gave 'owner'
 * to `ch."createdBy"` and 'member' to everyone else. On the already-exists
 * path nothing is written at all, not even a membership row: enrolling a
 * person is `joinDefaultChannels`' job, it is idempotent, and a caller healing
 * an old workspace composes the two.
 *
 * ON THE CREATOR'S MEMBERSHIP being in the same statement pair as the channel:
 * `createChannelAction` argues this for a private channel ("a channel that
 * committed without its owner row would be invisible to everyone"). For a
 * public channel the stake is smaller — it would still be visible — but the
 * founder would have no watermark in the one channel they are certain to care
 * about, and no runtime path exists to give them one. So it stays paired.
 *
 * FAILURE POLICY — call this INSIDE the signup transaction. There is nothing
 * to lose there: the account does not exist yet, so a rollback costs a
 * retryable error page rather than data, while a commit that skipped the
 * channel is precisely the bug this module was written to end. Outside the
 * transaction the trade inverts — the failure would be silent and permanent,
 * and we would have rebuilt the bug with extra steps.
 */
export async function ensureGeneralChannel(
  tx: ChatBootstrapClient,
  companyId: string,
  creatorId: string
): Promise<string> {
  const existing = await findGeneralChannelId(tx, companyId);
  if (existing) return existing;

  try {
    const channel = await tx.channel.create({
      data: {
        companyId,
        kind: "public",
        slug: GENERAL_CHANNEL_SLUG,
        name: GENERAL_CHANNEL_NAME,
        topic: GENERAL_CHANNEL_TOPIC,
        // NULL, not the empty string: `@@unique([companyId, dmKey])` treats
        // NULLs as distinct in Postgres, so every non-DM channel is exempt
        // from the anti-fork index. An empty string would collide with the
        // next one.
        dmKey: null,
        createdBy: creatorId,
      },
      select: { id: true },
    });
    await tx.channelMember.create({
      data: { channelId: channel.id, userId: creatorId, role: "owner" },
    });
    return channel.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;

    // Somebody else committed #general between our lookup and our insert. That
    // is the index doing its job, not an incident: re-read and hand back the
    // row they wrote, so both callers end up pointing at one channel.
    //
    // The `.catch` is not defensive noise. Under Postgres a failed statement
    // ABORTS the surrounding transaction, so when `tx` really is a
    // `$transaction` callback this re-read raises 25P02 rather than returning
    // a row. Swallowing that and rethrowing the ORIGINAL P2002 keeps the
    // diagnostic pointed at the collision that actually happened instead of at
    // its aftershock — and for a signup, a rollback is the correct outcome
    // anyway (see FAILURE POLICY above). The re-read is what saves the callers
    // whose client is NOT mid-transaction: the base `db` client, and any
    // future backfill script.
    const raced = await findGeneralChannelId(tx, companyId).catch(() => null);
    if (raced) return raced;
    throw e;
  }
}

/**
 * Enrol someone in the workspace's default channels. Returns how many
 * memberships were actually created.
 *
 * WHY A COUNT AND NOT VOID: the caller is inside an invite acceptance and 0 is
 * a legitimate, non-exceptional answer — an already-joined user, or a
 * workspace whose #general has not been created yet. Returning it lets a smoke
 * script assert the interesting case without inferring it from silence.
 *
 * DOES NOT CREATE A CHANNEL, on purpose. Healing a channel-less workspace from
 * here would mean stamping the newest, most junior person in the building as
 * `createdBy` with `role: "owner"` of the company-wide channel, handing a
 * day-one hire the right to rename and archive it. Joining and founding are
 * different acts; `ensureGeneralChannel` is the other one.
 *
 * FAILURE POLICY — safe to call INSIDE the invite transaction, which is the
 * question worth thinking about, because that transaction is also what marks
 * a single-use token `usedAt`. Two things make it safe. First, the token is
 * consumed by the SAME transaction, so a rollback un-consumes it: the invitee
 * gets the retry message and their link still works, rather than being left
 * holding a burnt token. Second, and more importantly, this function is
 * written so that "nothing to join" is a zero rather than a throw — no
 * channels, already a member, both return quietly. That leaves essentially one
 * way to fail, which is the database being unreachable, and in that case the
 * `user.create` above has already taken the transaction down. So putting it on
 * the critical path does not add a realistic way to lock someone out of a
 * workspace over a chat row.
 */
export async function joinDefaultChannels(
  tx: ChatBootstrapClient,
  companyId: string,
  userId: string
): Promise<number> {
  const channels = await tx.channel.findMany({
    where: {
      companyId,
      slug: { in: [...DEFAULT_CHANNEL_SLUGS] },
      // Both filters matter here, unlike in `findGeneralChannelId`. An
      // archived channel is read-only for everyone, so a membership in one
      // only buys a badge for a room nobody can post in; and a private channel
      // that happens to hold the slug must not be auto-joined, because
      // membership IS the access decision for private (`canSeeChannel`).
      // Auto-enrolling would be a permission grant wearing an onboarding hat.
      kind: "public",
      archivedAt: null,
    },
    select: { id: true },
  });
  if (channels.length === 0) return 0;

  // `skipDuplicates` rather than a read-then-filter: the unique index
  // `@@unique([channelId, userId])` is the only thing that can answer "am I
  // already in?" without a race between the check and the insert, and this is
  // how you ask it without the answer arriving as an exception that would
  // poison the caller's transaction.
  //
  // `role: "member"` and no explicit `lastReadAt` — the column defaults to
  // now(), which is exactly the semantics we want and the reason the schema
  // comment gives for the default existing at all: joining must not greet you
  // with a badge for history you were never around for.
  const { count } = await tx.channelMember.createMany({
    data: channels.map((channel) => ({ channelId: channel.id, userId, role: "member" })),
    skipDuplicates: true,
  });
  return count;
}
