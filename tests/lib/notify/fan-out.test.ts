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

type Stored = { userId: string; event: string; inApp: boolean; email: boolean; push: boolean };

/** Stand-in for the `Pick<typeof db, "notification" | "notificationPreference">` the helper takes. */
function fakeClient(stored: Stored[] = []) {
  const calls: { data: Record<string, unknown>[] }[] = [];
  return {
    calls,
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
        // The fan-out looks addresses up by id; the shape is all it needs.
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id) => ({ name: `User ${id}`, email: `${id}@nimbus.app` })),
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

  it("does not look up addresses when nobody is eligible", async () => {
    // A user lookup per notification would be a wasted round-trip on the
    // noisiest events, which are exactly the ones that never email.
    const { client } = fakeClient();
    let lookups = 0;
    const spy = {
      ...(client as unknown as Record<string, unknown>),
      user: {
        findMany: async () => {
          lookups += 1;
          return [];
        },
      },
    } as never;
    await notifyUsers({
      ...base,
      event: "transaction_logged",
      category: "finance",
      userIds: ["u1"],
      tx: spy,
    });
    expect(lookups).toBe(0);
  });
});
