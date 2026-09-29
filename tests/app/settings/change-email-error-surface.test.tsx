/**
 * acct-016, second pass — an instruction the reader can still read.
 *
 * WHAT acct-016 CHANGED. `requestEmailChangeAction` used to answer a collision
 * with the target address with one flat sentence. It now distinguishes a LIVE
 * account from a tombstoned one and, for the tombstone, hands back a remedy:
 * "That email belongs to a FounderFlow account that was deleted. Contact support
 * to restore it, or use a different address." (lib/actions/email-change.ts:250).
 *
 * WHAT IT DID NOT CHANGE, and why that undoes most of it. The modal delivers
 * every server refusal through `toast.error(res.error)` and nothing else, and the
 * global toast duration is 3500ms (components/providers.tsx). The old message was
 * 41 characters and a verdict; this one is 120 characters and its whole point is
 * an instruction — the user has to decide between "contact support" and "use a
 * different address", and by the time they have, the sentence has gone. Nothing
 * on the screen can be re-read, and no error is left where an assistive
 * technology can be pointed at it.
 *
 * So: the refusal gets a persistent surface in the dialog, next to the field
 * whose value caused it, in `role="alert"` — the shape app/forgot-password/
 * page.tsx:198 already uses for exactly this. The toast stays, because it is what
 * draws the eye back to a dialog the user may have scrolled away from; it is no
 * longer the only copy.
 *
 * The copy is never typed out here: every assertion reads the action's own
 * return value, so this file pins the SURFACE, not the sentence.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangeEmailModal } from "@/app/(app)/settings/change-email-modal";

const actions = vi.hoisted(() => ({ requestEmailChangeAction: vi.fn() }));
vi.mock("@/lib/actions/email-change", () => ({
  requestEmailChangeAction: (input: unknown) => actions.requestEmailChangeAction(input),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ locale: "en" }),
  useStoreHasHydrated: () => true,
}));

/** The live message acct-016 added, as the action actually returns it. */
const DELETED_ACCOUNT_REFUSAL =
  "That email belongs to a FounderFlow account that was deleted. " +
  "Contact support to restore it, or use a different address.";

async function submitChange(newEmail = "taken@example.com") {
  const user = userEvent.setup();
  render(<ChangeEmailModal open onClose={vi.fn()} currentEmail="founder@example.com" />);
  await user.type(screen.getByLabelText("New email"), newEmail);
  await user.type(screen.getByLabelText("Current password"), "hunter2hunter2");
  await user.click(screen.getByRole("button", { name: /send confirmation/i }));
  return user;
}

describe("a refused email change leaves its instruction on the screen", () => {
  beforeEach(() => {
    actions.requestEmailChangeAction.mockReset();
    toasts.error.mockReset();
  });

  it("renders the server's refusal where it can be re-read", async () => {
    // WHAT BREAKS IN PRODUCTION: a 3500ms toast is the entire delivery of a
    // two-option instruction. The user looks away to think, and the only thing
    // that told them "contact support" is gone with no way back to it.
    actions.requestEmailChangeAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    await submitChange();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);
  });

  it("keeps the address that caused the refusal, so the fix is one edit", async () => {
    actions.requestEmailChangeAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    await submitChange("taken@example.com");

    await screen.findByRole("alert");
    expect(screen.getByLabelText("New email")).toHaveValue("taken@example.com");
  });

  it("clears the old refusal when the user tries again", async () => {
    // A stale alert under a fresh attempt reads as a second failure.
    actions.requestEmailChangeAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    const user = await submitChange();
    await screen.findByRole("alert");

    actions.requestEmailChangeAction.mockResolvedValue({
      success: true,
      data: { newEmail: "taken@example.com" },
    });
    await user.click(screen.getByRole("button", { name: /send confirmation/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("still fires the toast, which is what pulls the eye back to the dialog", async () => {
    actions.requestEmailChangeAction.mockResolvedValue({
      success: false,
      error: DELETED_ACCOUNT_REFUSAL,
    });

    await submitChange();

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DELETED_ACCOUNT_REFUSAL));
  });
});
