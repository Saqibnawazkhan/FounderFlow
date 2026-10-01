"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertOctagon,
  ArrowDown,
  ArrowUp,
  Calendar,
  CheckCircle2,
  CheckSquare,
  CircleDot,
  Clock,
  GripVertical,
  LayoutGrid,
  LayoutList,
  CalendarDays,
  MessageSquare,
  Minus,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  bulkDeleteTasksAction,
  bulkUpdateTaskStatusAction,
  deleteTaskAction,
  reorderTaskAction,
  updateTaskStatusAction,
} from "@/lib/actions/tasks";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TaskForm } from "@/components/tasks/task-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { CommentThreadModal } from "@/components/comments/comment-thread-modal";
import { TaskDetailModal } from "@/components/tasks/task-detail-modal";
import { TaskCalendar } from "@/components/tasks/task-calendar";
import { cn } from "@/lib/utils";
import { canDeleteTask, canEditTask } from "@/lib/tasks/task-permissions";
import {
  formatDeadlineDay,
  isDeadlineOverdue,
  isDeadlineToday,
  isDeadlineWithinDays,
} from "@/lib/tasks/deadline";
import type { MentionUser } from "@/lib/comments/mentions";
import type { TaskStatus, TaskPriority, User } from "@/lib/types";
import type { TaskWithCount } from "@/lib/queries/tasks";
import { useNumberFormat } from "@/lib/i18n/use-t";

interface Column {
  status: TaskStatus;
  title: string;
  icon: LucideIcon;
  tone: "primary" | "forest" | "mint";
}

const COLUMNS: Column[] = [
  { status: "pending", title: "Pending", icon: Clock, tone: "mint" },
  { status: "in_progress", title: "In progress", icon: CircleDot, tone: "forest" },
  { status: "completed", title: "Completed", icon: CheckCircle2, tone: "primary" },
];

// The three ways of looking at the same tasks. Views are a primary choice,
// not a filter, so they render as tabs on their own rule under the title
// rather than as a pill at the end of the filter row — where Calendar was
// easy to miss entirely.
const VIEWS = [
  { key: "board", label: "Board", icon: LayoutGrid },
  { key: "list", label: "List", icon: LayoutList },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
] as const;

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: "border-danger/30 bg-danger/10 text-danger-strong",
  high: "border-warning/30 bg-warning/10 text-warning-strong",
  medium: "border-info/30 bg-info/10 text-info-strong",
  low: "border-border bg-bg text-fg-muted",
};

// Shape/icon differentiator so priority isn't communicated via color alone
// — meets the a11y ask from audit row T8. The text label stays; the icon is
// a redundant channel that a color-blind user can still parse at a glance.
const PRIORITY_ICONS: Record<TaskPriority, LucideIcon> = {
  urgent: AlertOctagon,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
};

type Props = {
  initialTasks: TaskWithCount[];
  /** Assignee picker + avatars. Carries no `handle` — see `mentionUsers`. */
  users: User[];
  /**
   * The roster the comment composer resolves @mentions against, WITH `handle`
   * (tasks-and-comments-002).
   *
   * Separate from `users` because the `User` DTO has no handle field, so this
   * page used to hand the thread `users.map((u) => ({ id, name }))` and
   * `mentionToken` fell back to the name slug every time: no handle could ever
   * be offered or inserted, and a teammate whose display name carries no ASCII
   * letters ("مہوش زیدی" slugifies to `"-"`, which the token grammar cannot
   * produce) had no row in the dropdown at all — the very person the handle
   * column was added for.
   */
  mentionUsers: MentionUser[];
  /**
   * Every project the caller may SEE — the toolbar's Project filter. Includes
   * projects a member merely holds a task in, because they need to filter their
   * own work by them.
   */
  projects: { id: string; name: string }[];
  /**
   * The projects the caller may FILE A TASK INTO — the new-task form's picker,
   * and the precondition for offering its CTA at all
   * (tasks-and-comments-008). A strict subset of `projects`: for a member it is
   * only the ones they supervise, which is what `addTaskAction` accepts. When it
   * is empty there is nowhere to file, so the CTAs are not rendered.
   */
  filableProjects: { id: string; name: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
};

export function TasksClient({
  initialTasks,
  users,
  mentionUsers,
  projects,
  filableProjects,
  currentUserId,
  currentUserRole,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const n = useNumberFormat();

  // When a task-notification link lands here as `?taskId=...`, scroll the
  // matching card into view and flash a highlight ring on it. The ring is
  // driven by `highlightId`; the effect below clears it after 2.5s and then
  // wipes the query param so a page refresh doesn't re-flash.
  //
  // One task id can own SEVERAL nodes at the same time. The calendar renders
  // its md+ grid and its narrow agenda together and hides one with CSS, so a
  // plain id -> element map keeps whichever branch registered last — on a
  // desktop that is the `display:none` one, and scrollIntoView on a hidden
  // element silently does nothing. Keep every node; pick a laid-out one at
  // scroll time.
  const highlightIdParam = searchParams.get("taskId");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const scrollRefs = useRef<Map<string, Set<HTMLElement>>>(new Map());
  function registerRef(id: string) {
    return (el: HTMLElement | null) => {
      // React passes null when it detaches the PREVIOUS callback, which it
      // does on every render because this closure is fresh each time — so a
      // null here says nothing about whether the node is gone. Stale nodes are
      // pruned at read time against `isConnected` instead.
      if (!el) return;
      const nodes = scrollRefs.current.get(id);
      if (nodes) nodes.add(el);
      else scrollRefs.current.set(id, new Set([el]));
    };
  }
  /** A node for `id` that is still in the document and actually laid out. */
  function scrollTargetFor(id: string): HTMLElement | null {
    const nodes = scrollRefs.current.get(id);
    if (!nodes) return null;
    const live: HTMLElement[] = [];
    nodes.forEach((node) => {
      if (node.isConnected) live.push(node);
      else nodes.delete(node);
    });
    if (nodes.size === 0) scrollRefs.current.delete(id);
    // getClientRects() is empty for anything inside a `display:none` subtree,
    // which is exactly how the calendar hides the layout this viewport isn't
    // using. jsdom lays nothing out, so tests fall through to live[0].
    return live.find((n) => n.getClientRects().length > 0) ?? live[0] ?? null;
  }
  useEffect(() => {
    if (!highlightIdParam) return;
    setHighlightId(highlightIdParam);
    // Resolve the target on the next frame rather than in this commit: the
    // calendar may still have to page itself to the month the task is due in,
    // and that state update has not rendered yet while this effect runs.
    const frame = requestAnimationFrame(() => {
      scrollTargetFor(highlightIdParam)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const t = setTimeout(() => {
      setHighlightId(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("taskId");
      window.history.replaceState({}, "", url.toString());
    }, 2500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIdParam]);

  // Optimistic local copy of the task list. Seeded from the RSC prop, then
  // mutated in place for snappy DnD updates. router.refresh() in the parent
  // re-runs the server query and arrives back here as `initialTasks`; we
  // resync via the effect below.
  const [tasks, setTasks] = useState<TaskWithCount[]>(initialTasks);
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  // Active task whose comment thread is open. Null = drawer closed. Stays
  // a reference to the original row so the modal title can show the title.
  const [commentingTask, setCommentingTask] = useState<TaskWithCount | null>(null);
  // Active task whose full detail modal is open. Separate from the comment
  // drawer so a card click gives the whole picture (metadata + description +
  // comments inline), while the comment icon still jumps straight to the
  // thread for people who know what they want.
  const [detailTask, setDetailTask] = useState<TaskWithCount | null>(null);
  // Keep the detail modal's task snapshot in sync with the RSC prop after a
  // status change or comment write — otherwise the modal would keep showing
  // the stale row until the user closed and reopened it.
  useEffect(() => {
    if (!detailTask) return;
    const fresh = initialTasks.find((t) => t.id === detailTask.id);
    if (fresh && fresh !== detailTask) setDetailTask(fresh);
  }, [initialTasks, detailTask]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  /* ── WHAT THIS VIEWER CAN ACTUALLY DO (tasks-and-comments-009) ─────────────
   *
   * `canEditTask` / `canDeleteTask` (lib/tasks/task-permissions.ts) are the same
   * functions `updateTaskStatusAction`, `reorderTaskAction` and
   * `deleteTaskAction` apply, so a control this page offers is a control the
   * server will honour. Before this, only DELETE was threaded through: every
   * card rendered an enabled status `<select>` and a drag handle for every
   * viewer, and a cofounder — who is not in the server's edit set — was handed
   * the whole kanban and could move nothing that was not their own. The drag
   * applies optimistically first, so the card moved, a toast fired, and it
   * snapped back.
   */
  const actor = useMemo(
    () => ({ userId: currentUserId, role: currentUserRole }),
    [currentUserId, currentUserRole]
  );
  const mayEdit = (task: TaskWithCount) => canEditTask({ actor, task });
  const mayDelete = (task: TaskWithCount) => canDeleteTask({ actor, task });

  const [modalOpen, setModalOpen] = useState(false);
  /**
   * Is there anywhere for this person to file a task? (tasks-and-comments-008.)
   *
   * `addTaskAction` needs a project it will accept, so with no filable project
   * the form cannot succeed for any input and the CTA is a dead end — a member
   * filled in four fields and got "Only the supervisor or a founder can add
   * tasks here". Hidden rather than disabled: there is no action the reader could
   * take to enable it, so a tooltip would only explain a button that should not
   * be there. The empty state says what WILL appear instead.
   */
  const canFileTask = filableProjects.length > 0;
  // View + filter live in localStorage so a user's chosen slice survives a
  // page refresh. Reads happen behind a hydration effect so SSR + first
  // client paint agree; without the effect gate we'd hit a hydration diff.
  // One timestamp per render pass (matches time-client.tsx) so the calendar's
  // today marker is stable across SSR and hydration.
  const renderedAt = useMemo(() => new Date(), []);

  // Persist on change rather than in an effect on [value]. Under StrictMode the
  // effect version double-invokes: the restore sets "calendar", the writer then
  // fires with the PREVIOUS render's "board" and clobbers storage, and the
  // second restore reads "board" back — so the chosen slice silently reset on
  // every refresh in development. Writing from the handler has no such race,
  // because nothing writes until the user actually chooses something.
  function persist(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage throws on private-mode Safari — the choice just won't stick.
    }
  }
  function chooseView(next: "board" | "list" | "calendar") {
    setView(next);
    persist("ff.tasks.view", next);
  }
  function chooseFilter(next: "all" | "mine" | "assigned-by-me") {
    setFilter(next);
    persist("ff.tasks.filter", next);
  }
  function choosePriority(next: "all" | TaskPriority) {
    setPriorityFilter(next);
    persist("ff.tasks.priority", next);
  }
  function chooseProject(next: string) {
    setProjectFilter(next);
    persist("ff.tasks.project", next);
  }
  function chooseDue(next: "all" | "overdue" | "today" | "week") {
    setDueFilter(next);
    persist("ff.tasks.due", next);
  }
  const [view, setView] = useState<"board" | "list" | "calendar">("board");
  const [filter, setFilter] = useState<"all" | "mine" | "assigned-by-me">("all");
  // Secondary filters (T4) — stack on top of the relationship filter above.
  const [priorityFilter, setPriorityFilter] = useState<"all" | TaskPriority>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  // NO "none" MEMBER (tasks-and-comments-012). `Task.deadline` is a
  // non-nullable `DateTime`, `NewTaskSchema` demands a parseable date and
  // `toClient` always emits an ISO string, so an "undated" bucket matches no row
  // that can exist — components/tasks/task-calendar.tsx states the same
  // invariant. The option and its `!t.deadline` branch shipped anyway, so
  // choosing it always answered "No tasks match this filter", which a user
  // cannot tell from a genuinely empty result. If undated tasks are ever wanted,
  // `Task.deadline` has to become nullable first; until then this union is the
  // complete set.
  const [dueFilter, setDueFilter] = useState<"all" | "overdue" | "today" | "week">("all");
  useEffect(() => {
    try {
      const savedView = localStorage.getItem("ff.tasks.view");
      const savedFilter = localStorage.getItem("ff.tasks.filter");
      const savedPriority = localStorage.getItem("ff.tasks.priority");
      const savedProject = localStorage.getItem("ff.tasks.project");
      const savedDue = localStorage.getItem("ff.tasks.due");
      if (savedView === "board" || savedView === "list" || savedView === "calendar") {
        setView(savedView);
      }
      if (savedFilter === "all" || savedFilter === "mine" || savedFilter === "assigned-by-me") {
        setFilter(savedFilter);
      }
      if (
        savedPriority === "all" ||
        savedPriority === "urgent" ||
        savedPriority === "high" ||
        savedPriority === "medium" ||
        savedPriority === "low"
      ) {
        setPriorityFilter(savedPriority);
      }
      if (savedProject) setProjectFilter(savedProject);
      // A stored "none" from before tasks-and-comments-012 is not restored: it
      // is no longer a value this filter has, and reviving it would restore the
      // empty board it used to produce.
      if (
        savedDue === "all" ||
        savedDue === "overdue" ||
        savedDue === "today" ||
        savedDue === "week"
      ) {
        setDueFilter(savedDue);
      }
    } catch {
      // localStorage can throw on private-mode Safari — silently fall back.
    }
  }, []);

  // A project the user still has selected can vanish (archived / deleted).
  // Fall back to "all" so the list never silently shows nothing. This one is
  // an effect on purpose — it reacts to the server's project list, not to a
  // click — and it goes through chooseProject so the dead id is cleared out of
  // storage too, rather than being restored on the next visit.
  useEffect(() => {
    if (projectFilter !== "all" && !projects.some((p) => p.id === projectFilter)) {
      chooseProject("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectFilter, projects]);

  const secondaryActive =
    priorityFilter !== "all" || projectFilter !== "all" || dueFilter !== "all";

  function clearSecondary() {
    choosePriority("all");
    chooseProject("all");
    chooseDue("all");
  }

  const filtered = useMemo(() => {
    // Relationship slice first, then stack the secondary filters.
    let rows = tasks;
    if (filter === "mine") rows = rows.filter((t) => t.assignedTo === currentUserId);
    else if (filter === "assigned-by-me") rows = rows.filter((t) => t.assignedBy === currentUserId);

    if (priorityFilter !== "all") rows = rows.filter((t) => t.priority === priorityFilter);
    if (projectFilter !== "all") rows = rows.filter((t) => t.projectId === projectFilter);

    if (dueFilter !== "all") {
      // Whole DAYS, from UTC parts (tasks-and-comments-011). These used to
      // compare the stored instant in the viewer's zone, so at UTC-5 every
      // bucket was a day out: "Overdue" caught tasks due today, "Due today"
      // caught tomorrow's, and "Next 7 days" — which compared against `now`
      // rather than the start of today — silently excluded everything due today.
      rows = rows.filter((t) => {
        // `!t.deadline` is still checked, and is still not an "undated" bucket:
        // the column is non-nullable, so this only catches a malformed payload,
        // which is hidden rather than crashed on.
        if (!t.deadline) return false;
        if (dueFilter === "overdue") return isDeadlineOverdue(t.deadline);
        if (dueFilter === "today") return isDeadlineToday(t.deadline);
        if (dueFilter === "week") return isDeadlineWithinDays(t.deadline, 7);
        return true;
      });
    }
    return rows;
  }, [tasks, filter, priorityFilter, projectFilter, dueFilter, currentUserId]);

  /* ── A TASK DEEP LINK OUTRANKS THE REMEMBERED SLICE (tasks-and-comments-013) ─
   *
   * Both task notifications link here — `task_assigned` and `task_completed`,
   * lib/actions/tasks.ts — and five filter values are restored from
   * localStorage on mount. Nothing reconciled the two, so a reader who once
   * chose "Urgent" (or a project, or "Assigned to me") got "No tasks match this
   * filter" for every later ping about anything else: `scrollRefs` held no node
   * for the linked id and the scroll effect silently did nothing. The calendar
   * view already goes to real lengths for the same promise, paging itself to the
   * task's month and expanding a collapsed "+N more".
   *
   * WHY THIS IS A SEPARATE EFFECT AND NOT A CHECK INSIDE THE SCROLL EFFECT.
   * Effects run in declaration order, and the scroll effect is declared above
   * the localStorage restore. On mount it therefore runs while every filter is
   * still "all" — the linked task is visible at that instant and hidden a
   * moment later. Keying on `filtered` instead means the decision is taken
   * against the slice the user will actually see, whether the filters arrived
   * from storage on mount or were already applied when the bell was clicked
   * from this very page (a client-side navigation that never unmounts this
   * island, which is the common way these links are followed).
   *
   * WHY IT WIDENS RATHER THAN REFUSING. The link names one task; that is a
   * stronger statement of intent than a filter set days ago. But it writes the
   * WIDENED VALUES THROUGH THE RAW SETTERS, not through `chooseX`, so nothing is
   * persisted: the reader's saved slice is intact and returns on their next
   * visit. `deepLinkWidened` says so on screen, because a toolbar that silently
   * resets itself is its own bug report.
   *
   * `widenedForRef` makes it once-per-id. Without it the effect would fight a
   * user who deliberately re-filters while `?taskId=` is still in the URL.
   * It is never cleared: a second widening for the same link is exactly the
   * behaviour worth refusing.
   */
  const widenedForRef = useRef<string | null>(null);
  const [deepLinkWidened, setDeepLinkWidened] = useState(false);
  useEffect(() => {
    const id = highlightIdParam;
    if (!id) return;
    if (widenedForRef.current === id) return;
    // Not on this page at all — beyond the page window, or not visible to this
    // reader. Clearing filters would empty the board for nothing.
    if (!tasks.some((t) => t.id === id)) return;
    if (filtered.some((t) => t.id === id)) return;
    widenedForRef.current = id;
    setFilter("all");
    setPriorityFilter("all");
    setProjectFilter("all");
    setDueFilter("all");
    setDeepLinkWidened(true);
  }, [highlightIdParam, tasks, filtered]);

  // Bulk selection (list view). `selected` holds task ids; we prune any that
  // fall out of the filtered set so the action bar count never lies after a
  // filter switch or an RSC refresh removes rows.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(filtered.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (live.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [filtered]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))
    );
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function handleBulkStatus(status: TaskStatus) {
    if (selected.size === 0) return;
    setBulkPending(true);
    const res = await bulkUpdateTaskStatusAction({ ids: Array.from(selected), status });
    setBulkPending(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    const skipped = selected.size - res.data.updated;
    toast.success(
      `Moved ${res.data.updated} task${res.data.updated === 1 ? "" : "s"} to ${status.replace("_", " ")}` +
        (skipped > 0 ? ` (${skipped} skipped — not yours to change)` : "")
    );
    clearSelection();
    refresh();
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Delete ${selected.size} task${selected.size === 1 ? "" : "s"}?`,
      description: "This action cannot be undone. Only tasks you created will be deleted.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBulkPending(true);
    const res = await bulkDeleteTasksAction({ ids: Array.from(selected) });
    setBulkPending(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    const skipped = selected.size - res.data.deleted;
    toast.success(
      `Deleted ${res.data.deleted} task${res.data.deleted === 1 ? "" : "s"}` +
        (skipped > 0 ? ` (${skipped} skipped — only the creator can delete)` : "")
    );
    clearSelection();
    refresh();
  }

  const grouped = useMemo(() => {
    // Sort each column by the manual order key (smaller = higher), createdAt
    // desc as the tiebreak. Sorting here — not just relying on the server
    // order — means an optimistic reorder (which only mutates one task's
    // `order`) re-lays-out the column immediately, before the RSC refresh.
    const byOrder = (a: TaskWithCount, b: TaskWithCount) =>
      a.order - b.order || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return {
      pending: filtered.filter((t) => t.status === "pending").sort(byOrder),
      in_progress: filtered.filter((t) => t.status === "in_progress").sort(byOrder),
      completed: filtered.filter((t) => t.status === "completed").sort(byOrder),
    };
  }, [filtered]);

  async function handleStatusChange(id: string, status: TaskStatus) {
    const result = await updateTaskStatusAction({ id, status });
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(`Task marked as ${status.replace("_", " ")}`);
    refresh();
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this task?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteTaskAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Task deleted");
    refresh();
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  const [draggingTask, setDraggingTask] = useState<TaskWithCount | null>(null);

  function handleDragStart(e: DragStartEvent) {
    const t = tasks.find((x) => x.id === e.active.id);
    if (t) setDraggingTask(t);
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggingTask(null);
    const taskId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    // `over` is either a column droppable (its id IS the status) or another
    // card (its id is a task id). Resolve the destination status from either.
    const STATUS_IDS: TaskStatus[] = ["pending", "in_progress", "completed"];
    const overIsColumn = (STATUS_IDS as string[]).includes(overId);
    const destStatus = overIsColumn
      ? (overId as TaskStatus)
      : tasks.find((t) => t.id === overId)?.status;
    if (!destStatus) return;

    // ── Cross-column: change status (unchanged behavior + rollback). ──
    if (destStatus !== task.status) {
      const priorStatus = task.status;
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: destStatus } : t)));
      void updateTaskStatusAction({ id: taskId, status: destStatus }).then((res) => {
        if (!res.success) {
          toast.error(res.error);
          setTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, status: priorStatus } : t))
          );
          refresh();
        }
      });
      return;
    }

    // ── Same column: reorder. Only meaningful when dropped over another card. ──
    if (overIsColumn || overId === taskId) return;
    const column = grouped[destStatus];
    const oldIndex = column.findIndex((t) => t.id === taskId);
    const newIndex = column.findIndex((t) => t.id === overId);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    // Midpoint between the drop neighbors after the move. Float `order` means
    // one row write, not a full-column renumber. (If the gap ever collapses
    // to equal floats, the createdAt tiebreak keeps rendering stable and a
    // future reorder re-spreads it.)
    const reordered = arrayMove(column, oldIndex, newIndex);
    const pos = reordered.findIndex((t) => t.id === taskId);
    const prevOrder = pos > 0 ? reordered[pos - 1].order : null;
    const nextOrder = pos < reordered.length - 1 ? reordered[pos + 1].order : null;
    let newOrder: number;
    if (prevOrder === null && nextOrder === null) newOrder = task.order;
    else if (prevOrder === null) newOrder = (nextOrder as number) - 1000;
    else if (nextOrder === null) newOrder = prevOrder + 1000;
    else newOrder = (prevOrder + nextOrder) / 2;

    const priorOrder = task.order;
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, order: newOrder } : t)));
    void reorderTaskAction({ id: taskId, order: newOrder }).then((res) => {
      if (!res.success) {
        toast.error(res.error);
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, order: priorOrder } : t)));
        refresh();
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge>Get it done</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Tasks</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Assign work, set deadlines, and ship.
          </p>
        </div>
        {canFileTask && (
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New task
          </button>
        )}
      </header>

      <div className="-mt-3 border-b border-border">
        <div
          role="group"
          aria-label="Task view"
          className="scrollbar-thin flex items-center gap-1 overflow-x-auto"
        >
          {VIEWS.map((v) => (
            <ViewTab
              key={v.key}
              icon={v.icon}
              label={v.label}
              active={view === v.key}
              onSelect={() => chooseView(v.key)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedToggle
          value={filter}
          onChange={(v) => chooseFilter(v as typeof filter)}
          options={[
            { key: "all", label: "All", count: tasks.length },
            {
              key: "mine",
              label: "Assigned to me",
              count: tasks.filter((t) => t.assignedTo === currentUserId).length,
            },
            {
              key: "assigned-by-me",
              label: "Created by me",
              count: tasks.filter((t) => t.assignedBy === currentUserId).length,
            },
          ]}
        />
      </div>

      {/* tasks-and-comments-013: the deep link widened a filter, so say so.
          `role="status"` rather than an alert — it reports something already
          done, and nothing is waiting on the reader. */}
      {deepLinkWidened && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-primary/30 bg-primary/[0.06] px-4 py-2.5 text-xs text-fg"
        >
          <span>
            Cleared your filters to show this task. Your saved filters are back next time you open
            Tasks.
          </span>
          <button
            type="button"
            onClick={() => setDeepLinkWidened(false)}
            className="font-semibold text-fg-muted underline underline-offset-2 transition-colors hover:text-fg"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Secondary filters (T4): priority · project · due date. Stack on top
          of the relationship filter; each persists to localStorage. */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Priority"
          value={priorityFilter}
          onChange={(v) => choosePriority(v as typeof priorityFilter)}
          options={[
            { value: "all", label: "Any priority" },
            { value: "urgent", label: "Urgent" },
            { value: "high", label: "High" },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ]}
        />
        <FilterSelect
          label="Project"
          value={projectFilter}
          onChange={(v) => chooseProject(v)}
          options={[
            { value: "all", label: "All projects" },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <FilterSelect
          label="Due"
          value={dueFilter}
          onChange={(v) => chooseDue(v as typeof dueFilter)}
          options={[
            { value: "all", label: "Any time" },
            { value: "overdue", label: "Overdue" },
            { value: "today", label: "Due today" },
            { value: "week", label: "Next 7 days" },
          ]}
        />
        {secondaryActive && (
          <button
            onClick={clearSecondary}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-danger/40 hover:text-danger"
          >
            Clear filters
          </button>
        )}
        <span className="ms-auto font-mono text-[11px] tabular-nums text-fg-muted">
          {n.number(filtered.length)} {filtered.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={CheckSquare}
            title={tasks.length === 0 ? "No tasks yet" : "No tasks match this filter"}
            description={
              tasks.length === 0
                ? canFileTask
                  ? "Create your first task to start coordinating work across your team."
                  : "Work assigned to you will appear here. Ask a founder, or the supervisor of your project, to file a task."
                : canFileTask
                  ? "Switch filters or create a new task."
                  : "Switch filters to see other work."
            }
            action={
              canFileTask ? (
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Create task
                </button>
              ) : undefined
            }
          />
        </div>
      ) : view === "board" ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingTask(null)}
        >
          <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0">
            {COLUMNS.map((col) => (
              <div key={col.status} className="w-[85vw] shrink-0 snap-center md:w-auto md:shrink">
                <DroppableColumn
                  column={col}
                  tasks={grouped[col.status]}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                  onOpenComments={setCommentingTask}
                  onOpenDetail={setDetailTask}
                  canDeleteTask={mayDelete}
                  canEditTask={mayEdit}
                  isDragActive={draggingTask !== null}
                  highlightId={highlightId}
                  registerRef={registerRef}
                />
              </div>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTask && (
              <TaskCardView
                task={draggingTask}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                canDelete={false}
                // Only a card this viewer may move can be dragging at all, so the
                // clone keeps the live look rather than painting itself disabled.
                canEdit
                isOverlay
              />
            )}
          </DragOverlay>
        </DndContext>
      ) : view === "calendar" ? (
        <TaskCalendar
          tasks={filtered}
          now={renderedAt}
          onOpenDetail={setDetailTask}
          highlightId={highlightId}
          registerRef={registerRef}
        />
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th scope="col" className="w-12 px-4 py-3.5">
                    <label className="sr-only" htmlFor="select-all-tasks">
                      Select all tasks
                    </label>
                    <input
                      id="select-all-tasks"
                      type="checkbox"
                      checked={filtered.length > 0 && selected.size === filtered.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate = selected.size > 0 && selected.size < filtered.length;
                      }}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Task
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Priority
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Assigned
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Deadline
                  </th>
                  <th scope="col" className="px-6 py-3.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((task) => {
                  const overdue = isDeadlineOverdue(task.deadline) && task.status !== "completed";
                  const isHighlighted = highlightId === task.id;
                  const isSelected = selected.has(task.id);
                  return (
                    <tr
                      key={task.id}
                      ref={registerRef(task.id)}
                      onClick={() => setDetailTask(task)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetailTask(task);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open task ${task.title}`}
                      className={cn(
                        "cursor-pointer border-b border-border/60 transition-all last:border-b-0 hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        isHighlighted && "bg-primary/[0.08] shadow-inner",
                        isSelected && "bg-primary/[0.06]"
                      )}
                    >
                      <td className="px-4 py-4">
                        <label className="sr-only" htmlFor={`select-${task.id}`}>
                          Select {task.title}
                        </label>
                        <input
                          id={`select-${task.id}`}
                          type="checkbox"
                          checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelected(task.id)}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-sm font-medium text-fg">{task.title}</p>
                        {task.description && (
                          <p className="mt-0.5 max-w-xs truncate text-xs text-fg-muted">
                            {task.description}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <label htmlFor={`status-${task.id}`} className="sr-only">
                          Change status of {task.title}
                        </label>
                        <select
                          id={`status-${task.id}`}
                          value={task.status}
                          disabled={!mayEdit(task)}
                          title={
                            mayEdit(task)
                              ? undefined
                              : "Only the assignee, the person who filed it, or an admin can move this task"
                          }
                          onChange={(e) =>
                            handleStatusChange(task.id, e.target.value as TaskStatus)
                          }
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            "rounded-full border border-border bg-bg px-3 py-1 text-xs font-medium text-fg focus:border-primary/50 focus:outline-none",
                            mayEdit(task) || "cursor-not-allowed opacity-60"
                          )}
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                        </select>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            PRIORITY_STYLES[task.priority]
                          )}
                        >
                          {(() => {
                            const Icon = PRIORITY_ICONS[task.priority];
                            return <Icon className="h-3 w-3" aria-hidden="true" />;
                          })()}
                          {task.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Avatar name={task.assignedToName} size="xs" />
                          <span className="text-sm text-fg">{task.assignedToName}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "font-mono text-xs uppercase tracking-wider",
                            overdue ? "font-bold text-danger" : "text-fg-muted"
                          )}
                        >
                          {overdue && (
                            <>
                              <AlertCircle className="me-1 inline h-3 w-3" aria-hidden="true" />
                              {/* The overdue state was colour + an aria-hidden
                                  icon only, so it did not exist for a screen
                                  reader. */}
                              <span className="sr-only">Overdue — </span>
                            </>
                          )}
                          {formatDeadlineDay(task.deadline, "MMM dd, yyyy")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-end">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setCommentingTask(task);
                            }}
                            aria-label={
                              task.commentCount > 0
                                ? `Open comments (${n.number(task.commentCount)}) for ${task.title}`
                                : `Add a comment to ${task.title}`
                            }
                            className={cn(
                              "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                              task.commentCount > 0
                                ? "text-forest-strong hover:bg-forest/10"
                                : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
                            )}
                          >
                            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                            {task.commentCount > 0 && (
                              <span className="font-mono font-bold">
                                {n.number(task.commentCount)}
                              </span>
                            )}
                          </button>
                          {mayDelete(task) && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(task.id);
                              }}
                              aria-label={`Delete task ${task.title}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Bulk-action bar — floats when the list view has a selection. Fixed
          so it stays reachable while scrolling a long list. */}
      {view === "list" && selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-sticky flex justify-center px-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface/95 p-2 ps-4 shadow-card-hover backdrop-blur-xl">
            <span className="text-sm font-semibold text-fg">{selected.size} selected</span>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <label className="sr-only" htmlFor="bulk-status">
              Set status for selected tasks
            </label>
            <select
              id="bulk-status"
              defaultValue=""
              disabled={bulkPending}
              onChange={(e) => {
                const v = e.target.value as TaskStatus | "";
                if (v) handleBulkStatus(v);
                e.currentTarget.value = "";
              }}
              className="cursor-pointer rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg focus:border-primary/50 focus:outline-none disabled:opacity-50"
            >
              <option value="" disabled>
                Move to…
              </option>
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
            </select>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkPending}
              className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-bold text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkPending}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New task"
        description="Assign work to your team"
        size="lg"
      >
        <TaskForm
          users={users}
          // The filable subset, not `projects` (tasks-and-comments-008): the
          // picker must not offer a project the action will refuse.
          projects={filableProjects}
          currentUserId={currentUserId}
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>

      {commentingTask && (
        <CommentThreadModal
          open={Boolean(commentingTask)}
          onClose={() => setCommentingTask(null)}
          target={{ taskId: commentingTask.id }}
          title={`Comments · ${commentingTask.title}`}
          description={`@-mention a teammate to notify them`}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          onChanged={() => {
            // Optimistic bump on the card so the badge count updates in the
            // same frame the modal fires onChanged, not after router.refresh()
            // arrives with the canonical count. The RSC refresh corrects the
            // number if we drifted (e.g. a delete happened concurrently).
            setTasks((prev) =>
              prev.map((t) =>
                t.id === commentingTask.id ? { ...t, commentCount: t.commentCount + 1 } : t
              )
            );
            refresh();
          }}
        />
      )}

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          open={Boolean(detailTask)}
          onClose={() => setDetailTask(null)}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          canDelete={mayDelete(detailTask)}
          canEdit={mayEdit(detailTask)}
          onStatusChange={handleStatusChange}
          onDelete={handleDelete}
          onCommentsChanged={() => {
            const targetId = detailTask.id;
            setTasks((prev) =>
              prev.map((t) => (t.id === targetId ? { ...t, commentCount: t.commentCount + 1 } : t))
            );
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* SegmentedToggle                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

interface ToggleOption {
  key: string;
  label: string;
  count?: number;
  icon?: LucideIcon;
}

/**
 * One view tab. Reads as navigation: bigger hit area than a filter pill, an
 * emerald rule under the active one, and the label always visible — no icon-
 * only collapse, which is what made Calendar invisible at a glance.
 */
function ViewTab({
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-2 px-4 py-3 text-sm font-semibold transition-colors",
        active ? "text-fg" : "text-fg-muted hover:text-fg"
      )}
    >
      <Icon
        className={cn("h-4 w-4", active ? "text-primary-strong" : "text-fg-muted")}
        aria-hidden="true"
      />
      {label}
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
        />
      )}
    </button>
  );
}

function SegmentedToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (key: string) => void;
  options: ToggleOption[];
}) {
  const n = useNumberFormat();
  return (
    <div className="inline-flex w-fit gap-1 rounded-full border border-border bg-bg p-1">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {opt.label}
            {opt.count !== undefined && (
              <span className="font-mono text-[10px] text-fg-muted">{n.number(opt.count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* FilterSelect — labelled dropdown for the secondary task filters (T4)       */
/* ─────────────────────────────────────────────────────────────────────────── */

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== "all";
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border py-1 pe-1.5 ps-3 text-xs transition-colors",
        active ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-bg"
      )}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[9rem] cursor-pointer truncate rounded-full bg-transparent py-0.5 pe-1 text-xs font-semibold text-fg focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* DroppableColumn                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function DroppableColumn({
  column,
  tasks,
  onStatusChange,
  onDelete,
  onOpenComments,
  onOpenDetail,
  canDeleteTask,
  canEditTask: canEditTaskFn,
  isDragActive,
  highlightId,
  registerRef,
}: {
  column: Column;
  tasks: TaskWithCount[];
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onOpenComments: (task: TaskWithCount) => void;
  onOpenDetail: (task: TaskWithCount) => void;
  canDeleteTask: (task: TaskWithCount) => boolean;
  /** Whether this viewer may change the task's status or board order. */
  canEditTask: (task: TaskWithCount) => boolean;
  isDragActive: boolean;
  highlightId: string | null;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
}) {
  const n = useNumberFormat();
  const { setNodeRef, isOver } = useDroppable({ id: column.status });

  const toneText =
    column.tone === "forest"
      ? "text-forest-strong"
      : column.tone === "mint"
        ? "text-mint-strong"
        : "text-primary-strong";
  const toneFill =
    column.tone === "forest"
      ? "bg-forest/10"
      : column.tone === "mint"
        ? "bg-mint/10"
        : "bg-primary/10";

  return (
    <section
      ref={setNodeRef}
      aria-label={column.title}
      className={cn(
        "space-y-3 rounded-2xl border bg-surface p-4 transition-colors",
        isOver ? "border-primary/60 bg-primary/[0.04]" : "border-border",
        isDragActive && !isOver && "border-dashed"
      )}
    >
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", toneFill)}>
            <column.icon className={cn("h-3.5 w-3.5", toneText)} aria-hidden="true" />
          </div>
          <h3 className="text-sm font-semibold">{column.title}</h3>
        </div>
        <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
          {n.number(tasks.length)}
        </span>
      </div>
      <div className="min-h-[180px] space-y-2.5">
        {tasks.length === 0 ? (
          <div
            className={cn(
              "rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              isOver ? "border-primary/60 bg-primary/[0.04]" : "border-border"
            )}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
              {isOver ? "Drop to move" : "Nothing here"}
            </p>
          </div>
        ) : (
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onStatusChange={onStatusChange}
                onDelete={onDelete}
                onOpenComments={onOpenComments}
                onOpenDetail={onOpenDetail}
                canDelete={canDeleteTask(task)}
                canEdit={canEditTaskFn(task)}
                highlighted={highlightId === task.id}
                externalRef={registerRef(task.id)}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* TaskCard                                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

// Thin sortable wrapper: owns the useSortable hook + drag handle, and hands
// a presentational <TaskCardView> the ref/style/handle. Only the live column
// cards use this — the DragOverlay renders TaskCardView directly so it never
// registers a second sortable node for the same id.
function TaskCard({
  task,
  onStatusChange,
  onDelete,
  onOpenComments,
  onOpenDetail,
  canDelete,
  canEdit,
  highlighted = false,
  externalRef,
}: {
  task: TaskWithCount;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onOpenComments?: (task: TaskWithCount) => void;
  onOpenDetail?: (task: TaskWithCount) => void;
  canDelete: boolean;
  canEdit: boolean;
  highlighted?: boolean;
  externalRef?: (el: HTMLElement | null) => void;
}) {
  // `draggable` only (tasks-and-comments-009). A blanket `disabled: true` would
  // also take the card OUT of the droppable set, so a teammate's card would stop
  // being a valid drop position and reordering the cards around it would break.
  // What the viewer may not do is pick this one up.
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({
    id: task.id,
    disabled: { draggable: !canEdit, droppable: false },
  });

  const dragHandle = (
    <button
      type="button"
      aria-label={`Drag ${task.title} to reorder or change status`}
      {...attributes}
      {...listeners}
      // Bare click on the handle (no 8px movement so DnD Kit never activates)
      // would otherwise bubble to the card wrapper and open the detail modal.
      onClick={(e) => e.stopPropagation()}
      className="cursor-grab touch-none rounded-md p-0.5 text-fg-muted/70 transition-colors hover:bg-glass/[0.06] hover:text-fg active:cursor-grabbing"
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  return (
    <TaskCardView
      task={task}
      onStatusChange={onStatusChange}
      onDelete={onDelete}
      onOpenComments={onOpenComments}
      onOpenDetail={onOpenDetail}
      canDelete={canDelete}
      canEdit={canEdit}
      highlighted={highlighted}
      rootRef={(el) => {
        setNodeRef(el);
        externalRef?.(el);
      }}
      rootStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragging={isDragging}
      // No handle at all rather than a disabled one: a grip that cannot grip is
      // a second thing to explain, and the keyboard sensor is bound to these
      // listeners, so withholding them is what actually stops the drag.
      dragHandle={canEdit ? dragHandle : undefined}
      isOverlay={false}
    />
  );
}

// Presentational card. NO dnd hooks — safe to render inside the DragOverlay
// (which would otherwise duplicate the sortable id of the live card).
function TaskCardView({
  task,
  onStatusChange,
  onDelete,
  onOpenComments,
  onOpenDetail,
  canDelete,
  canEdit,
  highlighted = false,
  rootRef,
  rootStyle,
  dragging = false,
  dragHandle,
  isOverlay = false,
}: {
  task: TaskWithCount;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onOpenComments?: (task: TaskWithCount) => void;
  onOpenDetail?: (task: TaskWithCount) => void;
  canDelete: boolean;
  /** False disables the status select — the server would refuse the write. */
  canEdit: boolean;
  highlighted?: boolean;
  rootRef?: (el: HTMLElement | null) => void;
  rootStyle?: React.CSSProperties;
  dragging?: boolean;
  dragHandle?: React.ReactNode;
  isOverlay?: boolean;
}) {
  const n = useNumberFormat();
  // The DAY the assigner picked, read from UTC parts (tasks-and-comments-011).
  // `format(new Date(task.deadline), "MMM dd")` rendered the stored instant in
  // the viewer's zone, so at UTC-5 the card said one day and the assignment
  // email said another; `isPast` on the same instant also flagged a task due
  // today as overdue, in PKT as well.
  const overdue = isDeadlineOverdue(task.deadline) && task.status !== "completed";
  const dueToday = isDeadlineToday(task.deadline);

  const style: React.CSSProperties = isOverlay
    ? { boxShadow: "0 20px 50px rgb(0 0 0 / 0.30)", transform: "rotate(-1.5deg)" }
    : (rootStyle ?? {});

  // Card body is a genuine click target for the detail modal — but only when
  // we're not the DragOverlay clone and a real onOpenDetail handler is wired.
  const clickable = !isOverlay && !!onOpenDetail;
  function openDetail() {
    if (clickable) onOpenDetail!(task);
  }

  return (
    <div
      ref={rootRef}
      style={style}
      onClick={openDetail}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetail();
        }
      }}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Open task ${task.title}` : undefined}
      className={cn(
        "group rounded-xl border border-border bg-bg p-4 transition-all hover:border-primary/30",
        clickable &&
          "cursor-pointer focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        dragging && !isOverlay && "opacity-30",
        isOverlay && "cursor-grabbing border-primary/40 bg-surface",
        highlighted &&
          "border-primary/60 shadow-[0_0_30px_rgb(var(--primary)_/_0.35)] ring-2 ring-primary/50"
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {!isOverlay && dragHandle}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              PRIORITY_STYLES[task.priority]
            )}
          >
            {(() => {
              const Icon = PRIORITY_ICONS[task.priority];
              return <Icon className="h-3 w-3" aria-hidden="true" />;
            })()}
            {task.priority}
          </span>
        </div>
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            aria-label={`Delete task ${task.title}`}
            className="rounded-md p-1.5 text-fg-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <h4 className="mb-1 text-sm font-semibold leading-snug text-fg">{task.title}</h4>
      {task.description && (
        <p className="mb-3 line-clamp-2 text-xs text-fg-muted">{task.description}</p>
      )}

      <div className="mb-3 flex items-center gap-1.5 text-xs">
        <Calendar
          className={cn("h-3 w-3", overdue ? "text-danger" : "text-fg-muted")}
          aria-hidden="true"
        />
        <span
          className={cn(
            "font-mono uppercase tracking-wider",
            overdue
              ? "font-bold text-danger"
              : dueToday
                ? "font-bold text-warning"
                : "text-fg-muted"
          )}
        >
          {overdue && (
            <>
              <AlertCircle className="me-0.5 inline h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Overdue — </span>
            </>
          )}
          {dueToday && !overdue && <span className="sr-only">Due today — </span>}
          {formatDeadlineDay(task.deadline, "MMM dd")}
        </span>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <Avatar name={task.assignedToName} size="xs" />
          <span className="text-xs text-fg-muted">{task.assignedToName.split(" ")[0]}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenComments && !isOverlay && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenComments(task);
              }}
              aria-label={
                task.commentCount > 0
                  ? `Open comments (${n.number(task.commentCount)}) for ${task.title}`
                  : `Add a comment to ${task.title}`
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-bold transition-colors",
                task.commentCount > 0
                  ? "border-forest/30 bg-forest/10 text-forest-strong hover:bg-forest/15"
                  : "border-border text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
              )}
            >
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {task.commentCount > 0 && (
                <span className="font-mono">{n.number(task.commentCount)}</span>
              )}
            </button>
          )}
          <label htmlFor={`board-status-${task.id}`} className="sr-only">
            Status of {task.title}
          </label>
          <select
            id={`board-status-${task.id}`}
            value={task.status}
            disabled={!canEdit}
            title={
              canEdit
                ? undefined
                : "Only the assignee, the person who filed it, or an admin can move this task"
            }
            onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "rounded-md border border-border bg-bg px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg focus:border-primary/50 focus:outline-none",
              canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-60"
            )}
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>
    </div>
  );
}
