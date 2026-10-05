"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pause, Pencil, Play, Plus, Target, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { deleteBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import { budgetPercentLabel } from "@/lib/budgets/threshold";
import { EditBudgetLimitForm, NewBudgetForm } from "@/components/budgets/budget-forms";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

type Props = {
  budgets: BudgetWithSpend[];
  projects: { id: string; name: string }[];
};

export function BudgetsClient({ budgets, projects }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // The cap being edited, or null (finance-planning-006). Held as the ROW
  // rather than its id, and the dialog at the bottom of this component is
  // mounted only while it is set, so the form is born with the numbers of the
  // card that was clicked. A permanently-mounted dialog needs an explicit
  // reseed-on-open instead — see the argument in EditProjectModal
  // (projects-010), where react-hook-form state outlived every close and an
  // ordinary edit started re-submitting page-load values.
  const [editing, setEditing] = useState<BudgetWithSpend | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleToggle(b: BudgetWithSpend) {
    setPendingId(b.id);
    const res = await updateBudgetAction({ budgetId: b.id, active: !b.active });
    setPendingId(null);
    if (res.success) {
      toast.success(b.active ? "Budget paused" : "Budget resumed");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleDelete(b: BudgetWithSpend) {
    const ok = await confirm({
      // The project is part of the subject, not decoration: since money-018 a
      // workspace can hold a Salaries cap in Alpha AND one in Beta, and
      // "Delete the Salaries budget?" would not say which row is about to go.
      title: `Delete the ${b.category} budget in ${b.projectName}?`,
      description:
        "Spending continues, you just won't get alerts anymore. Caps on the same category in other projects aren't touched.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setPendingId(b.id);
    const res = await deleteBudgetAction(b.id);
    setPendingId(null);
    if (res.success) {
      toast.success("Budget deleted");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  // Every active cap as a (project, category) pair. The form narrows this to the
  // project it is targeting — it must NOT be flattened to a company-wide set of
  // categories here (money-018). `createBudgetAction` refuses a duplicate only
  // `{ projectId, category, active: true }` and says so in its error text
  // ("already exists in this project"), so one Salaries cap in Alpha used to
  // make Salaries unpickable for Beta forever — the UI forbidding what the
  // server permits, and per-project budgeting unusable past the first project.
  const activeCaps = useMemo(
    () =>
      budgets
        .filter((b) => b.active)
        .map((b) => ({ projectId: b.projectId, category: b.category })),
    [budgets]
  );

  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="primary">Budget caps</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Budgets
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Set a monthly cap per category. Everyone gets a heads-up at 80% and an alert if you blow
            past 100%.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New budget
        </button>
      </header>

      {budgets.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Target}
            title="No budgets yet"
            description="Pick a category like Marketing or Office Rent and set a monthly cap. You'll get pinged before you blow it."
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> Add first budget
              </button>
            }
          />
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {budgets.map((b) => (
            <BudgetCard
              key={b.id}
              budget={b}
              pending={pendingId === b.id}
              onEdit={() => setEditing(b)}
              onToggle={() => handleToggle(b)}
              onDelete={() => handleDelete(b)}
            />
          ))}
        </section>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New budget"
        description="Pick an expense category and the monthly cap. You can pause or remove it later."
      >
        <NewBudgetForm
          activeCaps={activeCaps}
          projects={projects}
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            refresh();
            setModalOpen(false);
          }}
        />
      </Modal>

      {/* Mounted only while a cap is being edited (see `editing` above), which is
          the shape tasks-client.tsx uses for TaskDetailModal. */}
      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Edit the ${editing.category} cap`}
          description={`Monthly cap for ${editing.category} in ${editing.projectName}. This moves the line spending is measured against; no expense already recorded is touched.`}
          size="sm"
        >
          <EditBudgetLimitForm
            budget={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              refresh();
              setEditing(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function BudgetCard({
  budget,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  budget: BudgetWithSpend;
  pending: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const money = useMoney();
  const n = useNumberFormat();
  const pct = budget.percentUsed;
  // The state reads the UNROUNDED ratio, against the same two thresholds the
  // server's notification uses (`WARN_PCT` / `ALERT_PCT`,
  // lib/budgets/threshold.ts). Deriving it from the rounded label instead would
  // badge a budget at 99.6% as "Over" while the alert — which fires on the true
  // ratio — is still only a warning: money-004's "the page screamed and the
  // notification stayed silent", the wrong way round.
  const isOver = pct >= 1;
  const isWarning = pct >= 0.8 && pct < 1;
  // ONE formatter, shared with the threshold notification that describes the
  // same crossing of the same line — `budgetPercentLabel` in
  // lib/budgets/threshold.ts, which is also where the rounding and the
  // band-clamping are argued (money-014). A second copy of that arithmetic in
  // lib/budgets/check.ts is exactly what made the bell say "at 100% of the cap"
  // about a budget this card called 99% (R5-money-014-bell), so the derivation
  // lives in one place and both surfaces call it.
  //
  // Stays a raw integer: `aria-valuenow` below is machine-read by assistive tech
  // and is specified as a plain number, so it must NOT be localised — grouping
  // separators or non-Latin digits would make it unparseable. The human-readable
  // label is formatted from this same integer, so the two never disagree about
  // which band the budget is in. They are not always the same NUMBER:
  // `aria-valuenow` is additionally clamped to `aria-valuemax` (100), because a
  // progressbar whose value sits outside its own declared range is invalid ARIA.
  // That clamp can only bite above the cap — where the badge already says
  // "Over" — so at 125% the bar reports 100 of 100 while the headline reads
  // "125%". The `aria-label` on the same element carries the exact figure, which
  // is what keeps the overrun audible.
  const pctLabel = budgetPercentLabel(pct);
  const pctText = n.percent(pctLabel / 100, { maximumFractionDigits: 0 });
  const barWidth = Math.min(100, Math.max(2, pct * 100));

  const tone = isOver
    ? {
        bar: "bg-danger",
        text: "text-danger-strong",
        bg: "bg-danger/10",
        border: "border-danger/30",
      }
    : isWarning
      ? {
          bar: "bg-warning",
          text: "text-warning-strong",
          bg: "bg-warning/10",
          border: "border-warning/30",
        }
      : {
          bar: "bg-primary",
          text: "text-primary-strong",
          bg: "bg-primary/10",
          border: "border-primary/30",
        };

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-surface p-6 transition-opacity",
        budget.active ? "border-border" : "border-border/40 opacity-70"
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider",
                tone.border,
                tone.bg,
                tone.text
              )}
            >
              {isOver ? (
                <>
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Over
                </>
              ) : isWarning ? (
                <>
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Warning
                </>
              ) : (
                <>
                  <Target className="h-3 w-3" aria-hidden="true" /> On track
                </>
              )}
            </span>
            {!budget.active && (
              <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg-muted">
                Paused
              </span>
            )}
          </div>
          <h3 className="truncate text-lg font-bold text-fg">{budget.category}</h3>
          {/* A cap is a (project, category) pair, so the card has to print both
              or two legitimate Salaries caps are one indistinguishable card
              twice over (R3-money-018-cards). The name comes down on the row
              rather than being joined against the project picker here — the
              picker omits completed and archived projects, whose caps this page
              still lists. */}
          <p className="mt-0.5 truncate font-mono text-[11px] uppercase tracking-wider text-fg-muted">
            {budget.projectName}
          </p>
        </div>
        <p className={cn("shrink-0 font-mono text-2xl font-bold tabular-nums", tone.text)}>
          {pctText}
        </p>
      </div>

      <div className="space-y-2">
        <div
          role="progressbar"
          aria-label={`${budget.category} budget in ${budget.projectName}: ${pctText} of ${money(budget.monthlyLimit)} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, pctLabel)}
          className="h-2.5 overflow-hidden rounded-full bg-glass/[0.06]"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700",
              tone.bar,
              // A11y row F9: over-budget bars carry a diagonal stripe pattern
              // on top of the danger color so a color-blind user can still
              // tell them apart from the on-track and warning states.
              isOver &&
                "bg-[repeating-linear-gradient(45deg,rgb(255_255_255_/_0.2)_0,rgb(255_255_255_/_0.2)_4px,transparent_4px,transparent_8px)]"
            )}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="flex items-center justify-between font-mono text-xs">
          <span className="text-fg-muted">Spent {money(budget.monthToDateSpend)}</span>
          <span className="font-bold text-fg">of {money(budget.monthlyLimit)}</span>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-border pt-4 text-xs">
        <div className="flex items-center gap-2 text-fg-muted">
          <Avatar name={budget.createdByName} size="xs" />
          <span>Set by {budget.createdByName.split(" ")[0]}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* The cap is the number most likely to change — a raise, a new
              quarter, a renegotiated rent. Before finance-planning-006 the only
              route to a different one was delete-and-recreate, which restarts
              the authorship line just above this row and re-fires the alert
              against the new cap, while `updateBudgetAction` had accepted
              `monthlyLimit` all along with nothing in the UI sending it. */}
          <button
            onClick={onEdit}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
            aria-label={`Edit ${budget.category} budget cap in ${budget.projectName}`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit cap
          </button>
          <button
            onClick={onToggle}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
            // All three controls in this row name the (project, category) pair for
            // the same reason the heading does: with two Salaries caps on screen,
            // "Pause budget" twice tells a screen-reader user nothing about which
            // one is which.
            aria-label={
              budget.active
                ? `Pause ${budget.category} budget in ${budget.projectName}`
                : `Resume ${budget.category} budget in ${budget.projectName}`
            }
          >
            {budget.active ? (
              <>
                <Pause className="h-3.5 w-3.5" aria-hidden="true" /> Pause
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" /> Resume
              </>
            )}
          </button>
          <button
            onClick={onDelete}
            disabled={pending}
            aria-label={`Delete ${budget.category} budget in ${budget.projectName}`}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
          </button>
        </div>
      </div>
    </article>
  );
}
