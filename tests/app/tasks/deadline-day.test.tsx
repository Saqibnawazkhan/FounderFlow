/**
 * A deadline is a CALENDAR DAY, and every surface must name the same one.
 *
 * FINDING tasks-and-comments-011. `Task.deadline` is a `DateTime` column holding
 * a calendar day: `components/tasks/task-form.tsx` sends an `<input type=date>`
 * value through `new Date(value).toISOString()`, i.e. UTC midnight. The SERVER
 * reads it back from UTC parts and is right (`formatDeadline`,
 * lib/actions/tasks.ts, with a long comment defending exactly that). Every
 * CLIENT surface formatted the same instant in the VIEWER's zone, so for anyone
 * west of Greenwich:
 *
 *   • the card, the list row, the detail modal and the calendar all showed the
 *     day BEFORE the one the assigner picked, while the assignment email showed
 *     the right one;
 *   • `isPast`/`isToday` shifted with it, so the overdue flag fired a day early;
 *   • and "due today" could not be entered at all — `NewTaskSchema` compares the
 *     UTC-midnight value against the viewer's LOCAL start-of-today, and UTC
 *     midnight of today is 05:00 BEFORE local midnight at UTC-5.
 *
 * WHY THIS FILE IS HONEST ABOUT TIMEZONES. `npm test` runs
 * `cross-env TZ=America/Bogota`, which is UTC-5 — a zone where the bug is real.
 * Nothing here calls `emulateTimezone` or stubs `Date`: the assertions are
 * written in the pinned zone and were red in it. The product already ships USD,
 * EUR and GBP as workspace currencies, so a non-PKT customer is expected, not
 * hypothetical.
 *
 * THE FIX SHAPE. Storage is unchanged for existing rows, and new rows are written
 * at NOON UTC rather than midnight — see lib/tasks/deadline.ts for why that one
 * change also fixes two files this slice does not own. Reading goes through
 * `deadlineDay`, which rebuilds the day from UTC parts, so a row written either
 * way reads back as the day that was picked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  deadlineDay,
  deadlineDayValue,
  deadlineInstantForDay,
  isDeadlineToday,
  isDeadlineOverdue,
  isDeadlineWithinDays,
} from "@/lib/tasks/deadline";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { User } from "@/lib/types";

const actions = vi.hoisted(() => ({
  // The parameter is declared even though the body ignores it: without it the
  // call tuple is `[]` and reading `mock.calls[0][0]` is a TS2493 at typecheck
  // while passing happily under vitest (the trap
  // tests/lib/comments/mention-delivery.test.ts documents).
  addTaskAction: vi.fn(async (_input: unknown) => ({ success: true, data: {} })),
}));
vi.mock("@/lib/actions/tasks", () => ({
  addTaskAction: (input: unknown) => actions.addTaskAction(input),
  updateTaskStatusAction: vi.fn(),
  deleteTaskAction: vi.fn(),
}));
vi.mock("@/lib/actions/comments", () => ({
  createCommentAction: vi.fn(),
  listCommentsAction: vi.fn(async () => ({ success: true, data: [] })),
  deleteCommentAction: vi.fn(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

import { TaskForm } from "@/components/tasks/task-form";
import { TaskDetailModal } from "@/components/tasks/task-detail-modal";

/* ───────────────────────────── fixtures ─────────────────────────────────── */

/** Stored the OLD way: UTC midnight. Every existing row in the database. */
const STORED_MIDNIGHT = "2026-10-15T00:00:00.000Z";
/** Stored the NEW way: noon UTC. Both must read back as 15 Oct 2026. */
const STORED_NOON = "2026-10-15T12:00:00.000Z";

function task(over: Partial<TaskWithCount> = {}): TaskWithCount {
  return {
    id: "t1",
    companyId: "c1",
    projectId: "p1",
    title: "Ship the invoice export",
    description: "",
    status: "pending",
    priority: "medium",
    assignedTo: "u_me",
    assignedToName: "Sana Malik",
    assignedBy: "u_admin",
    assignedByName: "Ayesha Raza",
    deadline: STORED_MIDNIGHT,
    createdAt: "2026-09-01T00:00:00.000Z",
    order: 0,
    commentCount: 0,
    ...over,
  };
}

function user(id: string, name: string): User {
  return {
    id,
    name,
    email: `${id}@nimbus.test`,
    password: "",
    role: "member",
    companyId: "c1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  actions.addTaskAction.mockClear();
  vi.useRealTimers();
});

/* ══════════ the rule, as a pure function ══════════════════════════════════ */

describe("deadlineDay — the calendar day the assigner picked", () => {
  it("reads a row stored at UTC midnight as that day, not the day before", () => {
    expect(deadlineDayValue(STORED_MIDNIGHT)).toBe("2026-10-15");
  });

  it("reads a row stored at noon UTC as the same day", () => {
    // The two storage shapes must be indistinguishable to every reader, because
    // the column now holds both and no migration reconciles them.
    expect(deadlineDayValue(STORED_NOON)).toBe("2026-10-15");
    expect(deadlineDay(STORED_NOON).getTime()).toBe(deadlineDay(STORED_MIDNIGHT).getTime());
  });

  it("returns a LOCAL midnight, so date-fns comparisons mean the viewer's day", () => {
    const d = deadlineDay(STORED_MIDNIGHT);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 15]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it("round-trips a picked day through the value that gets stored", () => {
    const stored = deadlineInstantForDay("2026-10-15");
    expect(deadlineDayValue(stored)).toBe("2026-10-15");
    // Noon, not midnight: the reason is in the module header — it is what makes
    // the un-owned local-day bucketing and the un-owned "is it in the past?"
    // refine correct for a viewer west of Greenwich.
    expect(stored).toBe(STORED_NOON);
  });
});

describe("isDeadlineToday / isDeadlineOverdue — whole days, not instants", () => {
  const NOW = new Date(2026, 9, 15, 9, 0); // local 09:00 on 15 Oct 2026

  it("calls a task due today 'today', in a zone west of Greenwich", () => {
    expect(isDeadlineToday(STORED_MIDNIGHT, NOW)).toBe(true);
  });

  it("does NOT call a task due today overdue", () => {
    // The old code was `isPast(new Date(deadline))`, which is true from the
    // first second of the due day onwards — in PKT as well as in Bogota. A
    // deadline is a day, and a day is not late until it is over.
    expect(isDeadlineOverdue(STORED_MIDNIGHT, NOW)).toBe(false);
  });

  it("calls yesterday's deadline overdue", () => {
    expect(isDeadlineOverdue("2026-10-14T00:00:00.000Z", NOW)).toBe(true);
    expect(isDeadlineToday("2026-10-14T00:00:00.000Z", NOW)).toBe(false);
  });

  it("counts today inside the next-7-days window, and the eighth day outside it", () => {
    expect(isDeadlineWithinDays(STORED_MIDNIGHT, 7, NOW)).toBe(true);
    expect(isDeadlineWithinDays("2026-10-22T00:00:00.000Z", 7, NOW)).toBe(true);
    expect(isDeadlineWithinDays("2026-10-23T00:00:00.000Z", 7, NOW)).toBe(false);
    expect(isDeadlineWithinDays("2026-10-14T00:00:00.000Z", 7, NOW)).toBe(false);
  });
});

/* ══════════ the form: what actually gets stored ═══════════════════════════ */

describe("TaskForm sends the day the user picked (011)", () => {
  it("stores the picked calendar day at noon UTC", async () => {
    const userEv = userEvent.setup();
    render(
      <TaskForm
        users={[user("u_me", "Sana Malik")]}
        projects={[{ id: "p1", name: "General" }]}
        currentUserId="u_me"
        onClose={vi.fn()}
      />
    );

    await userEv.type(screen.getByLabelText("Title"), "Rename the export column");
    const deadline = screen.getByLabelText("Deadline") as HTMLInputElement;
    await userEv.clear(deadline);
    await userEv.type(deadline, "2026-10-15");
    await userEv.click(screen.getByRole("button", { name: /create task/i }));

    expect(actions.addTaskAction).toHaveBeenCalledTimes(1);
    const sent = actions.addTaskAction.mock.calls[0][0] as { deadline: string };
    expect(sent.deadline).toBe(STORED_NOON);
  });
});

/* ══════════ the detail modal ══════════════════════════════════════════════ */

describe("TaskDetailModal names the picked day (011)", () => {
  function renderModal(over: Partial<TaskWithCount> = {}) {
    return render(
      <TaskDetailModal
        task={task(over)}
        open
        onClose={vi.fn()}
        currentUserId="u_me"
        currentUserRole="admin"
        companyUsers={[]}
        canDelete={false}
        // Required since sec-016 (it defaulted to `true`, which is how
        // /projects/[id] shipped an enabled select the server refuses). These
        // cases are about which DAY is rendered, and the viewer is an admin, so
        // the value that preserves them is the one an admin would get.
        canEdit
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
      />
    );
  }

  it("shows 15 Oct for a deadline stored as 15 Oct, at UTC-5", () => {
    renderModal();
    expect(screen.getByText(/Oct 15, 2026/)).toBeInTheDocument();
  });

  it("shows the same day for a row stored at noon UTC", () => {
    renderModal({ deadline: STORED_NOON });
    expect(screen.getByText(/Oct 15, 2026/)).toBeInTheDocument();
  });

  it("does not call a task due today overdue", () => {
    vi.setSystemTime(new Date(2026, 9, 15, 9, 0));
    renderModal();
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/· today/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
