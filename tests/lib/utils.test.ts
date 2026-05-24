import { describe, it, expect } from "vitest";
import {
  cn,
  formatCurrency,
  formatNumber,
  formatDate,
  formatRelativeTime,
  generateAvatar,
  getAvatarColor,
} from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("dedupes conflicting tailwind classes (last wins)", () => {
    // twMerge specialty: px-2 + px-4 → px-4
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("handles falsy values", () => {
    expect(cn("base", undefined, null, false, "extra")).toBe("base extra");
  });

  it("handles conditional object syntax", () => {
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });
});

describe("formatCurrency", () => {
  it("formats PKR with no decimals and the PKR prefix", () => {
    expect(formatCurrency(12345)).toBe("PKR 12,345");
  });

  it("rounds large PKR amounts without decimals", () => {
    expect(formatCurrency(1_500_000)).toBe("PKR 1,500,000");
  });

  it("handles zero", () => {
    expect(formatCurrency(0)).toBe("PKR 0");
  });

  it("handles negative balances", () => {
    expect(formatCurrency(-2500)).toBe("PKR -2,500");
  });

  it("falls through to Intl for non-PKR currencies", () => {
    const result = formatCurrency(1000, "USD");
    // en-US locale renders USD as "$1,000"
    expect(result).toMatch(/\$1,000/);
  });
});

describe("formatNumber", () => {
  it("uses M suffix above one million", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
  });

  it("uses K suffix between 1k and 1M", () => {
    expect(formatNumber(15_000)).toBe("15.0K");
    expect(formatNumber(999)).toBe("999");
  });

  it("returns raw string under 1000", () => {
    expect(formatNumber(500)).toBe("500");
    expect(formatNumber(0)).toBe("0");
  });

  it("handles negatives by magnitude", () => {
    expect(formatNumber(-2_500_000)).toBe("-2.5M");
    expect(formatNumber(-3_500)).toBe("-3.5K");
  });
});

describe("formatDate", () => {
  it("renders ISO date as MMM dd, yyyy", () => {
    expect(formatDate("2026-05-24T12:00:00Z")).toMatch(/May 24, 2026/);
  });

  it("accepts a Date object directly", () => {
    expect(formatDate(new Date("2026-01-15T00:00:00Z"))).toMatch(/Jan 1[45], 2026/);
  });
});

describe("formatRelativeTime", () => {
  it("returns 'Today at <time>' for today's timestamps", () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toMatch(/^Today at /);
  });

  it("returns 'Yesterday at <time>' for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatRelativeTime(yesterday)).toMatch(/^Yesterday at /);
  });

  it("returns 'X ago' for older dates", () => {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    // date-fns formatDistanceToNow with addSuffix → e.g. "10 days ago"
    expect(formatRelativeTime(tenDaysAgo)).toMatch(/ago$/);
  });
});

describe("generateAvatar", () => {
  it("uses first letter of each of the first two words", () => {
    expect(generateAvatar("Saqib Nawaz")).toBe("SN");
    expect(generateAvatar("Jane Doe Smith")).toBe("JD");
  });

  it("falls back to 'U' for empty input", () => {
    expect(generateAvatar("")).toBe("U");
  });

  it("handles single names", () => {
    expect(generateAvatar("Madonna")).toBe("M");
  });

  it("uppercases lowercase initials", () => {
    expect(generateAvatar("alice bob")).toBe("AB");
  });
});

describe("getAvatarColor", () => {
  it("returns the same color for the same name (stable hash)", () => {
    expect(getAvatarColor("Saqib")).toBe(getAvatarColor("Saqib"));
  });

  it("returns a tailwind gradient class string", () => {
    expect(getAvatarColor("any")).toMatch(/^from-\w+-500 to-\w+-500$/);
  });

  it("distributes different names across the palette", () => {
    const colors = new Set(
      ["Saqib", "Jane", "Alice", "Bob", "Charlie", "Dave", "Eve", "Frank"].map(getAvatarColor)
    );
    // Won't always hit all 8 with only 8 names, but should hit several.
    expect(colors.size).toBeGreaterThan(1);
  });
});
