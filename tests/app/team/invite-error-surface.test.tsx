/**
 * acct-016 on /team — the remedy the admin can still read.
 *
 * WHAT acct-016 GAVE THE SERVER. `inviteUserAction` no longer answers an
 * address collision with one flat sentence. It now distinguishes a *deactivated*
 * teammate from a *deleted* account and hands back an instruction for each
 * (the two `existing?.deletedAt` branches of `inviteUserAction`) — "Reactivate
 * them in the Deactivated list
 * on the Team page instead of re-inviting them", and "Contact support to restore
 * it, or invite a different address". Same file, `reactivateUserAction` throws a
 * three-option instruction when the workspace is at its seat cap
 * (`seatLimitMessage`): upgrade, or deactivate someone else, or give up.
 *
 * WHAT THE CLIENT DID WITH IT. `toast.error(res.error)` and nothing else, at a
 * toaster duration of 3500ms (components/providers.tsx:186). Every one of those
 * messages asks the reader to CHOOSE between two or three courses of action, and
 * the sentence is gone before a careful reader has finished weighing them. There
 * is nothing left on screen to re-read and nothing an assistive technology can be
 * pointed back at.
 *
 * WHAT THIS FILE PINS, and why it is the DOM and not a variable. The previous
 * wave was caught asserting that a hint had been *computed* while never checking
 * it reached the screen, so deleting the JSX left the suite green and the fix
 * invisible. So: mount the real component, drive the real failing submit, and
 * read the text off the rendered output. Deleting either rendered line in
 * team-client.tsx turns this file red.
 *
 * SCOPE — WHY TWO HANDLERS AND NOT SIX. team-client.tsx has six toast-only
 * failure handlers. A toast is the right surface for a verdict ("Invite not
 * found", "Not authorized", "Couldn't revoke right now"); it is the wrong one for
 * an instruction. Of the four left alone, each one's instruction-shaped message
 * is UNREACHABLE from this UI, which is the evidence rather than a preference:
 *
 *   - handleRoleChange — the only instruction it can receive is "You're the only
 *     admin. Promote someone else first" (`updateUserRoleAction`), which needs
 *     `target.id === actorId`; team-client renders the role <select> only for
 *     `user.id !== currentUserId`, so the actor cannot aim it at themselves.
 *   - handleRemove — both of its instructions are equally out of reach: "Use the
 *     Sign-out button" (`removeUserAction`) needs `userId === actorId` and the
 *     Deactivate button is rendered only for other people; "You can't remove the
 *     last admin" (`removeUserAction`) needs an admin target while `adminCount <= 1`,
 *     and the actor is already an admin who is not the target, so the count is at
 *     least 2 whenever that branch is evaluated.
 *   - handleResend / handleRevoke — every refusal is a short verdict.
 *
 * If one of those messages ever becomes reachable, it needs this treatment too.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeactivatedUser, Task, User } from "@/lib/types";

/* ───────────────────────────── mocks ─────────────────────────────────── */

const nav = vi.hoisted(() => ({ router: { refresh: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

const actions = vi.hoisted(() => ({
  inviteUserAction: vi.fn(),
  reactivateUserAction: vi.fn(),
  removeUserAction: vi.fn(),
  resendInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  updateUserRoleAction: vi.fn(),
}));
vi.mock("@/lib/actions/team", () => ({
  inviteUserAction: (input: unknown) => actions.inviteUserAction(input),
  reactivateUserAction: (id: string) => actions.reactivateUserAction(id),
  removeUserAction: (id: string) => actions.removeUserAction(id),
  resendInviteAction: (id: string) => actions.resendInviteAction(id),
  revokeInviteAction: (id: string) => actions.revokeInviteAction(id),
  updateUserRoleAction: (input: unknown) => actions.updateUserRoleAction(input),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

// Real dictionary, real formatters; only the store is faked, because that is
// where the locale and the workspace currency come from.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

import { TeamClient } from "@/app/(app)/team/team-client";
import { FREE_MEMBER_LIMIT, PLAN_LABELS } from "@/lib/billing/plan";

/* ──────────────────────────── fixtures ───────────────────────────────── */

/**
 * The two collision refusals, spelled exactly as lib/actions/team.ts returns
 * them. The seat-cap one below is DERIVED instead — see its comment.
 */
const DELETED_ACCOUNT_REFUSAL =
  "That email belongs to a FounderFlow account that was deleted. " +
  "Contact support to restore it, or invite a different address.";

const DEACTIVATED_TEAMMATE_REFUSAL =
  "That teammate is deactivated, not gone — their address stays reserved while " +
  "the account exists. Reactivate them in the Deactivated list on the Team page " +
  "instead of re-inviting them.";

/**
 * `reactivateUserAction`'s seat-cap instruction, BUILT FROM THE SAME CONSTANTS
 * THE ACTION INTERPOLATES rather than transcribed.
 *
 * WHY, and it is not style. This fixture was written out longhand as "Your Free
 * plan is limited to 2 members…" under a comment claiming it was the action's
 * copy verbatim. It never was: the action interpolates `${PLAN_LABELS.free}`,
 * and that label is "Solo", so the sentence a real admin reads begins "Your
 * Solo plan…". Because this file feeds the fixture into a mocked action and
 * reads it back off the DOM, the mismatch could not fail — it pinned the
 * surface while describing copy the server has never sent, and it would have
 * stayed green through any rename of either plan. Two independent adversarial
 * verifiers found it in the same wave.
 *
 * Deriving it means a label or cap change moves the expectation with the code.
 * The other three fixtures above stay longhand on purpose: their strings are
 * literals in the action, so transcribing them is a real cross-check, whereas
 * transcribing an interpolation only copies today's output of it.
 */
const SEAT_CAP_REFUSAL =
  `Your ${PLAN_LABELS.free} plan is limited to ${FREE_MEMBER_LIMIT} members, and it is full. ` +
  `Upgrade to ${PLAN_LABELS.team} in Settings, or deactivate someone else, to restore Bilal.`;

const admin: User = {
  id: "u-admin",
  name: "Ayesha Khan",
  email: "ayesha@example.com",
  password: "",
  role: "admin",
  companyId: "c1",
  createdAt: "2026-01-04T10:00:00.000Z",
};

const deactivated: DeactivatedUser = {
  id: "u-bilal",
  name: "Bilal",
  email: "bilal@example.com",
  role: "cofounder",
  deactivatedAt: "2026-09-01T10:00:00.000Z",
};

// No `transactions` prop any more: /team receives no ledger rows at all, only
// the per-person contribution aggregate (transactions-ledger-001).
const tasks: Task[] = [];

function renderTeam() {
  return render(
    <TeamClient
      users={[admin]}
      tasks={tasks}
      pendingInvites={[]}
      deactivatedUsers={[deactivated]}
      currentUserId={admin.id}
      currentUserRole="admin"
    />
  );
}

/** Open the invite dialog and submit a valid invite. */
async function submitInvite(user: ReturnType<typeof userEvent.setup>, email = "ghost@example.com") {
  await user.click(screen.getByRole("button", { name: /invite member/i }));
  await user.type(await screen.findByLabelText("Full name"), "Ghost Founder");
  await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("button", { name: /to team$/i }));
}

/* ──────────────────────────── the invite form ────────────────────────── */

describe("a refused invite leaves its instruction on the screen", () => {
  beforeEach(() => {
    Object.values(actions).forEach((fn) => fn.mockReset());
    toasts.error.mockReset();
    toasts.success.mockReset();
  });

  it("renders the deleted-account remedy where it can be re-read", async () => {
    // WHAT BREAKS IN PRODUCTION: a 3500ms toast is the entire delivery of a
    // two-option instruction. The admin looks away to decide between "contact
    // support" and "a different address", and the sentence that offered them
    // both is gone with no way back to it.
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);
  });

  it("renders the deactivated-teammate remedy too — it names a place to go", async () => {
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DEACTIVATED_TEAMMATE_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user, "bilal@example.com");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DEACTIVATED_TEAMMATE_REFUSAL);
  });

  it("keeps the address that caused it, so the fix is one edit", async () => {
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user, "ghost@example.com");

    await screen.findByRole("alert");
    expect(screen.getByLabelText("Email")).toHaveValue("ghost@example.com");
  });

  it("clears the old refusal when the admin tries again", async () => {
    // A stale instruction sitting under a fresh attempt reads as a second
    // failure for the same reason.
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user);
    await screen.findByRole("alert");

    actions.inviteUserAction.mockResolvedValue({
      success: true,
      data: { email: "ghost@example.com", emailSent: true, inviteUrl: "https://x/invite/t" },
    });
    await user.click(screen.getByRole("button", { name: /to team$/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not carry a stale refusal into a reopened dialog", async () => {
    // Today this holds because `Modal` is a Radix Dialog that unmounts its
    // content when it closes, so no clear-on-close is wired in the form (see the
    // note on `formError` in team-client.tsx). The assertion is here so that if
    // `forceMount` is ever added, the gap surfaces as a failing test rather than
    // as a week-old refusal greeting the next invite.
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user);
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    await user.click(screen.getByRole("button", { name: /invite member/i }));
    await screen.findByLabelText("Full name");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still fires the toast, which is what pulls the eye back to the dialog", async () => {
    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await submitInvite(user);

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DELETED_ACCOUNT_REFUSAL));
  });
});

describe("the invite refusal outlives the toast", () => {
  beforeEach(() => {
    Object.values(actions).forEach((fn) => fn.mockReset());
    toasts.error.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is still on screen long after 3500ms would have taken the toast away", async () => {
    // The point of the fix is that this copy has no expiry. `shouldAdvanceTime`
    // keeps Radix's and RHF's own timers running in real time so the dialog
    // still mounts; the explicit jump is what proves nothing clears the line.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    actions.inviteUserAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    renderTeam();
    await submitInvite(user);
    await screen.findByRole("alert");

    vi.advanceTimersByTime(30_000);

    expect(screen.getByRole("alert")).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);
  });
});

/* ───────────────────── the Reactivate button on the roster ───────────── */

describe("a refused reactivation leaves its instruction on the screen", () => {
  beforeEach(() => {
    Object.values(actions).forEach((fn) => fn.mockReset());
    toasts.error.mockReset();
  });

  it("renders the seat-cap remedy in the row the admin pressed", async () => {
    // This one has no dialog to render into, which is exactly why it was the
    // worst of the six: the whole delivery of a three-option instruction was a
    // toast at the top of the viewport, fired by a button at the bottom of the
    // page, and 3500ms later there was no record that anything had happened.
    actions.reactivateUserAction.mockResolvedValue({
      success: false,
      error: SEAT_CAP_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await user.click(screen.getByRole("button", { name: /reactivate/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SEAT_CAP_REFUSAL);
    // Adjacent to the click, not parked at the top of a long roster.
    expect(alert.closest("li")).toHaveTextContent(deactivated.email);
  });

  it("still fires the toast", async () => {
    actions.reactivateUserAction.mockResolvedValue({
      success: false,
      error: SEAT_CAP_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await user.click(screen.getByRole("button", { name: /reactivate/i }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(SEAT_CAP_REFUSAL));
  });

  it("clears the refusal once the reactivation succeeds", async () => {
    actions.reactivateUserAction.mockResolvedValue({
      success: false,
      error: SEAT_CAP_REFUSAL,
    });

    const user = userEvent.setup();
    renderTeam();
    await user.click(screen.getByRole("button", { name: /reactivate/i }));
    await screen.findByRole("alert");

    actions.reactivateUserAction.mockResolvedValue({ success: true, data: undefined });
    await user.click(screen.getByRole("button", { name: /reactivate/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
