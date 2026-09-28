/**
 * <EditProjectModal> — the second half of projects-010, and the half that makes
 * the first half safe.
 *
 * THE BUG IN THIS FILE'S SUBJECT. The modal is mounted permanently by
 * app/(app)/projects/[id]/project-detail-client.tsx (`{canManage && <EditProjectModal
 * open={editOpen} … />}`), so `useForm` runs ONCE, on the first render of the
 * page, and `defaultValues` is a snapshot of the project as it was then. Radix
 * unmounts the dialog's DOM when it closes but react-hook-form's state lives in
 * the component above it and survives, so after any `router.refresh()` — a task
 * status change, a colleague's rename arriving, an archive — the form still
 * holds page-load values. Open it, press Save, and the page-load values are
 * written back over whatever has happened since.
 *
 * WHY THIS MUST BE FIXED IN THE SAME CHANGE AS THE CONCURRENCY TOKEN, not after.
 * The token makes `updateProjectAction` refuse a payload built from a row that
 * has since changed. A form seeded once at page load is, by construction,
 * exactly that payload. So shipping the token alone converts a silent overwrite
 * into "This project changed since you opened it. Reload and try again." on a
 * genuine, first-time edit — a guard that mostly fires on innocent people is a
 * guard that gets deleted. The form has to be reseeded from the current props
 * whenever it opens, and the token has to be the one that came with THOSE props.
 *
 * These tests are about wiring, so the server action is a spy: the payload it
 * receives is the whole contract between this file and lib/actions/projects.ts.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectClient } from "@/lib/queries/projects";
import { EditProjectModal } from "@/app/(app)/projects/[id]/edit-project-modal";

const spies = vi.hoisted(() => ({ updateProjectAction: vi.fn() }));
const updateProjectAction = spies.updateProjectAction;
vi.mock("@/lib/actions/projects", () => ({
  updateProjectAction: (input: unknown) => spies.updateProjectAction(input),
}));

// Hoisted: `vi.mock`'s factory runs before module-level `const`s are
// initialised, so a plain `const toastError = vi.fn()` above would be a TDZ
// ReferenceError inside the factory.
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const toastError = toasts.error;
const toastSuccess = toasts.success;
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

// The real dictionary; only the store is faked, because `useT` reads the locale
// from it. Faking the dictionary would mean asserting against labels this
// product does not actually render.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/** The project as the page first rendered it. */
const AT_PAGE_LOAD: ProjectClient = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: "the description at page load",
  supervisorId: "u-2",
  supervisorName: "Bilal",
  status: "active",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
};

/** The same project after a colleague renamed it and the page refreshed. */
const AFTER_COLLEAGUES_RENAME: ProjectClient = {
  ...AT_PAGE_LOAD,
  name: "Nimbus — Q4 launch",
  description: "the description Bilal just wrote",
  updatedAt: "2026-09-29T09:30:00.000Z",
};

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}
function descriptionInput(): HTMLTextAreaElement {
  return screen.getByLabelText("Description") as HTMLTextAreaElement;
}
function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: /save changes/i });
}

function renderModal(project: ProjectClient) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <EditProjectModal open={false} onClose={onClose} project={project} onSaved={onSaved} />
  );
  /** Re-render with a (possibly different) project and open state, as the page does. */
  const set = (next: ProjectClient, open: boolean) =>
    view.rerender(
      <EditProjectModal open={open} onClose={onClose} project={next} onSaved={onSaved} />
    );
  return { onClose, onSaved, set, ...view };
}

beforeEach(() => {
  updateProjectAction.mockReset();
  updateProjectAction.mockResolvedValue({ success: true, data: undefined });
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("EditProjectModal — reseeds itself from the project it is given", () => {
  it("shows the CURRENT name when it opens, not the one from page load", async () => {
    // WHAT BREAKS FOR A CUSTOMER: Bilal renames the project; Ada's page
    // refreshes and the header shows the new name; Ada opens Edit to change the
    // colour and the name box still reads "Nimbus". She presses Save and Bilal's
    // rename is gone — from a dialog that showed her the old name the whole time.
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AFTER_COLLEAGUES_RENAME, false); // router.refresh() lands
    set(AFTER_COLLEAGUES_RENAME, true); // …then Ada clicks Edit

    await waitFor(() => expect(nameInput()).toBeTruthy());
    expect(
      nameInput().value,
      "the dialog is showing a name that is no longer the project's name"
    ).toBe(AFTER_COLLEAGUES_RENAME.name);
    expect(descriptionInput().value).toBe(AFTER_COLLEAGUES_RENAME.description);
  });

  it("submits the values it is showing, so a refresh cannot be echoed back", async () => {
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AFTER_COLLEAGUES_RENAME, false);
    set(AFTER_COLLEAGUES_RENAME, true);

    await waitFor(() => expect(nameInput()).toBeTruthy());
    await user.click(saveButton());

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalledTimes(1));
    const payload = updateProjectAction.mock.calls[0][0] as Record<string, unknown>;
    expect(
      payload.name,
      "pressing Save re-sent the name the page was first rendered with, which is the lost update itself"
    ).toBe(AFTER_COLLEAGUES_RENAME.name);
  });

  it("does not discard what the user typed while the dialog is open", async () => {
    // The reseed must happen on OPEN, not on every render: a `router.refresh()`
    // fired by something else on the page (a task's status changing) while the
    // dialog is open would otherwise wipe a half-typed name mid-sentence.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);

    await waitFor(() => expect(nameInput()).toBeTruthy());
    await user.clear(nameInput());
    await user.type(nameInput(), "Ada's new name");

    set(AFTER_COLLEAGUES_RENAME, true); // a refresh arrives mid-edit

    expect(
      nameInput().value,
      "a background refresh threw away the name the user was in the middle of typing"
    ).toBe("Ada's new name");
  });
});

describe("EditProjectModal — carries the concurrency token", () => {
  it("sends the updatedAt the form was seeded from", async () => {
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AFTER_COLLEAGUES_RENAME, false);
    set(AFTER_COLLEAGUES_RENAME, true);

    await waitFor(() => expect(nameInput()).toBeTruthy());
    await user.click(saveButton());

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalledTimes(1));
    const payload = updateProjectAction.mock.calls[0][0] as Record<string, unknown>;
    expect(
      payload.expectedUpdatedAt,
      "the payload carries no token, so updateProjectAction has nothing to compare and the lost update is undetectable"
    ).toBe(AFTER_COLLEAGUES_RENAME.updatedAt);
  });

  it("sends the token from the render the FORM was seeded from, not a newer one", async () => {
    // A refresh that arrives while the dialog is open updates the prop but
    // deliberately does NOT reseed the form (see above). Sending the newer token
    // with the older values would make the server accept exactly the write the
    // token exists to refuse.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);

    await waitFor(() => expect(nameInput()).toBeTruthy());
    set(AFTER_COLLEAGUES_RENAME, true); // refresh mid-edit; form keeps its values
    await user.click(saveButton());

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalledTimes(1));
    const payload = updateProjectAction.mock.calls[0][0] as Record<string, unknown>;
    expect(
      payload.expectedUpdatedAt,
      "the token was refreshed out from under the values, so a stale payload would be accepted as current"
    ).toBe(AT_PAGE_LOAD.updatedAt);
  });

  it("still mentions description when the user clears it, so NULL is written", async () => {
    // `mentions()` in lib/actions/projects.ts distinguishes absent from empty by
    // raw key presence. Clearing the textarea has to keep the KEY.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);

    await waitFor(() => expect(descriptionInput()).toBeTruthy());
    await user.clear(descriptionInput());
    await user.click(saveButton());

    await waitFor(() => expect(updateProjectAction).toHaveBeenCalledTimes(1));
    const payload = updateProjectAction.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "description")).toBe(true);
  });

  it("shows the conflict the server reports and does not claim it saved", async () => {
    updateProjectAction.mockResolvedValue({
      success: false,
      error: "This project changed since you opened it. Reload and try again.",
    });
    const user = userEvent.setup();
    const { set, onSaved } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);

    await waitFor(() => expect(nameInput()).toBeTruthy());
    await user.click(saveButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/changed since you opened it/i);
    expect(onSaved, "the dialog closed as though the edit had landed").not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
