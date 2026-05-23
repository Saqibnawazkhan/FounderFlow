"use client";

import { useId, useState } from "react";
import toast from "react-hot-toast";
import { addTransactionAction } from "@/lib/actions/transactions";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, type TransactionType } from "@/lib/types";

interface Props {
  type: TransactionType;
  onClose: () => void;
  /** Called after the server action succeeds so the parent can re-fetch. */
  onSuccess?: () => void;
}

export function TransactionForm({ type, onClose, onSuccess }: Props) {
  const categories = type === "expense" ? EXPENSE_CATEGORIES : INVESTMENT_CATEGORIES;

  const amountId = useId();
  const categoryId = useId();
  const dateId = useId();
  const descId = useId();

  const [form, setForm] = useState({
    amount: "",
    category: categories[0],
    description: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    if (!form.description.trim()) {
      toast.error("Please add a description");
      return;
    }
    setLoading(true);
    const result = await addTransactionAction({
      type,
      amount,
      category: form.category,
      description: form.description.trim(),
      // Send a date-only ISO string; the server reparses it into a real Date.
      date: new Date(form.date).toISOString(),
    });
    setLoading(false);

    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(`${type === "expense" ? "Expense" : "Investment"} added`);
    onSuccess?.();
    onClose();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label
          htmlFor={amountId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Amount (PKR)
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-fg-muted">
            PKR
          </span>
          <input
            id={amountId}
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            className="w-full rounded-xl border border-border bg-bg py-3 pl-14 pr-4 text-lg font-semibold text-fg transition-colors placeholder:text-fg-muted/60 focus:border-primary/50 focus:bg-surface focus:outline-none"
            placeholder="0.00"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </div>
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
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="w-full appearance-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            {categories.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
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
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
            max={new Date().toISOString().slice(0, 10)}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor={descId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Description
        </label>
        <textarea
          id={descId}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="min-h-[80px] w-full resize-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:border-primary/50 focus:bg-surface focus:outline-none"
          placeholder={
            type === "expense"
              ? "What is this expense for?"
              : "What's the source or purpose of this investment?"
          }
        />
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
          disabled={loading}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {loading ? "Adding…" : `Add ${type === "expense" ? "expense" : "investment"}`}
        </button>
      </div>
    </form>
  );
}
