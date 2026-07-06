"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Pause, Play, Plus, Target, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import { NewBudgetSchema, type NewBudgetInput } from "@/lib/schemas/budget";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatCurrency } from "@/lib/utils";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import type { BudgetWithSpend } from "@/lib/queries/budgets";

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
      title: `Delete the ${b.category} budget?`,
      description: "Spending continues, you just won't get alerts anymore.",
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

  // Categories that already have an active budget — disabled in the dropdown
  // so users don't try to create a duplicate (server also rejects this).
  const takenCategories = new Set(budgets.filter((b) => b.active).map((b) => b.category));

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
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
          takenCategories={takenCategories}
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
  const pct = budget.percentUsed;
  const pctLabel = Math.round(pct * 100);
  const barWidth = Math.min(100, Math.max(2, pct * 100));
  const isOver = pct >= 1;
  const isWarning = pct >= 0.8 && pct < 1;

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
        </div>
        <p className={cn("shrink-0 font-mono text-2xl font-bold tabular-nums", tone.text)}>
          {pctLabel}%
        </p>
      </div>

      <div className="space-y-2">
        <div
          role="progressbar"
          aria-label={`${budget.category} budget: ${pctLabel}% of ${formatCurrency(budget.monthlyLimit)} used`}
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
          <span className="text-fg-muted">Spent {formatCurrency(budget.monthToDateSpend)}</span>
          <span className="font-bold text-fg">of {formatCurrency(budget.monthlyLimit)}</span>
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
            aria-label={budget.active ? "Pause budget" : "Resume budget"}
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
            aria-label={`Delete ${budget.category} budget`}
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

function NewBudgetForm({
  takenCategories,
  projects,
  onClose,
  onCreated,
}: {
  takenCategories: Set<string>;
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const categoryId = useId();
  const limitId = useId();
  const projectFieldId = useId();

  // Pick the first NOT-already-budgeted category as the default so the form
  // opens in a valid state most of the time.
  const defaultCategory =
    EXPENSE_CATEGORIES.find((c) => !takenCategories.has(c)) ?? EXPENSE_CATEGORIES[0];

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewBudgetInput>({
    resolver: zodResolver(NewBudgetSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      category: defaultCategory,
      monthlyLimit: undefined as unknown as number,
      projectId: projects[0]?.id ?? "",
    },
  });

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
          {...register("projectId")}
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
        <select id={categoryId} {...register("category")} className={inputClass(!!errors.category)}>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c} disabled={takenCategories.has(c)} className="bg-bg">
              {c}
              {takenCategories.has(c) ? " (already set)" : ""}
            </option>
          ))}
        </select>
        {errors.category && <p className="mt-1.5 text-xs text-danger">{errors.category.message}</p>}
      </div>

      <div>
        <label
          htmlFor={limitId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Monthly cap (PKR)
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
          disabled={isSubmitting}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {isSubmitting ? "Saving…" : "Create budget"}
        </button>
      </div>
    </form>
  );
}
