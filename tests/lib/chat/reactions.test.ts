import { describe, it, expect } from "vitest";
import { foldReactions, type ReactionRow } from "@/lib/chat/reactions";
import { REACTION_EMOJI } from "@/lib/schemas/chat";

const ME = "u-me";

function rows(...pairs: [string, string][]): ReactionRow[] {
  return pairs.map(([emoji, userId]) => ({ emoji, userId }));
}

describe("foldReactions (raw rows → the chip rail)", () => {
  it("returns nothing for a message nobody reacted to", () => {
    expect(foldReactions([], ME)).toEqual([]);
  });

  it("counts everyone who used the same emoji as one chip", () => {
    const folded = foldReactions(rows(["👍", "u-a"], ["👍", "u-b"], ["👍", "u-c"]), ME);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toEqual({ emoji: "👍", count: 3, mine: false });
  });

  it("marks the chip the viewer is in as mine", () => {
    const folded = foldReactions(rows(["👍", "u-a"], ["👍", ME]), ME);
    expect(folded[0].mine).toBe(true);
    expect(folded[0].count).toBe(2);
  });

  it("leaves another viewer's chip unmarked", () => {
    const folded = foldReactions(rows(["👍", "u-a"], ["👍", ME]), "u-someone-else");
    expect(folded[0].mine).toBe(false);
  });

  it("gives each distinct emoji its own chip", () => {
    const folded = foldReactions(rows(["👍", "u-a"], ["🎉", "u-a"], ["👀", "u-b"]), ME);
    expect(folded.map((f) => f.emoji)).toEqual(["👍", "🎉", "👀"]);
  });

  it("does not let one person count twice for the same emoji", () => {
    const folded = foldReactions(rows(["👍", "u-a"], ["👍", "u-a"]), ME);
    expect(folded[0].count).toBe(1);
  });

  it("keeps an emoji that has since left the allow-list rather than dropping it", () => {
    const folded = foldReactions(rows(["🦄", "u-a"], ["👍", "u-b"]), ME);
    expect(folded.map((f) => f.emoji)).toContain("🦄");
    // Retired emoji sort after the known set so a chip never jumps the queue.
    expect(folded[folded.length - 1].emoji).toBe("🦄");
  });

  it("orders chips by the allow-list, not by how many people reacted", () => {
    // 👀 is later in REACTION_EMOJI than 👍 but has far more reactions.
    const many: ReactionRow[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ emoji: "👀", userId: `u-${i}` })),
      { emoji: "👍", userId: "u-solo" },
    ];
    expect(foldReactions(many, ME).map((f) => f.emoji)).toEqual(["👍", "👀"]);
  });

  it("orders chips the same way however the rows arrive", () => {
    const source = rows(["🚀", "u-a"], ["👍", "u-b"], ["❤️", "u-c"], ["🎉", "u-d"]);
    const forward = foldReactions(source, ME).map((f) => f.emoji);
    const reversed = foldReactions([...source].reverse(), ME).map((f) => f.emoji);
    expect(reversed).toEqual(forward);
  });

  it("puts every allow-listed emoji in its declared position when all are used", () => {
    const all = REACTION_EMOJI.map((emoji, i) => ({ emoji, userId: `u-${i}` }));
    const folded = foldReactions([...all].reverse(), ME);
    expect(folded.map((f) => f.emoji)).toEqual([...REACTION_EMOJI]);
    for (const chip of folded) {
      expect(chip.count).toBe(1);
      expect(chip.mine).toBe(false);
    }
  });

  it("accounts for every row it was given, across a mixed rail", () => {
    const source = rows(
      ["👍", "u-a"],
      ["👍", ME],
      ["🎉", "u-b"],
      ["🚀", "u-a"],
      ["🚀", "u-b"],
      ["🚀", ME]
    );
    const folded = foldReactions(source, ME);
    const total = folded.reduce((sum, f) => sum + f.count, 0);
    expect(total).toBe(source.length);
    for (const chip of folded) {
      const expectedMine = source.some((r) => r.emoji === chip.emoji && r.userId === ME);
      expect(chip.mine).toBe(expectedMine);
    }
  });
});
