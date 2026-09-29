/**
 * acct-018, second pass — the hint a CUSTOMER can see, and the branch that must
 * not guess.
 *
 * WHY THIS FILE EXISTS ALONGSIDE danger-zone-export-pointer.test.ts. That file
 * asserts the hint is *computed*: it reads `const exportHint = …` out of
 * delete-account-modal.tsx as text and checks the branch is there. Nothing in it
 * asserts the value is ever put on screen, so deleting the one line that renders
 * it — `{exportHint && <p …>}` — left all 18 of its tests green and the fix
 * invisible to every paying customer. That is this repo's signature defect
 * (computed, tested, rendered nowhere) reproduced inside the fix for another
 * finding, so the guard here is a render, not a scan: mount the modal, read the
 * screen.
 *
 * AND THE SECOND HALF, which is the reason the render matters. `deletesWorkspace`
 * is derived from `scope?.deletesWorkspace === true`, and `scope` is null in TWO
 * different situations: "we have not asked yet" and "we asked and the lookup
 * failed". The first is covered by `scopeLoaded`. The second was not: on a failed
 * `describeAccountDeletionAction` the modal used to fall through to the PERSONAL
 * variant and tell a sole founder to take "Download my data" — the one file that
 * provably does NOT contain the transactions, budgets and recurring rules this
 * click destroys (app/api/export/route.ts: money belongs to the workspace, not to
 * a person). It stated, as fact, the exact lie the branch was written to prevent.
 * On an unknown scope the modal owes the user silence, not the narrower claim.
 *
 * The copy itself is never spelled out here — every assertion goes through
 * `en.settings.*`, so rewording a string cannot turn these green or red on its
 * own. tests/app/settings/danger-zone-export-pointer.test.ts owns the wording.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteAccountModal } from "@/app/(app)/settings/delete-account-modal";
import { DeleteWorkspaceModal } from "@/app/(app)/settings/delete-workspace-modal";
import { en } from "@/lib/i18n/strings";

// Hoisted: `vi.mock`'s factory runs before module-level `const`s exist, so a
// plain `const` referenced inside it would be a TDZ ReferenceError. Mocking the
// whole action module also keeps Prisma and next-auth out of this test.
const actions = vi.hoisted(() => ({
  describeAccountDeletionAction: vi.fn(),
  deleteAccountAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
}));
vi.mock("@/lib/actions/account", () => ({
  describeAccountDeletionAction: () => actions.describeAccountDeletionAction(),
  deleteAccountAction: (input: unknown) => actions.deleteAccountAction(input),
  deleteWorkspaceAction: (input: unknown) => actions.deleteWorkspaceAction(input),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

// The real dictionary, only the store faked: `useT` reads the locale from it, and
// faking the strings would mean asserting against copy the product never ships.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ locale: "en" }),
  useStoreHasHydrated: () => true,
}));

const WORKSPACE = "Nimbus Labs";
const PERSONAL_HINT = en.settings.exportBeforeAccountDeleteHint;
const WORKSPACE_HINT = en.settings.exportBeforeWorkspaceDeleteHint;

/** Mount the account dialog and wait for the scope lookup to settle. */
async function mountAccountModal(canExportWorkspace = true) {
  render(<DeleteAccountModal open onClose={vi.fn()} canExportWorkspace={canExportWorkspace} />);
  // The submit button is disabled until the scope answer lands, so its enabling
  // is the signal that the hint has had its chance to render.
  await waitFor(() => expect(screen.getByRole("button", { name: /delete/i })).not.toBeDisabled());
}

describe("the delete-account dialog puts its export hint on the screen", () => {
  beforeEach(() => {
    actions.describeAccountDeletionAction.mockReset();
    toasts.error.mockReset();
  });

  it("shows the personal-file hint when the workspace survives the delete", async () => {
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: true,
      data: { deletesWorkspace: false, workspaceName: WORKSPACE },
    });

    await mountAccountModal();

    expect(
      screen.getByText(PERSONAL_HINT),
      "a leaver whose teammates stay behind gets the file that really does hold all of theirs"
    ).toBeInTheDocument();
    expect(screen.queryByText(WORKSPACE_HINT)).toBeNull();
  });

  it("shows the ledger warning when this delete takes the whole workspace", async () => {
    // THE RENDER THIS FILE EXISTS FOR. Every source-scanning assertion about
    // `exportHint` stays green with the rendering line deleted; this one does not.
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: true,
      data: { deletesWorkspace: true, workspaceName: WORKSPACE },
    });

    await mountAccountModal(true);

    expect(
      screen.getByText(WORKSPACE_HINT),
      "the sole founder is the one customer whose personal export omits the ledger — " +
        "the warning has to reach their eyes, not just the bundle"
    ).toBeInTheDocument();
    expect(screen.queryByText(PERSONAL_HINT)).toBeNull();
  });

  it("says nothing when the reader cannot reach the workspace export card", async () => {
    // `deletesWorkspace` is `otherUsers === 0` alone and never consults the role,
    // so this branch is reachable for a non-finance reader. Pointing at a card
    // that is not on their screen is worse than the pre-existing silence.
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: true,
      data: { deletesWorkspace: true, workspaceName: WORKSPACE },
    });

    await mountAccountModal(false);

    expect(screen.queryByText(WORKSPACE_HINT)).toBeNull();
    expect(screen.queryByText(PERSONAL_HINT)).toBeNull();
  });

  it("says nothing — not the personal-file line — when the scope lookup fails", async () => {
    // WHAT BREAKS IN PRODUCTION: `scope` is null on failure while `scopeLoaded`
    // still flips true, so `deletesWorkspace` reads false and the modal asserts
    // the NARROWER of the two claims about a destruction whose size it does not
    // know. A sole founder is told "use Download my data — your profile, tasks,
    // tracked time and comments" about a click that erases transactions, budgets
    // and recurring rules that file has never contained.
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: false,
      error: "Couldn't load your workspace details.",
    });

    await mountAccountModal();

    expect(
      screen.queryByText(PERSONAL_HINT),
      "an unknown scope must not be reported as the personal-only one"
    ).toBeNull();
    expect(screen.queryByText(WORKSPACE_HINT)).toBeNull();
  });

  it("still lets the delete be attempted when the scope lookup fails", async () => {
    // The other direction: withholding the hint must not strand the user in a
    // dialog that cannot be submitted. The server re-checks the typed workspace
    // name in the same branch that runs the cascade (lib/actions/account.ts:132),
    // so a submit with an unknown scope fails closed there, with an error that
    // names the workspace.
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: false,
      error: "Couldn't load your workspace details.",
    });

    await mountAccountModal();

    expect(screen.getByRole("button", { name: /delete/i })).not.toBeDisabled();
  });
});

describe("the delete-workspace dialog carries the same warning on screen", () => {
  it("renders the ledger warning, not just a reference to it", async () => {
    render(<DeleteWorkspaceModal open onClose={vi.fn()} workspaceName={WORKSPACE} />);

    expect(
      await screen.findByText(WORKSPACE_HINT),
      "this dialog destroys the identical rows, so it owes the identical sentence"
    ).toBeInTheDocument();
  });
});

/**
 * The same defect the acct-016 verifier found in change-email-modal.tsx — a long
 * instruction delivered only by a 3500ms toast — reached this dialog too, and here
 * it is the recovery route for the scope-lookup failure above. The sole-founder
 * gate in `deleteAccountAction` answers with a 150-character instruction that
 * names the workspace and tells the reader to type it; with the scope unknown
 * there is no name field on the screen, so the only way forward is to read that
 * sentence, close the dialog and reopen it (which re-asks for the scope). A toast
 * that has already faded makes that unguessable.
 */
describe("a refused delete leaves the server's instruction where it can be read", () => {
  const SOLE_FOUNDER_REFUSAL =
    `You're the only person in "${WORKSPACE}", so deleting your account deletes the whole ` +
    `workspace — every transaction, task and budget. Type "${WORKSPACE}" exactly to confirm.`;

  beforeEach(() => {
    actions.describeAccountDeletionAction.mockReset();
    actions.deleteAccountAction.mockReset();
    toasts.error.mockReset();
  });

  it("renders the refusal, and still fires the toast that draws the eye to it", async () => {
    actions.describeAccountDeletionAction.mockResolvedValue({
      success: false,
      error: "Couldn't load your workspace details.",
    });
    actions.deleteAccountAction.mockResolvedValue({
      success: false,
      error: SOLE_FOUNDER_REFUSAL,
    });

    const user = userEvent.setup();
    await mountAccountModal();
    await user.type(screen.getByLabelText(en.settings.passwordConfirm), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(SOLE_FOUNDER_REFUSAL);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(SOLE_FOUNDER_REFUSAL));
  });

  it("does the same in the workspace dialog, which gets the same kind of refusal", async () => {
    // lib/actions/account.ts:376 — the billing-unreachable refusal is two steps in
    // another product. Both dialogs are reached from the same section by the same
    // person; they must not answer a refusal two different ways.
    const BILLING_REFUSAL =
      `"${WORKSPACE}" has a live subscription and billing isn't reachable from this ` +
      `deployment, so it can't be cancelled here. Cancel it in LemonSqueezy first, ` +
      `then delete the workspace.`;
    actions.deleteWorkspaceAction.mockResolvedValue({ success: false, error: BILLING_REFUSAL });

    const user = userEvent.setup();
    render(<DeleteWorkspaceModal open onClose={vi.fn()} workspaceName={WORKSPACE} />);
    await user.type(screen.getByLabelText(en.settings.workspaceNameConfirm), WORKSPACE);
    await user.type(screen.getByLabelText(en.settings.passwordConfirm), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(BILLING_REFUSAL);
  });
});
