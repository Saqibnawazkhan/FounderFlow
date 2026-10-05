import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyUsers } from "@/lib/notify/fan-out";

// The helper falls back to the shared Prisma client when no `tx` is passed.
// Stub it so importing this module never constructs a real client — every test
// below drives the write through an explicit fake client instead.
vi.mock("@/lib/db", () => ({
  db: {
    notification: { createMany: vi.fn() },
    notificationPreference: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

// Push is raised here now (it used to be a Prisma $extends hook in lib/db.ts),
// so it is assertable. The helper imports it dynamically to break a cycle;
// vi.mock intercepts that just as it would a static import.
const pushForNotificationRows = vi.fn();
vi.mock("@/lib/push/notify", () => ({
  pushForNotificationRows: (...args: unknown[]) => pushForNotificationRows(...args),
}));

// Email routing is asserted here; the mechanics of rendering and the daily
// budget are covered by tests/lib/email/quota.test.ts and the template itself.
const fireNotificationEmails = vi.fn();
vi.mock("@/lib/notify/email", () => ({
  fireNotificationEmails: (...args: unknown[]) => fireNotificationEmails(...args),
  linkBase: () => "http://localhost:3000",
}));

/**
 * The finance entitlement rule (sec-005). It lives in lib/queries/notifications
 * beside the read-time filter it has to agree with, and it is unit-tested there
 * over 15 cases — so what is asserted HERE is the wiring: that the fan-out asks
 * it, asks it with the right scope, and honours the answer on all three
 * channels. Mocked rather than exercised, because the real module reaches a
 * Prisma client and the rule itself already has its own suite.
 *
 * The default implementation is a pass-through so that every pre-existing
 * finance-category test in this file keeps meaning what it meant.
 */
const financeRecipients = vi.fn();
vi.mock("@/lib/queries/notifications", () => ({
  financeRecipients: (...args: unknown[]) => financeRecipients(...args),
}));

type Stored = { userId: string; event: string; inApp: boolean; email: boolean; push: boolean };

/**
 * Stand-in for the `Pick<typeof db, "notification" | "notificationPreference" |
 * "user">` the helper takes.
 *
 * `user.findMany` MODELS THE FILTER rather than ignoring it: ids listed in
 * `tombstoned` come back only when the query did not ask for
 * `deletedAt: null`. A fake that returns every id whatever the `where` says
 * cannot fail for data-integrity-004 — it would agree with the bug.
 */
function fakeClient(stored: Stored[] = [], tombstoned: string[] = []) {
  const calls: { data: Record<string, unknown>[] }[] = [];
  const lookups: Array<Record<string, unknown>> = [];
  return {
    calls,
    lookups,
    client: {
      notification: {
        createMany: async (args: { data: Record<string, unknown>[] }) => {
          calls.push(args);
          return { count: args.data.length };
        },
      },
      notificationPreference: {
        findMany: async () => stored,
      },
      user: {
        findMany: async (args: { where: { id: { in: string[] }; deletedAt?: null } }) => {
          lookups.push(args.where as Record<string, unknown>);
          const wantsLiveOnly = args.where.deletedAt === null;
          return args.where.id.in
            .filter((id) => !(wantsLiveOnly && tombstoned.indexOf(id) !== -1))
            .map((id) => ({ id, name: `User ${id}`, email: `${id}@nimbus.app` }));
        },
      },
    } as never,
  };
}

const base = {
  event: "task_assigned",
  companyId: "c1",
  title: "New task assigned",
  message: "Ali assigned you something",
  category: "task",
} as const;

/** A stored row that mutes one channel and leaves the rest on. */
function mute(userId: string, event: string, channel: "inApp" | "email" | "push"): Stored {
  return { userId, event, inApp: true, email: true, push: true, [channel]: false } as Stored;
}

/** Push is fire-and-forget behind a dynamic import; let the microtask run. */
const settlePush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  pushForNotificationRows.mockClear();
  fireNotificationEmails.mockClear();
  financeRecipients.mockReset();
  financeRecipients.mockImplementation((ids: string[]) => Promise.resolve(ids));
});

describe("notifyUsers (the single notification delivery path)", () => {
  it("writes one row per recipient and reports how many landed", async () => {
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(res.notified).toBe(2);
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1", "u2"]);
  });

  it("never notifies the same person twice for one event", async () => {
    // Budget alerts union the supervisor with the task assignees, and the
    // supervisor is frequently also an assignee.
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...base, userIds: ["u1", "u1", "u2"], tx: client });
    expect(res.notified).toBe(2);
    expect(calls[0]!.data).toHaveLength(2);
  });

  it("does not notify the actor about their own action", async () => {
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], exclude: "u1", tx: client });
    expect(res.notified).toBe(1);
    expect(calls[0]!.data[0]!.userId).toBe("u2");
  });

  it("accepts several excluded people", async () => {
    const { client } = fakeClient();
    const res = await notifyUsers({
      ...base,
      userIds: ["u1", "u2", "u3"],
      exclude: ["u1", "u3"],
      tx: client,
    });
    expect(res.notified).toBe(1);
  });

  it("writes nothing at all when every recipient was excluded", async () => {
    // The old call sites guarded this with `if (target.id !== actorId)`. If the
    // helper stopped short-circuiting, Prisma would be handed an empty array on
    // every self-action.
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...base, userIds: ["u1"], exclude: "u1", tx: client });
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing when handed an empty recipient list", async () => {
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...base, userIds: [], tx: client });
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("defaults the tone to info, and carries an explicit one through", async () => {
    const { client, calls } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1"], tx: client });
    expect(calls[0]!.data[0]!.type).toBe("info");

    const second = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1"], tone: "warning", tx: second.client });
    expect(second.calls[0]!.data[0]!.type).toBe("warning");
  });

  it("normalises an absent project scope to null rather than undefined", async () => {
    // lib/queries/notifications.ts filters on projectId to strip finance pings
    // from members; `undefined` would omit the column instead of nulling it.
    const { client, calls } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1"], tx: client });
    expect(calls[0]!.data[0]!.projectId).toBeNull();
    expect(calls[0]!.data[0]!.link).toBeNull();
  });

  it("carries the project scope when one is given", async () => {
    const { client, calls } = fakeClient();
    await notifyUsers({
      ...base,
      userIds: ["u1"],
      projectId: "p1",
      link: "/projects/p1",
      tx: client,
    });
    expect(calls[0]!.data[0]!.projectId).toBe("p1");
    expect(calls[0]!.data[0]!.link).toBe("/projects/p1");
  });
});

describe("notifyUsers preference enforcement (FaultsAudit S9)", () => {
  it("skips someone who muted this event in-app, and still notifies everyone else", async () => {
    const { client, calls } = fakeClient([mute("u1", "task_assigned", "inApp")]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(res.notified).toBe(1);
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u2"]);
  });

  it("writes nothing when every recipient muted the event", async () => {
    const { client, calls } = fakeClient([
      mute("u1", "task_assigned", "inApp"),
      mute("u2", "task_assigned", "inApp"),
    ]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("ignores a preference stored against a different event", async () => {
    // A muted `mention` must not silence `task_assigned`.
    const { client } = fakeClient([mute("u1", "mention", "inApp")]);
    const res = await notifyUsers({ ...base, userIds: ["u1"], tx: client });
    expect(res.notified).toBe(1);
  });

  it("pushes to the recipients who allow it", async () => {
    const { client } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    expect(pushForNotificationRows).toHaveBeenCalledTimes(1);
    const rows = pushForNotificationRows.mock.calls[0]![0] as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
  });

  it("does not push to someone who muted push, even though they still get it in-app", async () => {
    const { client, calls } = fakeClient([mute("u1", "task_assigned", "push")]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    expect(res.notified).toBe(2); // in-app untouched
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1", "u2"]);
    const rows = pushForNotificationRows.mock.calls[0]![0] as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u2"]);
  });

  it("still pushes to someone who muted in-app but left push on", async () => {
    // The channels are independent: no Notification row, but the phone buzzes.
    // This is the case the old Prisma $extends hook could not express at all,
    // because it only ever saw a written row.
    const { client, calls } = fakeClient([mute("u1", "task_assigned", "inApp")]);
    const res = await notifyUsers({ ...base, userIds: ["u1"], tx: client });
    await settlePush();
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
    const rows = pushForNotificationRows.mock.calls[0]![0] as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u1"]);
  });

  it("raises no push at all when nobody allows it", async () => {
    // transaction_logged defaults push OFF — the noisiest event in the product.
    const { client } = fakeClient();
    await notifyUsers({
      ...base,
      event: "transaction_logged",
      category: "finance",
      userIds: ["u1", "u2"],
      tx: client,
    });
    await settlePush();
    expect(pushForNotificationRows).not.toHaveBeenCalled();
  });
});

describe("notifyUsers email channel", () => {
  it("emails the recipients whose preference allows it, resolved to real addresses", async () => {
    const { client } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1", "u2"], link: "/tasks?taskId=t1", tx: client });
    expect(fireNotificationEmails).toHaveBeenCalledTimes(1);
    const job = fireNotificationEmails.mock.calls[0]![0] as {
      event: string;
      recipients: { email: string }[];
      link: string;
    };
    expect(job.event).toBe("task_assigned");
    expect(job.recipients.map((r) => r.email)).toEqual(["u1@nimbus.app", "u2@nimbus.app"]);
    expect(job.link).toBe("/tasks?taskId=t1");
  });

  it("does not email someone who muted email but still writes their in-app row", async () => {
    const { client, calls } = fakeClient([mute("u1", "task_assigned", "email")]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(res.notified).toBe(2);
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1", "u2"]);
    const job = fireNotificationEmails.mock.calls[0]![0] as { recipients: { email: string }[] };
    expect(job.recipients.map((r) => r.email)).toEqual(["u2@nimbus.app"]);
  });

  it("sends no email at all for an event that defaults it off", async () => {
    // transaction_logged fires at every teammate on every money row — the one
    // event that could exhaust the daily budget by itself.
    const { client } = fakeClient();
    await notifyUsers({
      ...base,
      event: "transaction_logged",
      category: "finance",
      userIds: ["u1", "u2"],
      tx: client,
    });
    expect(fireNotificationEmails).not.toHaveBeenCalled();
  });

  it("resolves recipients in ONE query, not one per channel", async () => {
    // WHAT THIS TEST USED TO SAY, AND WHY IT CHANGED (data-integrity-004). It
    // asserted ZERO user lookups for an event that emails nobody, on the grounds
    // that a lookup per notification is a wasted round-trip on the noisiest
    // events. The round-trip argument still holds — hence "one" — but "zero" was
    // only achievable by trusting the caller's id list, and the caller's id list
    // is where tombstoned users come from (Task.assignedTo and stored mentions
    // both outlive a deactivation). The recipients are now resolved through the
    // User table once, up front, and that same read serves the email addresses.
    const { client, lookups } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.deletedAt, "and it is the live-only read").toBe(null);
  });

  it("does not look anyone up when every channel is muted", async () => {
    // Nothing will be delivered, so there is nothing to resolve.
    const { client, lookups } = fakeClient([
      { userId: "u1", event: "task_assigned", inApp: false, email: false, push: false },
    ]);
    await notifyUsers({ ...base, userIds: ["u1"], tx: client });
    expect(lookups).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* data-integrity-004 — a tombstoned recipient receives nothing, on any channel */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a deactivated teammate is not a recipient (data-integrity-004)", () => {
  it("writes no in-app row for a tombstoned user", async () => {
    // This branch was the gap. The EMAIL branch filtered `deletedAt: null` and
    // said why in a comment; `notification.createMany` two statements above it
    // wrote a row for whoever it was handed. The rows then pile up for ever and
    // all flood back if the account is ever reactivated.
    const { client, calls } = fakeClient([], ["u2"]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(res.notified, "only the live teammate was notified").toBe(1);
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1"]);
  });

  it("raises no push for a tombstoned user", async () => {
    // sendPushToUsers filters `user: { deletedAt: null }` at the delivery
    // boundary too — but the fan-out must not even ask. A removed employee's
    // phone buzzing with "New expense — 2,500,000" is confidential finance data
    // leaving the tenant after access was revoked.
    const { client } = fakeClient([], ["u2"]);
    await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    const rows = pushForNotificationRows.mock.calls[0]![0] as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u1"]);
  });

  it("sends no email to a tombstoned user (the half that already worked)", async () => {
    const { client } = fakeClient([], ["u2"]);
    await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    const job = fireNotificationEmails.mock.calls[0]![0] as { recipients: { email: string }[] };
    expect(job.recipients.map((r) => r.email)).toEqual(["u1@nimbus.app"]);
  });

  it("writes nothing at all when every recipient is tombstoned", async () => {
    const { client, calls } = fakeClient([], ["u1", "u2"]);
    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(pushForNotificationRows).not.toHaveBeenCalled();
    expect(fireNotificationEmails).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* sec-005 — a member is never TOLD a finance figure, on any channel           */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a finance event only reaches people entitled to the money (sec-005)", () => {
  // WHY THE READ FILTER IS NOT ENOUGH, restated because it is the whole point.
  // `visibleNotifications` strips a finance row at READ time, which covers
  // /notifications — and covers nothing else. `notifyUsers` writes the in-app
  // row, fires push and sends email before any reader calls any filter, so a
  // member with `budget_alert` push on gets "Marketing is 90% spent —
  // 2,500,000 PKR" on their lock screen and in their inbox, outside the app,
  // where nothing downstream can reach it. The recipient list is the only place
  // that covers all three at once.
  const finance = {
    event: "budget_alert",
    companyId: "c1",
    title: "Budget alert",
    message: "Marketing is at 90% — 2,500,000 PKR of 2,800,000 PKR",
    category: "finance",
    projectId: "p1",
    link: "/projects/p1",
  } as const;

  it("drops a recipient the finance rule does not allow, in-app", async () => {
    // u2 is an ordinary member on a project they do not supervise.
    financeRecipients.mockResolvedValue(["u1"]);
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    expect(res.notified, "only the entitled reader was notified").toBe(1);
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1"]);
  });

  it("raises no push for a recipient the finance rule does not allow", async () => {
    financeRecipients.mockResolvedValue(["u1"]);
    const { client } = fakeClient();
    await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    const rows = pushForNotificationRows.mock.calls[0]![0] as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u1"]);
  });

  it("sends no email to a recipient the finance rule does not allow", async () => {
    financeRecipients.mockResolvedValue(["u1"]);
    const { client } = fakeClient();
    await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    const job = fireNotificationEmails.mock.calls[0]![0] as { recipients: { email: string }[] };
    expect(job.recipients.map((r) => r.email)).toEqual(["u1@nimbus.app"]);
  });

  it("delivers nothing at all when nobody may be told about the money", async () => {
    financeRecipients.mockResolvedValue([]);
    const { client, calls } = fakeClient();
    const res = await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    await settlePush();
    expect(res.notified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(pushForNotificationRows).not.toHaveBeenCalled();
    expect(fireNotificationEmails).not.toHaveBeenCalled();
  });

  it("asks the rule with the event's company and project scope", async () => {
    // The project scope is what grants the supervisor escape hatch. Passing it
    // as `undefined` (rather than null) for an unscoped event would make a
    // company-wide money ping look project-scoped to a stricter rule later.
    financeRecipients.mockResolvedValue(["u1"]);
    const { client } = fakeClient();
    await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    expect(financeRecipients).toHaveBeenCalledTimes(1);
    expect(financeRecipients.mock.calls[0]![1]).toEqual({ companyId: "c1", projectId: "p1" });

    financeRecipients.mockClear();
    const second = fakeClient();
    await notifyUsers({ ...finance, projectId: undefined, userIds: ["u1"], tx: second.client });
    expect(financeRecipients.mock.calls[0]![1]).toEqual({ companyId: "c1", projectId: null });
  });

  it("does not consult the finance rule for a task event", async () => {
    // Every notification would otherwise pay for the extra reads, and a task
    // ping has no money in it to protect.
    const { client } = fakeClient();
    await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });
    expect(financeRecipients).not.toHaveBeenCalled();
  });

  it("asks the rule only about people some channel would actually reach", async () => {
    // u2 muted every channel, so they are not a recipient of anything and the
    // entitlement question about them is moot.
    financeRecipients.mockImplementation((ids: string[]) => Promise.resolve(ids));
    const { client } = fakeClient([
      { userId: "u2", event: "budget_alert", inApp: false, email: false, push: false },
    ]);
    await notifyUsers({ ...finance, userIds: ["u1", "u2"], tx: client });
    expect(financeRecipients.mock.calls[0]![0]).toEqual(["u1"]);
  });
});

/**
 * `skipInApp` — chat announces itself on the Chat badge, not under the bell.
 *
 * WHAT WAS WRONG. Every direct message wrote a Notification row, so a two-line
 * exchange put two entries in the notifications list beside budget alerts and
 * role changes, while the word "Chat" in the sidebar never changed. The unread
 * signal was in the wrong place and there was no way to tell "someone messaged
 * me" from "my role changed" without opening both surfaces.
 *
 * The flag has to do exactly one thing. The failure mode worth guarding is not
 * "the row still gets written" — that is obvious and would be caught by any
 * assertion — but the quiet over-reach: suppressing the row and taking push or
 * email down with it, which would silently stop telling people they had been
 * messaged while away. Half of these tests exist for that direction.
 */
describe("skipInApp — the in-app row, and ONLY the in-app row", () => {
  it("writes no notification row", async () => {
    const { calls, client } = fakeClient();

    const res = await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1", "u2"],
      skipInApp: true,
      tx: client,
    });

    expect(calls, "a row here is the bug this flag exists to fix").toHaveLength(0);
    expect(res.notified).toBe(0);
  });

  it("still pushes, so being messaged while away still reaches you", async () => {
    const { client } = fakeClient();

    await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1"],
      skipInApp: true,
      tx: client,
    });
    await settlePush();

    expect(
      pushForNotificationRows,
      "'don't list it under the bell' and 'don't tell me at all' are different requests"
    ).toHaveBeenCalledTimes(1);
    expect(pushForNotificationRows.mock.calls[0][0]).toEqual([
      expect.objectContaining({ userId: "u1" }),
    ]);
  });

  it("still emails — the flag refuses the row, not the mail", async () => {
    // THIS TEST USED TO RAISE `dm`, AND ASSERTED THE DEFECT the owner reported
    // on 2026-10-05: "each chat message gets emailed too […] a user in a busy
    // channel will receive 100s of emails just from chat." Email for chat is
    // gone, so a DM can no longer demonstrate anything about this flag — it
    // would pass for the wrong reason the day `skipInApp` started suppressing
    // email too.
    //
    // The property is unchanged and still worth holding: `skipInApp` means
    // "this surface owns its own unread signal", not "say nothing". So it is
    // asserted on an event where email IS deliverable. Chat's silence comes
    // from `EVENT_DELIVERABLE_CHANNELS`, one layer up, and is asserted in the
    // describe block below.
    const { client } = fakeClient();

    await notifyUsers({
      ...base,
      event: "task_assigned",
      userIds: ["u1"],
      skipInApp: true,
      tx: client,
    });

    expect(fireNotificationEmails).toHaveBeenCalledTimes(1);
  });

  it("leaves every other call site alone", async () => {
    const { calls, client } = fakeClient();

    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });

    expect(calls, "without the flag the in-app row is written exactly as before").toHaveLength(1);
    expect(res.notified).toBe(2);
  });

  it("reports `reached` so a suppressed caller can still say who it got to", async () => {
    const { client } = fakeClient();

    const res = await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1", "u2", "u3"],
      skipInApp: true,
      tx: client,
    });

    expect(
      res.dispatched,
      "notified is 0 by design here; without `reached` the composer says 'pinged 0' over a message that reached three people"
    ).toBe(3);
  });

  it("counts PEOPLE in `reached`, not deliveries", async () => {
    // u1 has all three channels on. That is one person dispatched, not three.
    const { client } = fakeClient();

    const res = await notifyUsers({ ...base, userIds: ["u1"], tx: client });

    expect(res.dispatched).toBe(1);
    expect(res.notified).toBe(1);
  });

  it("does not count someone every channel would miss", async () => {
    // u2 has turned this event off everywhere; u1 has it on.
    const stored: Stored[] = [
      { userId: "u2", event: base.event, inApp: false, email: false, push: false },
    ];
    const { client } = fakeClient(stored);

    const res = await notifyUsers({ ...base, userIds: ["u1", "u2"], tx: client });

    expect(res.dispatched, "reached means delivered, not attempted").toBe(1);
  });

  it("does not count a deactivated teammate as reached", async () => {
    const { client } = fakeClient([], ["u2"]);

    const res = await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1", "u2"],
      skipInApp: true,
      tx: client,
    });

    expect(
      res.dispatched,
      "the tombstone filter runs before delivery; reached must agree with it"
    ).toBe(1);
  });

  it("reaches nobody when in-app was the recipient's only channel", async () => {
    // The realistic shape of a zero: push and email off, in-app on — and in-app
    // is the one this call refuses. Nothing was delivered, and `reached` says so
    // rather than crediting the preference row that would have been honoured.
    const stored: Stored[] = [
      { userId: "u1", event: "dm", inApp: true, email: false, push: false },
    ];
    const { calls, client } = fakeClient(stored);

    const res = await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1"],
      skipInApp: true,
      tx: client,
    });
    await settlePush();

    expect(res).toEqual({ notified: 0, dispatched: 0 });
    expect(calls).toHaveLength(0);
    expect(pushForNotificationRows).not.toHaveBeenCalled();
    expect(fireNotificationEmails).not.toHaveBeenCalled();
  });
});

/**
 * EVENT_DELIVERABLE_CHANNELS is a rule, not a label on a checkbox.
 *
 * The owner's report of 2026-10-05 — "each chat message gets emailed too […] a
 * user in a busy channel will receive 100s of emails just from chat" — was
 * fixed by giving chat its own events and leaving `email` out of their rows in
 * `EVENT_DELIVERABLE_CHANNELS`. That map had exactly one reader at the time:
 * the settings page, which renders a dash instead of a checkbox. Nothing in the
 * delivery path consulted it, so the map could only ever hide a control; it
 * could not stop a send.
 *
 * That gap is reachable. `updateNotificationPreferenceAction` validates its
 * payload against NOTIFY_EVENTS × NOTIFY_CHANNELS and upserts whatever it is
 * given, so one hand-made request stores `email: true` for `chat_mention` — and
 * so would any row left behind by a future change to this map. `splitByChannel`
 * would then resolve that row and the emails would be back for that person,
 * with the settings page still showing a dash and no way to turn it off.
 *
 * So the fan-out intersects every resolved list with the map. These are the
 * cases that fail if that intersection is removed: a default cannot deliver on
 * an undeliverable channel, and neither can an explicit stored row.
 */
describe("an undeliverable channel cannot be delivered on, by anyone", () => {
  it("sends no email for a chat mention, though the event is otherwise live", async () => {
    const { calls, client } = fakeClient();

    const res = await notifyUsers({
      ...base,
      event: "chat_mention",
      userIds: ["u1", "u2"],
      tx: client,
    });
    await settlePush();

    expect(fireNotificationEmails, "chat is not emailed").not.toHaveBeenCalled();
    // And the event is not merely switched off: both other channels delivered.
    expect(calls[0]!.data.map((d) => d.userId)).toEqual(["u1", "u2"]);
    expect(pushForNotificationRows).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ notified: 2, dispatched: 2 });
  });

  it("sends no email for a chat mention even to someone whose row says email: true", async () => {
    // The row the UI cannot produce and the action will happily store.
    const stored: Stored[] = [
      { userId: "u1", event: "chat_mention", inApp: true, email: true, push: true },
    ];
    const { client } = fakeClient(stored);

    await notifyUsers({ ...base, event: "chat_mention", userIds: ["u1"], tx: client });

    expect(
      fireNotificationEmails,
      "a stored preference must not re-open a channel the product refuses"
    ).not.toHaveBeenCalled();
  });

  it("sends no email for a DM either, stored row or not", async () => {
    const stored: Stored[] = [{ userId: "u1", event: "dm", inApp: true, email: true, push: true }];
    const { calls, client } = fakeClient(stored);

    const res = await notifyUsers({
      ...base,
      event: "dm",
      userIds: ["u1"],
      skipInApp: true,
      tx: client,
    });
    await settlePush();

    expect(fireNotificationEmails).not.toHaveBeenCalled();
    expect(calls, "a DM's unread signal is the Chat badge").toHaveLength(0);
    // Push is all a DM has left — which is why it must not be lost too.
    expect(pushForNotificationRows).toHaveBeenCalledTimes(1);
    expect(res.dispatched).toBe(1);
  });

  it("leaves an event whose row names all three channels completely alone", async () => {
    // The intersection must be a no-op for every event but chat's two, or it is
    // a silent delivery regression across the whole product.
    const { calls, client } = fakeClient();

    await notifyUsers({ ...base, event: "task_assigned", userIds: ["u1"], tx: client });
    await settlePush();

    expect(calls).toHaveLength(1);
    expect(pushForNotificationRows).toHaveBeenCalledTimes(1);
    expect(fireNotificationEmails).toHaveBeenCalledTimes(1);
  });
});
