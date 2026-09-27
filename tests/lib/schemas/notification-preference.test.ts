import { describe, it, expect } from "vitest";
import { UpdateNotificationPreferenceSchema } from "@/lib/schemas/notification-preference";
import { NOTIFY_CHANNELS, NOTIFY_EVENTS } from "@/lib/notify/events";

const valid = { event: "mention", channel: "email", enabled: false };

describe("UpdateNotificationPreferenceSchema", () => {
  it("accepts a well-formed toggle", () => {
    expect(UpdateNotificationPreferenceSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts every declared event", () => {
    // Iterate the union: an event the schema rejects is a switch the settings
    // page renders but can never save.
    for (const event of NOTIFY_EVENTS) {
      const r = UpdateNotificationPreferenceSchema.safeParse({ ...valid, event });
      expect(r.success, event).toBe(true);
    }
  });

  it("accepts every declared channel", () => {
    for (const channel of NOTIFY_CHANNELS) {
      const r = UpdateNotificationPreferenceSchema.safeParse({ ...valid, channel });
      expect(r.success, channel).toBe(true);
    }
  });

  it("rejects an event it does not know", () => {
    const r = UpdateNotificationPreferenceSchema.safeParse({ ...valid, event: "nonsense" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Unknown notification type");
  });

  it("rejects a channel it does not know", () => {
    const r = UpdateNotificationPreferenceSchema.safeParse({ ...valid, channel: "sms" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Unknown delivery channel");
  });

  it("rejects a missing enabled flag rather than guessing", () => {
    const { enabled: _drop, ...withoutFlag } = valid;
    expect(UpdateNotificationPreferenceSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("rejects a non-boolean enabled flag", () => {
    // A checkbox posting "on" instead of true must not read as enabled.
    expect(UpdateNotificationPreferenceSchema.safeParse({ ...valid, enabled: "on" }).success).toBe(
      false
    );
  });
});
