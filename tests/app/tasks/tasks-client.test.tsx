/**
 * The /tasks toolbar, its CTAs and its deep link — the affordances the board
 * offers, checked against what the server will actually do.
 *
 * Every contract here is about `app/(app)/tasks/tasks-client.tsx`.
 *
 *   tasks-and-comments-012  A filter option that can never match a row. The Due
 *                           filter offered "No deadline" and the predicate was
 *                           `!t.deadline` — but `Task.deadline` is a
 *                           non-nullable `DateTime` (prisma/schema.prisma:515),
 *                           `NewTaskSchema` demands a parseable date, and
 *                           `toClient` always emits an ISO string. So the option
 *                           emptied the board every time, and the user cannot
 *                           tell that from a genuinely empty result.
 *
 *   tasks-and-comments-013  `/tasks?taskId=<id>` must reveal that task. Five
 *                           filter values are restored from localStorage on
 *                           mount and the deep-link effect never checked whether
 *                           the linked task survived them, so a notification
 *                           about a low-priority task landed on "No tasks match
 *                           this filter" for anyone who had once chosen
 *                           "Urgent". Both task notification types
 *                           (`task_assigned`, `task_completed`) link here.
 *
 *   tasks-and-comments-002  The @-mention dropdown could never offer a
 *                           teammate's handle, and a teammate whose display name
 *                           carries no ASCII letters was dropped from it
 *                           entirely. `User` (lib/types.ts) has no `handle`,
 *                           `getCompanyUsers` returns none, and this page then
 *                           narrowed further with `users.map((u) => ({ id, name
 *                           }))` — so `mentionToken` always fell back to the
 *                           name slug, and "مہوش زیدی" has no typable slug at
 *                           all, so `useMentionAutocomplete` filtered her out.
 *                           Settings calls the handle "the @mention address".
 *
 *   tasks-and-comments-008  /tasks gave an ordinary member a prominent "New
 *                           task" CTA, a full form, and a project picker filled
 *                           from `listProjectOptions` — which for a member
 *                           returns every project they supervise OR hold a task
 *                           in. `addTaskAction` gates on `canManageProject`,
 *                           i.e. supervisor only. So the common case — a member
 *                           with tasks in a project they do not supervise —
 *                           filled in a title, a description, an assignee and a
 *                           deadline and was then told "Only the supervisor or a
 *                           founder can add tasks here".
 *
 *   tasks-and-comments-011  A deadline is a calendar DAY stored as an instant.
 *                           Every client surface formatted it in the VIEWER's
 *                           zone, so at UTC-5 — which is the zone `npm test`
 *                           pins — the card and the list row named the day
 *                           BEFORE the one the assignment email named, and
 *                           `isPast` flagged a task due today as overdue.
 *
 *   tasks-and-comments-009  Every card rendered an enabled status `<select>`
 *                           and a drag handle with no permission check, while
 *                           `updateTaskStatusAction` and `reorderTaskAction`
 *                           accept only `assignedTo === me || assignedBy === me
 *                           || role === "admin"`. A COFOUNDER is not in that
 *                           set, so the second seat every workspace buys was
 *                           handed the whole kanban and could move nothing that
 *                           was not their own — with the drag applied
 *                           optimistically first, so the card visibly moved,
 *                           an error toast fired, and it snapped back.
 *
 *                           The rule is NOT widened here: whether a cofounder
 *                           should be able to move a teammate's task is a
 *                           product decision, and the chat acceptance criterion
 *                           already on file says the opposite ("a cofounder
 *                           cannot delete mine", FaultsAudit X20). So the
 *                           control is made honest instead, against the exact
 *                           predicate the server applies.
 *
 * ORDER OF EFFECTS IS THE WHOLE DIFFICULTY OF 013. The deep-link effect is
 * declared BEFORE the localStorage restore, so on mount it runs while every
 * filter is still its default "all" — the linked task is visible at that moment
 * and hidden a microtask later. A check inside that effect alone therefore
 * proves nothing, which is why the widening below keys on the FILTERED list and
 * not on mount.
 *
 * jsdom applies no CSS and resolves no Tailwind, so nothing here asserts a
 * colour or a computed style — only the DOM contract: which controls exist,
 * which are disabled, and what is on screen after an interaction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksClient } from "@/app/(app)/tasks/tasks-client";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { MentionUser } from "@/lib/comments/mentions";
import type { User } from "@/lib/types";

/* ───────────────────────────── module mocks ─────────────────────────────── */

vi.mock("@/lib/actions/tasks", () => ({
  addTaskAction: vi.fn(async () => ({ success: true, data: {} })),
  deleteTaskAction: vi.fn(async () => ({ success: true, data: undefined })),
  updateTaskStatusAction: vi.fn(async () => ({ success: true, data: {} })),
  reorderTaskAction: vi.fn(async () => ({ success: true, data: undefined })),
  bulkDeleteTasksAction: vi.fn(async () => ({ success: true, data: { deleted: 0 } })),
  bulkUpdateTaskStatusAction: vi.fn(async () => ({ success: true, data: { updated: 0 } })),
}));
// The comment thread / detail modals import lib/actions/comments, which pulls in
// lib/auth — next-auth's server entry does not resolve under vitest. Never
// opened here.
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

const nav = vi.hoisted(() => ({ params: new Map<string, string>() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: (k: string) => nav.params.get(k) ?? null }),
}));

/* ────────────────────────────── fixtures ────────────────────────────────── */

function task(over: Partial<TaskWithCount> & { id: string }): TaskWithCount {
  return {
    companyId: "c1",
    projectId: "p1",
    title: over.id,
    description: "",
    status: "pending",
    priority: "medium",
    assignedTo: "u_me",
    assignedToName: "Sana Malik",
    assignedBy: "u_admin",
    assignedByName: "Ayesha Raza",
    deadline: "2026-10-15T00:00:00.000Z",
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

const USERS = [user("u_me", "Sana Malik"), user("u_admin", "Ayesha Raza")];

/**
 * The @mention roster — a SEPARATE prop from `users`, and carrying `handle`,
 * which is the whole of tasks-and-comments-002. See MENTION_ROSTER below for the
 * cases that matter.
 */
const MENTION_USERS: MentionUser[] = [
  { id: "u_me", name: "Sana Malik", handle: "sana" },
  { id: "u_admin", name: "Ayesha Raza", handle: "ayesha" },
];
const PROJECTS = [
  { id: "p1", name: "General" },
  { id: "p2", name: "Website relaunch" },
];

/**
 * The one-line notice the board shows when a deep link had to widen a filter.
 * Matched as a regex on a distinctive phrase, not on `role="status"`: dnd-kit
 * mounts its own status live region, so the role is not unique here.
 */
const NOTICE = /cleared your filters to show this task/i;

beforeEach(() => {
  nav.params.clear();
  localStorage.clear();
});

type BoardProps = React.ComponentProps<typeof TasksClient>;
type Overrides = Partial<BoardProps>;

/**
 * Default props for the board.
 *
 * Merged through an OBJECT spread and then assigned to `BoardProps`, rather than
 * spread straight into the JSX. TypeScript widens an optional property of a
 * spread JSX attribute to `T | undefined`, so `<TasksClient {...over} />` with
 * `over: Partial<BoardProps>` fails typecheck on every required prop while
 * passing under vitest — one of this repo's documented traps in miniature.
 */
const BOARD_DEFAULTS: BoardProps = {
  initialTasks: [],
  users: USERS,
  mentionUsers: MENTION_USERS,
  projects: PROJECTS,
  // What the caller may FILE into, which is not what they may FILTER by: a
  // member sees every project they hold a task in and can add a task only to one
  // they supervise (tasks-and-comments-008). The default is the full list, so the
  // tests that are not about 008 read as an admin would see it.
  filableProjects: PROJECTS,
  currentUserId: "u_me",
  currentUserRole: "member",
};

function renderBoard(over: Overrides = {}) {
  const props: BoardProps = {
    ...BOARD_DEFAULTS,
    initialTasks: [task({ id: "t1", title: "Ship the invoice export" })],
    ...over,
  };
  return render(<TasksClient {...props} />);
}

/**
 * One of the three toolbar filter selects, found through the label that names
 * it.
 *
 * Structural rather than `getByRole("combobox", { name })` on purpose.
 * `FilterSelect` wraps its `<select>` inside the `<label>`, and the accessible
 * name that computation produces is not the visible word — a loose `/due/i`
 * matched three controls and silently read the PRIORITY select in the first
 * draft of this file, which made the assertion below pass against the bug.
 * The label's own text is unambiguous.
 */
function filterSelect(label: "Priority" | "Project" | "Due"): HTMLSelectElement {
  const span = screen.getByText(label, { selector: "span" });
  const select = span.closest("label")?.querySelector("select");
  if (!select) throw new Error(`No <select> inside the "${label}" filter label`);
  return select as HTMLSelectElement;
}

function dueSelect(): HTMLSelectElement {
  return filterSelect("Due");
}

/* ══════════ 012 — every filter option can match something ═════════════════ */

describe("the Due filter offers no option that can never match (012)", () => {
  it("does not offer 'No deadline', which Task.deadline being non-nullable makes unmatchable", () => {
    renderBoard();
    const options = Array.from(dueSelect().options).map((o) => o.textContent ?? "");
    expect(
      options.filter((label) => /no deadline/i.test(label)),
      "the Due filter still offers an option that empties the board for every possible row"
    ).toEqual([]);
  });

  it("keeps the options that can match: any time, overdue, today, next 7 days", () => {
    // Guards the guard: an assertion that the list contains no "No deadline"
    // would also pass against a Due filter that had been emptied by accident.
    renderBoard();
    const options = Array.from(dueSelect().options).map((o) => o.value);
    expect(options).toEqual(["all", "overdue", "today", "week"]);
  });

  it("still filters on a value that can match — 'Next 7 days' hides a far-future task", async () => {
    const userEv = userEvent.setup();
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    renderBoard({
      initialTasks: [
        task({ id: "t_soon", title: "Due this week", deadline: "2026-10-03T00:00:00.000Z" }),
        task({ id: "t_far", title: "Due next year", deadline: "2027-10-03T00:00:00.000Z" }),
      ],
    });
    await userEv.selectOptions(dueSelect(), "week");
    expect(screen.getByText("Due this week")).toBeInTheDocument();
    expect(screen.queryByText("Due next year")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

/* ══════════ 013 — a task deep link always shows its task ══════════════════ */

describe("/tasks?taskId= reveals the task whatever the saved filters are (013)", () => {
  it("shows a low-priority task linked from a notification when 'Urgent' was remembered", () => {
    localStorage.setItem("ff.tasks.priority", "urgent");
    nav.params.set("taskId", "t_low");
    renderBoard({
      initialTasks: [
        task({ id: "t_low", title: "Rename the export column", priority: "low" }),
        task({ id: "t_hot", title: "Fix the login throttle", priority: "urgent" }),
      ],
    });

    expect(
      screen.queryByText("Rename the export column"),
      "the linked task is hidden by a filter the user chose days ago"
    ).toBeInTheDocument();
  });

  it("shows a teammate's task linked from a task_completed ping when 'Assigned to me' was remembered", () => {
    localStorage.setItem("ff.tasks.filter", "mine");
    nav.params.set("taskId", "t_theirs");
    renderBoard({
      initialTasks: [
        task({ id: "t_mine", title: "My own work", assignedTo: "u_me" }),
        task({
          id: "t_theirs",
          title: "Ayesha finished the migration",
          assignedTo: "u_admin",
          assignedBy: "u_me",
        }),
      ],
    });

    expect(screen.queryByText("Ayesha finished the migration")).toBeInTheDocument();
  });

  it("shows a task in another project when a project filter was remembered", () => {
    localStorage.setItem("ff.tasks.project", "p2");
    nav.params.set("taskId", "t_p1");
    renderBoard({
      initialTasks: [
        task({ id: "t_p1", title: "Task in General", projectId: "p1" }),
        task({ id: "t_p2", title: "Task in the relaunch", projectId: "p2" }),
      ],
    });

    expect(screen.queryByText("Task in General")).toBeInTheDocument();
  });

  it("says why the filters changed, rather than silently discarding the chosen slice", () => {
    localStorage.setItem("ff.tasks.priority", "urgent");
    nav.params.set("taskId", "t_low");
    renderBoard({
      initialTasks: [task({ id: "t_low", title: "Rename the export column", priority: "low" })],
    });

    // Not `getByRole("status")`: dnd-kit mounts its own `role="status"` live
    // region on every board render, so that query is ambiguous and an
    // `not.toBeInTheDocument` written against it can never pass.
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it("leaves the remembered slice in localStorage, so it is back on the next visit", () => {
    localStorage.setItem("ff.tasks.priority", "urgent");
    nav.params.set("taskId", "t_low");
    renderBoard({
      initialTasks: [task({ id: "t_low", title: "Rename the export column", priority: "low" })],
    });

    expect(
      localStorage.getItem("ff.tasks.priority"),
      "a notification click permanently destroyed the filter the user had chosen"
    ).toBe("urgent");
  });
});

describe("the deep-link widening does not fire when it is not needed (013)", () => {
  it("leaves a remembered filter alone when the linked task survives it", () => {
    localStorage.setItem("ff.tasks.priority", "urgent");
    nav.params.set("taskId", "t_hot");
    renderBoard({
      initialTasks: [
        task({ id: "t_low", title: "Rename the export column", priority: "low" }),
        task({ id: "t_hot", title: "Fix the login throttle", priority: "urgent" }),
      ],
    });

    expect(screen.getByText("Fix the login throttle")).toBeInTheDocument();
    expect(
      screen.queryByText("Rename the export column"),
      "the filter was cleared even though the linked task was already visible"
    ).not.toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("leaves the filters alone when the linked task is not on this page at all", () => {
    // A task id from beyond the 300-row window, or one this member cannot see.
    // Clearing filters would empty the board for nothing.
    localStorage.setItem("ff.tasks.priority", "urgent");
    nav.params.set("taskId", "t_absent");
    renderBoard({
      initialTasks: [
        task({ id: "t_low", title: "Rename the export column", priority: "low" }),
        task({ id: "t_hot", title: "Fix the login throttle", priority: "urgent" }),
      ],
    });

    expect(screen.queryByText("Rename the export column")).not.toBeInTheDocument();
    expect(screen.getByText("Fix the login throttle")).toBeInTheDocument();
  });

  it("does nothing at all without a taskId", () => {
    localStorage.setItem("ff.tasks.priority", "urgent");
    renderBoard({
      initialTasks: [
        task({ id: "t_low", title: "Rename the export column", priority: "low" }),
        task({ id: "t_hot", title: "Fix the login throttle", priority: "urgent" }),
      ],
    });

    expect(screen.queryByText("Rename the export column")).not.toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

/* ══════════ 009 — a board control the server will refuse is not offered ════ */

/** A task that belongs to somebody else entirely: not mine, not filed by me. */
const SOMEONE_ELSES = task({
  id: "t_theirs",
  title: "Ayesha's migration",
  assignedTo: "u_admin",
  assignedBy: "u_admin",
});

/** My own task — the control must stay live for this one. */
const MINE = task({
  id: "t_mine",
  title: "My own work",
  assignedTo: "u_me",
  assignedBy: "u_admin",
});

function boardStatusSelect(title: string): HTMLSelectElement {
  return screen.getByLabelText(`Status of ${title}`) as HTMLSelectElement;
}

describe("the board does not offer a cofounder controls the server refuses (009)", () => {
  it("disables the status select on a task that is neither theirs nor filed by them", () => {
    renderBoard({
      initialTasks: [SOMEONE_ELSES, MINE],
      currentUserId: "u_co",
      currentUserRole: "cofounder",
    });

    expect(
      boardStatusSelect("Ayesha's migration"),
      "a cofounder is offered a status select that updateTaskStatusAction answers with 'Not authorized'"
    ).toBeDisabled();
  });

  it("offers no drag handle on a card the cofounder cannot move", () => {
    renderBoard({
      initialTasks: [SOMEONE_ELSES, MINE],
      currentUserId: "u_co",
      currentUserRole: "cofounder",
    });

    expect(
      screen.queryByLabelText(/Drag Ayesha's migration/),
      "the card still drags, moves optimistically, and snaps back on the server refusal"
    ).not.toBeInTheDocument();
  });

  it("leaves the cofounder's OWN task fully operable", () => {
    // Guards the guard: a blanket disable would pass the two assertions above
    // and take the kanban away from everyone.
    renderBoard({
      initialTasks: [SOMEONE_ELSES, MINE],
      currentUserId: "u_me",
      currentUserRole: "cofounder",
    });

    expect(boardStatusSelect("My own work")).toBeEnabled();
    expect(screen.getByLabelText(/Drag My own work/)).toBeInTheDocument();
  });

  it("leaves an admin every control, on every card", () => {
    renderBoard({
      initialTasks: [SOMEONE_ELSES, MINE],
      currentUserId: "u_admin2",
      currentUserRole: "admin",
    });

    expect(boardStatusSelect("Ayesha's migration")).toBeEnabled();
    expect(screen.getByLabelText(/Drag Ayesha's migration/)).toBeInTheDocument();
  });

  it("applies the same rule in the list view's status cell", async () => {
    const userEv = userEvent.setup();
    // The viewer is a cofounder whose own assigned task is MINE — so this one
    // render shows both sides of the rule in the same table.
    renderBoard({
      initialTasks: [SOMEONE_ELSES, MINE],
      currentUserId: "u_me",
      currentUserRole: "cofounder",
    });
    await userEv.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByLabelText("Change status of Ayesha's migration")).toBeDisabled();
    expect(screen.getByLabelText("Change status of My own work")).toBeEnabled();
  });

  it("keeps the creator's control even when the task is assigned away", () => {
    renderBoard({
      initialTasks: [
        task({ id: "t_filed", title: "Filed by me", assignedTo: "u_admin", assignedBy: "u_me" }),
      ],
      currentUserId: "u_me",
      currentUserRole: "member",
    });

    expect(boardStatusSelect("Filed by me")).toBeEnabled();
  });
});

/* ══════════ 008 — no CTA for a form the server will refuse ════════════════ */

describe("a member who can file into no project is not offered the form (008)", () => {
  it("renders no 'New task' CTA in the header", () => {
    renderBoard({ filableProjects: [], currentUserRole: "member" });

    expect(
      screen.queryByRole("button", { name: /new task/i }),
      "a member is handed a CTA that addTaskAction answers with 'Only the supervisor or a founder can add tasks here'"
    ).not.toBeInTheDocument();
  });

  it("renders no 'Create task' CTA in the empty state either", () => {
    renderBoard({ initialTasks: [], filableProjects: [], currentUserRole: "member" });

    expect(screen.queryByRole("button", { name: /create task/i })).not.toBeInTheDocument();
  });

  it("says what WILL appear on the board instead of offering a dead end", () => {
    renderBoard({ initialTasks: [], filableProjects: [], currentUserRole: "member" });

    expect(screen.getByText(/assigned to you/i)).toBeInTheDocument();
  });

  it("keeps the CTA for a member who supervises a project", () => {
    // Guards the guard: hiding the button for every member would pass all three
    // assertions above and take task creation away from supervisors, who are
    // exactly who `canManageProject`'s escape hatch is for.
    renderBoard({ filableProjects: [PROJECTS[1]], currentUserRole: "member" });

    expect(screen.getByRole("button", { name: /new task/i })).toBeInTheDocument();
  });

  it("keeps the CTA for an admin", () => {
    renderBoard({ filableProjects: PROJECTS, currentUserRole: "admin" });

    expect(screen.getByRole("button", { name: /new task/i })).toBeInTheDocument();
  });

  it("offers the form only the projects the caller can actually file into", async () => {
    const userEv = userEvent.setup();
    // Visible for FILTERING: both. Filable: only the one they supervise.
    renderBoard({ filableProjects: [PROJECTS[1]], currentUserRole: "member" });
    await userEv.click(screen.getByRole("button", { name: /new task/i }));

    const dialog = within(screen.getByRole("dialog"));
    const picker = dialog.getByLabelText("Project") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["p2"]);
  });

  it("still offers every visible project in the toolbar's Project FILTER", () => {
    // The two lists are deliberately different. Narrowing the filter as well
    // would hide a member's own work in a project they do not supervise.
    renderBoard({ filableProjects: [PROJECTS[1]], currentUserRole: "member" });

    expect(Array.from(filterSelect("Project").options).map((o) => o.value)).toEqual([
      "all",
      "p1",
      "p2",
    ]);
  });
});

/* ══════════ 002 — the composer can offer, and insert, a handle ═════════════ */

/**
 * Mahwish is the population `User.handle` exists for: "مہوش زیدی" slugifies to
 * `"-"`, which the mention token grammar cannot produce, so her handle is the
 * only address she has. Ali has both a handle and a usable name slug, which is
 * what makes the precedence assertion below meaningful.
 */
const MENTION_ROSTER = [
  { id: "u_me", name: "Sana Malik", handle: "sana" },
  { id: "u_mahwish", name: "مہوش زیدی", handle: "mahwish" },
  { id: "u_ali", name: "Ali Khan", handle: "ali" },
];

/**
 * Open a card's comment thread and return its composer plus a scoped query for
 * the mention listbox.
 *
 * The listbox rows are `<li role="option">`, and so is every `<option>` of the
 * three toolbar `<select>`s — a bare `getAllByRole("option")` returned fifteen
 * of them in the first draft of this file. Scoping to the popup is what makes
 * the assertions mean what they say.
 */
async function openCommentComposer(userEv: ReturnType<typeof userEvent.setup>, title: string) {
  await userEv.click(screen.getByRole("button", { name: `Add a comment to ${title}` }));
  const dialog = await screen.findByRole("dialog");
  const textarea = within(dialog).getByRole("combobox") as HTMLTextAreaElement;
  const mentionOptions = () => {
    const listbox = within(dialog).queryByRole("listbox");
    return listbox ? within(listbox).queryAllByRole("option") : [];
  };
  return { textarea, mentionOptions };
}

describe("the comment composer's @-mention list is reachable for everybody (002)", () => {
  it("offers a teammate whose name has no ASCII letters, by their handle", async () => {
    const userEv = userEvent.setup();
    renderBoard({ mentionUsers: MENTION_ROSTER, currentUserRole: "admin" });
    const { textarea, mentionOptions } = await openCommentComposer(
      userEv,
      "Ship the invoice export"
    );

    await userEv.type(textarea, "@mahwish");

    expect(
      mentionOptions()
        .map((o) => o.textContent ?? "")
        .join(" | "),
      "the one teammate the handle column was added for has no row in the dropdown"
    ).toContain("مہوش زیدی");
  });

  it("inserts the handle, not the name slug, when a row is accepted", async () => {
    const userEv = userEvent.setup();
    renderBoard({ mentionUsers: MENTION_ROSTER, currentUserRole: "admin" });
    const { textarea } = await openCommentComposer(userEv, "Ship the invoice export");

    await userEv.type(textarea, "@ali");
    await userEv.keyboard("{Enter}");

    // `@ali`, the address Ali chose and the one the server's parser resolves —
    // not `@ali-khan`, which is what the name-slug fallback produced, and not
    // the raw typed text plus a newline, which is what a composer with no row to
    // accept leaves behind when Enter falls through to the textarea.
    expect(textarea.value).toBe("@ali ");
  });

  it("offers nobody when the typed token matches nobody", async () => {
    // Guards the guard: an assertion that "some row contains her name" would
    // also pass against a dropdown that offered the whole roster unconditionally.
    const userEv = userEvent.setup();
    renderBoard({ mentionUsers: MENTION_ROSTER, currentUserRole: "admin" });
    const { textarea, mentionOptions } = await openCommentComposer(
      userEv,
      "Ship the invoice export"
    );

    await userEv.type(textarea, "@nobodyhere");

    expect(mentionOptions()).toHaveLength(0);
  });

  it("never offers the reader themselves", async () => {
    const userEv = userEvent.setup();
    renderBoard({ mentionUsers: MENTION_ROSTER, currentUserId: "u_me", currentUserRole: "admin" });
    const { textarea, mentionOptions } = await openCommentComposer(
      userEv,
      "Ship the invoice export"
    );

    await userEv.type(textarea, "@sana");

    expect(mentionOptions()).toHaveLength(0);
  });
});

/* ══════════ 011 — the board names the day the assigner picked ══════════════ */

describe("the board and the list name the deadline's own calendar day (011)", () => {
  /** 15 Oct 2026, stored the way every existing row is: UTC midnight. */
  const DUE_15_OCT = "2026-10-15T00:00:00.000Z";

  it("shows 'Oct 15' on the card, not the day before, at UTC-5", () => {
    renderBoard({
      initialTasks: [
        task({ id: "t_due", title: "Rename the export column", deadline: DUE_15_OCT }),
      ],
    });
    expect(screen.getByText("Oct 15")).toBeInTheDocument();
  });

  it("shows 'Oct 15, 2026' in the list view", async () => {
    const userEv = userEvent.setup();
    renderBoard({
      initialTasks: [
        task({ id: "t_due", title: "Rename the export column", deadline: DUE_15_OCT }),
      ],
    });
    await userEv.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByText("Oct 15, 2026")).toBeInTheDocument();
  });

  it("does not mark a task due today as overdue, and says 'due today' out loud", () => {
    vi.setSystemTime(new Date(2026, 9, 15, 9, 0));
    renderBoard({
      initialTasks: [
        task({ id: "t_due", title: "Rename the export column", deadline: DUE_15_OCT }),
      ],
    });

    // The overdue state used to be colour plus an aria-hidden icon, so it did not
    // exist for a screen reader at all — and it was wrong as well as invisible.
    //
    // Matched WITH the em dash: the Due filter also renders `<option>Overdue` and
    // `<option>Due today`, so a bare `/^Overdue/` matches two elements and
    // `queryByText` throws instead of answering.
    expect(screen.queryByText(/^Overdue —/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Due today —/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("does mark yesterday's deadline overdue", () => {
    // Guards the guard: a fix that simply stopped computing `overdue` would pass
    // the assertion above.
    vi.setSystemTime(new Date(2026, 9, 16, 9, 0));
    renderBoard({
      initialTasks: [
        task({ id: "t_due", title: "Rename the export column", deadline: DUE_15_OCT }),
      ],
    });

    expect(screen.getByText(/^Overdue —/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("filters 'Due today' by the viewer's day, not by the stored instant", async () => {
    const userEv = userEvent.setup();
    vi.setSystemTime(new Date(2026, 9, 15, 9, 0));
    renderBoard({
      initialTasks: [
        // Titles chosen not to collide with the filter's own option labels.
        task({ id: "t_today", title: "Send the payroll run", deadline: DUE_15_OCT }),
        task({
          id: "t_tomorrow",
          title: "Reconcile the bank feed",
          deadline: "2026-10-16T00:00:00.000Z",
        }),
      ],
    });
    await userEv.selectOptions(dueSelect(), "today");

    expect(screen.getByText("Send the payroll run")).toBeInTheDocument();
    expect(screen.queryByText("Reconcile the bank feed")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

/* ══════════ 009, third surface — the detail modal's status select ══════════ */

describe("the detail modal's status select obeys the same rule (009)", () => {
  it("is disabled for a cofounder on somebody else's task", async () => {
    const userEv = userEvent.setup();
    renderBoard({
      initialTasks: [SOMEONE_ELSES],
      currentUserId: "u_co",
      currentUserRole: "cofounder",
    });
    await userEv.click(screen.getByRole("button", { name: "Open task Ayesha's migration" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Change status")).toBeDisabled();
  });

  it("is enabled on the viewer's own task", async () => {
    const userEv = userEvent.setup();
    renderBoard({ initialTasks: [MINE], currentUserId: "u_me", currentUserRole: "cofounder" });
    await userEv.click(screen.getByRole("button", { name: "Open task My own work" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Change status")).toBeEnabled();
  });
});

/* ══════════ 003 — the mention link opens the thread it names ══════════════ */

/**
 * tasks-and-comments-003, the half that was left.
 *
 * `createCommentAction` sends "<name> mentioned you" to
 * `/tasks?taskId=<taskId>&comment=<commentId>`. The `taskId=` half was fixed
 * first and is covered by the 013 block above — the card scrolls and flashes.
 * `comment=` was carried but read by NOBODY: the repo-wide grep for
 * `searchParams.get` under app/(app)/ found only `taskId` here and
 * `transactionId` in expenses-client. So the only call to action an @mention
 * has landed the reader on a board with the conversation still closed, which is
 * the finding's own words: "the comment it points at never opens".
 *
 * WHAT IS ASSERTED, and why it is the dialog rather than a scroll position. The
 * comment id cannot be resolved on the client — mapping it to its target needs
 * a server read — so the thread is opened via the `taskId=` the link already
 * carries, which is why `createCommentAction` puts the target first. Scrolling
 * to the individual comment INSIDE the thread lives in components/comments/,
 * which is reported rather than built here.
 *
 * `listCommentsAction` is mocked at the top of this file to answer `[]`, so
 * these cases are about whether the thread is OPENED, not about its contents.
 */
describe("/tasks?comment= opens the comment thread the mention points at (003)", () => {
  it("opens the named task's thread on arrival", async () => {
    nav.params.set("taskId", "t1");
    nav.params.set("comment", "cm_1");
    renderBoard({ initialTasks: [task({ id: "t1", title: "Ship the invoice export" })] });

    const dialog = await screen.findByRole("dialog");
    // The thread modal titles itself after the task, which is what proves it is
    // the comment thread and not some other dialog the board can raise.
    expect(within(dialog).getByText(/Comments · Ship the invoice export/)).toBeInTheDocument();
  });

  it("opens nothing when the link carries no comment id", async () => {
    // GUARDS THE GUARD. Without this, the case above would pass just as happily
    // against a board that opened the thread for every `?taskId=` link — which
    // would be a different bug (every task notification, not just mentions,
    // would raise a modal nobody asked for).
    nav.params.set("taskId", "t1");
    renderBoard({ initialTasks: [task({ id: "t1", title: "Ship the invoice export" })] });

    // The card itself must still be there — i.e. the board rendered — so an
    // absent dialog is a decision and not a crash.
    expect(screen.getByText("Ship the invoice export")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens nothing when the task is not on this reader's board", async () => {
    // A member mentioned on a teammate's task: `getTasks` filters their board
    // to `assignedTo`, so the row is absent, and `listCommentsForTarget` would
    // refuse them the thread anyway. An empty modal is a worse answer than none.
    nav.params.set("taskId", "t_not_mine");
    nav.params.set("comment", "cm_1");
    renderBoard({ initialTasks: [task({ id: "t1", title: "Ship the invoice export" })] });

    expect(screen.getByText("Ship the invoice export")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays closed once the reader closes it", async () => {
    // The param is still in the URL at that point, so without the once-per-id
    // ref the next render would re-open the thread and the reader could not
    // dismiss it.
    const userEv = userEvent.setup();
    nav.params.set("taskId", "t1");
    nav.params.set("comment", "cm_1");
    renderBoard({ initialTasks: [task({ id: "t1", title: "Ship the invoice export" })] });

    const dialog = await screen.findByRole("dialog");
    await userEv.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
