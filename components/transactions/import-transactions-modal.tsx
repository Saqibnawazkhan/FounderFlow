"use client";

/**
 * CSV import for transactions (F2). Two-step flow inside one modal:
 *   1. Pick a .csv (or paste rows). We parse + auto-detect the date / amount
 *      / category / description columns and show a validated preview.
 *   2. Confirm — valid rows go to bulkImportTransactionsAction, which
 *      re-validates every row (categories especially) before inserting.
 *
 * Parsing + validation here are for PREVIEW ONLY. The server is the trust
 * boundary; it drops any row whose category isn't real for the chosen type.
 */

import { useMemo, useRef, useState } from "react";
import { Download, FileUp, UploadCloud } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { bulkImportTransactionsAction } from "@/lib/actions/transactions";
import { parseCSV, findColumn } from "@/lib/transactions/csv";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, REVENUE_CATEGORIES } from "@/lib/types";
import { cn } from "@/lib/utils";

type TxnType = "expense" | "investment" | "income";

type ParsedRow = {
  amount: number;
  category: string;
  description: string;
  date: string; // ISO
  valid: boolean;
  error?: string;
  raw: string; // for the preview's "original" hint
};

export function ImportTransactionsModal({
  type,
  open,
  onClose,
  onImported,
}: {
  type: TxnType;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const categories =
    type === "expense"
      ? EXPENSE_CATEGORIES
      : type === "income"
        ? REVENUE_CATEGORIES
        : INVESTMENT_CATEGORIES;
  // Case-insensitive lookup so "marketing" maps to the canonical "Marketing".
  const canonicalByLower = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.toLowerCase(), c);
    return m;
  }, [categories]);

  const validCount = rows?.filter((r) => r.valid).length ?? 0;
  const skipCount = rows ? rows.length - validCount : 0;

  function reset() {
    setRows(null);
    setParseError(null);
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  function parseText(text: string) {
    const grid = parseCSV(text);
    if (grid.length < 2) {
      setRows(null);
      setParseError("That file has no data rows. Expected a header row plus at least one entry.");
      return;
    }
    const headers = grid[0].map((h) => h.trim().toLowerCase());
    const dateCol = findColumn(headers, ["date"]);
    const amountCol = findColumn(headers, ["amount", "value", "cost", "price", "total"]);
    const catCol = findColumn(headers, ["category", "cat"]);
    const descCol = findColumn(headers, ["description", "desc", "note", "memo", "detail"]);

    if (dateCol === -1 || amountCol === -1 || catCol === -1) {
      setRows(null);
      setParseError(
        "Couldn't find the required columns. Your CSV needs headers for date, amount, and category."
      );
      return;
    }

    const parsed: ParsedRow[] = grid.slice(1).map((cols) => {
      const rawDate = (cols[dateCol] ?? "").trim();
      const rawAmount = (cols[amountCol] ?? "").trim();
      const rawCat = (cols[catCol] ?? "").trim();
      const description = descCol >= 0 ? (cols[descCol] ?? "").trim() : "";
      const raw = cols.join(", ");

      // Amount: strip currency symbols, thousands separators, spaces.
      const amount = Number(rawAmount.replace(/[^0-9.-]/g, ""));
      const parsedDate = new Date(rawDate);
      const canonical = canonicalByLower.get(rawCat.toLowerCase());

      let error: string | undefined;
      if (!rawDate || Number.isNaN(parsedDate.getTime())) error = `Unreadable date "${rawDate}"`;
      else if (parsedDate > new Date()) error = "Date is in the future";
      else if (!Number.isFinite(amount) || amount <= 0) error = `Invalid amount "${rawAmount}"`;
      else if (!canonical) error = `Unknown category "${rawCat}"`;

      return {
        amount: Number.isFinite(amount) ? amount : 0,
        category: canonical ?? rawCat,
        description,
        date: Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString(),
        valid: !error,
        error,
        raw,
      };
    });

    setParseError(null);
    setRows(parsed);
  }

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => parseText(String(reader.result ?? ""));
    reader.onerror = () => setParseError("Couldn't read that file.");
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!rows) return;
    const valid = rows.filter((r) => r.valid);
    if (valid.length === 0) {
      toast.error("No valid rows to import");
      return;
    }
    setBusy(true);
    const res = await bulkImportTransactionsAction({
      type,
      rows: valid.map((r) => ({
        amount: r.amount,
        category: r.category,
        description: r.description,
        date: r.date,
      })),
    });
    setBusy(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    const { imported, skipped } = res.data;
    toast.success(
      skipped > 0
        ? `Imported ${imported} — skipped ${skipped} invalid row(s)`
        : `Imported ${imported} ${type === "expense" ? "expense" : "investment"}(s)`
    );
    reset();
    onImported();
  }

  const templateHref = useMemo(() => {
    const sample =
      type === "expense"
        ? `date,amount,category,description\n2026-06-01,25000,${EXPENSE_CATEGORIES[0]},June office rent\n2026-06-03,4500,${EXPENSE_CATEGORIES[2]},Ad spend`
        : `date,amount,category,description\n2026-06-01,500000,${INVESTMENT_CATEGORIES[0]},Founder seed\n2026-06-10,150000,${INVESTMENT_CATEGORIES[3]},Bank loan`;
    return `data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`;
  }, [type]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Import ${type === "expense" ? "expenses" : "investments"} from CSV`}
      description="Upload a CSV with date, amount, category, and description columns."
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a
            href={templateHref}
            download={`founderflow-${type}-template.csv`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-strong hover:underline"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download template
          </a>
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            Valid categories: {categories.length}
          </span>
        </div>

        {!rows && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-bg/40 px-6 py-10 text-center transition-colors hover:border-primary/40 hover:bg-glass/[0.04]"
          >
            <UploadCloud className="h-8 w-8 text-fg-muted" aria-hidden="true" />
            <span className="text-sm font-semibold text-fg">Choose a CSV file</span>
            <span className="text-xs text-fg-muted">
              We&apos;ll detect the columns and preview before anything is saved.
            </span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />

        {parseError && (
          <p className="rounded-xl border border-danger/30 bg-danger/[0.06] px-4 py-3 text-sm text-danger">
            {parseError}
          </p>
        )}

        {rows && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1.5 font-semibold text-fg">
                <FileUp className="h-4 w-4 text-fg-muted" aria-hidden="true" />
                {fileName ?? "Pasted data"}
              </span>
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary-strong">
                {validCount} valid
              </span>
              {skipCount > 0 && (
                <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning">
                  {skipCount} skipped
                </span>
              )}
              <button
                type="button"
                onClick={reset}
                className="ml-auto text-xs font-semibold text-fg-muted hover:text-fg"
              >
                Choose another file
              </button>
            </div>

            <div className="max-h-72 overflow-auto rounded-xl border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      Date
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      Amount
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      Category
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={i}
                      className={cn(
                        "border-b border-border/50 last:border-b-0",
                        !r.valid && "bg-danger/[0.05]"
                      )}
                      title={r.error ?? undefined}
                    >
                      <td className="px-3 py-1.5 font-mono text-fg-muted">
                        {r.date ? r.date.slice(0, 10) : "—"}
                      </td>
                      <td className="px-3 py-1.5 font-mono tabular-nums text-fg">
                        {r.amount || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-fg">{r.category || "—"}</td>
                      <td className="px-3 py-1.5 text-fg-muted">
                        {r.valid ? (
                          r.description || <span className="text-fg-muted/50">—</span>
                        ) : (
                          <span className="text-danger">{r.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={busy || !rows || validCount === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <FileUp className="h-4 w-4" aria-hidden="true" />
            {busy ? "Importing…" : validCount > 0 ? `Import ${validCount}` : "Import"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
