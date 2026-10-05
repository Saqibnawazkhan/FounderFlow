/**
 * Chat does not email. Comments still do.
 *
 * THE DEFECT, as the owner reported it: "each chat message gets emailed too,
 * should only come as a push notification and an in-app notification, not an
 * email notification — a user in a busy channel will receive 100s of emails
 * just from chat."
 *
 * Both halves of chat were emailing. `lib/actions/chat.ts` fanned its @mention
 * out as `event: "mention"` — all three channels deliverable, email on by
 * default — and its DM fan-out raised `event: "dm"`, likewise email-by-default.
 * One @-mention per message in an active channel is one email per message, and
 * `DAILY_NOTIFICATION_EMAIL_BUDGET` (300) is shared with every other
 * notification in the product, so a busy afternoon of chat also silences
 * budget alerts and task assignments for everybody else in the workspace.
 *
 * WHY THIS FILE EXISTS RATHER THAN A UNIT TEST OF THE EVENT MAP. The thing
 * that must be true is a sentence about two call sites and one delivery path:
 * a chat mention sends no email, and a comment mention naming the SAME person
 * still does. No test that mocks `notifyUsers` can see that — it would assert
 * the argument, not the outcome — and no test of `notifyUsers` alone can see
 * which event each action raises. So this one drives the REAL
 * `sendMessageAction`, the REAL `createCommentAction` and the REAL fan-out,
 * and mocks only the two delivery boundaries (`lib/notify/email`,
 * `lib/push/notify`) and Prisma.
 *
 * It was RED before the fix: the chat case saw `fireNotificationEmails` called
 * with Bilal's address.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → a canned value, or a function of the call args. */
  const results = new Map<string, unknown>();
  const errors: unknown[] = [];

  // An explicit model list rather than a Proxy: an action that starts reaching
  // for a new table fails loudly here instead of silently recording nothing.
  const MODELS = [
    "channel",
    "channelMember",
    "message",
    "user",
    "notification",
    "notificationPreference",
    "comment",
    "task",
    "project",
    "transaction",
  ];
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
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { calls, results, errors, db, session: { value: null as unknown } };
});

/** The two delivery boundaries. Everything else in the path is real. */
const emailed = vi.fn();
const pushed = vi.fn();

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
// Always-allow, so a run of writes in one file cannot trip the real in-memory
// window and turn a delivery assertion into a 429.
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
vi.mock("@/lib/notify/email", () => ({
  fireNotificationEmails: (...args: unknown[]) => emailed(...args),
  linkBase: () => "http://localhost:3000",
}));
vi.mock("@/lib/push/notify", () => ({
  pushForNotificationRows: (...args: unknown[]) => pushed(...args),
}));

import { sendMessageAction } from "@/lib/actions/chat";
import { createCommentAction } from "@/lib/actions/comments";

/* ──────────────────────────────── fixtures ─────────────────────────────── */

const ME = {
  id: "u_me",
  name: "Ayesha Raza",
  handle: "ayesha",
  role: "admin",
  avatar: null,
  email: "ayesha@nimbus.app",
};
/**
 * A cofounder, deliberately: the comment half of this test posts on a task
 * Bilal neither owns nor was assigned, and `mayAccessTaskThread` lets a
 * cofounder read any thread. A plain member would be filtered out of the
 * comment fan-out before any channel decision was made, and the test would go
 * green for the wrong reason.
 */
const BILAL = {
  id: "u_bilal",
  name: "Bilal Ahmed",
  handle: "bilal",
  role: "cofounder",
  avatar: null,
  email: "bilal@nimbus.app",
};

/** Push is fire-and-forget behind a dynamic import; let the microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

/** Every address `fireNotificationEmails` was handed, across all calls. */
function emailAddresses(): string[] {
  const out: string[] = [];
  for (const call of emailed.mock.calls) {
    const job = call[0] as { recipients?: Array<{ email: string }> } | undefined;
    for (const r of job?.recipients ?? []) out.push(r.email);
  }
  return out;
}

/** Every user id a push was raised for. */
function pushedIds(): string[] {
  const out: string[] = [];
  for (const call of pushed.mock.calls) {
    for (const row of (call[0] as Array<{ userId: string }>) ?? []) out.push(row.userId);
  }
  return out;
}

/** Every user id an in-app Notification row was written for. */
function inAppIds(): string[] {
  const out: string[] = [];
  for (const args of callsTo("notification.createMany")) {
    for (const row of (args.data as Array<{ userId: string }>) ?? []) out.push(row.userId);
  }
  return out;
}

/**
 * Wire the chat write path. `kind` chooses between a public channel (the
 * @mention case) and a DM (the direct-message case).
 */
function chatIsSendable(kind: "public" | "dm", dmOthers: string[] = []): void {
  when("channel.findFirst", () => ({
    id: "ch_general",
    slug: kind === "dm" ? "dm-ayesha-bilal" : "general",
    name: kind === "dm" ? "Ayesha & Bilal" : "general",
    kind,
    archivedAt: null,
    lastMessageAt: null,
    members: [{ role: "member", mutedAt: null }],
  }));
  when("user.findUnique", () => ({ ...ME }));
  when("message.create", () => ({ id: "m_new", createdAt: new Date("2026-10-05T10:00:00Z") }));
  when("channel.update", () => ({}));
  // The action asks this delegate three different questions. Branch on the
  // `where` the way Postgres would, or the membership filter is untestable.
  when("channelMember.findMany", (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const mutedProbe = where.mutedAt !== null && typeof where.mutedAt === "object";
    if (mutedProbe) return [];
    const userId = where.userId as Record<string, unknown> | undefined;
    if (userId && "not" in userId) return dmOthers.map((id) => ({ userId: id }));
    // The private/DM membership intersection: everyone named is a member.
    const inList = ((userId?.in as string[] | undefined) ?? []).map((id) => ({ userId: id }));
    return inList;
  });
}

/** Wire the comment write path on a task Bilal can read as a cofounder. */
function commentIsPostable(): void {
  when("task.findUnique", () => ({
    companyId: "c_nimbus",
    deletedAt: null,
    projectId: "p_1",
    assignedTo: "u_me",
    assignedBy: "u_me",
  }));
  when("project.findFirst", () => ({ supervisorId: null }));
  when("user.findUnique", () => ({ ...ME }));
  when("comment.create", () => ({ id: "cm_1", taskId: "t_1" }));
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.errors.length = 0;
  H.session.value = { user: { id: ME.id, companyId: "c_nimbus", role: "admin" } };
  emailed.mockClear();
  pushed.mockClear();

  // The roster read, and the fan-out's own live-recipient read, hit the same
  // delegate with different `where` clauses. Branch on `id`, exactly as the
  // real queries differ: the roster asks by company, the fan-out asks by id.
  when("user.findMany", (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const ids = (where.id as { in?: string[] } | undefined)?.in;
    const all = [ME, BILAL];
    if (ids) return all.filter((u) => ids.indexOf(u.id) !== -1);
    return all;
  });
  // Nobody has touched their preferences: every recipient resolves through
  // DEFAULT_CHANNELS, which is the state every real user is in today.
  when("notificationPreference.findMany", () => []);
  when("notification.createMany", (args: Record<string, unknown>) => ({
    count: (args.data as unknown[]).length,
  }));
});

/* ════════════════════════════ THE HEADLINE ═══════════════════════════════ */

describe("chat delivers on push and in-app, never email", () => {
  it("sends NO email when a chat message @mentions someone", async () => {
    chatIsSendable("public");

    const res = await sendMessageAction({
      channelId: "ch_general",
      body: "@bilal can you look at the burn figure before standup?",
    });

    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(H.errors, "the fan-out threw").toEqual([]);
    expect(
      emailAddresses(),
      "a chat @mention emailed somebody — a busy channel is hundreds of emails"
    ).toEqual([]);
  });

  it("still pushes and still writes the in-app row for that same chat @mention", async () => {
    // The other half of the owner's sentence. Removing email must not be done
    // by removing the notification: a mention names a person, and the Chat
    // badge cannot say that one of the unread messages was addressed to them.
    chatIsSendable("public");

    await sendMessageAction({
      channelId: "ch_general",
      body: "@bilal can you look at the burn figure before standup?",
    });
    await settle();

    expect(inAppIds(), "the durable mention row").toEqual(["u_bilal"]);
    expect(pushedIds(), "the push that interrupts").toEqual(["u_bilal"]);
  });

  it("STILL EMAILS a comment @mention of the same person", async () => {
    // The blunt fix — dropping email from the `mention` row — would silence
    // this, and nobody asked for that. A task comment is low volume and an
    // email there is the point of the feature.
    commentIsPostable();

    const res = await createCommentAction({
      body: "@bilal is this invoice ours?",
      taskId: "t_1",
    });

    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(H.errors, "the fan-out threw").toEqual([]);
    expect(emailAddresses(), "a comment mention must still reach the inbox").toEqual([
      "bilal@nimbus.app",
    ]);
  });

  it("sends no email for a direct message either", async () => {
    chatIsSendable("dm", ["u_bilal"]);

    const res = await sendMessageAction({
      channelId: "ch_general",
      body: "are you around this afternoon?",
    });
    await settle();

    expect(res.success, JSON.stringify(res)).toBe(true);
    expect(emailAddresses(), "DM traffic must never reach the inbox").toEqual([]);
    // Unchanged and deliberate: a DM's unread signal is the Chat badge, so it
    // writes no notification row. Push is its only real-time channel.
    expect(inAppIds(), "a DM deliberately writes no in-app row").toEqual([]);
    expect(pushedIds(), "push is all a DM has left").toEqual(["u_bilal"]);
  });

  it("sends no chat email even for someone who has email switched ON for chat mentions", async () => {
    // Defence in depth. `EVENT_DELIVERABLE_CHANNELS` is what the settings page
    // reads to decide which checkboxes to render, and before this change it was
    // read by NOTHING ELSE — so a stored row saying `email: true` for an event
    // whose email cell the UI never shows would have been honoured by the
    // fan-out. `updateNotificationPreferenceAction` accepts any (event,
    // channel) pair in NOTIFY_EVENTS × NOTIFY_CHANNELS, so such a row is a
    // single hand-made request away, and a stale one could also survive a
    // future rename. The map is now enforced where delivery happens.
    chatIsSendable("public");
    when("notificationPreference.findMany", (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      return [{ userId: "u_bilal", event: where.event, inApp: true, email: true, push: true }];
    });

    await sendMessageAction({
      channelId: "ch_general",
      body: "@bilal standup moved to 4",
    });

    expect(emailAddresses(), "an undeliverable channel must not be re-openable by a row").toEqual(
      []
    );
  });
});
