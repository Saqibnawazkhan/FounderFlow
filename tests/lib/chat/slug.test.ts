import { describe, it, expect } from "vitest";
import {
  FALLBACK_CHANNEL_SLUG,
  MAX_CHANNEL_SLUG_LENGTH,
  slugifyChannelName,
  uniqueChannelSlug,
} from "@/lib/chat/slug";

describe("slugifyChannelName (the URL a channel name becomes)", () => {
  it("lowercases and hyphenates a plain name", () => {
    expect(slugifyChannelName("Growth Experiments")).toBe("growth-experiments");
  });

  it("collapses a run of punctuation into a single hyphen", () => {
    expect(slugifyChannelName("Q3 // Growth!!")).toBe("q3-growth");
  });

  it("trims separators off both ends", () => {
    expect(slugifyChannelName("  --Design--  ")).toBe("design");
  });

  it("falls back to a usable stem when a name carries no ASCII at all", () => {
    expect(slugifyChannelName("🎉🎉🎉")).toBe(FALLBACK_CHANNEL_SLUG);
    expect(slugifyChannelName("مالیات")).toBe(FALLBACK_CHANNEL_SLUG);
  });

  it("keeps digits, which are legitimate channel names", () => {
    expect(slugifyChannelName("2026 Planning")).toBe("2026-planning");
  });

  it("never returns an empty string, whatever it is handed", () => {
    const names = ["", "   ", "***", "🎉", "—", "\n\t", "!!!???", "。。。"];
    for (const name of names) {
      expect(slugifyChannelName(name).length).toBeGreaterThan(0);
    }
  });

  it("never emits a character outside the URL-safe set", () => {
    const names = [
      "Growth Experiments",
      "Q3 // Growth!!",
      "  --Design--  ",
      "2026 Planning",
      "Ali & Sons, Ltd.",
      "🎉 party 🎉",
      "UPPER_snake_case",
      "tabs\tand\nnewlines",
    ];
    for (const name of names) {
      expect(slugifyChannelName(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("caps the length and still leaves no trailing separator", () => {
    const long = "word ".repeat(40);
    const slug = slugifyChannelName(long);
    expect(slug.length).toBeLessThanOrEqual(MAX_CHANNEL_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("produces the same slug for names that differ only in case or spacing", () => {
    const variants = ["Growth Team", "growth team", "GROWTH   TEAM", " Growth-Team "];
    const slugs = new Set(variants.map(slugifyChannelName));
    expect(slugs.size).toBe(1);
  });
});

describe("uniqueChannelSlug (de-colliding within one workspace)", () => {
  it("hands back the base when nothing has taken it", () => {
    expect(uniqueChannelSlug("growth", [])).toBe("growth");
  });

  it("numbers from 2 when the base is taken", () => {
    expect(uniqueChannelSlug("growth", ["growth"])).toBe("growth-2");
  });

  it("skips over an existing numbered sibling", () => {
    expect(uniqueChannelSlug("growth", ["growth", "growth-2"])).toBe("growth-3");
  });

  it("fills the first gap in the series rather than always appending", () => {
    expect(uniqueChannelSlug("growth", ["growth", "growth-3"])).toBe("growth-2");
  });

  it("ignores slugs from another family", () => {
    expect(uniqueChannelSlug("growth", ["design", "finance", "growth-lab"])).toBe("growth");
  });

  it("refuses the route segments the chat pages reserve", () => {
    expect(uniqueChannelSlug("new", [])).toBe("new-2");
  });

  it("returns something unused for every prefix of a crowded family", () => {
    // Build up a workspace one channel at a time; each answer must be new.
    const taken: string[] = [];
    for (let i = 0; i < 25; i++) {
      const next = uniqueChannelSlug("growth", taken);
      expect(taken).not.toContain(next);
      taken.push(next);
    }
    expect(new Set(taken).size).toBe(taken.length);
  });

  it("keeps every answer inside the URL-safe set, even under collision", () => {
    const taken: string[] = [];
    for (let i = 0; i < 12; i++) {
      const next = uniqueChannelSlug(slugifyChannelName("🎉 Party 🎉"), taken);
      expect(next).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      taken.push(next);
    }
  });
});
