"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, type TransactionType } from "@/lib/types";

interface Props {
  type: TransactionType;
  onClose: () => void;
}

export function TransactionForm({ type, onClose }: Props) {
  const addTransaction = useStore((s) => s.addTransaction);
  const categories = type === "expense" ? EXPENSE_CATEGORIES : INVESTMENT_CATEGORIES;

  const [form, setForm] = useState({
    amount: "",
    category: categories[0],
    description: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
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
    addTransaction({
      type,
      amount,
      category: form.category,
      description: form.description.trim(),
      date: new Date(form.date).toISOString(),
    });
    toast.success(`${type === "expense" ? "Expense" : "Investment"} added`);
    setLoading(false);
    onClose();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Amount (PKR)</label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">PKR</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            className="input pl-14 text-lg font-semibold"
            placeholder="0.00"
            autoFocus
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Category</label>
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="input"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Date</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="input"
            max={new Date().toISOString().slice(0, 10)}
          />
        </div>
      </div>

      <div>
        <label className="label">Description</label>
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="input min-h-[80px] resize-none"
          placeholder={
            type === "expense"
              ? "What is this expense for?"
              : "What's the source or purpose of this investment?"
          }
        />
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="btn-primary flex-1">
          {loading ? "Adding..." : `Add ${type === "expense" ? "Expense" : "Investment"}`}
        </button>
      </div>
    </form>
  );
}
