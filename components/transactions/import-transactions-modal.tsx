"use client";

/**
 * CSV import for transactions (F2). Two-step flow inside one modal:
 *   1. Pick a .csv (or paste rows). We parse + auto-detect the date / amount
 *      / category / description columns, SHOW which column each field is being
 *      read from (editable), and show a validated preview.
 *   2. Confirm — valid rows go to bulkImportTransactionsAction, one call per
 *      batch of at most `IMPORT_MAX_ROWS_PER_BATCH` rows, which re-validates
 *      every row (categories especially) before inserting.
 *
 * Parsing + validation here are for PREVIEW ONLY. The server is the trust
 * boundary; it drops any row whose category isn't real for the chosen type.
 *
 * ## Amounts are parsed, not scrubbed (money-009)
 *
 * The amount cell used to go through `Number(raw.replace(/[^0-9.-]/g, ""))`,
 * which kept every digit, dot and minus and trusted the result: "Rs. 1,000"
 * imported as 0.10 and the row was reported to the user as VALID. Amount
 * reading now lives in `parseMoneyInput` (lib/format.ts), which refuses
 * anything it cannot read unambiguously, and this file turns that refusal into
 * a skipped row naming the offending cell. The preview shows the PARSED amount
 * formatted in the workspace currency — what will actually be stored — rather
 * than the raw cell, because a preview of the input tells you nothing about
 * what the importer understood.
 *
 * ## Dates are read, not guessed either (transactions-ledger-003)
 *
 * The date cell used to go through `new Date(rawDate)`, whose fallback parser
 * guesses month-first: a DD/MM/YYYY export — what Excel writes in this
 * product's home market — imported "02/06/2026" as 6 February and REFUSED
 * "25/06/2026", so the customer was shown "61 valid, 39 skipped", repaired the
 * 39, and kept the 61 whose month and day had been transposed. Date reading now
 * lives in `lib/transactions/ledger-date.ts`, which resolves the day/month order
 * from the whole COLUMN (one "25/06/2026" settles the file) and refuses the rest
 * by name rather than picking. The order it inferred is stated above the
 * preview, because a silently-chosen order is how this got shipped.
 *
 * ## Which COLUMN each field is read from is shown, and correctable
 * ## (transactions-ledger-014)
 *
 * Detection was `findColumn` — the first header, in header order, containing any
 * candidate as a substring. The amount candidates include "total" and the
 * category candidates include "cat", so:
 *
 *     date,subtotal,amount,…          the SUBTOTAL imported as the amount
 *     date,amount,allocation,category the ALLOCATION imported as the category
 *
 * In both files the right column is sitting one place to the right, correctly
 * named. Ranking now prefers a header that IS the name over one that merely
 * contains it (`detectColumn`, lib/transactions/csv.ts), which settles both.
 *
 * But ranking alone cannot settle `date,subtotal,grand total` — neither column
 * is named "amount", both match only on "total", and the importer has no way to
 * know which one is the row's money. That is why the mapping is on SCREEN and
 * editable rather than merely better: the preview renders whichever column was
 * chosen with no hint that a choice was made, and an import that looks like it
 * worked with amounts off the wrong column is the hardest money bug to notice.
 * A tie names the column it rejected.
 *
 * This is also why the preview is DERIVED (`preview`, a useMemo over the file
 * and the mapping) instead of being built once inside `parseText`: a control
 * that re-labels without re-reading is the same silent import with a label on
 * it.
 *
 * ## The batch can be tagged to a project (transactions-ledger-004)
 *
 * The picker below is the reachable half of that fix. Until it existed the
 * action hardcoded `projectId: null`, and because every `Budget` belongs to a
 * project while both budget readers count untagged spend against no cap,
 * imported spend moved no budget and fired no over-budget alert — for a customer
 * whose first act is to import their history, budgets silently did nothing.
 *
 * It tags the WHOLE batch, not a row: a CSV has no project column, and inventing
 * a header for one would mean resolving a project NAME to an id row by row.
 * Untagged stays the default, because company-wide spend is a real answer.
 *
 * Because a CSV carries no project column, a customer with spend across several
 * projects imports once per project — so the tag lasts exactly ONE batch and is
 * dropped the moment one lands. See `clearBatch` for why that is not the same
 * as "cleared when the modal closes".
 *
 * ## Rows the ledger already holds are reported back (transactions-ledger-008)
 *
 * The server withholds any row whose date, amount, category and description
 * already exist in this ledger — importing the same CSV twice used to double
 * burn, revenue, budget spend and the runway denominator in silence. That
 * decision has to reach the screen, for two reasons that pull in opposite
 * directions:
 *
 *   • an "Imported 0" with no explanation is indistinguishable from a broken
 *     importer, and invites exactly the retry the finding is about;
 *   • a guard with no override silently destroys a real transaction — two
 *     identical charges on one day with the same memo do happen.
 *
 * So a batch that withheld anything holds this modal OPEN with the count and an
 * "import anyway", and the override re-sends only the rows the server withheld.
 * Only those: a partial import has already written the fresh rows by the time
 * the prompt is on screen, so re-sending the whole batch would double exactly
 * what the guard just saved.
 *
 * That same partial import is why two other things here are not cosmetic. Every
 * way OUT of this modal has to refresh the page behind once anything has been
 * written — Done, Cancel, Escape and the X alike (`handleClose`) — or the
 * ledger shows none of the rows that just landed, which reads as "the import
 * did nothing" and invites the retry. And the success toast counts BOTH
 * attempts (`importedThisFile`), because the override's own count is not what
 * landed.
 *
 * ## A file bigger than one batch is SPLIT, not refused (transactions-ledger-010)
 *
 * `ImportTransactionsSchema` caps a CALL at `IMPORT_MAX_ROWS_PER_BATCH` rows and
 * this file used to send every valid row in one. So a 3,000-row accounting
 * export — the file a new paying customer onboards with — produced a single zod
 * failure, "Import at most 1000 rows at a time", and zero inserts, after they
 * had picked the file, waited for the preview and pressed Import. The cap
 * appeared nowhere before that moment: not in the dialog, not on the template
 * link, not in the file input's hint.
 *
 * Four things changed, and the first is the one that matters:
 *
 *   • `submit` CHUNKS. One call per `IMPORT_MAX_ROWS_PER_BATCH` rows, in file
 *     order, with the batch number on the button while it runs. The chunk size
 *     is the schema's own exported constant, because a client chunking at a
 *     different number is this finding again with the rejection moved one step
 *     earlier.
 *   • The limits are stated BEFORE the file picker, and the batch plan ("sent in
 *     3 batches") before Import is pressed.
 *   • A file is refused for its SIZE before the `FileReader` reads it, and for
 *     its ROW COUNT immediately after `parseCSV`. Reading megabytes into a
 *     string is itself what locked the tab up while the customer waited to be
 *     told no, so the byte check has to come first.
 *   • The preview TABLE renders at most `IMPORT_PREVIEW_ROWS` rows. Validation
 *     is never truncated — the badges and the import still cover every row —
 *     because a preview that quietly stopped checking would be a far worse bug
 *     than a slow one.
 *
 * The duplicate question above stays ONE question for the whole file: the rows
 * every batch withheld are collected and asked about once, and "import anyway"
 * re-sends exactly those. Asking per batch, or re-sending a whole chunk, would
 * double the ledger — transactions-ledger-008 reintroduced by this finding's own
 * fix. The same reasoning is why a batch that FAILS part-way narrows the
 * outstanding question to the rows that were never sent (see `submit`).
 *
 * ## A call that never comes back is a failure too (transactions-ledger-007)
 *
 * `submit` awaited the action bare. The action catches its own database body and
 * answers `{ success: false }`, so the only failures that reach the client are
 * transport-level — a dropped network, a Next.js action-boundary error, a
 * dev-server recompile — and those REJECT rather than return. The rejection
 * unwound past `setBusy(false)`, so `busy` stayed true forever: the confirm
 * button sat disabled reading "Importing…", no toast fired, and reloading the
 * page was the only way out of the dialog. On an 800-row file the customer
 * cannot tell whether their import landed, and that reload is the retry the
 * section above is about.
 *
 * `sendImportBatch` turns the rejection into a value and `submit`'s `stop`
 * handles it, with one difference from an answered failure that is the whole
 * reason the two are not merged: a returned `{ success: false }` proves that
 * batch did not commit, while a rejection proves nothing either way. So the
 * outstanding duplicate question skips the batch that was in flight, and the
 * recovery the toast points at is the plain re-import — which re-checks for
 * duplicates — rather than the override, which by definition does not.
 *
 * ## The dialog is about the ledger it opened from (transactions-ledger-002)
 *
 * `type` has THREE values and three of this file's strings were two-way
 * `type === "expense" ? … : …` ternaries with no income branch, so /revenue —
 * which renders this modal with `type="income"` (revenue-client.tsx) — fell to
 * the INVESTMENT side of every one of them: the title read "Import investments
 * from CSV", the success toast said "Imported 3 investment(s)", and "Download
 * template" handed over the investment sample, whose categories are "Seed
 * Capital" and "Loan".
 *
 * The template is the expensive half. Validation was already right —
 * `categories` below picks REVENUE_CATEGORIES for `"income"` — so neither of
 * those categories is real on /revenue: every row of the page's OWN template
 * previewed as `Unknown category "…"`, the valid count was 0 and the Import
 * button stayed disabled. A customer's real sales export would have imported;
 * the only guidance the page offered guaranteed failure, and the word on screen
 * while it failed told them their income had been booked as founder capital —
 * which, for a product where a sale mis-booked as investment inflates the cap
 * table, is not an unreasonable reading.
 *
 * Both are now `Record<TxnType, …>` tables (`TXN_NOUN`, `TEMPLATE_ROWS`), so
 * the compiler asks for every branch rather than letting one type inherit
 * another's, and the template's category is an INDEX into the type's own
 * category list rather than a typed-out name — it cannot drift from the list
 * the preview validates against.
 */

import { useId, useMemo, useRef, useState } from "react";
import { Download, FileUp, UploadCloud } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { bulkImportTransactionsAction } from "@/lib/actions/transactions";
import { parseCSV, detectColumn, type ColumnMatch } from "@/lib/transactions/csv";
import {
  readLedgerDate,
  detectLedgerDateOrder,
  resolveLedgerDate,
  type LedgerDateOrder,
  type LedgerDateResult,
} from "@/lib/transactions/ledger-date";
import {
  chunkImportRows,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS_PER_BATCH,
  IMPORT_MAX_TOTAL_ROWS,
  IMPORT_PREVIEW_ROWS,
} from "@/lib/transactions/import-batches";
import { parseMoneyInput, type MoneyParseFailure } from "@/lib/format";
import { useMoney } from "@/lib/hooks/useMoney";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, REVENUE_CATEGORIES } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/i18n/use-t";

type TxnType = "expense" | "investment" | "income";

/**
 * The nouns this dialog says out loud, per type (transactions-ledger-002 — see
 * the header for what the two-way ternaries these replace did on /revenue).
 *
 * `title` is the mass noun: you import revenue, not "revenues". `one` / `many`
 * are the count noun the three ledger clients already use for a ROW — "revenue
 * entries" (revenue-client.tsx:382), "Delete this revenue entry?" (:206) —
 * because what a toast counts is entries. `slug` names the downloaded template,
 * so it is the word the page uses rather than the internal type code `income`.
 */
const TXN_NOUN: Record<TxnType, { title: string; one: string; many: string; slug: string }> = {
  expense: { title: "expenses", one: "expense", many: "expenses", slug: "expense" },
  income: { title: "revenue", one: "revenue entry", many: "revenue entries", slug: "revenue" },
  investment: { title: "investments", one: "investment", many: "investments", slug: "investment" },
};

/**
 * The example rows behind "Download template", per type — deliberately WITHOUT
 * the category name. `categoryIndex` points into the type's own category list
 * (`categories` inside the component, the very array the preview validates
 * against), wrapped modulo its length so a shortened list cannot leave the cell
 * empty. A name typed here could drift from that list; an index cannot, which
 * is the structural half of transactions-ledger-002.
 */
const TEMPLATE_ROWS: Record<
  TxnType,
  { date: string; amount: string; categoryIndex: number; description: string }[]
> = {
  expense: [
    { date: "2026-06-01", amount: "25000.00", categoryIndex: 0, description: "June office rent" },
    { date: "2026-06-03", amount: "4500.50", categoryIndex: 2, description: "Ad spend" },
  ],
  income: [
    { date: "2026-06-01", amount: "180000", categoryIndex: 0, description: "June product sales" },
    { date: "2026-06-10", amount: "45000.50", categoryIndex: 3, description: "Retainer invoice" },
  ],
  investment: [
    { date: "2026-06-01", amount: "500000", categoryIndex: 0, description: "Founder seed" },
    { date: "2026-06-10", amount: "150000", categoryIndex: 3, description: "Bank loan" },
  ],
};

/** One row as it is submitted — and as the server hands back the ones it
 *  withheld, so "import anyway" can re-send exactly those. */
type ImportRow = { amount: number; category: string; description: string; date: string };

type ParsedRow = {
  /**
   * `null` when the cell could not be read. Deliberately nullable rather than
   * defaulting to 0: a 0 that means "unparseable" is one careless
   * `?? 0` away from being imported as a real amount, which is the shape of
   * money-009. Import filters on `amount !== null` with a type guard so the
   * compiler enforces it.
   */
  amount: number | null;
  rawAmount: string; // echoed back when we refuse the cell
  category: string;
  description: string;
  date: string; // ISO
  valid: boolean;
  error?: string;
  raw: string; // for the preview's "original" hint
};

/**
 * Why we could not read an amount cell, in the user's words, with the cell
 * quoted back. "Invalid amount" alone sent people hunting through a 240-row
 * CSV; the reason tells them what to change.
 */
function amountCellError(rawAmount: string, reason: MoneyParseFailure): string {
  if (reason === "empty") return `Missing amount ("${rawAmount}")`;
  if (reason === "scale") {
    return `Amount "${rawAmount}" has more than 2 decimal places — it would be rounded`;
  }
  if (reason === "negative") {
    return `Amount "${rawAmount}" is negative — import positive amounts only`;
  }
  // "ambiguous": the separators don't name one number. Name the two forms we
  // can read instead of guessing, which is what the old parser did.
  return `Couldn't read amount "${rawAmount}" — write it as 1234.56 or 1,234.56`;
}

/**
 * Why we could not read a date cell, with the cell quoted back
 * (transactions-ledger-003). The ambiguous case names BOTH dates the cell could
 * mean, because "ambiguous date" on its own reads like a complaint about
 * formatting rather than a warning that ten months are at stake.
 */
function dateCellError(rawDate: string, refusal: Extract<LedgerDateResult, { ok: false }>): string {
  if (refusal.reason === "empty") return "Missing date";
  if (refusal.reason === "impossible") return `"${rawDate}" isn't a real date`;
  if (refusal.reason === "ambiguous") {
    return (
      `Ambiguous date "${rawDate}" — could be ${refusal.dayFirst.slice(0, 10)} or ` +
      `${refusal.monthFirst.slice(0, 10)}. Write dates as YYYY-MM-DD.`
    );
  }
  return `Couldn't read date "${rawDate}" — write it as YYYY-MM-DD`;
}

/**
 * How the day/month order the column settled on should be read back to the
 * customer, with the example that makes it unmistakable. `null` means the column
 * never settled it, and those rows carry their own refusal instead.
 */
const DATE_ORDER_NOTE: Record<LedgerDateOrder, string> = {
  dayFirst: "Dates read day first — 02/06/2026 means 2 June 2026.",
  monthFirst: "Dates read month first — 02/06/2026 means 6 February 2026.",
};

/** Which column of the file each field is read from. `-1` means "not read",
 *  which only `description` may be — the other three are required for the file
 *  to get past `parseText` at all. */
type ColumnMapping = { date: number; amount: number; category: number; description: number };

type MappingField = keyof ColumnMapping;

/** The header names we look for, MOST CANONICAL FIRST: that order is the
 *  tiebreak inside `detectColumn`, so "amount" beats a file's "cost" column. */
const COLUMN_CANDIDATES: Record<MappingField, string[]> = {
  date: ["date"],
  amount: ["amount", "value", "cost", "price", "total"],
  category: ["category", "cat"],
  description: ["description", "desc", "note", "memo", "detail"],
};

const COLUMN_LABEL: Record<MappingField, string> = {
  date: "Date",
  amount: "Amount",
  category: "Category",
  description: "Description",
};

const MAPPING_FIELDS: MappingField[] = ["date", "amount", "category", "description"];

/** A header as it should appear in the mapping picker. A spreadsheet can ship a
 *  blank header cell, and an empty option is unpickable. */
function headerLabel(headers: string[], i: number): string {
  return headers[i]?.trim() || `Column ${i + 1}`;
}

/** Bytes as a count of megabytes. Deliberately returns a NUMBER: the caller runs
 *  it through `n.number`, which owns the numbering system and the grouping
 *  (i18n-004), so no copy in this file names a locale. */
function megabytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** What one import call answered with, or the sentinel below when it never
 *  answered at all. */
type ImportCallResult = Awaited<ReturnType<typeof bulkImportTransactionsAction>> | "unreachable";

/**
 * One import call, with transport-level failure turned into a VALUE
 * (transactions-ledger-007).
 *
 * A server action can reject rather than return: the network drops mid-flight,
 * the Next.js action boundary errors, the dev server recompiles during the
 * request. The action's own try/catch (`bulkImportTransactionsAction`, which
 * catches its whole database body and answers `{ success: false }`) cannot help
 * with any of that — it never ran. So `submit` awaited this bare and the
 * rejection unwound straight past `setBusy(false)`: `busy` stayed true forever,
 * the confirm button sat disabled reading "Importing…", no toast fired, and
 * reloading the page was the only way out. On an 800-row file that reload is
 * also the retry that doubles a ledger, which is the whole of
 * transactions-ledger-008.
 *
 * A sentinel rather than a re-thrown error, because the caller has to treat the
 * two failures DIFFERENTLY: a returned `{ success: false }` proves that batch
 * did not commit, while a rejection proves nothing either way — the rows may
 * have been written and only the response lost. See `submit`.
 */
async function sendImportBatch(input: unknown): Promise<ImportCallResult> {
  try {
    return await bulkImportTransactionsAction(input);
  } catch {
    return "unreachable";
  }
}

export function ImportTransactionsModal({
  type,
  projects,
  open,
  onClose,
  onImported,
}: {
  type: TxnType;
  /** The workspace's live projects, for the batch tag.
   *
   *  REQUIRED rather than optional-with-a-`[]`-default: the picker below is the
   *  only thing that makes the action's `projectId` reachable, so an optional
   *  prop lets a future render site omit it and silently revert that page to
   *  "an import can never be tagged" — which is this finding, and "shipped,
   *  tested, unreachable" is this repo's most documented recurrent defect. The
   *  compiler asks every present and future caller instead of a hard-coded list
   *  of call sites in a test.
   *
   *  An empty array stays legal — a workspace with no projects yet has nothing
   *  to tag — and renders the caption below in place of the picker. */
  projects: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const n = useNumberFormat();
  const money = useMoney();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectSelectId = useId();
  const mappingIdBase = useId();
  /**
   * The file as parsed, kept so the preview can be re-read when the customer
   * re-points a column. `headers` is the original header text (for the picker's
   * labels); detection ran on a lowercased copy.
   */
  const [file, setFile] = useState<{ headers: string[]; body: string[][] } | null>(null);
  /** Which column each field is read from — detected, then whatever the customer
   *  corrected it to. The preview below is derived from this, so a correction
   *  re-reads the whole file rather than only re-labelling it. */
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  /** What detection actually found, for the picker's "also matched" note.
   *  Unchanged by a correction: it records what the IMPORTER chose. */
  const [detected, setDetected] = useState<Record<MappingField, ColumnMatch> | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which call of how many is in flight, for a file that takes more than one
   * (transactions-ledger-010). `null` while idle, and also while a
   * single-batch import runs — "Importing…" already says everything there is to
   * say about one call, and a "Batch 1 of 1" would only invite the question of
   * what the other batches are.
   */
  const [progress, setProgress] = useState<{ batch: number; of: number } | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  /** "" = not tagged to a project. The server coerces it to a SQL NULL. */
  const [projectId, setProjectId] = useState("");
  /**
   * The unanswered duplicate question (transactions-ledger-008): the rows the
   * server withheld, and how many of the batch it did take. `null` = nothing to
   * ask. It holds the ROWS rather than a count because the override re-sends
   * them verbatim — a count would leave the client guessing which ones.
   */
  const [heldBack, setHeldBack] = useState<{ rows: ImportRow[]; imported: number } | null>(null);
  /**
   * How many rows the file on screen has actually written, across BOTH attempts
   * — the first and the "import anyway". The override re-sends only the rows
   * the server withheld, so the second call's own count is not what landed: a
   * 2-row file that imported 1 fresh row and then 1 override row has imported
   * 2, and the toast is the only place the customer sees that number. Cleared
   * by `reset`, because the next file's toast is about the next file.
   */
  const [importedThisFile, setImportedThisFile] = useState(0);
  /**
   * Has anything been written since the page behind this modal last refreshed?
   *
   * Separate from the count above, and deliberately NOT cleared by `reset`: the
   * rows a partial import already wrote still have to be refreshed into the
   * ledger behind even if the customer then picks a different file. Only
   * `clearBatch` clears it, which is the same moment one of the two callbacks
   * fires. See `handleClose`.
   */
  const [wroteRows, setWroteRows] = useState(false);

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

  /**
   * The preview, DERIVED from the file plus the current column mapping rather
   * than built once at parse time — which is what makes the mapping picker
   * below a correction and not a label. Re-reading is cheap: the whole file is
   * already in memory, and `parseText` has already refused anything above
   * `IMPORT_MAX_TOTAL_ROWS` rows, so this is bounded work. It reads EVERY row,
   * including the ones the preview table does not render — the badges and the
   * import itself are counts over the whole file.
   */
  const preview = useMemo(() => {
    if (!file || !mapping) return null;
    const { body } = file;
    // Dates need TWO passes, because a numeric "02/06/2026" is a property of the
    // column and not of the cell: one "25/06/2026" anywhere in the file proves
    // it is day-first, and without that evidence the cell is refused rather than
    // guessed. See lib/transactions/ledger-date.ts.
    const dateReadings = body.map((cols) => readLedgerDate((cols[mapping.date] ?? "").trim()));
    const order = detectLedgerDateOrder(dateReadings);
    const now = new Date();

    const rows: ParsedRow[] = body.map((cols, i) => {
      const rawDate = (cols[mapping.date] ?? "").trim();
      const rawAmount = (cols[mapping.amount] ?? "").trim();
      const rawCat = (cols[mapping.category] ?? "").trim();
      const description = mapping.description >= 0 ? (cols[mapping.description] ?? "").trim() : "";
      const raw = cols.join(", ");

      // Amount: read deliberately, or refuse. See parseMoneyInput. Named
      // `cell` rather than `money` so it can't be confused with the `money()`
      // formatter this component also holds.
      const cell = parseMoneyInput(rawAmount);
      const amount = cell.ok ? cell.amount : null;
      // UTC midnight when it resolves, so the row lands in the month every
      // reader buckets it into (money-007) instead of the one the browser's
      // timezone would have shifted it to.
      const when = resolveLedgerDate(dateReadings[i], order);
      const canonical = canonicalByLower.get(rawCat.toLowerCase());

      let error: string | undefined;
      if (!when.ok) error = dateCellError(rawDate, when);
      else if (new Date(when.iso) > now) error = "Date is in the future";
      else if (!cell.ok) error = amountCellError(rawAmount, cell.reason);
      else if (cell.amount <= 0) error = `Amount "${rawAmount}" must be greater than 0`;
      else if (!canonical) error = `Unknown category "${rawCat}"`;

      return {
        amount,
        rawAmount,
        category: canonical ?? rawCat,
        description,
        date: when.ok ? when.iso : "",
        valid: !error,
        error,
        raw,
      };
    });

    return { rows, dateOrder: order };
  }, [file, mapping, canonicalByLower]);

  const rows = preview?.rows ?? null;
  /** The day/month order this file's date column turned out to be in, for the
   *  note above the preview. `null` = the column never said, and the ambiguous
   *  rows carry their own refusal. */
  const dateOrder = preview?.dateOrder ?? null;

  const validCount = rows?.filter((r) => r.valid).length ?? 0;
  const skipCount = rows ? rows.length - validCount : 0;
  /**
   * How many calls this file will take, and therefore what the dialog promises
   * before Import is pressed (transactions-ledger-010). Derived from the VALID
   * count, because that is what `handleImport` sends.
   */
  const batchCount = Math.ceil(validCount / IMPORT_MAX_ROWS_PER_BATCH);
  /**
   * The rows the TABLE renders. Every row above is still parsed, validated and
   * counted; only the `<tr>`s are capped, because one per row is what makes a
   * real export lock the tab up before the customer has agreed to anything.
   */
  const shownRows = rows ? rows.slice(0, IMPORT_PREVIEW_ROWS) : null;
  const hiddenRows = rows && shownRows ? rows.length - shownRows.length : 0;
  /** Skipped rows the customer cannot see, because they lie below the cut. The
   *  notice says how many; locating them needs a row-number column the preview
   *  has never had, which is a separate change. */
  const hiddenSkipCount = rows ? rows.slice(IMPORT_PREVIEW_ROWS).filter((r) => !r.valid).length : 0;

  /**
   * Clears the chosen FILE only. This is also "Choose another file", which is
   * why the batch's project tag deliberately survives it: silently dropping the
   * tag when someone re-picks a file is how a batch meant for a project lands
   * untagged, and untagged spend crosses no budget.
   */
  function reset() {
    setFile(null);
    setMapping(null);
    setDetected(null);
    setParseError(null);
    setFileName(null);
    // The duplicate question belongs to the file that raised it — a different
    // file has a different answer, and a stale prompt would re-send rows that
    // are no longer on screen. Same for the write count the toast reports.
    setHeldBack(null);
    setImportedThisFile(0);
    // Belt and braces: every exit from `submit` already clears it, and a stale
    // "Batch 2 of 3" over a different file would be a lie.
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * Everything that belongs to ONE import, the project tag included.
   *
   * Both ways out of this modal come through here — Cancel / Escape / the X, and
   * a SUCCESSFUL import — because closing is not unmounting. All three ledger
   * clients render `<ImportTransactionsModal>` unconditionally and close it by
   * flipping their own `importOpen` flag (expenses-client.tsx:712,
   * revenue-client.tsx:533, investments-client.tsx:528), so React never discards
   * this component and nothing resets its state for us. While only `handleClose`
   * cleared the tag, the success path — which those clients take, via
   * `onImported` rather than `onClose` — left the picker on project A for the
   * rest of the page visit, and the next CSV silently landed on A's ledger. That
   * moves the wrong budget's month-to-date spend and can fire an 80%/100% alert
   * that `lib/budgets/check.ts` fans out as in-app + email + push about a
   * project that never spent it, with no remedy but delete-and-reimport
   * (`EditTransactionSchema` refuses `projectId`). Importing once per project is
   * the normal flow here, not an exotic one.
   */
  /**
   * Re-point one field at a different column of the file the customer already
   * chose (transactions-ledger-014). The preview is DERIVED from the mapping, so
   * this re-reads every row — amount, date, category and description — rather
   * than relabelling what was read once at parse time.
   *
   * `detected` is deliberately left alone: it records what the importer chose,
   * which is what the "also matched" note is about.
   */
  function setColumn(field: MappingField, index: number) {
    setMapping((m) => {
      if (!m) return m;
      const next = { ...m };
      next[field] = index;
      return next;
    });
  }

  function clearBatch() {
    setProjectId("");
    // Cleared HERE and not in `reset`, which is also "Choose another file":
    // whether the page behind owes a refresh outlives the file that caused it.
    setWroteRows(false);
    reset();
  }

  /**
   * Cancel / Escape / the X — Radix routes all three through the Modal's
   * `onClose` (components/ui/modal.tsx).
   *
   * `onImported` when this batch has already WRITTEN something, because that is
   * the only one of the two callbacks that refreshes: `onClose` is
   * `() => setImportOpen(false)` in all three ledger clients
   * (expenses-client.tsx:712, revenue-client.tsx:533,
   * investments-client.tsx:528) and `onImported` closes AND calls `refresh()`.
   * Dismissing the duplicate prompt with Escape used to leave the ledger
   * showing none of the rows that had just landed, which reads as "the import
   * did nothing" — the same stale screen that invites the retry this finding is
   * about. `onClose` stays the answer when nothing was written, so a plain
   * cancel does not trigger a pointless re-fetch.
   */
  function handleClose() {
    const owesRefresh = wroteRows;
    clearBatch();
    if (owesRefresh) onImported();
    else onClose();
  }

  /**
   * No usable file, and why — the four places that have to say so. Clears the
   * same state `reset` does except the message itself, and clears the file
   * input's value so re-picking the SAME file after fixing it fires `change`
   * again (a browser suppresses the event for an unchanged value).
   */
  function refuseFile(message: string) {
    setFile(null);
    setMapping(null);
    setDetected(null);
    setFileName(null);
    setParseError(message);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function parseText(text: string) {
    const grid = parseCSV(text);
    if (grid.length < 2) {
      refuseFile("That file has no data rows. Expected a header row plus at least one entry.");
      return;
    }
    // transactions-ledger-010. Checked HERE, before the preview is derived and
    // long before Import is pressed: the ceiling exists because chunking turns
    // one call into one per thousand rows and every call spends from the write
    // limiter's 60-a-minute budget (see lib/transactions/import-batches.ts). A
    // count is only knowable after parsing — a quoted cell may contain a newline
    // — which is why the BYTE ceiling in `handleFile` comes first and bounds
    // this parse.
    const dataRows = grid.length - 1;
    if (dataRows > IMPORT_MAX_TOTAL_ROWS) {
      refuseFile(
        `That file has ${n.number(dataRows)} rows. The importer takes up to ` +
          `${n.number(IMPORT_MAX_TOTAL_ROWS)} at a time — split it and import the parts.`
      );
      return;
    }
    const headers = grid[0].map((h) => h.trim());
    // Detection is case-insensitive; the picker's labels use the original text.
    const lowered = headers.map((h) => h.toLowerCase());
    const matches: Record<MappingField, ColumnMatch> = {
      date: detectColumn(lowered, COLUMN_CANDIDATES.date),
      amount: detectColumn(lowered, COLUMN_CANDIDATES.amount),
      category: detectColumn(lowered, COLUMN_CANDIDATES.category),
      description: detectColumn(lowered, COLUMN_CANDIDATES.description),
    };

    if (matches.date.index === -1 || matches.amount.index === -1 || matches.category.index === -1) {
      refuseFile(
        "Couldn't find the required columns. Your CSV needs headers for date, amount, and category."
      );
      return;
    }

    setParseError(null);
    setDetected(matches);
    setMapping({
      date: matches.date.index,
      amount: matches.amount.index,
      category: matches.category.index,
      description: matches.description.index,
    });
    setFile({ headers, body: grid.slice(1) });
  }

  function handleFile(file: File) {
    // transactions-ledger-010. Before the FileReader, not after: `readAsText`
    // pulls the whole file into a string on the main thread, so a multi-megabyte
    // file froze the tab and only THEN told the customer it was too big. The
    // ceiling is many times the row ceiling at the shape a transaction CSV
    // actually has, so this catches a file that was never an export rather than
    // a large one.
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      refuseFile(
        `That file is ${n.number(megabytes(file.size), { maximumFractionDigits: 1 })} MB. ` +
          `The importer reads files up to ${n.number(megabytes(IMPORT_MAX_FILE_BYTES))} MB — ` +
          `export it in parts, or split it in your spreadsheet.`
      );
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => parseText(String(reader.result ?? ""));
    reader.onerror = () => setParseError("Couldn't read that file.");
    reader.readAsText(file);
  }

  /**
   * The one path to the server — now one call per BATCH of at most
   * `IMPORT_MAX_ROWS_PER_BATCH` rows (transactions-ledger-010), in file order,
   * because the schema caps a call and used to refuse a larger file in full.
   *
   * `allowDuplicates` is the customer's answer to the prompt below; it is false
   * on every first attempt, so a forgotten flag can never mean "yes, double the
   * ledger".
   *
   * Sequential, not `Promise.all`: each call writes rows that the NEXT call's
   * duplicate lookup has to be able to see, which is what catches two identical
   * lines that straddle a batch boundary (the in-batch pass in
   * `splitDuplicateImportRows` cannot see across calls). Concurrency would also
   * spend the write limiter's budget in one burst and give the progress line
   * nothing honest to say.
   *
   * ONE duplicate question for the whole file: every batch's withheld rows are
   * collected and asked about once. Asking per batch would put the prompt up
   * while later batches were still writing, and "import anyway" would re-send a
   * chunk rather than the withheld rows — transactions-ledger-008 reintroduced
   * by this finding's own fix.
   *
   * Every exit runs through `stop` below, including a call that never came back
   * at all (transactions-ledger-007) — nothing here may leave `busy` true, or
   * the dialog is unusable without a page reload.
   */
  async function submit(payload: ImportRow[], allowDuplicates: boolean) {
    const batches = chunkImportRows(payload);
    setBusy(true);
    // Cumulative across BOTH the loop and any earlier attempt: the override
    // re-sends only the rows the server withheld, so no single call's `imported`
    // is what landed. The customer is already counting at this point — the whole
    // of 008 is about doubling — and "Imported 1" after importing 2 is what
    // sends them to the ledger to count by hand.
    let importedTotal = importedThisFile;
    let skippedTotal = 0;
    let wrote = false;
    const withheld: ImportRow[] = [];

    /**
     * Stop the run and hand the customer back a USABLE dialog: no spinner, the
     * Import button live again, the parsed preview still on screen to retry
     * with, a toast saying what did and did not land, and the outstanding
     * duplicate question narrowed to rows that were definitely not written.
     *
     * `firstUnsent` is the index of the first batch whose rows are known to be
     * absent from the ledger. The two failures differ exactly here:
     *
     *   • the server ANSWERED `{ success: false }` — batch `i` did not commit,
     *     so `i` is the first unsent batch;
     *   • the call never came back (transactions-ledger-007) — batch `i` may
     *     have committed and lost its response, so `i + 1` is. Re-offering a
     *     possibly-written row under "import anyway", which skips the duplicate
     *     check by definition, is the doubling transactions-ledger-008 exists
     *     to prevent. The plain re-import DOES re-check, which is why the toast
     *     points at that instead.
     *
     * `setHeldBack` is called either way, with `null` when there is nothing left
     * to ask: leaving a stale prompt up would offer an override over rows that
     * are no longer the ones in question. (On the answered-failure path that is
     * a no-op — `allowDuplicates` always leaves at least batch `i` unanswered,
     * and a first attempt cannot start with the question already open because
     * `heldBack` disables the Import button.)
     */
    function stop(message: string, firstUnsent: number, mayHaveWritten: boolean) {
      setBusy(false);
      setProgress(null);
      setImportedThisFile(importedTotal);
      if (wrote || mayHaveWritten) setWroteRows(true);
      toast.error(message);
      const unanswered = allowDuplicates
        ? batches.slice(firstUnsent).reduce<ImportRow[]>((all, b) => all.concat(b), [])
        : withheld;
      setHeldBack(unanswered.length > 0 ? { rows: unanswered, imported: importedTotal } : null);
    }

    for (let i = 0; i < batches.length; i++) {
      setProgress(batches.length > 1 ? { batch: i + 1, of: batches.length } : null);
      const res = await sendImportBatch({
        type,
        projectId,
        rows: batches[i],
        allowDuplicates,
      });
      if (res === "unreachable") {
        // transactions-ledger-007. The call never answered, so nothing here can
        // say whether this batch is in the ledger — only that the batches
        // before it are. `mayHaveWritten` is therefore true even when
        // `importedTotal` is 0: the page behind owes a refresh on the way out,
        // because the alternative is a ledger that silently omits rows that did
        // land, which reads as "the import did nothing" and invites the retry.
        stop(
          `Couldn't reach the server.` +
            (batches.length > 1
              ? ` Stopped at batch ${n.number(i + 1)} of ${n.number(batches.length)} — ` +
                `${n.number(importedTotal)} row(s) were imported before it.`
              : "") +
            ` That batch may or may not have landed — check the ledger, then re-import the ` +
            `same file: rows already in it come back as duplicates, not copies.`,
          i + 1,
          true
        );
        return;
      }
      if (!res.success) {
        stop(
          batches.length > 1
            ? `${res.error} Stopped at batch ${i + 1} of ${batches.length} — ` +
                `${n.number(importedTotal)} row(s) were imported. Re-import the same file: ` +
                `rows already in the ledger come back as duplicates, not copies.`
            : res.error,
          // The server answered, so this batch provably did not commit and its
          // rows are still the customer's to decide about.
          i,
          false
        );
        return;
      }
      importedTotal += res.data.imported;
      skippedTotal += res.data.skipped;
      if (res.data.imported > 0) wrote = true;
      for (const row of res.data.duplicates) withheld.push(row);
    }

    setBusy(false);
    setProgress(null);
    setImportedThisFile(importedTotal);
    if (wrote) setWroteRows(true);

    // Rows were withheld. Hold the modal open and ask — see the header for why
    // neither silently skipping nor silently inserting them is acceptable.
    if (withheld.length > 0) {
      setHeldBack({ rows: withheld, imported: importedTotal });
      return;
    }

    // transactions-ledger-002. The noun comes from the table, so /revenue says
    // "revenue entries" rather than the investment branch of a two-way ternary.
    const noun = importedTotal === 1 ? TXN_NOUN[type].one : TXN_NOUN[type].many;
    toast.success(
      skippedTotal > 0
        ? `Imported ${n.number(importedTotal)} ${noun} — skipped ${n.number(
            skippedTotal
          )} invalid row(s)`
        : `Imported ${n.number(importedTotal)} ${noun}`
    );
    // clearBatch, not reset: the tag belongs to the batch that just landed, and
    // the caller closes this modal without ever calling `onClose`.
    clearBatch();
    onImported();
  }

  async function handleImport() {
    if (!rows) return;
    // Every valid row in the FILE, not only the ones the preview table rendered
    // — the table is capped at `IMPORT_PREVIEW_ROWS`, the import never is. The
    // payload may therefore be larger than one call allows; `submit` splits it
    // (transactions-ledger-010).
    //
    // The type guard is the point: a row whose amount we could not read has
    // `amount: null` and cannot reach the payload below, so there is no path
    // that sends an invented number to the server.
    const valid = rows.filter((r): r is ParsedRow & { amount: number } => {
      return r.valid && r.amount !== null;
    });
    if (valid.length === 0) {
      toast.error("No valid rows to import");
      return;
    }
    await submit(
      valid.map((r) => ({
        amount: r.amount,
        category: r.category,
        description: r.description,
        date: r.date,
      })),
      false
    );
  }

  /**
   * "Done" on the duplicate prompt. `onImported`, not `onClose`, because a
   * partial import has already written rows the page behind is not showing yet
   * — only `onImported` refreshes it (expenses-client.tsx:712 and the two other
   * ledger clients). Unconditional here, and harmless when nothing was
   * imported: this button is only ever on screen with the prompt. `handleClose`
   * makes the same call for the other three exits, where it has to be
   * conditional — a plain cancel that wrote nothing should not re-fetch.
   */
  function finishBatch() {
    clearBatch();
    onImported();
  }

  /**
   * The template the page offers, built from `categories` — the same list the
   * preview validates against, so this file always imports (see TEMPLATE_ROWS
   * and transactions-ledger-002 in the header).
   */
  const templateHref = useMemo(() => {
    const sample = ["date,amount,category,description"]
      .concat(
        TEMPLATE_ROWS[type].map((r) => {
          const category = categories[r.categoryIndex % categories.length];
          return `${r.date},${r.amount},${category},${r.description}`;
        })
      )
      .join("\n");
    return `data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`;
  }, [type, categories]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Import ${TXN_NOUN[type].title} from CSV`}
      description="Upload a CSV with date, amount, category, and description columns."
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a
            href={templateHref}
            download={`founderflow-${TXN_NOUN[type].slug}-template.csv`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-forest-strong hover:underline"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download template
          </a>
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            Valid categories: {n.number(categories.length)}
          </span>
        </div>

        {/* transactions-ledger-010. The limits, BEFORE the file picker. The
            per-call cap used to be stated only by the server's rejection, which
            arrived after the customer had chosen a file, waited for a preview
            and pressed Import — so the first thing they learned about the
            product's capacity was that their history did not fit. A single
            template literal rather than interpolated fragments, so the sentence
            is one text node and reads as one sentence to a screen reader. */}
        <p className="text-xs text-fg-muted">
          {`Up to ${n.number(IMPORT_MAX_TOTAL_ROWS)} rows per file (${n.number(
            megabytes(IMPORT_MAX_FILE_BYTES)
          )} MB), imported in batches of ${n.number(IMPORT_MAX_ROWS_PER_BATCH)}.`}
        </p>

        {projects.length > 0 ? (
          <div>
            <label
              htmlFor={projectSelectId}
              className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              Project{" "}
              <span className="font-sans normal-case tracking-normal text-fg-muted/60">
                (optional, applies to every row)
              </span>
            </label>
            <select
              id={projectSelectId}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full appearance-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
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
            {type === "expense" && (
              <p className="mt-1.5 text-xs text-fg-muted">
                Budgets are per project, so untagged expenses count against no cap.
              </p>
            )}
          </div>
        ) : (
          // No projects yet is the finding's own onboarding scenario: the
          // customer whose FIRST act is to import their spend history has
          // nothing to tag it to, so every budget they create afterwards reads 0
          // spent for this spend. There is no picker to render in that state —
          // but the silence is what made the original bug invisible, so say it.
          type === "expense" && (
            <p className="rounded-xl border border-border bg-bg/40 px-4 py-3 text-xs text-fg-muted">
              No projects yet, so there&apos;s nothing to tag this batch to. Budgets are per
              project, so these expenses will count against no cap — and an imported expense
              can&apos;t be re-tagged afterwards. Create a project first if you want this spend
              budgeted.
            </p>
          )
        )}

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
                {n.number(validCount)} valid
              </span>
              {skipCount > 0 && (
                <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning">
                  {n.number(skipCount)} skipped
                </span>
              )}
              <button
                type="button"
                onClick={reset}
                className="ms-auto text-xs font-semibold text-fg-muted hover:text-fg"
              >
                Choose another file
              </button>
            </div>

            {batchCount > 1 && (
              // transactions-ledger-010. What pressing Import is about to do,
              // before it is pressed. The alternative this replaces is not a
              // quieter version of the same thing: it was a single zod refusal
              // and zero inserts, with the cap named for the first time in the
              // error.
              <p className="rounded-xl border border-border bg-bg/40 px-4 py-3 text-xs text-fg-muted">
                {`${n.number(validCount)} rows is more than one batch, so this will be sent in ${n.number(
                  batchCount
                )} batches of up to ${n.number(
                  IMPORT_MAX_ROWS_PER_BATCH
                )}. Leave this window open until it finishes.`}
              </p>
            )}

            {file && mapping && (
              // transactions-ledger-014. Which column each field was read from,
              // and a control to change it. Detection is a ranked guess over the
              // header row — it cannot know that a file's "Subtotal" is not its
              // amount — and the preview below renders the chosen column's
              // values exactly as confidently whether the choice was right or
              // wrong. So the choice is stated, and it is correctable.
              <div className="rounded-xl border border-border bg-bg/40 px-4 py-3">
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
                  Columns we&apos;re reading
                </p>
                <p className="mt-1 text-xs text-fg-muted">
                  Detected from your header row. Change any that&apos;s wrong — the preview below
                  re-reads your file.
                </p>
                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                  {MAPPING_FIELDS.map((field) => {
                    const selectId = `${mappingIdBase}-${field}`;
                    const rivals = detected?.[field].rivals ?? [];
                    return (
                      <div key={field}>
                        <label
                          htmlFor={selectId}
                          className="mb-1 block text-xs font-semibold text-fg"
                        >
                          {COLUMN_LABEL[field]} column
                        </label>
                        <select
                          id={selectId}
                          value={String(mapping[field])}
                          onChange={(e) => setColumn(field, Number(e.target.value))}
                          // Locked once rows have been offered to the server: the
                          // duplicate prompt below holds the exact rows it
                          // withheld, and re-reading the file underneath it would
                          // leave "import anyway" re-sending a batch that is no
                          // longer the one on screen. Same reason the Import
                          // button is disabled while that question is open.
                          disabled={busy || heldBack !== null}
                          className="w-full appearance-none rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none disabled:opacity-60"
                        >
                          {field === "description" && (
                            <option value="-1" className="bg-bg">
                              Not imported
                            </option>
                          )}
                          {file.headers.map((_, i) => (
                            <option key={i} value={String(i)} className="bg-bg">
                              {headerLabel(file.headers, i)}
                            </option>
                          ))}
                        </select>
                        {rivals.length > 0 && (
                          // A tie on match quality: nothing in the header row
                          // ranks these, so the column we picked was picked by
                          // position. Name the other one rather than let a coin
                          // toss over somebody's money look like a reading.
                          <p className="mt-1 text-xs text-warning">
                            Also matched{" "}
                            {rivals.map((i) => `“${headerLabel(file.headers, i)}”`).join(", ")} —
                            check this is the right one.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {dateOrder !== null && (
              // The order was INFERRED from the column, so say which one was
              // chosen. A guess made silently is the whole of
              // transactions-ledger-003: the preview showed a transposed date
              // as confidently as a correct one.
              <p className="text-xs text-fg-muted">{DATE_ORDER_NOTE[dateOrder]}</p>
            )}

            <div className="max-h-72 overflow-auto rounded-xl border border-border">
              <table className="w-full text-start text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      Date
                    </th>
                    <th
                      className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
                      title="Shown in your workspace currency, exactly as it will be saved"
                    >
                      Amount as saved
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
                  {(shownRows ?? []).map((r, i) => (
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
                        {r.amount === null ? (
                          // Echo the cell we refused, so the user can find it.
                          <span className="text-danger">{r.rawAmount || "—"}</span>
                        ) : (
                          money(r.amount)
                        )}
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

            {hiddenRows > 0 && (
              // transactions-ledger-010. One <tr> per row with no bound is what
              // made a real export freeze the tab before the customer had agreed
              // to anything. Say that the rows below the cut were still CHECKED,
              // because a preview that had quietly stopped validating would be
              // the worse bug, and say how many of them are skipped — the
              // preview carries no row numbers, so that count is all this notice
              // can honestly offer towards finding them.
              <p className="text-xs text-fg-muted">
                {`Showing the first ${n.number(shownRows?.length ?? 0)} of ${n.number(
                  rows.length
                )} rows. Every row was checked, and the counts above cover the whole file.` +
                  (hiddenSkipCount > 0
                    ? ` ${n.number(hiddenSkipCount)} of the skipped rows are further down the file.`
                    : "")}
              </p>
            )}
          </>
        )}

        {heldBack && (
          // transactions-ledger-008. Phrased as what the customer can check —
          // the four fields that have to match — because "duplicate" on its own
          // reads like a complaint about their file rather than a statement
          // about their ledger.
          <div className="rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3">
            <p className="text-sm font-semibold text-fg">
              {heldBack.rows.length === 1
                ? "1 row looks like a duplicate of an entry you already have"
                : `${n.number(heldBack.rows.length)} rows look like duplicates of entries you already have`}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Same date, amount, category and description as something already in this ledger, or as
              another row in this file.{" "}
              {heldBack.imported > 0
                ? `The other ${n.number(heldBack.imported)} ${
                    heldBack.imported === 1 ? "row was" : "rows were"
                  } imported.`
                : "Nothing was imported."}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit(heldBack.rows, true)}
                disabled={busy}
                className="rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
              >
                {busy
                  ? progress
                    ? `Batch ${n.number(progress.batch)} of ${n.number(progress.of)}…`
                    : "Importing…"
                  : `Import ${n.number(heldBack.rows.length)} anyway`}
              </button>
              <button
                type="button"
                onClick={finishBatch}
                disabled={busy}
                className="rounded-full border border-border px-4 py-1.5 text-xs font-semibold text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-60"
              >
                Done
              </button>
            </div>
          </div>
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
            // `heldBack` disables it: the preview still reads "Import 2" over
            // the same rows, and pressing it again is a second write attempt
            // that leaves the duplicate question unanswered.
            disabled={busy || !rows || validCount === 0 || heldBack !== null}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <FileUp className="h-4 w-4" aria-hidden="true" />
            {busy
              ? // transactions-ledger-010. A multi-batch import takes several
                // round trips, so an unchanging "Importing…" over a 10,000-row
                // file is indistinguishable from a hung one — which is what
                // invites the retry that doubles a ledger.
                progress
                ? `Batch ${n.number(progress.batch)} of ${n.number(progress.of)}…`
                : "Importing…"
              : validCount > 0
                ? `Import ${n.number(validCount)}`
                : "Import"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
