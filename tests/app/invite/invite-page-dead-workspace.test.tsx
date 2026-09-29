/**
 * auth-009 — AN INVITE PAGE THAT OUTLIVES THE WORKSPACE IT WAS SENT FOR.
 *
 * WHAT IS ALREADY CLOSED, so nobody re-fixes it here. The SECURITY half is shut
 * twice over: `acceptInviteAction` refuses a token whose company carries a
 * tombstone (lib/actions/team.ts, finding data-integrity-003, tested in
 * tests/lib/auth/finance-gate.test.ts), and `softDeleteWorkspace` hard-deletes
 * every unused invite token inside the *same* `$transaction` that writes
 * `Company.deletedAt` (lib/actions/account.ts, acct-003), so after any in-app
 * workspace delete the row is gone and the page's "invalid link" branch fires.
 * Nobody can set a password and walk into a dead workspace.
 *
 * WHAT WAS STILL OPEN, and is what this file is about. The PAGE fetched the
 * company and never read `deletedAt` — `grep -rn deletedAt app/invite/` returned
 * nothing. So for the cases where a token can still outlive its workspace (a
 * tombstone written before the token burn landed, or one written by hand in the
 * database) the recipient got the complete welcome: their first name, their
 * email, the workspace name, the role they would hold, and a password field.
 * They chose a password, submitted, and only then were told the workspace is
 * gone. The two surfaces disagreed about the same token.
 *
 * WHY THE WORDING IS ASSERTED AGAINST THE ACTION'S SOURCE. Copying the sentence
 * into this file would let the two drift apart again the first time somebody
 * rewords one of them — which is the shape of the original bug. So the expected
 * text is READ OUT OF lib/actions/team.ts at run time: change either surface's
 * wording alone and this fails, which forces them to move together.
 *
 * Per HOUSE-RULES rule 15(b) this is a DOM-contract test. It asserts no colour
 * and no computed style. The page is an async Server Component, so it is called
 * and its returned element rendered — exactly what Next does.
 *
 * THE INVITE PAGE'S RATE LIMIT IS NOT THIS FILE'S SUBJECT (auth-008's GET half
 * lives in tests/lib/actions/accept-invite-throttle.test.ts), but the page now
 * reads the client address before it looks anything up, so the mock and the
 * `resetAuthGates()` below are what keep these assertions about auth-009.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type React from "react";

/* ── the one invite row, and the workspace it points at ────────────────── */

const H = vi.hoisted(() => {
  const company = {
    id: "c_nimbus",
    name: "Nimbus Labs",
    deletedAt: null as Date | null,
  };
  const invite = {
    id: "inv_zara",
    companyId: "c_nimbus",
    email: "zara@nimbus.app",
    name: "Zara Khan",
    role: "member",
    token: "f0e1d2c3b4a596871234567890abcdef".repeat(2),
    usedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 5 * 86_400_000),
    invitedBy: "u_ayesha",
  };
  const exists = { value: true };
  const db = {
    inviteToken: {
      findUnique: () =>
        Promise.resolve(exists.value ? { ...invite, company: { ...company } } : null),
    },
  };
  return { company, invite, exists, db };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
// The page reads the client address for its own rate-limit bucket (auth-008's
// GET half), and `headers()` throws outside a request scope. A fixed trusted
// address plus `resetAuthGates()` below keeps the REAL limiter in the loop
// here — if the gate ever started refusing a first render, these tests would be
// the ones to say so — while giving every test its own full allowance.
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("198.51.100.5") }));
// The App Router's Link needs a router context it has no business having here;
// an anchor is the whole of what this page asks of it.
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The password form is a client island with its own tests; what matters here is
// whether the page renders it at all, so it is reduced to a recognisable stub.
//
// THE STUB RENDERS THE PROPS IT IS HANDED, and that is load-bearing rather than
// decorative. The real island prints the invitee's e-mail
// (accept-invite-client.tsx:79); a stub that swallowed it made
// "does not print the invitee's address" below an assertion that could not fail
// in the fixed page or the unfixed one. Mirroring the two identifying props is
// the smallest thing that makes the leak observable where the test looks for it.
vi.mock("@/app/invite/[token]/accept-invite-client", () => ({
  AcceptInviteClient: ({
    inviteeEmail,
    inviteeName,
  }: {
    inviteeEmail: string;
    inviteeName: string;
  }) => (
    <form data-testid="accept-invite-form">
      <span>{inviteeEmail}</span>
      <span>{inviteeName}</span>
    </form>
  ),
}));
// Belt and braces: if the alias above ever stops matching, the real island must
// still not drag bcrypt/next-auth into a DOM test.
vi.mock("@/lib/actions/team", () => ({
  acceptInviteAction: () => Promise.resolve({ success: true }),
}));

import InvitePage from "@/app/invite/[token]/page";
import { resetAuthGates } from "@/lib/rate-limit";

/* ── the action's wording, read from the action ────────────────────────── */

/**
 * `acceptInviteAction`'s refusal for exactly this case. Extracted rather than
 * copied — see the header. The lead clause is the page's heading; the rest is
 * its body.
 */
const ACTION_MESSAGE = (() => {
  const source = readFileSync(join(process.cwd(), "lib/actions/team.ts"), "utf8");
  const match = /"(This workspace is no longer [^"]+)"/.exec(source);
  if (!match) {
    throw new Error(
      "lib/actions/team.ts no longer refuses a tombstoned workspace by that name — " +
        "if the action's wording changed, the page at app/invite/[token]/page.tsx " +
        "has to change with it, which is what this test exists to force."
    );
  }
  return match[1];
})();

const SENTENCE_BREAK = ACTION_MESSAGE.indexOf(". ");
const ACTION_LEAD = ACTION_MESSAGE.slice(0, SENTENCE_BREAK);
const ACTION_REST = ACTION_MESSAGE.slice(SENTENCE_BREAK + 2);

async function renderInvite() {
  const ui = await InvitePage({ params: { token: H.invite.token } });
  render(ui);
}

beforeEach(() => {
  // The page's render bucket is 15/min/address and every test here renders from
  // the same one, so without this the file would eventually throttle itself and
  // fail somewhere unrelated to what it asserts.
  resetAuthGates();
  H.company.deletedAt = null;
  H.exists.value = true;
  H.invite.usedAt = null;
  H.invite.expiresAt = new Date(Date.now() + 5 * 86_400_000);
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("an invite whose workspace has been deleted", () => {
  beforeEach(() => {
    H.company.deletedAt = new Date("2026-09-20T10:00:00.000Z");
  });

  it("does not offer a password form for a workspace that no longer exists", async () => {
    await renderInvite();

    expect(
      screen.queryByTestId("accept-invite-form"),
      "the recipient must not be asked to choose a password for a dead workspace"
    ).toBeNull();
    expect(screen.queryByText(/Welcome to/), "and must not be welcomed into it either").toBeNull();
  });

  it("says the same thing the action would say on submit", async () => {
    await renderInvite();

    expect(
      screen.getByRole("heading", { level: 1 }).textContent,
      `the page and lib/actions/team.ts must agree; the action says "${ACTION_MESSAGE}"`
    ).toBe(ACTION_LEAD);
    expect(screen.getByText(ACTION_REST)).toBeInTheDocument();
  });

  // SPLIT INTO TWO, one property each, because one of them used to be
  // unfalsifiable and hiding behind the other. See the note on the second.
  it("does not name the workspace", async () => {
    // A tombstoned workspace is one whose owner asked us to erase it. Naming it
    // to whoever opens a stale link is not something the dead-end state needs
    // to do its job.
    await renderInvite();

    expect(screen.queryByText(/Nimbus Labs/)).toBeNull();
  });

  it("does not print the invitee's address", async () => {
    // THIS ASSERTION USED TO BE VACUOUS, and it is worth saying how, because it
    // is the shape of mistake that keeps recurring here. The address is
    // rendered by the client island (accept-invite-client.tsx:79 —
    // `{inviteeEmail}`), the island is stubbed in this file, and the stub used
    // to render `<form data-testid="accept-invite-form" />` and nothing else.
    // So the address could not reach the DOM in the fixed page OR the unfixed
    // one: the assertion could not fail, and detected nothing.
    //
    // The stub now renders the props it is handed, which is what makes this
    // observable. The positive control is in the live-workspace test below: it
    // asserts the address IS on the page when the island renders, so this
    // negative can never go quiet again by the props silently stopping.
    await renderInvite();

    expect(screen.queryByText(/zara@nimbus\.app/)).toBeNull();
  });
});

describe("the branches that already worked keep working", () => {
  it("still renders the join form for a live workspace", async () => {
    // The guard against over-blocking: this is the case the page exists for.
    await renderInvite();

    expect(screen.getByTestId("accept-invite-form")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Welcome to");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Nimbus Labs");
    // THE POSITIVE CONTROL for "does not print the invitee's address" above. The
    // page passes `inviteeEmail` to the island and the island prints it, so when
    // the island renders the address IS on the page. If this ever goes quiet —
    // the prop renamed, the stub stopped mirroring it — the negative assertion
    // becomes unfalsifiable again, and this is the assertion that notices.
    expect(
      screen.getByText("zara@nimbus.app"),
      "the invitee's address must reach the DOM here, or the dead-workspace test " +
        "that asserts its ABSENCE is asserting nothing"
    ).toBeInTheDocument();
  });

  it("still refuses an expired invite", async () => {
    H.invite.expiresAt = new Date(Date.now() - 86_400_000);
    await renderInvite();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This invite has expired");
  });

  it("still refuses an invite that has been claimed", async () => {
    H.invite.usedAt = new Date("2026-09-10T10:00:00.000Z");
    await renderInvite();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This invite has already been used"
    );
  });

  it("still refuses a token that does not exist", async () => {
    H.exists.value = false;
    await renderInvite();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This invite link is invalid"
    );
  });
});
