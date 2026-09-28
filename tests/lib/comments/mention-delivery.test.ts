/**
 * Does an @mention actually reach the person, and does its notification
 * actually go somewhere?
 *
 * TWO FINDINGS, ONE FILE, because they are the two halves of one journey and
 * each is worthless without the other: a ping that never fires (001), and a
 * ping whose link is inert (003). Fixing either alone leaves the feature
 * broken, and splitting them across two files lets one rot while the other
 * stays green.
 *
 * ── tasks-and-comments-001 ────────────────────────────────────────────────
 * `createCommentAction` loaded the roster as `select: { id: true, name: true }`.
 * `MentionUser.handle` is OPTIONAL IN THE TYPE — deliberately, so older roster
 * queries keep compiling — so the omission was not a type error and not a
 * runtime error. It was silence: pass 1 of `buildMentionIndex` indexed no
 * handles, `@ali` resolved to nobody, `Comment.mentions` was stored as `"[]"`,
 * and zero notifications fanned out. Meanwhile lib/queries/comments.ts DOES
 * select `handle`, so the posted comment rendered a chip reading "Mentioned Ali
 * Khan". The writer was told the ping landed. It had not. For a teammate whose
 * display name carries no ASCII letters — the Urdu-script case `User.handle`
 * exists for — the handle is their ONLY address, so they could never be
 * mentioned at all. The same bug sat on the chat write path.
 *
 * ── tasks-and-comments-003 ────────────────────────────────────────────────
 * The notification's link was `/tasks?comment=<commentId>`. NOTHING in the
 * application reads a `comment` search param — the only `searchParams.get`
 * under app/(app)/ is `taskId`. So the one call to action a mention has landed
 * on a bare board. Worse for a MEMBER, whose board is filtered to
 * `assignedTo: userId`: a mention on a teammate's task sent them to a list that
 * provably does not contain it.
 *
 * ── WHY THE FAKE PRISMA PROJECTS `select` ─────────────────────────────────
 * This is the load-bearing detail of the whole file. A fake that ignored
 * `select` and handed back whole rows would hand the action a roster carrying
 * `handle` whether or not the action asked for it — and every assertion below
 * would have passed against the bug. The property under test is precisely
 * "does this action ASK for the handle", so the fake answers `user.findMany`
 * with the caller's own projection, exactly as Postgres would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMentions, tokenizeForRender } from "@/lib/comments/mentions";

/* ───────────────────────── the fake Prisma client ───────────────────────── */

type Row = Record<string, unknown>;
type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  /** Keyed "delegate.method". `has`, not `??`, so a deliberate null is a miss. */
  const answers = new Map<string, unknown>();
  /** The workspace roster, as full rows. Projected per query. See the header. */
  const users: Record<string, unknown>[] = [];

  /** Copy only the keys the caller's `select` asked for, like SQL would. */
  function project(rows: Record<string, unknown>[], select: unknown) {
    if (!select || typeof select !== "object") return rows.map((r) => ({ ...r }));
    const wanted: string[] = [];
    const s = select as Record<string, unknown>;
    for (const key of Object.keys(s)) if (s[key] === true) wanted.push(key);
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const key of wanted) out[key] = row[key];
      return out;
    });
  }

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    if (delegate === "user" && method === "findMany") {
      const select = (args[0] as { select?: unknown } | undefined)?.select;
      return Promise.resolve(project(users, select));
    }
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy rather than a literal fake, for the reason
  // tests/lib/auth/finance-gate.test.ts gives: a literal only knows the
  // delegates that existed the day it was written.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_t, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "$transaction") {
          return (cb: (tx: unknown) => unknown) => Promise.resolve(cb(db));
        }
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, users, db };
});

const notify = vi.hoisted(() => ({
  // The parameter is declared even though the body ignores it: without it the
  // call tuple is `[]` and reading `mock.calls[0][0]` is a TS2493 at typecheck
  // while passing happily under vitest.
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 1 })),
}));

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

const session = vi.hoisted(() => ({
  user: {
    id: "u_author",
    companyId: "c_nimbus",
    role: "admin",
  } as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve({ user: session.user }) }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCommentAction, deleteCommentAction } from "@/lib/actions/comments";
import { sendMessageAction } from "@/lib/actions/chat";

/* ───────────────────────────── the roster ──────────────────────────────── */

/**
 * Mahwish is the population `User.handle` was added for: "مہوش زیدی" slugifies
 * to `"-"`, which is not a typable mention token, so her handle is the only
 * address she has. Ali has both.
 */
const MAHWISH = { id: "u_mahwish", name: "مہوش زیدی", handle: "mahwish", avatar: null };
const ALI = { id: "u_ali", name: "Ali Khan", handle: "ali", avatar: null };
const AUTHOR = { id: "u_author", name: "Ayesha Raza", handle: "ayesha", avatar: null };

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

/** What `notifyUsers` was asked to send, or null if it was never called. */
function fanOut(): Record<string, unknown> | null {
  const call = notify.notifyUsers.mock.calls[0];
  return call ? (call[0] as Record<string, unknown>) : null;
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.users.length = 0;
  prisma.users.push({ ...AUTHOR }, { ...ALI }, { ...MAHWISH });
  notify.notifyUsers.mockClear();
  sentry.captureServerError.mockClear();
  session.user = { id: "u_author", companyId: "c_nimbus", role: "admin" };

  // The author profile, the comment target, and the row the create returns.
  prisma.answers.set("user.findUnique", { ...AUTHOR });
  prisma.answers.set("task.findUnique", { companyId: "c_nimbus" });
  prisma.answers.set("comment.create", { id: "cm_1", taskId: "t_1" });
});

/* ══════ tasks-and-comments-001 — the ping reaches the person ═══════════ */

describe("a comment @mention reaches the teammate it names (tasks-and-comments-001)", () => {
  it("notifies the person whose HANDLE was typed", async () => {
    const res = await createCommentAction({
      body: "@ali can you sanity-check the burn figure?",
      taskId: "t_1",
    });

    expect(res.success).toBe(true);
    expect(fanOut()).toMatchObject({ userIds: ["u_ali"] });
  });

  it("reaches a teammate whose display name has no ASCII letters at all", async () => {
    // Her name slugifies to "-", which MENTION_REGEX can never produce. If the
    // roster arrives without `handle`, she is unmentionable inside her own
    // workspace — the exact bug the handle column was added to fix.
    const res = await createCommentAction({
      body: "@mahwish please take a look",
      taskId: "t_1",
    });

    expect(res.success).toBe(true);
    expect(fanOut()).toMatchObject({ userIds: ["u_mahwish"] });
  });

  it("stores the resolved mention on the comment rather than an empty list", async () => {
    await createCommentAction({ body: "@ali and @mahwish — ready?", taskId: "t_1" });

    const create = callsTo("comment", "create")[0];
    const data = (create.args[0] as { data: { mentions: string } }).data;
    expect(JSON.parse(data.mentions)).toEqual(["u_ali", "u_mahwish"]);
  });

  it("reports honestly how many people it pinged", async () => {
    notify.notifyUsers.mockResolvedValueOnce({ notified: 2 });
    const res = await createCommentAction({ body: "@ali @mahwish", taskId: "t_1" });

    expect(res.success && res.data.mentionedUserIds).toEqual(["u_ali", "u_mahwish"]);
    expect(res.success && res.data.notifiedCount).toBe(2);
  });

  it("makes the chip and the notification agree over one roster", async () => {
    // lib/comments/mentions.ts promises "a chip renders exactly when a
    // notification fired". The two paths used to be fed DIFFERENT rosters —
    // the write path's had no handles, the read path's did — which is how the
    // product managed to show a green "Mentioned Ali Khan" chip on a comment
    // that had pinged nobody.
    const body = "@mahwish and @ali, standup at 4";
    await createCommentAction({ body, taskId: "t_1" });

    const notified = (fanOut()?.userIds as string[]) ?? [];
    const roster = [AUTHOR, ALI, MAHWISH];
    const chipped = tokenizeForRender(body, roster)
      .filter((s): s is { type: "mention"; slug: string; userId?: string } => s.type === "mention")
      .map((s) => s.userId)
      .filter((id): id is string => typeof id === "string");

    expect(notified.slice().sort()).toEqual(chipped.slice().sort());
    // And the parser itself, over the same roster, agrees with both.
    expect(extractMentions(body, roster, "u_author").slice().sort()).toEqual(
      notified.slice().sort()
    );
  });

  it("does the same on the chat write path", async () => {
    // sendMessageAction carried the identical omission. A public channel so
    // the membership intersection does not mask the result.
    prisma.answers.set("channel.findFirst", {
      id: "ch_general",
      slug: "general",
      name: "general",
      kind: "public",
      archivedAt: null,
      lastMessageAt: null,
      members: [{ role: "member", mutedAt: null }],
    });
    prisma.answers.set("message.create", { id: "m_1", createdAt: new Date() });
    prisma.answers.set("channelMember.findMany", []);

    const res = await sendMessageAction({
      channelId: "ch_general",
      body: "@mahwish the deck is up",
    });

    expect(res.success).toBe(true);
    expect(fanOut()).toMatchObject({ userIds: ["u_mahwish"] });
  });
});

/* ══════ tasks-and-comments-003 — the ping leads somewhere ══════════════ */

describe('clicking "X mentioned you" opens the thing it points at (tasks-and-comments-003)', () => {
  it("deep-links a task mention at the task, not at a bare board", async () => {
    await createCommentAction({ body: "@ali have a look", taskId: "t_1" });

    const link = String(fanOut()?.link ?? "");
    // `?taskId=` is the ONE deep-link param the app actually reads
    // (app/(app)/tasks/tasks-client.tsx), and it scrolls + flashes the card.
    expect(link).toContain("taskId=t_1");
    // The comment id is still carried, so the thread can be opened once a
    // client reads it — and so deleteCommentAction can sweep this row.
    expect(link).toContain("comment=cm_1");
  });

  it("deep-links a transaction mention at the transaction", async () => {
    session.user = { id: "u_author", companyId: "c_nimbus", role: "admin" };
    prisma.answers.set("transaction.findUnique", { companyId: "c_nimbus" });
    prisma.answers.set("comment.create", { id: "cm_2", transactionId: "tx_9" });

    await createCommentAction({ body: "@ali is this ours?", transactionId: "tx_9" });

    const link = String(fanOut()?.link ?? "");
    expect(link).toContain("transactionId=tx_9");
    expect(link).toContain("comment=cm_2");
  });

  it("sweeps a mention notification when its comment is deleted", async () => {
    // Audit X10, applied to comments: deleteTaskAction already sweeps
    // `taskId=` links so a notification never lands on something gone. A
    // deleted comment's ping is the same dead end.
    prisma.answers.set("comment.findUnique", {
      id: "cm_1",
      companyId: "c_nimbus",
      authorId: "u_author",
      taskId: "t_1",
      transactionId: null,
    });

    const res = await deleteCommentAction({ commentId: "cm_1" });
    expect(res.success).toBe(true);

    const sweeps = callsTo("notification", "deleteMany");
    expect(sweeps.length).toBe(1);
    expect(JSON.stringify(sweeps[0].args[0])).toContain("comment=cm_1");
  });
});

/* ══════════ the structural half: this must not come back ══════════════ */

describe("every mention write path asks for the handle it resolves against", () => {
  /**
   * `extractMentions` is the NOTIFICATION path — the one whose silence nobody
   * can see. Sweeping by import rather than by a hard-coded list means the
   * third module to fan a mention out is covered on the day it lands.
   *
   * The render path (`tokenizeForRender`) has the mirror-image requirement and
   * is NOT swept here, because one of its two call sites lives in
   * lib/queries/chat.ts, which this agent does not own — see the report's
   * needsOtherFiles entry for `loadRoster`.
   */
  const MENTION_WRITERS = ["lib/actions/chat.ts", "lib/actions/comments.ts"];

  /**
   * Every `user.findMany` select in `src` that asks for `name`, paired with
   * whether it also asks for `handle`. Regex-scanned rather than parsed: the
   * shape is a literal object in a literal call, and the fixture below drives
   * the detector over a reconstruction of the bug so an empty answer cannot be
   * mistaken for a clean one.
   */
  function rosterSelects(src: string): { text: string; hasHandle: boolean }[] {
    const out: { text: string; hasHandle: boolean }[] = [];
    // `user.findMany(` … the first `select: { … }` after it.
    const re = /user\.findMany\(([\s\S]{0,600}?)\}\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const block = m[1];
      const sel = /select:\s*\{([^}]*)\}/.exec(block);
      if (!sel) continue;
      if (!/\bname:\s*true\b/.test(sel[1])) continue;
      out.push({ text: sel[1], hasHandle: /\bhandle:\s*true\b/.test(sel[1]) });
    }
    return out;
  }

  it("finds a roster select in each module, so an empty sweep is not a pass", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of MENTION_WRITERS) {
      const selects = rosterSelects(readFileSync(rel, "utf8"));
      expect(selects.length, `${rel} has no name-bearing user.findMany select`).toBeGreaterThan(0);
    }
  });

  it("selects handle in every one of them", async () => {
    const { readFileSync } = await import("node:fs");
    const offenders: string[] = [];
    for (const rel of MENTION_WRITERS) {
      const src = readFileSync(rel, "utf8");
      if (!src.includes("extractMentions")) continue;
      for (const sel of rosterSelects(src)) {
        if (!sel.hasHandle) offenders.push(`${rel}: select: {${sel.text.trim()}}`);
      }
    }
    expect(
      offenders,
      "A roster handed to extractMentions without `handle: true` resolves @handle " +
        "tokens to nobody and fans out ZERO notifications, while the read path " +
        "still renders a mention chip. It compiles, because MentionUser.handle " +
        "is optional in the type."
    ).toEqual([]);
  });

  it("the detector actually reports a handle-less roster", () => {
    // Every assertion above is "the offender list is empty", which passes just
    // as happily when the detector has stopped working.
    const bug = `
      const roster = await db.user.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true, name: true },
      });
    `;
    const found = rosterSelects(bug);
    expect(found.length).toBe(1);
    expect(found[0].hasHandle).toBe(false);

    const fixed = bug.replace("name: true", "name: true, handle: true");
    expect(rosterSelects(fixed)[0].hasHandle).toBe(true);
  });
});
