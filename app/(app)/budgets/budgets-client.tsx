"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Pause, Play, Plus, Target, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import { NewBudgetSchema, type NewBudgetInput } from "@/lib/schemas/budget";
import { budgetPercentLabel } from "@/lib/budgets/threshold";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import { useCurrency, useMoney } from "@/lib/hooks/useMoney";
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
    </div>
  );
}

function BudgetCard({
  budget,
  pending,
  onToggle,
  onDelete,
}: {
  budget: BudgetWithSpend;
  pending: boolean;
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
          <button
            onClick={onToggle}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
            // Both buttons name the (project, category) pair for the same reason
            // the heading does: with two Salaries caps on screen, "Pause budget"
            // twice tells a screen-reader user nothing about which one is which.
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* NewBudgetForm                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

/** One active cap, as much of it as the category picker needs. */
type ActiveCap = { projectId: string; category: string };

/** The categories already capped inside ONE project — never the whole company. */
function takenIn(caps: ActiveCap[], projectId: string): Set<string> {
  return new Set(caps.filter((c) => c.projectId === projectId).map((c) => c.category));
}

/**
 * The first category still free inside ONE project, or `null` when that project
 * has capped every one of them.
 *
 * It used to fall back to `EXPENSE_CATEGORIES[0]`, which in exactly that case is
 * a category the project has already capped — so the form parked on a disabled
 * option and offered a submit `createBudgetAction` is guaranteed to refuse
 * ("already exists in this project"). Returning null forces the caller to say so
 * instead of pretending there is a choice left.
 */
function firstFreeCategory(taken: Set<string>): string | null {
  return EXPENSE_CATEGORIES.find((c) => !taken.has(c)) ?? null;
}

function NewBudgetForm({
  activeCaps,
  projects,
  onClose,
  onCreated,
}: {
  activeCaps: ActiveCap[];
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const categoryId = useId();
  const limitId = useId();
  const projectFieldId = useId();

  // money-011 — the cap is entered in the workspace's currency, so the label has
  // to name it rather than a hardcoded "PKR". Same source as the `useMoney()` the
  // cards above use to render the caps back, so the ask and the answer agree.
  const currency = useCurrency();

  const defaultProjectId = projects[0]?.id ?? "";
  // Pick the first category not already capped IN THE PROJECT THE FORM OPENS ON,
  // so the form opens in a valid state most of the time. Empty when that project
  // has capped all of them — `everyCategoryTaken` below explains that and blocks
  // the submit, rather than the field sitting on a disabled option.
  const defaultCategory = firstFreeCategory(takenIn(activeCaps, defaultProjectId)) ?? "";

  // Set only when the form MOVES the user off a category they picked, which can
  // happen on a project change. Silence there was the second half of
  // R3-money-018-cards: the choice was replaced without a word.
  const [categoryNote, setCategoryNote] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<NewBudgetInput>({
    resolver: zodResolver(NewBudgetSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      category: defaultCategory,
      monthlyLimit: undefined as unknown as number,
      projectId: defaultProjectId,
    },
  });

  // Which categories are unavailable depends on the project currently selected,
  // so it is recomputed whenever that field changes rather than frozen at mount.
  const selectedProjectId = watch("projectId");
  const takenCategories = useMemo(
    () => takenIn(activeCaps, selectedProjectId),
    [activeCaps, selectedProjectId]
  );
  // Nothing left to file in this project. Every option is disabled, so the form
  // has no valid submit to offer and says that plainly.
  const everyCategoryTaken = useMemo(
    () => EXPENSE_CATEGORIES.every((c) => takenCategories.has(c)),
    [takenCategories]
  );

  /** The picked project as the user sees it named, for the messages below. */
  function projectNameOf(projectId: string): string {
    return projects.find((p) => p.id === projectId)?.name ?? "that project";
  }

  const projectField = register("projectId");
  const categoryField = register("category");

  async function onSubmit(data: NewBudgetInput) {
    const res = await createBudgetAction(data);
    if (res.success) {
      toast.success(`Budget set for ${data.category}`);
      onCreated();
    } else {
      toast.error(res.error);
    }
  }

  function inputClass(hasError: boolean) {
    return cn(
      "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 transition-colors focus:bg-surface focus:outline-none",
      hasError ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <div>
        <label
          htmlFor={projectFieldId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Project
        </label>
        <select
          id={projectFieldId}
          {...projectField}
          onChange={(e) => {
            projectField.onChange(e);
            // The disabled set is per project, so the category already chosen may
            // be capped in the project just picked. Move off it instead of leaving
            // a disabled option selected and a submit the server will refuse —
            // but SAY SO, because the category was the user's choice and this is
            // taking it away from them.
            const projectId = e.target.value;
            const taken = takenIn(activeCaps, projectId);
            const chosen = getValues("category");
            if (!taken.has(chosen)) {
              setCategoryNote(null);
              return;
            }
            const free = firstFreeCategory(taken);
            setValue("category", free ?? "");
            // No free category left is the `everyCategoryTaken` message's job;
            // two notes saying overlapping things would be worse than one.
            setCategoryNote(
              free
                ? `${chosen} already has a cap in ${projectNameOf(projectId)}, so this switched to ${free}.`
                : null
            );
          }}
          className={inputClass(!!errors.projectId)}
        >
          {projects.length === 0 && <option value="">No projects available</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id} className="bg-bg">
              {p.name}
            </option>
          ))}
        </select>
        {errors.projectId && (
          <p className="mt-1.5 text-xs text-danger">{errors.projectId.message}</p>
        )}
      </div>

      <div>
        <label
          htmlFor={categoryId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Category
        </label>
        <select
          id={categoryId}
          {...categoryField}
          onChange={(e) => {
            categoryField.onChange(e);
            // The user has just made the choice themselves; a note about an
            // earlier automatic switch is stale from here on.
            setCategoryNote(null);
          }}
          className={inputClass(!!errors.category)}
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c} disabled={takenCategories.has(c)} className="bg-bg">
              {c}
              {takenCategories.has(c) ? " (already set in this project)" : ""}
            </option>
          ))}
        </select>
        {errors.category && <p className="mt-1.5 text-xs text-danger">{errors.category.message}</p>}
        {everyCategoryTaken ? (
          <p
            data-testid="no-category-left"
            role="status"
            className="mt-1.5 text-xs text-warning-strong"
          >
            Every expense category already has an active cap in {projectNameOf(selectedProjectId)}.
            Pause or delete one to add another.
          </p>
        ) : (
          categoryNote && (
            <p
              data-testid="category-switch-note"
              role="status"
              className="mt-1.5 text-xs text-fg-muted"
            >
              {categoryNote}
            </p>
          )
        )}
      </div>

      <div>
        <label
          htmlFor={limitId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Monthly cap ({currency})
        </label>
        <input
          id={limitId}
          type="number"
          inputMode="decimal"
          min="0"
          step="100"
          placeholder="50000"
          {...register("monthlyLimit", { valueAsNumber: true })}
          className={inputClass(!!errors.monthlyLimit)}
        />
        {errors.monthlyLimit && (
          <p className="mt-1.5 text-xs text-danger">{errors.monthlyLimit.message}</p>
        )}
      </div>

      <div className="flex gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-full border border-border bg-bg px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          type="submit"
          // Blocked while the chosen project has no free category: the only
          // submit available there is one the server answers with "already
          // exists in this project".
          disabled={isSubmitting || everyCategoryTaken}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {isSubmitting ? "Saving…" : "Create budget"}
        </button>
      </div>
    </form>
  );
}
