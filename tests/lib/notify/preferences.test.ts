import { describe, it, expect } from "vitest";
import { EVENT_COPY, NOTIFY_CHANNELS, NOTIFY_EVENTS } from "@/lib/notify/events";
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
});
