import { describe, it, expect } from "vitest";
import { UNREAD_CAP, capUnread, isUnreadCapped, unreadLabel } from "@/lib/chat/unread";

describe("capUnread (what the rail badge is allowed to say)", () => {
  it("passes an ordinary count straight through", () => {
    expect(capUnread(7)).toBe(7);
  });

  it("shows nothing for a channel with no unread messages", () => {
    expect(capUnread(0)).toBe(0);
  });

  it("shows the exact number right up to the cap", () => {
    expect(capUnread(UNREAD_CAP)).toBe(UNREAD_CAP);
  });

  it("clips the first count past the cap", () => {
    expect(capUnread(UNREAD_CAP + 1)).toBe(UNREAD_CAP);
  });

  it("clips a wildly large count to the same number as a barely-large one", () => {
    expect(capUnread(10_000)).toBe(capUnread(UNREAD_CAP + 1));
  });

  it("treats a negative count as nothing to read", () => {
    expect(capUnread(-1)).toBe(0);
    expect(capUnread(-10_000)).toBe(0);
  });

  it("refuses to put NaN or Infinity on a badge", () => {
    // A non-finite count is a broken aggregate, not a very busy channel, so
    // it renders as no badge at all rather than as "99+".
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(capUnread(n)).toBe(0);
    }
  });

  it("floors a fractional count rather than rendering a decimal", () => {
    expect(capUnread(3.9)).toBe(3);
  });

  it("stays inside 0..cap for every input it is handed", () => {
    const inputs = [-50, -1, 0, 1, 2, 50, UNREAD_CAP - 1, UNREAD_CAP, UNREAD_CAP + 1, 1e6, 0.4];
    for (const n of inputs) {
      const capped = capUnread(n);
      expect(capped).toBeGreaterThanOrEqual(0);
      expect(capped).toBeLessThanOrEqual(UNREAD_CAP);
      expect(Number.isInteger(capped)).toBe(true);
    }
  });

  it("never reports a bigger badge for a smaller count", () => {
    const ascending = [0, 1, 5, 40, UNREAD_CAP - 1, UNREAD_CAP, UNREAD_CAP + 1, 500];
    for (let i = 1; i < ascending.length; i++) {
      expect(capUnread(ascending[i])).toBeGreaterThanOrEqual(capUnread(ascending[i - 1]));
    }
  });
});

describe("isUnreadCapped (whether the badge earns its plus sign)", () => {
  it("stays quiet for a count the badge can show exactly", () => {
    for (const n of [0, 1, 50, UNREAD_CAP]) {
      expect(isUnreadCapped(n)).toBe(false);
    }
  });

  it("flags every count the cap clipped", () => {
    for (const n of [UNREAD_CAP + 1, 200, 10_000]) {
      expect(isUnreadCapped(n)).toBe(true);
    }
  });

  it("agrees with capUnread about where the boundary sits", () => {
    for (let n = UNREAD_CAP - 2; n <= UNREAD_CAP + 2; n++) {
      expect(isUnreadCapped(n)).toBe(capUnread(n) !== n);
    }
  });
});

/**
 * `unreadLabel` — the printed form, shared by the channel rail and the
 * sidebar's Chat row.
 *
 * It exists because those two surfaces each owned a copy of "when does 99
 * become 99+", against two separate copies of the cap constant. They agreed by
 * coincidence, and a badge that disagrees with the list it summarises is worse
 * than no badge.
 *
 * THE INPUT IS ALREADY CAPPED. Both query paths run `capUnread` server-side, so
 * 99 arriving here means "99 or more" and must print "99+". That is why this
 * cannot be written in terms of `isUnreadCapped`, which asks about the RAW
 * count: it would print a clipped 400 as a flat "99".
 */
describe("unreadLabel", () => {
  it("prints small counts as themselves", () => {
    expect(unreadLabel(1)).toBe("1");
    expect(unreadLabel(42)).toBe("42");
    expect(unreadLabel(98)).toBe("98");
  });

  it("prints the cap as 99+, because a capped 99 means 'at least'", () => {
    expect(unreadLabel(UNREAD_CAP)).toBe("99+");
  });

  it("prints a raw over-cap count as 99+ too, if one ever reaches it uncapped", () => {
    expect(unreadLabel(400)).toBe("99+");
  });

  it("collapses nonsense to 0 rather than rendering NaN in a badge", () => {
    expect(unreadLabel(Number.NaN)).toBe("0");
    expect(unreadLabel(-3)).toBe("0");
  });
});
