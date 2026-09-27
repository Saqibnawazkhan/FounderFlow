import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskCalendar } from "@/components/tasks/task-calendar";
import type { TaskWithCount } from "@/lib/queries/tasks";

/**
 * Bucketing is proved in tests/lib/tasks/calendar.test.ts against the pure
 * grid builder; this file covers only what needs a DOM — the disclosure, the
 * pager, and that choosing a chip reaches the caller.
 *
 * jsdom applies no CSS, so the grid and the agenda BOTH render and every task
 * title appears twice. Queries are scoped to one branch or the other via the
 * `data-calendar` hooks rather than searching the whole tree, which would
 * match ambiguously.
 */

const NOW = new Date(2026, 8, 23, 10, 0); // Wed 23 Sep 2026

function task(over: Partial<TaskWithCount> & { id: string; deadline: string }): TaskWithCount {
  return {
    companyId: "c1",
    projectId: "p1",
    title: over.id,
    description: "",
    status: "pending",
    priority: "medium",
    assignedTo: "u1",
    assignedToName: "Ali",
    assignedBy: "u2",
    assignedByName: "Sara",
    createdAt: "2026-09-01T00:00:00.000Z",
    order: 0,
    commentCount: 0,
    ...over,
  };
}

function localIso(y: number, m: number, d: number, h = 12) {
  return new Date(y, m, d, h).toISOString();
}

function grid(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-calendar="grid"]')!;
}
function agenda(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-calendar="agenda"]')!;
}

describe("TaskCalendar (the /tasks Calendar tab)", () => {
  it("lays the week out Monday first", () => {
    const { container } = render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    const headers = within(grid(container))
      .getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
      .map((el) => el.textContent);
    expect(headers).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("opens on the month containing today and names it", () => {
    render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    expect(screen.getByText("September 2026")).toBeInTheDocument();
  });

  it("marks today for a screen reader, not only with colour", () => {
    const { container } = render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    expect(within(grid(container)).getByText("Today")).toBeInTheDocument();
  });

  it("collapses a day holding more than three tasks behind a plus-N control", () => {
    const due = localIso(2026, 8, 15);
    const tasks = ["A", "B", "C", "D", "E"].map((id, i) =>
      task({ id, title: `Task ${id}`, deadline: due, order: i })
    );
    const { container } = render(<TaskCalendar tasks={tasks} now={NOW} onOpenDetail={vi.fn()} />);
    const g = within(grid(container));
    expect(g.getByTitle("Task A")).toBeInTheDocument();
    expect(g.getByTitle("Task C")).toBeInTheDocument();
    expect(g.queryByTitle("Task D")).not.toBeInTheDocument();
    expect(g.getByText("+2 more")).toBeInTheDocument();
  });

  it("reveals the rest of the day when the plus-N control is used", async () => {
    const user = userEvent.setup();
    const due = localIso(2026, 8, 15);
    const tasks = ["A", "B", "C", "D", "E"].map((id, i) =>
      task({ id, title: `Task ${id}`, deadline: due, order: i })
    );
    const { container } = render(<TaskCalendar tasks={tasks} now={NOW} onOpenDetail={vi.fn()} />);
    await user.click(within(grid(container)).getByText("+2 more"));
    const g = within(grid(container));
    expect(g.getByTitle("Task E")).toBeInTheDocument();
    expect(g.queryByText("+2 more")).not.toBeInTheDocument();
  });

  it("hands the chosen task back to the caller so the detail modal can open", async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    const t = task({ id: "A", title: "Ship v2", deadline: localIso(2026, 8, 15) });
    const { container } = render(
      <TaskCalendar tasks={[t]} now={NOW} onOpenDetail={onOpenDetail} />
    );
    await user.click(within(grid(container)).getByTitle("Ship v2"));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "A" }));
  });

  it("pages to the previous month and back again", async () => {
    const user = userEvent.setup();
    render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    await user.click(screen.getByLabelText("Previous month"));
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Next month"));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
  });

  it("offers a way back only once the reader has left the current month", async () => {
    const user = userEvent.setup();
    render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    // No point offering "This month" while you are already on it.
    expect(screen.queryByText("This month")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Previous month"));
    await user.click(screen.getByText("This month"));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    expect(screen.queryByText("This month")).not.toBeInTheDocument();
  });

  it("collapses a disclosure that was left open when the month changes", async () => {
    const user = userEvent.setup();
    const due = localIso(2026, 8, 15);
    const tasks = ["A", "B", "C", "D"].map((id, i) =>
      task({ id, title: `Task ${id}`, deadline: due, order: i })
    );
    const { container } = render(<TaskCalendar tasks={tasks} now={NOW} onOpenDetail={vi.fn()} />);
    await user.click(within(grid(container)).getByText("+1 more"));
    await user.click(screen.getByLabelText("Previous month"));
    await user.click(screen.getByLabelText("Next month"));
    // Back where we started, and the day is folded again.
    expect(within(grid(container)).getByText("+1 more")).toBeInTheDocument();
  });

  it("lists only the days that carry work in the narrow agenda", () => {
    const tasks = [
      task({ id: "A", title: "Task A", deadline: localIso(2026, 8, 15) }),
      task({ id: "B", title: "Task B", deadline: localIso(2026, 8, 17) }),
    ];
    const { container } = render(<TaskCalendar tasks={tasks} now={NOW} onOpenDetail={vi.fn()} />);
    const a = within(agenda(container));
    expect(a.getByText("Tuesday")).toBeInTheDocument(); // 15 Sep
    expect(a.getByText("Thursday")).toBeInTheDocument(); // 17 Sep
    // A month has more than two days; the agenda is not a full grid.
    expect(a.queryByText("Monday")).not.toBeInTheDocument();
  });

  it("shows the agenda an empty state rather than a blank panel", () => {
    const { container } = render(<TaskCalendar tasks={[]} now={NOW} onOpenDetail={vi.fn()} />);
    expect(within(agenda(container)).getByText(/Nothing due in September/)).toBeInTheDocument();
  });
});
