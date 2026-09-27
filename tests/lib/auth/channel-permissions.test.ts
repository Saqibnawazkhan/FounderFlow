import { describe, expect, it } from "vitest";
import {
  canDeleteMessage,
  canManageChannel,
  canPostInChannel,
  canPostRunwayCard,
  canSeeChannel,
  dmKeyFor,
  visibleChannelWhere,
} from "@/lib/auth/channel-permissions";
import { CHANNEL_KINDS } from "@/lib/schemas/chat";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";

const ROLES: readonly Role[] = ["admin", "cofounder", "member"];

const ME = "cme00000000000000000000aa";
const CO = "c_nimbus";
const THEM = "cthem0000000000000000000b";

describe("canSeeChannel (who can read a channel at all)", () => {
  it("a member of the company sees a public channel they never joined", () => {
    expect(canSeeChannel({ kind: "public", isMember: false })).toBe(true);
  });

  it("a member of the company sees a public channel they did join", () => {
    expect(canSeeChannel({ kind: "public", isMember: true })).toBe(true);
  });

  it("a non-member cannot see a private channel", () => {
    expect(canSeeChannel({ kind: "private", isMember: false })).toBe(false);
  });

  it("an invited member sees the private channel", () => {
    expect(canSeeChannel({ kind: "private", isMember: true })).toBe(true);
  });

  it("a non-participant cannot see a direct message", () => {
    expect(canSeeChannel({ kind: "dm", isMember: false })).toBe(false);
  });

  it("a participant sees their direct message", () => {
    expect(canSeeChannel({ kind: "dm", isMember: true })).toBe(true);
  });

  // The rule this codebase most plausibly breaks by accident, in the name of
  // consistency with every other admin gate. Company role governs the
  // company's RECORDS; it does not govern private conversations. If this test
  // fails, somebody added `|| role === "admin"` to canSeeChannel and the
  // product now silently lets founders read private channels. That is a
  // product decision with a legal shape, not a refactor.
  it("an admin does not get a back door into a private channel they were not invited to", () => {
    // canSeeChannel takes no role at all — which IS the guarantee. The
    // assertion is that the answer is false for a non-member regardless of
    // what role the caller happens to hold.
    for (const _role of ROLES) {
      expect(canSeeChannel({ kind: "private", isMember: false })).toBe(false);
      expect(canSeeChannel({ kind: "dm", isMember: false })).toBe(false);
    }
  });

  // Fails closed: an unrecognised kind (a half-shipped migration, a typo in a
  // seed) must not become universally readable.
  it("an unknown channel kind is treated as private", () => {
    expect(canSeeChannel({ kind: "broadcast", isMember: false })).toBe(false);
    expect(canSeeChannel({ kind: "broadcast", isMember: true })).toBe(true);
  });
});

describe("canPostInChannel (who can write)", () => {
  it("anyone in the company posts in a public channel without joining", () => {
    expect(canPostInChannel({ kind: "public", isMember: false })).toBe(true);
  });

  it("an invited member posts in a private channel", () => {
    expect(canPostInChannel({ kind: "private", isMember: true })).toBe(true);
  });

  it("a non-member cannot post in a private channel", () => {
    expect(canPostInChannel({ kind: "private", isMember: false })).toBe(false);
  });

  // Archiving is a soft close: history stays readable, writing stops — for
  // everyone, with no exception for the people who could un-archive it.
  it("nobody can post in an archived channel", () => {
    const archivedAt = new Date("2026-09-01T00:00:00.000Z");
    for (const kind of CHANNEL_KINDS) {
      for (const isMember of [true, false]) {
        expect(canPostInChannel({ kind, isMember, archivedAt })).toBe(false);
      }
    }
  });

  it("accepts a serialized archivedAt string the same as a Date", () => {
    expect(canPostInChannel({ kind: "public", isMember: true, archivedAt: "2026-09-01" })).toBe(
      false
    );
  });

  // Posting is strictly narrower than reading. If this ever inverts, someone
  // can write into a channel they cannot open.
  it("never grants posting where reading is denied", () => {
    for (const kind of [...CHANNEL_KINDS, "broadcast"]) {
      for (const isMember of [true, false]) {
        for (const archivedAt of [null, new Date()]) {
          const post = canPostInChannel({ kind, isMember, archivedAt });
          if (post) expect(canSeeChannel({ kind, isMember })).toBe(true);
        }
      }
    }
  });
});

describe("canDeleteMessage (moderation)", () => {
  it("the author deletes their own message", () => {
    for (const role of ROLES) {
      expect(canDeleteMessage({ userId: ME, role, authorId: ME })).toBe(true);
    }
  });

  it("an admin deletes anyone's message", () => {
    expect(canDeleteMessage({ userId: ME, role: "admin", authorId: THEM })).toBe(true);
  });

  // Cofounder tracks admin here, as it does in canSeeFinances,
  // canManageProject, canReassignSupervisor and canManageChannel. Moderation
  // is the founder tier's job; members are the restricted one. If this ever
  // needs to become admin-only, that is a product decision about who may erase
  // other people's words — make it deliberately, don't drift into it.
  it("a cofounder deletes anyone's message, like an admin", () => {
    expect(canDeleteMessage({ userId: ME, role: "cofounder", authorId: THEM })).toBe(true);
  });

  it("a member cannot delete someone else's message", () => {
    expect(canDeleteMessage({ userId: ME, role: "member", authorId: THEM })).toBe(false);
  });
});

describe("canManageChannel (rename / archive)", () => {
  it("an admin manages any channel", () => {
    expect(canManageChannel({ role: "admin", channelRole: null })).toBe(true);
  });

  it("a cofounder manages any channel", () => {
    expect(canManageChannel({ role: "cofounder", channelRole: null })).toBe(true);
  });

  it("the channel owner manages their own channel without a company role", () => {
    expect(canManageChannel({ role: "member", channelRole: "owner" })).toBe(true);
  });

  it("a plain channel member cannot rename or archive it", () => {
    expect(canManageChannel({ role: "member", channelRole: "member" })).toBe(false);
  });

  it("a member who never joined cannot manage the channel", () => {
    expect(canManageChannel({ role: "member", channelRole: null })).toBe(false);
    expect(canManageChannel({ role: "member" })).toBe(false);
  });
});

describe("dmKeyFor (the direct-message identity)", () => {
  // Without sorting, "I open a DM with you" and "you open a DM with me"
  // produce different keys, the unique index never fires, and the pair ends up
  // with two half-conversations neither of them can see the whole of.
  it("produces the same direct-message key whichever way round the pair is given", () => {
    expect(dmKeyFor(ME, THEM)).toBe(dmKeyFor(THEM, ME));
  });

  it("joins the sorted pair with a colon", () => {
    const key = dmKeyFor(THEM, ME);
    expect(key).toBe([ME, THEM].sort().join(":"));
    expect(key.split(":")).toHaveLength(2);
  });

  it("keeps different pairs distinct", () => {
    const third = "cthird000000000000000000c";
    const keys = [dmKeyFor(ME, THEM), dmKeyFor(ME, third), dmKeyFor(THEM, third)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Coincidence guard: the predicate and the query must answer identically.
// ─────────────────────────────────────────────────────────────────────

type ChannelRow = { kind: string; members: Array<{ userId: string }> };

/**
 * A deliberately tiny, hand-written interpreter for the ONLY `where` forms
 * visibleChannelWhere actually produces: a top-level OR, a scalar equality on
 * `kind`, and a `members: { some: { userId } }` relation filter. It is not a
 * Prisma emulator and must not grow into one — if visibleChannelWhere starts
 * emitting a shape this doesn't handle, that is the signal to update BOTH the
 * interpreter and this guard, on purpose.
 */
function matchesWhere(where: unknown, row: ChannelRow): boolean {
  const w = where as {
    companyId?: string;
    OR?: unknown[];
    kind?: string;
    members?: { some?: { userId?: string } };
  };
  // companyId is asserted separately; the matrix below is all one workspace,
  // so the interpreter steps over it rather than pretending to check tenancy.
  if (typeof w.companyId === "string" && w.OR === undefined) return true;
  if (Array.isArray(w.OR)) return w.OR.some((clause) => matchesWhere(clause, row));
  if (typeof w.kind === "string") return row.kind === w.kind;
  if (w.members?.some?.userId !== undefined) {
    const wanted = w.members.some.userId;
    return row.members.some((m) => m.userId === wanted);
  }
  throw new Error(`unsupported where shape: ${JSON.stringify(where)}`);
}

describe("visibleChannelWhere (the query form of canSeeChannel)", () => {
  it("emits the OR of public-kind and my-membership, scoped to one workspace", () => {
    expect(visibleChannelWhere(ME, CO)).toEqual({
      companyId: CO,
      OR: [{ kind: "public" }, { members: { some: { userId: ME } } }],
    });
  });

  // The tenant boundary is a REQUIRED argument rather than something callers
  // remember to spread in alongside it. Without companyId the fragment matches
  // every public channel in every workspace — the one way chat could leak
  // across companies, and the one thing the matrix guard below cannot catch,
  // because it only ever evaluates rows from a single workspace.
  it("always carries the company scope", () => {
    expect(visibleChannelWhere(ME, CO).companyId).toBe(CO);
  });

  // The rail and the archive view select channels with this fragment; every
  // other read path re-checks with canSeeChannel. If the two disagree, THE
  // QUERY IS THE ONE THAT LEAKS — it runs with no per-row predicate behind it,
  // so a row it wrongly matches is a private channel rendered in somebody's
  // sidebar. A failure here is not a test to relax; it means the two
  // expressions of one rule have drifted apart and the query must be brought
  // back to the predicate.
  it("visibleChannelWhere agrees with canSeeChannel across the full fixture matrix", () => {
    const where = visibleChannelWhere(ME, CO);
    let checked = 0;

    for (const kind of CHANNEL_KINDS) {
      for (const isMember of [true, false]) {
        const row: ChannelRow = {
          kind,
          // A channel always has other members; only MY row varies.
          members: isMember ? [{ userId: THEM }, { userId: ME }] : [{ userId: THEM }],
        };
        expect(matchesWhere(where, row)).toBe(canSeeChannel({ kind, isMember }));
        checked += 1;
      }
    }

    // The invariant is "every combination was exercised", asserted against the
    // matrix itself rather than a hardcoded number, so adding a channel kind
    // widens the guard instead of breaking it.
    expect(checked).toBe(CHANNEL_KINDS.length * 2);
  });
});

describe("canPostRunwayCard (who may publish the company balance into a conversation)", () => {
  it("an admin posts a runway card", () => {
    expect(canPostRunwayCard("admin")).toBe(true);
  });

  it("a cofounder posts a runway card", () => {
    expect(canPostRunwayCard("cofounder")).toBe(true);
  });

  // A member cannot see the balance on /dashboard — /dashboard is in
  // MEMBER_BLOCKED_ROUTES — so they certainly cannot publish it into a channel
  // their whole team reads.
  it("a member cannot post a runway card", () => {
    expect(canPostRunwayCard("member")).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Coincidence guard: posting the balance and reading the balance are the
  // same rule, written once.
  //
  // `canPostRunwayCard` DELEGATES to `canSeeFinances` rather than restating
  // `admin || cofounder`, and this guard is what keeps the delegation honest.
  // Today the two agree trivially, which is exactly the condition under which
  // somebody "simplifies" the delegation into a second copy of the role list
  // and nothing visibly breaks.
  //
  // IF THIS FAILS, THE FINANCE RULE HAS BEEN FORKED, AND THE COPY IN CHAT IS
  // THE ONE THAT WILL LEAK. A role removed from `canSeeFinances` keeps
  // publishing the company's cash position into a public channel, because
  // nobody remembered there was a second list down in chat. Do not relax this
  // test to match the fork — collapse the fork back onto `canSeeFinances`. If
  // the two genuinely must diverge, that is a product decision about who may
  // publish a number they cannot look at, and it needs its own reasoning, not
  // an edited assertion.
  // ─────────────────────────────────────────────────────────────────────
  it("canPostRunwayCard agrees with canSeeFinances for every role", () => {
    let checked = 0;
    for (const role of ROLES) {
      expect(
        canPostRunwayCard(role),
        `canPostRunwayCard forked from canSeeFinances at "${role}"`
      ).toBe(canSeeFinances(role));
      checked += 1;
    }
    // Asserted against the role list itself rather than a hardcoded 3, so
    // adding a role widens the guard instead of leaving it half-blind.
    expect(checked).toBe(ROLES.length);
  });

  // The author gate is the WEAKER half of the rule and must not be mistaken
  // for the whole of it. It says nothing about who can post WHERE — an admin
  // still cannot post a card into an archived channel or into a private
  // channel they were never invited to, because callers must pass
  // canPostInChannel as well. Composition, not substitution.
  it("grants nothing about the channel — an admin still needs canPostInChannel", () => {
    expect(canPostRunwayCard("admin")).toBe(true);
    expect(canPostInChannel({ kind: "private", isMember: false })).toBe(false);
    expect(
      canPostInChannel({ kind: "public", isMember: true, archivedAt: new Date("2026-09-01") })
    ).toBe(false);
  });
});
