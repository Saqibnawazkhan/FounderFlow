/**
 * <ChangeSupervisorModal> — projects-008. The same frozen-defaults defect
 * `EditProjectModal` was fixed for, left behind in its neighbour, where it is
 * worse: this form has one field, so a stale value is not a stale detail, it is
 * the entire instruction.
 *
 * THE SCENARIO, IN THE USER'S WORDS. Ada reassigns "Nimbus" from Bilal to Chen.
 * The header updates. A minute later she opens "Change supervisor" again — to
 * check who is running it, or to hand it to someone else — and the dropdown says
 * BILAL. She presses Save. The project goes back to Bilal, Bilal gets a second
 * notification, the activity feed records a reassignment nobody asked for, and
 * the change Ada made a minute ago is gone.
 *
 * THE MECHANISM. project-detail-client.tsx mounts this component for the whole
 * page lifetime (`{canReassign && <ChangeSupervisorModal open={supOpen} … />}`),
 * so `useForm` runs once, at page load, and `defaultValues.supervisorId` is a
 * snapshot from then. Radix unmounts the dialog's DOM on close but
 * react-hook-form's state lives above it and survives, and the parent's
 * `onSaved` calls `refresh()` without remounting or resetting. So the `<select>`
 * carries the OLD id.
 *
 * WHY THE EXISTING NO-OP GUARD DOES NOT SAVE IT — and this is the part that
 * turns a cosmetic bug into a write. `onSubmit` returns early when
 * `data.supervisorId === project.supervisorId`. After a successful change,
 * `project.supervisorId` is the NEW id and the form holds the OLD one, so they
 * differ: the guard sees a legitimate change and lets it through.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectClient } from "@/lib/queries/projects";
import type { User } from "@/lib/types";
import { ChangeSupervisorModal } from "@/app/(app)/projects/[id]/change-supervisor-modal";

const spies = vi.hoisted(() => ({ changeSupervisorAction: vi.fn() }));
vi.mock("@/lib/actions/projects", () => ({
  changeSupervisorAction: (input: unknown) => spies.changeSupervisorAction(input),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/** Deliberately NOT in alphabetical or id order, so "the first option" and "the
 *  right option" are never the same answer by accident. */
const USERS: User[] = [
  { id: "u-bilal", name: "Bilal" },
  { id: "u-chen", name: "Chen" },
  { id: "u-ada", name: "Ada" },
] as unknown as User[];

/** The project as the page first rendered it: Bilal is running it. */
const AT_PAGE_LOAD: ProjectClient = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: null,
  supervisorId: "u-bilal",
  supervisorName: "Bilal",
  status: "active",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-ada",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
};

/** After Ada's reassignment landed and router.refresh() delivered fresh props. */
const AFTER_REASSIGN: ProjectClient = {
  ...AT_PAGE_LOAD,
  supervisorId: "u-chen",
  supervisorName: "Chen",
  updatedAt: "2026-09-29T09:30:00.000Z",
};

function supervisorSelect(): HTMLSelectElement {
  return screen.getByLabelText("Supervisor") as HTMLSelectElement;
}
function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: /save changes/i });
}

function renderModal(project: ProjectClient) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <ChangeSupervisorModal
      open={false}
      onClose={onClose}
      project={project}
      users={USERS}
      onSaved={onSaved}
    />
  );
  /** Re-render with a (possibly different) project and open state, as the page does. */
  const set = (next: ProjectClient, open: boolean) =>
    view.rerender(
      <ChangeSupervisorModal
        open={open}
        onClose={onClose}
        project={next}
        users={USERS}
        onSaved={onSaved}
      />
    );
  return { onClose, onSaved, set, ...view };
}

beforeEach(() => {
  spies.changeSupervisorAction.mockReset();
  spies.changeSupervisorAction.mockResolvedValue({ success: true, data: undefined });
  toasts.error.mockReset();
  toasts.success.mockReset();
});

describe("projects-008 — the dialog opens on the project's CURRENT supervisor", () => {
  it("shows the new supervisor when reopened after a reassignment", async () => {
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true); // Ada opens it
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());
    set(AT_PAGE_LOAD, false); // …saves; the parent closes it
    set(AFTER_REASSIGN, false); // …and router.refresh() lands
    set(AFTER_REASSIGN, true); // Ada opens it again

    await waitFor(() => expect(supervisorSelect()).toBeTruthy());
    expect(
      supervisorSelect().value,
      "the dialog presents the PREVIOUS supervisor as the current one — so it is showing an admin something false about who is running the project"
    ).toBe("u-chen");
  });

  it("pressing Save on the reopened dialog changes nothing", async () => {
    // The harm. One click on Save silently undid the reassignment made a minute
    // earlier, because the stale value differs from the fresh prop and so passes
    // the no-op guard as a legitimate change.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());
    set(AT_PAGE_LOAD, false);
    set(AFTER_REASSIGN, false);
    set(AFTER_REASSIGN, true);
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());

    await user.click(saveButton());

    expect(
      spies.changeSupervisorAction.mock.calls,
      "Save handed the project straight back to the previous supervisor, with a second notification to the wrong person and a misleading activity row"
    ).toEqual([]);
  });

  it("closes itself on that no-op Save rather than sitting there", async () => {
    const user = userEvent.setup();
    const { set, onClose } = renderModal(AT_PAGE_LOAD);
    set(AFTER_REASSIGN, true);
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());

    await user.click(saveButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("still submits a genuine change", async () => {
    // The reseed must not become a wall: picking somebody new has to work.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());

    await user.selectOptions(supervisorSelect(), "u-chen");
    await user.click(saveButton());

    await waitFor(() => expect(spies.changeSupervisorAction).toHaveBeenCalledTimes(1));
    expect(spies.changeSupervisorAction.mock.calls[0][0]).toEqual({
      projectId: "p-1",
      supervisorId: "u-chen",
    });
  });

  it("does not throw away a half-made choice when the page refreshes underneath", async () => {
    // Reseeding on EVERY prop change, rather than on the false→true transition,
    // would reset the dropdown the moment any other mutation on the page fired
    // router.refresh() — with the dialog open and the admin mid-decision. Same
    // reason EditProjectModal keys its reseed on the open transition.
    const user = userEvent.setup();
    const { set } = renderModal(AT_PAGE_LOAD);
    set(AT_PAGE_LOAD, true);
    await waitFor(() => expect(supervisorSelect()).toBeTruthy());

    await user.selectOptions(supervisorSelect(), "u-ada");
    // Something unrelated on the page refreshes the route while the dialog is open.
    set({ ...AT_PAGE_LOAD, name: "Nimbus (renamed by a colleague)" }, true);

    expect(
      supervisorSelect().value,
      "an unrelated refresh discarded the admin's half-made choice"
    ).toBe("u-ada");
  });
});
