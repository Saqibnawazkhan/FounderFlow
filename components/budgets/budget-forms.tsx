"use client";

/**
 * The two budget forms, shared by the company-wide /budgets page and by one
 * project's own Budgets section (finance-planning-010).
 *
 * WHY THEY LIVE HERE. Both were local to app/(app)/budgets/budgets-client.tsx,
 * which is the one page a MEMBER cannot open: /budgets is in
 * MEMBER_BLOCKED_ROUTES. All three budget endpoints gate on `canManageProject`
 * (lib/actions/budgets.ts), which a member who supervises the project passes,
 * so the forms had to become reachable from /projects/[id] too — and copying
 * them was not an option. A monthly cap has ONE rule, spelled once in
 * lib/schemas/budget.ts and resolved by both forms below; a second copy of
 * either form is the obvious place for the create path and the correction path
 * to drift, which is the defect money-002 and finance-planning-006 each closed
 * once already.
 *
 * This file is a MOVE, not a rewrite: the bodies and the comments arguing them
 * are the ones /budgets shipped. The one addition is `forcedProjectId`, which
 * locks the project picker exactly as `TaskForm` already does for the New-task
 * modal on that same project page.
 */

import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { createBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import {
  EditBudgetLimitSchema,
  NewBudgetSchema,
  type EditBudgetLimitInput,
  type NewBudgetInput,
} from "@/lib/schemas/budget";
import { cn } from "@/lib/utils";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import { useCurrency, useMoney } from "@/lib/hooks/useMoney";

/* ─────────────────────────────────────────────────────────────────────────── */
/* NewBudgetForm                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

/** Field chrome, shared by both forms in this file. */
function inputClass(hasError: boolean) {
  return cn(
    "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 transition-colors focus:bg-surface focus:outline-none",
    hasError ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
  );
}

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

export function NewBudgetForm({
  activeCaps,
  projects,
  forcedProjectId,
  onClose,
  onCreated,
}: {
  activeCaps: ActiveCap[];
  projects: { id: string; name: string }[];
  /**
   * Pre-select a project and LOCK the field, for the form rendered inside one
   * project's page — the same prop, with the same job, as `TaskForm`'s
   * (components/tasks/task-form.tsx). A cap filed from a project's own Budgets
   * section belongs to that project; `createBudgetAction` would accept any
   * project the caller supervises, so the lock is about not offering a choice
   * the user did not come here to make, not about authorisation.
   */
  forcedProjectId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const categoryId = useId();
  const limitId = useId();
  const projectFieldId = useId();

  // money-011 — the cap is entered in the workspace's currency, so the label has
  // to name it rather than a hardcoded "PKR". Same source as the `useMoney()`
  // the /budgets cards and the project page's bars read the caps back through,
  // so the ask and the answer agree.
  const currency = useCurrency();

  const defaultProjectId = forcedProjectId || projects[0]?.id || "";
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
          // Locked, not hidden: the field still says which project the cap
          // lands in, which is the one thing this form cannot be wrong about.
          disabled={Boolean(forcedProjectId)}
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* EditBudgetLimitForm                                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Change one budget's monthly cap in place (finance-planning-006).
 *
 * THE CAP ONLY. The category and the project are the budget's identity — the
 * duplicate guard in `createBudgetAction` is keyed on exactly that pair — so
 * moving a cap to another category or project is a different operation from
 * correcting its number, and it is not the one delete-and-recreate was standing
 * in for.
 *
 * The alert sentinels are deliberately NOT touched here. `decideRearm`
 * (lib/budgets/threshold.ts, finance-planning-005) clears `lastWarnedMonth` /
 * `lastAlertedMonth` from the PERCENTAGE rather than from an event, so a cap
 * raised after a 100% alert re-arms on the next expense with no hook on this
 * path — and a cap lowered past the month's spend alerts on that same next
 * expense rather than silently.
 */
export function EditBudgetLimitForm({
  budget,
  onClose,
  onSaved,
}: {
  budget: BudgetWithSpend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const limitId = useId();
  const money = useMoney();
  // money-011 — the cap is entered in the workspace's currency, same as on the
  // create form and the same source the card renders it back through.
  const currency = useCurrency();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditBudgetLimitInput>({
    // `EditBudgetLimitSchema` is `NewBudgetSchema`'s own `monthlyLimit` field, so
    // the scale rule the create form applies (money-002: reject 1234.567 rather
    // than let the Decimal(12, 2) column round it silently) cannot be looser on
    // the correction path. There is no mirror of that rule here to keep in step.
    resolver: zodResolver(EditBudgetLimitSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    // Seeded with the cap being changed: this is an edit, not a retype from
    // memory. Both callers mount the form WITH the row — `editing` in
    // BudgetsClient, `editingBudget` in ProjectDetailClient — so there is no
    // stale-default case to reset.
    defaultValues: { monthlyLimit: budget.monthlyLimit },
  });

  async function onSubmit(data: EditBudgetLimitInput) {
    const res = await updateBudgetAction({ budgetId: budget.id, monthlyLimit: data.monthlyLimit });
    if (res.success) {
      toast.success("Cap updated");
      onSaved();
    } else {
      // Stays open with the typed number still in the field. The refusals this
      // action can return are ones the user can act on — not the supervisor of
      // the project, or the budget deleted from under them — and closing would
      // take their number away along with the dialog.
      toast.error(res.error);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
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
          {...register("monthlyLimit", { valueAsNumber: true })}
          className={inputClass(!!errors.monthlyLimit)}
        />
        {errors.monthlyLimit && (
          <p className="mt-1.5 text-xs text-danger">{errors.monthlyLimit.message}</p>
        )}
        {/* The month's spend is what makes a too-low cap obvious before it is
            saved: a cap under this number is over budget the moment it lands. */}
        <p className="mt-1.5 text-xs text-fg-muted">
          Spent so far this month: {money(budget.monthToDateSpend)}. Current cap{" "}
          {money(budget.monthlyLimit)}.
        </p>
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
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {isSubmitting ? "Saving…" : "Save cap"}
        </button>
      </div>
    </form>
  );
}
