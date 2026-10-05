import { describe, it, expect } from "vitest";
import {
  EVENT_CHANNEL_NOTE,
  EVENT_COPY,
  EVENT_DELIVERABLE_CHANNELS,
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
} from "@/lib/notify/events";
import {
  DEFAULT_CHANNELS,
  matrixFor,
  resolveChannels,
  splitByChannel,
  type StoredPreference,
} from "@/lib/notify/preferences";

function stored(over: Partial<StoredPreference> & { event: string }): StoredPreference {
  return { inApp: true, email: true, push: true, ...over };
}

describe("resolveChannels (stored row vs default)", () => {
  it("uses the default when the person has never touched this event", () => {
    expect(resolveChannels("task_assigned", null)).toEqual(DEFAULT_CHANNELS.task_assigned);
  });

  it("lets a stored row override the default completely", () => {
    const row = stored({ event: "task_assigned", inApp: false, email: false, push: false });
    expect(resolveChannels("task_assigned", row)).toEqual({
      inApp: false,
      email: false,
      push: false,
    });
  });

  it("falls back to in-app only for an event it does not recognise", () => {
    // A row written by a newer deploy must never start emailing on an older
    // one that has no defaults for it — quiet is the safe direction.
    expect(resolveChannels("something_new", null)).toEqual({
      inApp: true,
      email: false,
      push: false,
    });
  });
});

describe("DEFAULT_CHANNELS", () => {
  it("covers every declared event", () => {
    // Iterate rather than count: a new event with no default would otherwise
    // silently resolve through the unknown-event fallback.
    const missing = NOTIFY_EVENTS.filter((e) => !(e in DEFAULT_CHANNELS));
    expect(missing, `No default for: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares all three channels for every event", () => {
    for (const event of NOTIFY_EVENTS) {
      const channels = DEFAULT_CHANNELS[event];
      for (const channel of NOTIFY_CHANNELS) {
        expect(typeof channels[channel], `${event}.${channel}`).toBe("boolean");
      }
    }
  });

  it("leaves every event reachable in-app", () => {
    // In-app is the durable record. An event defaulting to no channel at all
    // would be written nowhere and look like a bug.
    const silent = NOTIFY_EVENTS.filter((e) => !DEFAULT_CHANNELS[e].inApp);
    expect(silent, `Default to no in-app record: ${silent.join(", ")}`).toEqual([]);
  });

  it("keeps chat out of the inbox by default, on both of its events", () => {
    // The owner's report of 2026-10-05: "each chat message gets emailed too,
    // should only come as a push notification and an in-app notification, not
    // an email notification — a user in a busy channel will receive 100s of
    // emails just from chat." Chat arrives at typing speed; `mention` — the
    // same gesture in a comment on a task or a money row — is occasional and
    // keeps its email, which is the whole reason the two are separate events.
    //
    // The default is not the only thing holding this (email is left out of both
    // rows in EVENT_DELIVERABLE_CHANNELS and `notifyUsers` enforces that), but a
    // default that disagreed with the delivery path would write preference rows
    // and render a matrix that both claim something untrue.
    expect(DEFAULT_CHANNELS.chat_mention.email).toBe(false);
    expect(DEFAULT_CHANNELS.dm.email).toBe(false);
    expect(
      DEFAULT_CHANNELS.mention.email,
      "a comment mention still emails — the fix was a separation, not a deletion"
    ).toBe(true);
  });

  it("still interrupts for a chat mention on the channels it kept", () => {
    // Quietening chat must not mean silencing it. The person was named and is
    // being waited on, so the durable row and the push both stay — a Chat badge
    // reading "3 unread" cannot say that one of the three was addressed to them.
    expect(DEFAULT_CHANNELS.chat_mention.inApp).toBe(true);
    expect(DEFAULT_CHANNELS.chat_mention.push).toBe(true);
    expect(DEFAULT_CHANNELS.dm.push, "push is the only channel a DM has left").toBe(true);
  });

  it("keeps money-logged out of the inbox by default", () => {
    // transaction_logged fires at every teammate on every expense, revenue and
    // investment row. Defaulting it to email would be a dozen mails a day on an
    // active workspace and would alone threaten Gmail's ~500/day free cap.
    // If this is ever flipped on, that is a deliberate decision — not a tweak.
    expect(DEFAULT_CHANNELS.transaction_logged.email).toBe(false);
    expect(DEFAULT_CHANNELS.transaction_logged.push).toBe(false);
    expect(DEFAULT_CHANNELS.transaction_logged.inApp).toBe(true);
  });
});

describe("splitByChannel (one query, three recipient lists)", () => {
  const ids = ["u1", "u2", "u3"];

  it("sends everyone down every channel the default allows", () => {
    const out = splitByChannel("task_assigned", ids, []);
    expect(out.inApp).toEqual(ids);
    expect(out.email).toEqual(ids);
    expect(out.push).toEqual(ids);
  });

  it("drops just the person who muted a channel, from just that channel", () => {
    const out = splitByChannel("task_assigned", ids, [
      { userId: "u2", ...stored({ event: "task_assigned", push: false }) },
    ]);
    expect(out.push).toEqual(["u1", "u3"]);
    expect(out.inApp).toEqual(ids);
    expect(out.email).toEqual(ids);
  });

  it("ignores rows stored against a different event", () => {
    // The caller may hand over whatever preference rows it already loaded.
    const out = splitByChannel("task_assigned", ids, [
      { userId: "u1", ...stored({ event: "mention", inApp: false, email: false, push: false }) },
    ]);
    expect(out.inApp).toEqual(ids);
  });

  it("returns empty lists rather than throwing on no recipients", () => {
    const out = splitByChannel("task_assigned", [], []);
    expect(out).toEqual({ inApp: [], email: [], push: [] });
  });
});

describe("matrixFor (what the settings page renders)", () => {
  it("returns every event, in declaration order, even with nothing stored", () => {
    expect(matrixFor([]).map((r) => r.event)).toEqual([...NOTIFY_EVENTS]);
  });

  it("fills unstored events with their defaults and stored ones with the stored value", () => {
    const rows = matrixFor([stored({ event: "mention", email: false })]);
    const mention = rows.find((r) => r.event === "mention")!;
    const assigned = rows.find((r) => r.event === "task_assigned")!;
    expect(mention.channels.email).toBe(false);
    expect(assigned.channels).toEqual(DEFAULT_CHANNELS.task_assigned);
  });
});

describe("EVENT_COPY", () => {
  it("labels and describes every event", () => {
    // A missing entry renders a blank row in the settings table.
    for (const event of NOTIFY_EVENTS) {
      expect(EVENT_COPY[event]?.label, event).toBeTruthy();
      expect(EVENT_COPY[event]?.description, event).toBeTruthy();
    }
  });

  it("gives the two mention events labels a person can tell apart", () => {
    // They are adjacent rows in the matrix, they describe the same gesture, and
    // they now behave differently — one emails, one does not. Two rows reading
    // "Mentions" with different checkboxes is indistinguishable from a bug.
    expect(EVENT_COPY.mention.label).not.toBe(EVENT_COPY.chat_mention.label);
    expect(EVENT_COPY.mention.description).not.toBe(EVENT_COPY.chat_mention.description);
  });
});

describe("EVENT_CHANNEL_NOTE (why a cell has no checkbox)", () => {
  it("explains every channel the matrix refuses to offer", () => {
    // components/settings/notification-matrix.tsx renders a dash in place of
    // the checkbox for any channel missing from EVENT_DELIVERABLE_CHANNELS, with
    // this note as its `title`. With no note the cell is a bare dash, which
    // reads as a rendering fault — and the two rows that carry one now say
    // different things ("the Chat badge has it" vs "chat is never emailed"), so
    // a shared fallback sentence would not do.
    const unexplained = NOTIFY_EVENTS.filter(
      (event) =>
        EVENT_DELIVERABLE_CHANNELS[event].length < NOTIFY_CHANNELS.length &&
        !EVENT_CHANNEL_NOTE[event]
    );
    expect(
      unexplained,
      `These events hide a channel in the settings matrix with no explanation, ` +
        `so the cell renders as an unexplained dash: ${unexplained.join(", ")}`
    ).toEqual([]);
  });

  it("explains nothing that is fully available", () => {
    // The mirror case: a note on a row with all three checkboxes is never
    // rendered, so it is dead copy that reads as a live promise.
    const pointless = NOTIFY_EVENTS.filter(
      (event) =>
        EVENT_DELIVERABLE_CHANNELS[event].length === NOTIFY_CHANNELS.length &&
        EVENT_CHANNEL_NOTE[event]
    );
    expect(pointless, `Notes that can never be shown: ${pointless.join(", ")}`).toEqual([]);
  });

  it("names every channel it declares, with no duplicates or unknowns", () => {
    // Guards the guard above: the length comparison it makes is only meaningful
    // while each row is a subset of NOTIFY_CHANNELS. A typo'd or repeated
    // channel name would make a row look complete, or look short, for a reason
    // that has nothing to do with deliverability.
    for (const event of NOTIFY_EVENTS) {
      const declared = EVENT_DELIVERABLE_CHANNELS[event];
      const unknown = declared.filter((c) => NOTIFY_CHANNELS.indexOf(c) === -1);
      expect(unknown, `${event} declares unknown channel(s)`).toEqual([]);
      expect(declared.length, `${event} repeats a channel`).toBe(new Set<string>(declared).size);
      expect(declared.length, `${event} is deliverable on nothing at all`).toBeGreaterThan(0);
    }
  });
});
