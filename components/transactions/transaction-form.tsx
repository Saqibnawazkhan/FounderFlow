"use client";

import { useId } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { addTransactionAction, updateTransactionAction } from "@/lib/actions/transactions";
import { NewTransactionSchema, type NewTransactionInput } from "@/lib/schemas/transaction";
import {
  EXPENSE_CATEGORIES,
  INVESTMENT_CATEGORIES,
  REVENUE_CATEGORIES,
  type Transaction,
  type TransactionType,
} from "@/lib/types";
import { useCurrency } from "@/lib/hooks/useMoney";
import { cn } from "@/lib/utils";

interface Props {
  type: TransactionType;
  /** Optional project picker. Empty list → no picker rendered (members
   *  who aren't on any project just don't see the field). The
   *  transaction's projectId column is nullable, so this stays optional.
   *  Never rendered in edit mode — see `editing`. */
  projects?: { id: string; name: string }[];
  /**
   * Present → the form CORRECTS this row instead of creating one (money-016).
   *
   * The project picker is deliberately hidden in this mode. `Transaction` as it
   * crosses the RSC boundary carries no `projectId`, so the field could only
   * render "Not tagged to a project" over a row that IS tagged, and saving would
   * untag spend from a project's budget — a silent money bug dressed as a form
   * default. The edit action ignores the field for the same reason.
   */
  editing?: Transaction;
  onClose: () => void;
  /** Called after the server action succeeds so the parent can re-fetch. */
  onSuccess?: () => void;
}

export function TransactionForm({ type, projects = [], editing, onClose, onSuccess }: Props) {
  const typeCategories =
    type === "expense"
      ? EXPENSE_CATEGORIES
      : type === "income"
        ? REVENUE_CATEGORIES
        : INVESTMENT_CATEGORIES;
  // A row whose stored category is no longer on the list (one retired from
  // lib/types.ts after it was booked) still has to be openable, and the select
  // has to show the value it is actually holding rather than silently appear to
  // be the first option.
  const categories =
    editing && typeCategories.indexOf(editing.category) === -1
      ? [editing.category].concat(typeCategories)
      : typeCategories;
  const noun = type === "expense" ? "Expense" : type === "income" ? "Revenue" : "Investment";

  // money-011. The amount label and the in-input affix name the workspace's own
  // currency, never a literal. Nothing in this form converts — the number typed
  // is the number stored — so a label reading "(PKR)" on a USD workspace invited
  // a founder to convert in their head and book an amount wrong by the exchange
  // rate, on the same screen where every figure already renders through
  // `useMoney()`. Same source as those figures (no `company` row reaches this
  // component), so the question and the answer cannot disagree.
  //
  // The ISO CODE, not a symbol: all six SUPPORTED_CURRENCIES are three letters,
  // which keeps the input's `ps-14` affix gutter correct for every workspace, and
  // "$" alone would not say which dollar.
  const currency = useCurrency();

  const amountId = useId();
  const projectId = useId();
  const categoryId = useId();
  const dateId = useId();
  const descId = useId();

  const today = new Date().toISOString().slice(0, 10);

  // `NewTransactionSchema` is the resolver in BOTH modes: the four correctable
  // fields carry identical client-side rules either way (money-002's scale rule
  // most of all), and sharing it is what stops the correction path becoming the
  // looser one. `EditTransactionSchema` is the server's narrower view of the same
  // submission; it drops `type`/`projectId` rather than validating them
  // differently.
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewTransactionInput>({
    resolver: zodResolver(NewTransactionSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      type,
      // amount starts undefined so the input renders empty; valueAsNumber on
      // register converts the text to number before zod validates.
      amount: editing ? editing.amount : (undefined as unknown as number),
      category: editing ? editing.category : categories[0],
      description: editing ? editing.description : "",
      // Empty string round-trips to undefined in the schema's transform,
      // which becomes a SQL NULL — "no project tag" is the default.
      projectId: "",
      // The UTC day, not the local one: `Transaction.date` is a date-only value
      // stored at UTC midnight (money-007), so slicing the ISO string is what
      // puts the same day in the input that the ledger row renders.
      date: editing ? editing.date.slice(0, 10) : today,
    },
  });

  async function onSubmit(data: NewTransactionInput) {
    const result = editing
      ? await updateTransactionAction({
          id: editing.id,
          amount: data.amount,
          category: data.category,
          description: data.description.trim(),
          date: new Date(data.date).toISOString(),
        })
      : await addTransactionAction({
          ...data,
          description: data.description.trim(),
          // Server reparses; sending a yyyy-mm-dd is fine but normalize to ISO.
          date: new Date(data.date).toISOString(),
        });
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(editing ? `${noun} updated` : `${noun} added`);
    onSuccess?.();
    onClose();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <input type="hidden" {...register("type")} />

      <div>
        <label
          htmlFor={amountId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Amount ({currency})
        </label>
        <div className="relative">
          <span className="absolute start-4 top-1/2 -translate-y-1/2 text-sm font-medium text-fg-muted">
            {currency}
          </span>
          <input
            id={amountId}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? `${amountId}-err` : undefined}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            {...register("amount", { valueAsNumber: true })}
            className={cn(
              "w-full rounded-xl border bg-bg py-3 pe-4 ps-14 text-lg font-semibold text-fg transition-colors placeholder:text-fg-muted/60 focus:bg-surface focus:outline-none",
              errors.amount
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          />
        </div>
        {errors.amount && (
          <p id={`${amountId}-err`} className="mt-1.5 text-xs text-danger">
            {errors.amount.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={categoryId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Category
          </label>
          <select
            id={categoryId}
            aria-invalid={errors.category ? true : undefined}
            {...register("category")}
            className={cn(
              "w-full appearance-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:bg-surface focus:outline-none",
              errors.category
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          >
            {categories.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
          {errors.category && (
            <p className="mt-1.5 text-xs text-danger">{errors.category.message}</p>
          )}
        </div>
        <div>
          <label
            htmlFor={dateId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Date
          </label>
          <input
            id={dateId}
            type="date"
            max={today}
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={errors.date ? `${dateId}-err` : undefined}
            {...register("date")}
            className={cn(
              "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:bg-surface focus:outline-none",
              errors.date
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          />
          {errors.date && (
            <p id={`${dateId}-err`} className="mt-1.5 text-xs text-danger">
              {errors.date.message}
            </p>
          )}
        </div>
      </div>

      {projects.length > 0 && !editing && (
        <div>
          <label
            htmlFor={projectId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Project{" "}
            <span className="font-sans normal-case tracking-normal text-fg-muted/60">
              (optional)
            </span>
          </label>
          <select
            id={projectId}
            aria-invalid={errors.projectId ? true : undefined}
            {...register("projectId")}
            className={cn(
              "w-full appearance-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:bg-surface focus:outline-none",
              errors.projectId
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          >
            <option value="" className="bg-bg">
              Not tagged to a project
            </option>
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
      )}

      <div>
        <label
          htmlFor={descId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Description
        </label>
        <textarea
          id={descId}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? `${descId}-err` : undefined}
          {...register("description")}
          className={cn(
            "min-h-[80px] w-full resize-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:bg-surface focus:outline-none",
            errors.description
              ? "border-danger/60 focus:border-danger"
              : "border-border focus:border-primary/50"
          )}
          placeholder={
            type === "expense"
              ? "What is this expense for?"
              : type === "income"
                ? "What was sold, and to whom?"
                : "What's the source or purpose of this investment?"
          }
        />
        {errors.description && (
          <p id={`${descId}-err`} className="mt-1.5 text-xs text-danger">
            {errors.description.message}
          </p>
        )}
      </div>

      <div className="flex gap-3 pt-2">
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
          {editing
            ? isSubmitting
              ? "Saving…"
              : "Save changes"
            : isSubmitting
              ? "Adding…"
              : `Add ${noun.toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}
