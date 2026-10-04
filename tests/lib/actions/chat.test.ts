/**
 * lib/actions/chat.ts — the first test file this module has ever had.
 *
 * It is ~1440 lines of server actions and it shipped with a header comment saying
 * that is "the reason these actions can ship without unit tests of their own (the
 * predicates have them; the plumbing is covered by scripts/smoke-*.mjs)". That held
 * while the only thing in here was a call into a tested predicate. It stopped
 * holding once the plumbing itself started making decisions:
 *
 *   • chat-007 — WHICH PATH a write revalidates is not a predicate's business and
 *     no predicate test can see it. `markChannelReadAction` revalidated "/chat"
 *     alone while the rail that carries the unread badge is rendered by
 *     "/chat/[slug]", so reading a channel left its own badge lit until the reader
 *     navigated away and came back.
 *
 *   • chat-005 — WHAT THE ACTION TELLS THE CLIENT about a fan-out. The composer
 *     chooses between "pinged 2 teammates", a failure warning and silence purely
 *     from this action's return value, so the honesty of that toast is a property
 *     of this file.
 *
 *   • THE CROSS-TENANT REFUSAL in `addChannelMembersAction`. The re-verification
 *     `{ id: { in: userIds }, companyId, deletedAt: null }` is the only thing
 *     between a forged id and a stranger from another workspace being planted in a
 *     private channel — which for a private channel is a read grant on everything
 *     already said in it. A browser smoke covers the happy path; until this file
 *     existed the refusal was defended by code review alone.
 *
 * WHY THE FAKE PRISMA HONOURS `where` ON THE USER LOOKUP. The recorder is copied
 * from tests/lib/actions/comment-time-soft-delete.test.ts, but the roster answer is
 * a FILTERING one, for the reason tests/lib/comments/mention-delivery.test.ts
 * states at length: a fake that ignores the filter and hands back whatever rows it
 * holds would answer the cross-tenant lookup with the stranger's row whether or not
 * the action asked for `companyId`, and the assertion would pass against the bug.
 * `usersMatching` applies `companyId` and `deletedAt` itself, exactly as Postgres
 * would, so deleting either from that `where` clause turns the test red.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client — a recorder                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → the value to resolve with, or a function of the call args. */
  const results = new Map<string, unknown>();
  /** Every path handed to `revalidatePath`, in order. */
  const revalidated: string[] = [];
  /** Anything an action swallowed into Sentry, so a thrown error cannot
   *  masquerade as a polite "Couldn't … right now." pass. */
  const errors: unknown[] = [];
  /** What `notifyUsers` was called with, and how it should answer. */
  const fanOuts: Record<string, unknown>[] = [];
  /**
   * `reached` is what the fake is told to deliver; `notified` (in-app rows) is
   * DERIVED from it, exactly as the real fan-out derives it — zero whenever the
   * caller passed `skipInApp`. Modelling that rather than letting the test set
   * both means the chat action cannot quietly go back to reporting in-app rows:
   * it would start reading 0 here and these tests would say so.
   */
  const notify = { dispatched: 0 as number, throws: false };

  // An explicit model list, not a Proxy: an action that starts reaching for a
  // NEW table fails loudly here instead of silently recording nothing.
  const MODELS = ["channel", "channelMember", "message", "user", "messageReaction"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  db.$transaction = async (arg: unknown) => {
    calls.push({ path: "$transaction", args: {} });
    return typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  };

  return {
    calls,
    results,
    revalidated,
    errors,
    fanOuts,
    notify,
    db,
    session: { value: null as unknown },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    H.revalidated.push(path);
  },
}));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
// Always-allow, so a run of write actions in one file can't trip the real
// in-memory window and turn a behavioural assertion into a 429.
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async (input: Record<string, unknown>) => {
    H.fanOuts.push(input);
    if (H.notify.throws) throw new Error("fan-out exploded");
    return {
      notified: input.skipInApp === true ? 0 : H.notify.dispatched,
      dispatched: H.notify.dispatched,
    };
  },
}));

import {
  addChannelMembersAction,
  markChannelReadAction,
  sendMessageAction,
  setChannelMuteAction,
} from "@/lib/actions/chat";

/* ────────────────────────────── helpers ─────────────────────────────────── */

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function signedInAs(role: string, id = "u_me", companyId = "c_nimbus"): void {
  H.session.value = { user: { id, companyId, role } };
}

/** The shape `loadChannelContext`'s own `select` asks for. */
function channelRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ch_general",
    slug: "general",
    name: "general",
    kind: "public",
    archivedAt: null,
    lastMessageAt: null,
    members: [{ role: "member", mutedAt: null }],
    ...over,
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.revalidated.length = 0;
  H.errors.length = 0;
  H.fanOuts.length = 0;
  H.notify.dispatched = 0;
  H.notify.throws = false;
  H.session.value = null;
  signedInAs("member");
});

/* ═══════════ chat-007 — reading a channel clears its own badge ════════════
 *
 * The unread pill lives in <ChannelRail>, which is rendered from
 * `listChannelsForUser()` inside app/(app)/chat/[slug]/page.tsx — so the cached
 * render that has to be thrown away is the one for "/chat/<slug>", the page the
 * reader is looking at. `markChannelReadAction` revalidated "/chat" only, which
 * is the index route: the watermark moved in the database and the badge beside
 * the reader's own cursor kept claiming unread messages until they navigated
 * away and back. Every other write in the file — send, delete, react, add
 * members — already revalidates both, so this was the odd one out rather than a
 * deliberate exception.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("markChannelReadAction (chat-007)", () => {
  function readableChannel(): void {
    when("channel.findFirst", () => channelRow({ slug: "general" }));
    when("message.findFirst", () => ({ id: "m_newest" }));
    when("channelMember.update", () => ({}));
  }

  it("revalidates the channel's OWN path, so the badge clears where the reader is", async () => {
    readableChannel();

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res.success).toBe(true);
    expect(H.errors).toEqual([]);
    // The rail is rendered by /chat/[slug]. Revalidating only the index leaves
    // the badge the reader is looking at untouched.
    expect(H.revalidated).toContain("/chat/general");
  });

  it("still revalidates the index route as well", async () => {
    readableChannel();

    await markChannelReadAction({ channelId: "ch_general" });

    // Both, not one instead of the other: /chat is the index the empty state
    // and the DM list render from, and it was never the wrong thing to clear.
    expect(H.revalidated).toContain("/chat");
  });

  it("actually moved the watermark on the run that revalidates", async () => {
    readableChannel();

    await markChannelReadAction({ channelId: "ch_general" });

    // Guards the guard: if the action bailed early (no membership row, say) it
    // would revalidate nothing and the assertions above would fail for a reason
    // unrelated to the finding. This pins that the happy path actually ran.
    const updates = callsTo("channelMember.update");
    expect(updates).toHaveLength(1);
    expect((updates[0].data as Record<string, unknown>).lastReadMessageId).toBe("m_newest");
  });

  it("revalidates nothing when the caller is not a member", async () => {
    // A public channel the reader never joined has no watermark to move, and
    // must not be silently joined by being read.
    when("channel.findFirst", () => channelRow({ members: [] }));

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res.success).toBe(true);
    expect(callsTo("channelMember.update")).toHaveLength(0);
    expect(H.revalidated).toEqual([]);
  });

  /* ═══ chat-014 — the read receipt is not an app-wide cache eviction ════════
   *
   * This is the most frequent write in the product: the client fires it 750ms
   * after every transition into the at-bottom state, so a reader flicking up
   * and down a long channel sends a stream of them. Each one ran a membership
   * read, a newest-message read, a two-column UPDATE and TWO `revalidatePath`
   * calls on a shared cache tag — for a watermark that, nine times out of ten,
   * was already exactly where it was being moved to.
   *
   * WHAT IS DELIBERATELY NOT DONE: the limiter the finding asked for. The
   * exemption in this action's own header is right and stays — a rejected
   * receipt spends the budget the reader's next MESSAGE needs, and
   * `limiters.read` is already carrying the five-second liveness poll, which
   * fails silently by design. The fix is to stop doing pointless work, not to
   * price it.
   *
   * `moved` is the other half: the client only tells the sidebar's Chat badge
   * to refetch when something actually changed. The non-member branch above
   * returned a bare success, so the badge re-read the whole count on every
   * message in a public channel nobody had joined (audit row A54).
   * ═════════════════════════════════════════════════════════════════════════ */
  it("writes nothing, and evicts no cache, when the watermark is already there", async () => {
    when("channel.findFirst", () =>
      channelRow({ members: [{ role: "member", mutedAt: null, lastReadMessageId: "m_newest" }] })
    );
    when("message.findFirst", () => ({ id: "m_newest" }));

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res).toMatchObject({ success: true, data: { moved: false } });
    expect(callsTo("channelMember.update")).toHaveLength(0);
    expect(H.revalidated).toEqual([]);
  });

  it("writes, and evicts, when a newer message HAS arrived", async () => {
    // Guards the guard: a short-circuit that fired unconditionally would leave
    // every badge in the product permanently stale.
    when("channel.findFirst", () =>
      channelRow({ members: [{ role: "member", mutedAt: null, lastReadMessageId: "m_old" }] })
    );
    when("message.findFirst", () => ({ id: "m_newest" }));
    when("channelMember.update", () => ({}));

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res).toMatchObject({ success: true, data: { moved: true } });
    expect(callsTo("channelMember.update")).toHaveLength(1);
    expect(H.revalidated).toContain("/chat/general");
  });

  it("says plainly that nothing moved for a non-member", async () => {
    // Audit row A54: this returned a bare success, and the client reads success
    // as "tell the sidebar to refetch its unread total" — so every message in a
    // public channel the reader never joined cost a round trip to learn the
    // count had not changed.
    when("channel.findFirst", () => channelRow({ members: [] }));

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res).toMatchObject({ success: true, data: { moved: false } });
  });

  it("marks an empty channel read without writing anything", async () => {
    // No messages at all: there is nothing unread, so there is nothing to
    // record. `null === null` is the same "did not move" answer.
    when("channel.findFirst", () =>
      channelRow({ members: [{ role: "member", mutedAt: null, lastReadMessageId: null }] })
    );
    when("message.findFirst", () => null);

    const res = await markChannelReadAction({ channelId: "ch_general" });

    expect(res).toMatchObject({ success: true, data: { moved: false } });
    expect(callsTo("channelMember.update")).toHaveLength(0);
  });
});

/* ═══════════ chat-012 — the mute lever, server side ════════════════════════
 *
 * `ChannelMember.mutedAt` was read by both notification fan-outs in this file
 * and written by NOTHING in the repo — no action, no route, no control. These
 * cases are about the write that was missing and the three things it must not
 * do: join a non-member by stealth, let somebody else decide whether your phone
 * buzzes, or spend a cache eviction on a state the row already holds.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("setChannelMuteAction (chat-012)", () => {
  function member(over: Record<string, unknown> = {}): void {
    when("channel.findFirst", () => channelRow(over));
    when("channelMember.update", () => ({}));
  }

  it("writes a timestamp on MY membership row, and only mine", async () => {
    member();

    const res = await setChannelMuteAction({ channelId: "ch_general", muted: true });

    expect(res).toMatchObject({ success: true, data: { muted: true } });
    const updates = callsTo("channelMember.update");
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({
      channelId_userId: { channelId: "ch_general", userId: "u_me" },
    });
    expect((updates[0].data as Record<string, unknown>).mutedAt).toBeInstanceOf(Date);
  });

  it("clears the timestamp to unmute, rather than writing a second flag", async () => {
    // The timestamp IS the mute. A boolean beside it would be a second source
    // of truth for one fact, and the fan-out filters read `mutedAt`.
    member({ members: [{ role: "member", mutedAt: new Date("2026-09-01T00:00:00.000Z") }] });

    const res = await setChannelMuteAction({ channelId: "ch_general", muted: false });

    expect(res).toMatchObject({ success: true, data: { muted: false } });
    expect((callsTo("channelMember.update")[0].data as Record<string, unknown>).mutedAt).toBeNull();
  });

  it("refuses a non-member instead of creating a membership row for them", async () => {
    // A public channel's reader can post and be mentioned without joining. An
    // upsert here would silence them AND subscribe them to this channel's
    // unread badge forever — the stealth join markChannelReadAction refuses
    // above for the same reason.
    when("channel.findFirst", () => channelRow({ members: [] }));

    const res = await setChannelMuteAction({ channelId: "ch_general", muted: true });

    expect(res.success).toBe(false);
    expect(callsTo("channelMember.update")).toHaveLength(0);
    expect(callsTo("channelMember.create")).toHaveLength(0);
    expect(callsTo("channelMember.createMany")).toHaveLength(0);
    expect(H.revalidated).toEqual([]);
  });

  it("writes nothing, and evicts nothing, when the row already says so", async () => {
    // The payload is an absolute state, not a toggle, so this is success — and
    // a second tab asking for the state the row holds should not cost two cache
    // evictions on a shared tag.
    member({ members: [{ role: "member", mutedAt: new Date("2026-09-01T00:00:00.000Z") }] });

    const res = await setChannelMuteAction({ channelId: "ch_general", muted: true });

    expect(res).toMatchObject({ success: true, data: { muted: true } });
    expect(callsTo("channelMember.update")).toHaveLength(0);
    expect(H.revalidated).toEqual([]);
  });

  it("revalidates the channel's OWN path as well as the index", async () => {
    // The bell is rendered from getChannelBySlug inside /chat/[slug], so the
    // cached render that has to go is the one the reader is looking at — the
    // chat-007 lesson, applied to a new write rather than relearned later.
    member();

    await setChannelMuteAction({ channelId: "ch_general", muted: true });

    expect(H.revalidated).toContain("/chat/general");
    expect(H.revalidated).toContain("/chat");
  });

  it("will not mute a channel this caller cannot even see", async () => {
    // A private channel they were never added to. One refusal for "not yours"
    // and "does not exist", so this cannot be used to discover that
    // #acquisition exists.
    when("channel.findFirst", () => channelRow({ kind: "private", members: [] }));

    const res = await setChannelMuteAction({ channelId: "ch_general", muted: true });

    expect(res.success).toBe(false);
    expect(callsTo("channelMember.update")).toHaveLength(0);
  });

  it("refuses a payload that does not say which way to go", async () => {
    // `muted` is the desired state; a missing one is not "toggle".
    member();

    expect((await setChannelMuteAction({ channelId: "ch_general" })).success).toBe(false);
    expect(callsTo("channelMember.update")).toHaveLength(0);
  });

  it("needs a session, like every other write here", async () => {
    H.session.value = null;
    member();

    expect((await setChannelMuteAction({ channelId: "ch_general", muted: true })).success).toBe(
      false
    );
    expect(callsTo("channelMember.update")).toHaveLength(0);
  });
});

/* ═════════ chat-005 — the composer's toast must not invent a failure ══════
 *
 * WHAT THE AUTHOR SAW. `sendMessageAction` returned `notifiedCount` (from the
 * actual createMany) and `mentionedUserIds` (the full PARSED list), and nothing
 * in between. So <MessageComposer> had no way to tell "we tried to ping one
 * person and it blew up" from "we deliberately pinged nobody", and its
 * `else if (mentionedUserIds.length > 0)` branch fired for both:
 *
 *     Sent — couldn't send mention pings (1 attempted). The team has been notified.
 *
 * In a private channel the membership filter empties the recipient list, so
 * EVERY @-mention produced that toast. It is false twice over: nothing failed,
 * and nothing was reported to anyone — `captureServerError` runs only in the
 * fan-out's catch. A warning that cries wolf on the happy path is how a user
 * learns to ignore the one toast in the composer that means something.
 *
 * TWO NEW FIELDS, because two different questions were being answered by one
 * number. `mentionAttempted` is the POST-FILTER recipient list the action was
 * actually asked to notify (the value the action already computed as
 * `mentionRecipients` and threw away), and `mentionPingsFailed` is "the fan-out
 * threw and was reported". Counting alone is not enough for the second one:
 * `notifyUsers` legitimately returns `notified: 0` without throwing when a
 * recipient has in-app notifications switched off, so `notifiedCount === 0` does
 * NOT imply an incident, and a toast claiming "the team has been notified" on
 * that basis would be the same lie in a new place.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("sendMessageAction — honest mention reporting (chat-005)", () => {
  const BILAL = { id: "u_bilal", name: "Bilal Ahmed", handle: "bilal" };
  const ME = { id: "u_me", name: "Saqib Nawaz", handle: "saqib" };

  /** Who `channelMember.findMany` answers with, per probe. */
  const rows = { members: [] as string[], muted: [] as string[], dmOthers: [] as string[] };

  function sendable(over: Record<string, unknown> = {}): void {
    rows.members = [];
    rows.muted = [];
    rows.dmOthers = [];
    when("channel.findFirst", () => channelRow(over));
    when("user.findUnique", () => ({ name: ME.name, avatar: null }));
    when("user.findMany", () => [ME, BILAL]);
    when("message.create", () => ({ id: "m_new", createdAt: new Date("2026-09-30T12:00:00Z") }));
    when("channel.update", () => ({}));
    // The action asks this delegate three different questions. Answering them
    // all with one canned list would make the membership filter untestable, so
    // the fake branches on the `where` the same way Postgres would.
    when("channelMember.findMany", (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      const muteProbe = where.mutedAt !== null && typeof where.mutedAt === "object";
      if (muteProbe) return rows.muted.map((userId) => ({ userId }));
      const userId = where.userId as Record<string, unknown> | undefined;
      if (userId && "not" in userId) return rows.dmOthers.map((id) => ({ userId: id }));
      return rows.members.map((userId) => ({ userId }));
    });
  }

  it("reports ZERO attempted when the mentioned person is not in the private channel", async () => {
    sendable({ kind: "private", members: [{ role: "owner", mutedAt: null }] });
    rows.members = []; // Bilal is not a ChannelMember here.

    const res = await sendMessageAction({ channelId: "ch_general", body: "@bilal thoughts?" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    // The parsed list still carries him, so the stored body still renders his chip.
    expect(res.data.mentionedUserIds).toEqual(["u_bilal"]);
    // But nobody was ever attempted, so there is no failure to report.
    expect(res.data.mentionAttempted).toBe(0);
    expect(res.data.mentionPingsFailed).toBe(false);
    expect(H.fanOuts).toEqual([]);
    expect(H.errors).toEqual([]);
  });

  it("reports ZERO attempted when the only person mentioned has muted the channel", async () => {
    sendable({ kind: "public" });
    rows.muted = ["u_bilal"];

    const res = await sendMessageAction({ channelId: "ch_general", body: "@bilal thoughts?" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.mentionAttempted).toBe(0);
    expect(res.data.mentionPingsFailed).toBe(false);
    expect(H.fanOuts).toEqual([]);
  });

  it("reports what it attempted when the ping really went out", async () => {
    sendable({ kind: "public" });
    H.notify.dispatched = 1;

    const res = await sendMessageAction({ channelId: "ch_general", body: "@bilal thoughts?" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.mentionAttempted).toBe(1);
    expect(res.data.notifiedCount).toBe(1);
    expect(res.data.mentionPingsFailed).toBe(false);
  });

  it("says the pings failed ONLY when the fan-out actually threw", async () => {
    sendable({ kind: "public" });
    H.notify.throws = true;

    const res = await sendMessageAction({ channelId: "ch_general", body: "@bilal thoughts?" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.mentionAttempted).toBe(1);
    expect(res.data.notifiedCount).toBe(0);
    expect(res.data.mentionPingsFailed).toBe(true);
    // "The team has been notified" is only true because THIS ran. The flag and
    // the Sentry capture are asserted together so the copy cannot outlive it.
    expect(H.errors).toHaveLength(1);
  });

  it("does NOT claim a failure when the fan-out simply reached nobody", async () => {
    // `notifyUsers` reaches nobody, without throwing, whenever every recipient
    // has this event switched off on all three channels — or was deactivated
    // between the mention being parsed and the ping being sent. Nothing failed
    // and nothing was reported, so the flag must stay down. This is the case a
    // naive `notifiedCount === 0` check gets wrong, and it is why the flag
    // exists instead of a comparison. (It used to read "in-app off, but they
    // may have had a push"; chat no longer writes in-app rows at all, so that
    // example became the normal case rather than the interesting one.)
    sendable({ kind: "public" });
    H.notify.dispatched = 0;

    const res = await sendMessageAction({ channelId: "ch_general", body: "@bilal thoughts?" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.mentionAttempted).toBe(1);
    expect(res.data.notifiedCount).toBe(0);
    expect(res.data.mentionPingsFailed).toBe(false);
    expect(H.errors).toEqual([]);
  });

  it("attempts nobody, and reports nothing, for a message with no mentions", async () => {
    sendable({ kind: "public" });

    const res = await sendMessageAction({ channelId: "ch_general", body: "shipping friday" });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.mentionedUserIds).toEqual([]);
    expect(res.data.mentionAttempted).toBe(0);
    expect(res.data.mentionPingsFailed).toBe(false);
  });
});

/* ═══════ the cross-tenant refusal in addChannelMembersAction ══════════════
 *
 * NOT ONE OF THE SIX FINDINGS. It is the third of the three things the brief
 * recorded as known-open in this slice, and the reason it is worth the space is
 * blunt: this is the only thing standing between a forged id and a stranger from
 * another workspace appearing in a private channel's member list — which for a
 * private channel is a read grant on everything already said in it, plus every
 * mention fan-out from then on. A browser smoke covers the happy path. The
 * refusal was defended by code review alone.
 *
 * THESE TESTS PASSED ON THEIR FIRST RUN, every one of them. The behaviour was
 * already right and the missing thing was the test, which is worth saying plainly
 * rather than dressing up as a fix.
 *
 * WHICH MEANS THE FAKE IS THE ONLY THING THAT MAKES THEM WORTH ANYTHING.
 * `usersMatching` applies `companyId` and `deletedAt` itself, exactly as Postgres
 * would. A fake that ignored the `where` and returned whatever rows it held would
 * answer the lookup with the stranger's row whether or not the action asked for
 * the tenancy scope, and every assertion below would pass against the bug.
 *
 * So the last case in this block drives `usersMatching` DIRECTLY with the unscoped
 * clause the bug would have produced, and shows it hands the stranger back. That
 * is the guard-the-guard step (house rule 27) in the form available here: the
 * direct version — deleting `companyId` from the action and watching these go red
 * — was attempted and refused by the permission system as a deliberate weakening
 * of a security check, which is the right refusal. It is recorded in the report so
 * a reviewer with that permission can run it in one edit.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("addChannelMembersAction — tenancy re-verification", () => {
  const MINE = { id: "u_bilal", companyId: "c_nimbus", deletedAt: null };
  const STRANGER = { id: "u_outsider", companyId: "c_othercorp", deletedAt: null };
  const GONE = { id: "u_departed", companyId: "c_nimbus", deletedAt: new Date("2026-08-01") };

  /** Every user row in the fake database, across BOTH workspaces. */
  const WORLD = [MINE, STRANGER, GONE];

  /** Answer `user.findMany` the way Postgres would: apply the caller's where. */
  function usersMatching(args: Record<string, unknown>): { id: string }[] {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const idIn = ((where.id ?? {}) as { in?: string[] }).in ?? [];
    return WORLD.filter((u) => {
      if (idIn.indexOf(u.id) === -1) return false;
      // `in` on an absent key means "no filter", which is precisely the bug these
      // tests exist to catch — so the absence is honoured rather than defaulted.
      if ("companyId" in where && where.companyId !== u.companyId) return false;
      if ("deletedAt" in where && where.deletedAt === null && u.deletedAt !== null) return false;
      return true;
    }).map((u) => ({ id: u.id }));
  }

  function myPrivateChannel(): void {
    // I own it, so `canManageChannel` admits me on the channel role alone — no
    // company role needed, which is the case a private channel's creator is in.
    when("channel.findFirst", () =>
      channelRow({
        id: "ch_raise",
        slug: "pvt-raise",
        name: "pvt-raise",
        kind: "private",
        members: [{ role: "owner", mutedAt: null }],
      })
    );
    when("user.findMany", usersMatching);
    when("channelMember.createMany", (args: Record<string, unknown>) => ({
      count: ((args.data ?? []) as unknown[]).length,
    }));
  }

  it("refuses a forged id belonging to another workspace", async () => {
    myPrivateChannel();

    const res = await addChannelMembersAction({
      channelId: "ch_raise",
      userIds: [STRANGER.id],
    });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/nobody on that list is in this workspace/i);
    // The refusal that matters is the absent WRITE. An error string with a row
    // created behind it would be the same breach with better manners.
    expect(callsTo("channelMember.createMany")).toHaveLength(0);
  });

  it("drops the forged id and still adds the real teammate", async () => {
    // The sharp case: a mixed list must not be all-or-nothing in the direction
    // that lets the stranger ride in beside somebody legitimate.
    myPrivateChannel();

    const res = await addChannelMembersAction({
      channelId: "ch_raise",
      userIds: [MINE.id, STRANGER.id],
    });

    expect(res.success).toBe(true);
    const rows = (callsTo("channelMember.createMany")[0]?.data ?? []) as {
      userId: string;
    }[];
    expect(rows.map((r) => r.userId)).toEqual([MINE.id]);
  });

  it("refuses a tombstoned teammate", async () => {
    // Their ChannelMember rows and their User row still exist for the soft-delete
    // restore, so `id: { in: … }` alone would happily resurrect them into a rail
    // they are no longer supposed to be in.
    myPrivateChannel();

    const res = await addChannelMembersAction({
      channelId: "ch_raise",
      userIds: [GONE.id],
    });

    expect(res.success).toBe(false);
    expect(callsTo("channelMember.createMany")).toHaveLength(0);
  });

  it("names the tenancy scope in the lookup itself", async () => {
    // Belt and braces beside the behavioural assertions: they would also pass
    // against a `where` that scoped by something else that happened to exclude
    // the stranger. This names the two clauses.
    myPrivateChannel();
    await addChannelMembersAction({ channelId: "ch_raise", userIds: [MINE.id] });

    const where = (callsTo("user.findMany")[0]?.where ?? {}) as Record<string, unknown>;
    expect(where.companyId).toBe("c_nimbus");
    expect(where.deletedAt).toBeNull();
  });

  it("adds a teammate from my own workspace", async () => {
    // Guards the guard: every assertion above is satisfied by an action that
    // refuses everybody, which would make "add people" useless rather than safe.
    myPrivateChannel();

    const res = await addChannelMembersAction({
      channelId: "ch_raise",
      userIds: [MINE.id],
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.added).toBe(1);
    expect(H.errors).toEqual([]);
    // And the reader's own open channel is revalidated, not only the index.
    expect(H.revalidated).toContain("/chat/pvt-raise");
  });

  it("refuses a channel in another workspace outright, before it reads any user", async () => {
    // `loadChannelContext` scopes the CHANNEL by companyId too, so a forged
    // channelId is refused with the same generic "not found" a non-existent one
    // gets — and nothing downstream runs.
    when("channel.findFirst", () => null);

    const res = await addChannelMembersAction({
      channelId: "ch_someone_elses",
      userIds: [MINE.id],
    });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/not found/i);
    expect(callsTo("user.findMany")).toHaveLength(0);
    expect(callsTo("channelMember.createMany")).toHaveLength(0);
  });

  it("would have let the stranger through if the action had not scoped by company", () => {
    // GUARD THE GUARD. Everything above depends on `usersMatching` honouring the
    // `where` it is handed; if it ignored it, every assertion here would be
    // decoration. This is that dependency, asserted directly, in both directions.
    const asked = [MINE.id, STRANGER.id, GONE.id];

    // The clause the BUG would have sent: no tenancy, no tombstone filter.
    expect(usersMatching({ where: { id: { in: asked } } }).map((u) => u.id)).toEqual([
      MINE.id,
      STRANGER.id,
      GONE.id,
    ]);

    // The clause the action actually sends.
    expect(
      usersMatching({
        where: { id: { in: asked }, companyId: "c_nimbus", deletedAt: null },
      }).map((u) => u.id)
    ).toEqual([MINE.id]);
  });

  it("refuses a plain member who does not own the channel", async () => {
    // `canManageChannel` is the gate. Not tenancy, but the same write, and a test
    // file for this action that omitted it would be inviting the next reader to
    // assume it was covered.
    when("channel.findFirst", () =>
      channelRow({ kind: "private", members: [{ role: "member", mutedAt: null }] })
    );
    when("user.findMany", usersMatching);

    const res = await addChannelMembersAction({ channelId: "ch_general", userIds: [MINE.id] });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatch(/owner or an admin/i);
    expect(callsTo("channelMember.createMany")).toHaveLength(0);
  });
});
