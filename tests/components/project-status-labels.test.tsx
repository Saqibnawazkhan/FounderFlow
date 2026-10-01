/**
 * projects-002, the wiring. STATUS_LABEL_KEY exists, is exported, and is tested
 * (tests/components/project-status-badge.test.tsx) — and has exactly ONE caller.
 *
 * Its own doc comment says it was "Exported so the other three sites import one
 * source of truth". None of the three did. All three still build the dictionary
 * key from the slug:
 *
 *   app/(app)/projects/projects-client.tsx          the status FILTER CHIPS
 *   app/(app)/projects/[id]/edit-project-modal.tsx  the status <select>
 *   app/(app)/projects/[id]/project-detail-client.tsx  the header PILL
 *
 * `status${"on_hold".charAt(0).toUpperCase()}${"on_hold".slice(1).replace("_","")}`
 * is "statusOnhold" — lowercase h, because `.replace("_","")` removes the
 * underscore without capitalising what follows. lib/i18n/strings.ts defines
 * `statusOnHold` and nothing named `statusOnhold`, so the lookup is `undefined`
 * and React renders NOTHING: a filter chip that is a bare number, and an
 * `<option>` with no text that a user can still select — changing a project's
 * lifecycle state with no idea what they picked. It shipped in English and Urdu.
 *
 * Every site casts the computed string to the union it was meant to produce, so
 * `tsc` and `next build` are both silent. An `as` on a computed string is an
 * assertion, not a check — which is the whole reason a map was extracted.
 *
 * The header pill is covered in tests/components/project-detail-gates.test.tsx;
 * this file is the other two.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { PROJECT_STATUSES } from "@/lib/schemas/project";
import { en } from "@/lib/i18n/strings";
import { STATUS_LABEL_KEY } from "@/components/projects/project-card";
import type { ProjectClient, ProjectListItem } from "@/lib/queries/projects";
import type { User } from "@/lib/types";
import { ProjectsClient } from "@/app/(app)/projects/projects-client";
import { EditProjectModal } from "@/app/(app)/projects/[id]/edit-project-modal";

vi.mock("@/lib/actions/projects", () => ({
  updateProjectAction: vi.fn(async () => ({ success: true, data: undefined })),
  duplicateProjectAction: vi.fn(),
  restoreProjectAction: vi.fn(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

const PROJECT: ProjectClient = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: null,
  supervisorId: "u-1",
  supervisorName: "Ada",
  status: "on_hold",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
};

/** One project per status, so every filter chip has a non-zero count and the
 *  label and the number are distinguishable in the accessible name. */
const PROJECTS: ProjectListItem[] = PROJECT_STATUSES.map(
  (status, i) =>
    ({
      ...PROJECT,
      id: `p-${i}`,
      name: `Project ${status}`,
      status,
      openTaskCount: 1,
      totalTaskCount: 2,
      monthToDateSpendPkr: 0,
      financeVisible: true,
      trackedMs: 0,
      memberCount: 1,
    }) as unknown as ProjectListItem
);

const USERS: User[] = [{ id: "u-1", name: "Ada" }] as unknown as User[];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the /projects status filter chips are labelled", () => {
  it("guards the guard: the English dictionary really does have these four strings", () => {
    for (const status of PROJECT_STATUSES) {
      expect(en.projects[STATUS_LABEL_KEY[status]], `no English label for ${status}`).toBeTruthy();
    }
  });

  it('shows "On hold" on its chip, not just a number', () => {
    render(
      <ProjectsClient
        projects={PROJECTS}
        deletedProjects={[]}
        users={USERS}
        currentUserId="u-1"
        currentUserRole="admin"
      />
    );

    // The chip is a toggle button carrying the label and the count. `aria-pressed`
    // is what makes it findable as a chip rather than as any button on the page.
    const chips = screen.getAllByRole("button", { pressed: false });
    const labels = chips.map((c) => c.textContent ?? "");
    expect(
      labels.some((l) => l.indexOf("On hold") !== -1),
      `the "on hold" filter chip renders no label at all — it is a bare count. Chips read: ${JSON.stringify(labels)}`
    ).toBe(true);
  });

  it("labels every status chip", () => {
    render(
      <ProjectsClient
        projects={PROJECTS}
        deletedProjects={[]}
        users={USERS}
        currentUserId="u-1"
        currentUserRole="admin"
      />
    );

    const text = screen
      .getAllByRole("button")
      .map((c) => c.textContent ?? "")
      .join("|");
    for (const status of PROJECT_STATUSES) {
      const label = en.projects[STATUS_LABEL_KEY[status]];
      expect(text.indexOf(label), `no chip labelled "${label}"`).not.toBe(-1);
    }
  });
});

describe("the Edit-project status <select> is labelled", () => {
  it('offers a readable "On hold" option', async () => {
    const { rerender } = render(
      <EditProjectModal open={false} onClose={vi.fn()} project={PROJECT} onSaved={vi.fn()} />
    );
    rerender(<EditProjectModal open onClose={vi.fn()} project={PROJECT} onSaved={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Status")).toBeTruthy());
    const options = Array.from((screen.getByLabelText("Status") as HTMLSelectElement).options).map(
      (o) => o.textContent ?? ""
    );
    expect(
      options,
      "an option with no text at all, which a user can still select — changing the project's lifecycle state with no idea what they chose"
    ).toContain("On hold");
  });

  it("labels every status option", async () => {
    const { rerender } = render(
      <EditProjectModal open={false} onClose={vi.fn()} project={PROJECT} onSaved={vi.fn()} />
    );
    rerender(<EditProjectModal open onClose={vi.fn()} project={PROJECT} onSaved={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Status")).toBeTruthy());
    const options = Array.from((screen.getByLabelText("Status") as HTMLSelectElement).options).map(
      (o) => o.textContent ?? ""
    );
    expect(options.length).toBe(PROJECT_STATUSES.length);
    for (const status of PROJECT_STATUSES) {
      expect(options).toContain(en.projects[STATUS_LABEL_KEY[status]]);
    }
  });
});
