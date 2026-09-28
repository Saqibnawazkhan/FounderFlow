/**
 * projects-002 — a project set to "On hold" renders a completely blank status
 * badge, in every language.
 *
 * THE MECHANISM. Four call sites derive the dictionary key from the status slug:
 *
 *     `status${s.charAt(0).toUpperCase()}${s.slice(1).replace("_", "")}`
 *
 * For `s = "on_hold"` that is the literal string `"statusOnhold"` — lowercase h,
 * because `.replace("_", "")` deletes the underscore without capitalising what
 * follows it. lib/i18n/strings.ts defines `statusOnHold` (:214 in English, :566
 * in Urdu) and nothing called `statusOnhold`, so `t.projects[key]` is
 * `undefined` and React renders nothing at all.
 *
 * WHY NEITHER `tsc` NOR `next build` CAUGHT IT. Each site casts the derived
 * string to the union it is meant to produce:
 *
 *     as "statusActive" | "statusOnHold" | "statusCompleted" | "statusArchived"
 *
 * An `as` on a computed string is an assertion, not a check — it tells the
 * compiler to stop asking. Removing it is most of the fix: an explicit
 * `Record<ProjectStatus, …>` map makes a future fifth status a compile error
 * instead of a blank pill.
 *
 * WHAT THE CUSTOMER SEES. An empty pill on the card, a /projects filter chip
 * that is a bare number with no label, and — worst — an option with NO TEXT in
 * the Edit dialog's status `<select>`. Someone choosing that blank option
 * changes the project's lifecycle state with no idea what they picked.
 * project-detail-client.tsx:618 uses the literal `t.projects.statusOnHold`
 * correctly, so the header dropdown reads "On hold" while the badge beside it is
 * blank.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { en, ur } from "@/lib/i18n/strings";
import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/schemas/project";
import type { ProjectListItem } from "@/lib/queries/projects";

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

// The real dictionary, the real formatters — only the store is faked, because
// `useT`, `useMoney` and `useNumberFormat` all read the locale/currency from it.
// Faking the dictionary would be faking the thing under test.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

import { ProjectCard, STATUS_LABEL_KEY } from "@/components/projects/project-card";

function project(status: ProjectStatus): ProjectListItem {
  return {
    id: "p-1",
    companyId: "c-1",
    name: "Nimbus",
    description: "A project",
    supervisorId: "u-2",
    supervisorName: "Bilal",
    status,
    color: "emerald",
    targetEndDate: null,
    createdBy: "u-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    openTaskCount: 3,
    totalTaskCount: 8,
    monthToDateSpendPkr: 0,
    financeVisible: true,
    trackedMs: 0,
  } as ProjectListItem;
}

describe("projects-002 — the status badge has text in it", () => {
  it('reads "On hold" for an on_hold project', () => {
    render(
      <ProjectCard project={project("on_hold")} currentUserId="u-1" currentUserRole="admin" />
    );

    expect(
      screen.getByText(en.projects.statusOnHold),
      'the badge is empty: the derived key is "statusOnhold" (lowercase h) and no such string exists'
    ).toBeInTheDocument();
  });

  it("has a non-empty badge for EVERY status, not just the ones that happen to work", () => {
    for (const status of PROJECT_STATUSES) {
      const view = render(
        <ProjectCard project={project(status)} currentUserId="u-1" currentUserRole="admin" />
      );
      const label = en.projects[STATUS_LABEL_KEY[status]];
      expect(label, `no English label for ${status}`).toBeTruthy();
      expect(screen.getByText(label), `${status} renders a blank badge`).toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("projects-002 — the label map, not a string derived from the slug", () => {
  it("names one real dictionary key per status", () => {
    expect(typeof STATUS_LABEL_KEY, "there is no shared map — four sites derive the key").toBe(
      "object"
    );
    for (const status of PROJECT_STATUSES) {
      const key = STATUS_LABEL_KEY[status];
      expect(key, `${status} has no entry`).toBeTruthy();
      expect(en.projects[key], `${key} is not a real English string`).toBeTruthy();
      expect(ur.projects[key], `${key} is not a real Urdu string`).toBeTruthy();
    }
  });

  it("covers every status in PROJECT_STATUSES and invents none", () => {
    const mapped = Object.keys(STATUS_LABEL_KEY).sort();
    const declared = PROJECT_STATUSES.slice().sort();
    expect(mapped).toEqual(declared);
  });

  it("is what the slug-derivation could never produce", () => {
    // The bug, reconstructed: this is the string the four call sites built.
    const derived = `status${"on_hold".charAt(0).toUpperCase()}${"on_hold".slice(1).replace("_", "")}`;
    expect(derived).toBe("statusOnhold");
    expect(
      (en.projects as Record<string, unknown>)[derived],
      "if this key ever exists, the derivation is no longer the bug and this file needs rewriting"
    ).toBeUndefined();
    expect(STATUS_LABEL_KEY.on_hold).toBe("statusOnHold");
  });
});
