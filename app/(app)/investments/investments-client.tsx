"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Calculator,
  Filter,
  Pencil,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  Wallet,
} from "lucide-react";
import toast from "react-hot-toast";
import { deleteTransactionAction } from "@/lib/actions/transactions";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { LedgerTruncationNotice } from "@/components/transactions/ledger-truncation-notice";
import { TransactionCommentButton } from "@/components/transactions/transaction-comment-button";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { CommentThreadModal } from "@/components/comments/comment-thread-modal";
import { useCommentDeepLink } from "@/components/comments/comment-deep-link";
import { INVESTMENT_CATEGORIES, type Transaction, type User } from "@/lib/types";
// TYPE-ONLY, so lib/queries' server graph stays out of the client bundle.
import type { TransactionWithCount, TypeTotal, UserContribution } from "@/lib/queries/transactions";
import { useMoney } from "@/lib/hooks/useMoney";
import { useDateFormat, useNumberFormat } from "@/lib/i18n/use-t";

const ROLE_LABEL = {
  admin: "Admin Founder",
  cofounder: "Co-Founder",
  member: "Team Member",
} as const;

/* ─────────────────────────────────────────────────────────────────────────── *
 * /investments' money figures, as pure functions over EITHER an aggregate or the
 * row array (transactions-ledger-001, the tail of money-008).
 *
 * WHAT WAS WRONG. "Total raised", "Avg cheque", the contributor count and every
 * per-founder bar were computed from `transactions`, which is
 * `getTransactions()` — a LIST window capped at `MAX_TRANSACTIONS_PER_TYPE`
 * (5,000 per type) whose docstring ends "DO NOT SUM THE RESULT".
 *
 * THIS PAGE IS WHERE THAT HURT MOST. The rows a ceiling drops are the OLDEST,
 * and a startup's oldest rows are its seed investments — so the founder whose
 * capital started the company is the first person whose bar shrinks, on the one
 * page that exists to show it, and a founder who stopped investing early
 * disappears from the breakdown entirely.
 *
 * Pinned by tests/app/finance/uncapped-totals.test.ts, which also asserts
 * app/(app)/investments/page.tsx actually passes the aggregates.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The server-side aggregates /investments needs, in one prop. */
export interface InvestmentRollups {
  /** `getTransactionTotals().byType.investment` — whole-ledger capital sum + row
   *  count, neither of them capped. */
  investment: TypeTotal;
  /** `getContributionTotalsByUser()` — keyed by `Transaction.addedBy`. */
  contributions: Record<string, UserContribution>;
}

export interface InvestmentHeadline {
  /** All-time capital raised. */
  total: number;
  /** All-time investment ROW COUNT — the denominator of the average, and the
   *  "N contributions" caption. */
  count: number;
  /** `total / count`, NOT pre-rounded (money-001). */
  average: number;
}

export function investmentHeadline(
  investments: Transaction[],
  rollups?: InvestmentRollups
): InvestmentHeadline {
  const total = rollups ? rollups.investment.total : investments.reduce((s, t) => s + t.amount, 0);
  const count = rollups ? rollups.investment.count : investments.length;
  return { total, count, average: count > 0 ? total / count : 0 };
}

/**
 * Capital contributed per person, biggest first, zero-contributors omitted.
 *
 * Keyed by `Transaction.addedBy` (who RECORDED the row), matching what the page
 * has always displayed and what /dashboard's identical card uses, so the two
 * cannot quote different figures for the same founder.
 */
export function founderStatRows(
  users: User[],
  investments: Transaction[],
  rollups?: InvestmentRollups
): { name: string; amount: number; role: User["role"] }[] {
  const investedBy = (id: string): number =>
    rollups
      ? (rollups.contributions[id]?.investment ?? 0)
      : investments.filter((t) => t.addedBy === id).reduce((s, t) => s + t.amount, 0);
  return users
    .map((u) => ({ name: u.name, amount: investedBy(u.id), role: u.role }))
    .filter((f) => f.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

type Props = {
  /** Rows WITH their comment counts: `getTransactions` has always included
   *  `_count.comments` for every type, and since transactions-ledger-016 this
   *  page renders it instead of discarding it. */
  transactions: TransactionWithCount[];
  /** Doubles as the founder-contribution roster and the @-mention list a
   *  thread resolves `@name` against. */
  users: User[];
  projects: { id: string; name: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  /** Server-side aggregates, from app/(app)/investments/page.tsx. Every money
   *  figure on this page is short by whatever the 5,000-row-per-type list read
   *  dropped without them. */
  rollups: InvestmentRollups;
  /** `Company.currency`, from the row page.tsx fetched (transactions-ledger-006).
   *  Required rather than optional: the store's copy is absent for a whole
   *  server-action round-trip after sign-in, so a page that forgets this renders
   *  a USD workspace's money — and its amount input's label — in rupees, and
   *  `npm run typecheck` is the right place to catch that. */
  currency: string;
};

export function InvestmentsClient({
  transactions,
  users,
  projects,
  currentUserId,
  currentUserRole,
  rollups,
  currency,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  // The server's value, not the store's: see the `currency` prop above. The form
  // below takes the same one, so the figures and the question cannot disagree.
  const money = useMoney(currency);
  const n = useNumberFormat();
  const d = useDateFormat();

  const investments = useMemo(
    () => transactions.filter((t) => t.type === "investment"),
    [transactions]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  // Active row being corrected (null = closed). money-016 — a mistyped figure
  // has to be fixable in place, not only deletable.
  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  // Active row whose comment thread is open (null = closed).
  // transactions-ledger-016 — a cheque is exactly the kind of row that needs a
  // "what was this for?" trail next to it.
  const [commentingTxn, setCommentingTxn] = useState<TransactionWithCount | null>(null);
  const mentionUsers = useMemo(() => users.map((u) => ({ id: u.id, name: u.name })), [users]);

  /* ── A MENTION ON A CAPITAL ROW OPENS ITS THREAD (tasks-and-comments-003) ──
   *
   * `createCommentAction` picks the ledger from the row's own `type`
   * (transactions-ledger-016), so a comment on an investment sends its
   * "<name> mentioned you" to `/investments?transactionId=<id>&comment=<id>`.
   * This island read NO search param at all, so that link resolved to a bare
   * /investments — and a cheque is exactly the row whose "what was this for?"
   * trail somebody is being pinged about.
   *
   * THE THREAD, NOT THE ROW. Same deliberate scope as /revenue: scrolling to the
   * ROW needs the dual-layout ref machinery /expenses carries, and it buys little
   * once the thread is open on top of the page titled with the row's description
   * and amount. See the matching comment in revenue-client.tsx.
   */
  const searchParams = useSearchParams();
  const highlightIdParam = searchParams.get("transactionId");
  const commentIdParam = searchParams.get("comment");
  /** The one comment to scroll to inside the opened thread. Null when a reader
   *  opened the thread from the row's own button. */
  const [commentDeepLinkId, setCommentDeepLinkId] = useState<string | null>(null);
  useCommentDeepLink({
    commentId: commentIdParam,
    targetId: highlightIdParam,
    // `investments`, not `filtered`: a reader following the bell from this very
    // page still has their search text applied, and the thread they were sent to
    // must not depend on it.
    rows: investments,
    onOpen: (t) => {
      setCommentingTxn(t);
      setCommentDeepLinkId(commentIdParam);
    },
  });

  function refresh() {
    startTransition(() => router.refresh());
  }

  const filtered = useMemo(
    () =>
      investments.filter((t) => {
        const matchSearch =
          !search ||
          t.description.toLowerCase().includes(search.toLowerCase()) ||
          t.category.toLowerCase().includes(search.toLowerCase()) ||
          t.addedByName.toLowerCase().includes(search.toLowerCase());
        const matchCategory = categoryFilter === "all" || t.category === categoryFilter;
        return matchSearch && matchCategory;
      }),
    [investments, search, categoryFilter]
  );

  // From the aggregates, never from `investments`: that array is a
  // 5,000-row-per-type LIST window whose own docstring says not to sum it.
  const {
    total: totalInvestments,
    count: investmentCount,
    average: avgInvestment,
  } = useMemo(() => investmentHeadline(investments, rollups), [investments, rollups]);

  const founderStats = useMemo(
    () => founderStatRows(users, investments, rollups),
    [users, investments, rollups]
  );

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this investment?",
      // Same sentence as /expenses and /revenue, for the reason spelled out in
      // app/(app)/expenses/expenses-client.tsx: delete writes a `deletedAt`
      // tombstone (data-integrity-001), nothing purges an individually deleted
      // transaction, and recovery is an operator's UPDATE rather than a button.
      description:
        "It leaves your ledger, reports and exports immediately. Nothing is erased, though — " +
        "contact support right away and it can be restored.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteTransactionAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Investment deleted");
    refresh();
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="forest">Money in</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Investments
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Capital injected by founders and outside investors.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <Upload className="h-4 w-4" aria-hidden="true" /> Import CSV
          </button>
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add investment
          </button>
        </div>
      </header>

      <section aria-label="Investment metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total raised"
          value={money(totalInvestments)}
          icon={TrendingUp}
          tone="primary"
          delta="positive"
          deltaLabel={`${n.number(investmentCount)} contributions`}
        />
        <DashboardStat
          label="Contributors"
          value={n.number(founderStats.length)}
          icon={Users}
          tone="forest"
          deltaLabel={founderStats.length === 0 ? "No data yet" : "Active founders"}
        />
        <DashboardStat
          label="Avg / contribution"
          // Not pre-rounded: `money()` rounds to the stored scale, and
          // `Math.round` first threw the cents away before formatting (money-001).
          value={money(avgInvestment)}
          icon={Calculator}
          tone="mint"
          deltaLabel={`Across ${n.number(investmentCount)} entries`}
        />
      </section>

      {founderStats.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Who put in what
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Founder contributions</h3>
          </div>
          <div className="space-y-5">
            {founderStats.map((f) => {
              // A 0–1 ratio, the scale `n.percent` takes (lib/format.ts explains
              // why it matches Intl and not the old 0–100 call sites). The bar below
              // re-multiplies for its CSS `width`, which is a length, not a number
              // anyone reads.
              const ratio = totalInvestments > 0 ? f.amount / totalInvestments : 0;
              return (
                <div key={f.name} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Avatar name={f.name} size="md" />
                    <div className="flex flex-1 items-center justify-between">
                      <div>
                        <p className="font-semibold text-fg">{f.name}</p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                          {ROLE_LABEL[f.role]}
                        </p>
                      </div>
                      <div className="text-end">
                        <p className="font-mono text-base font-bold tabular-nums text-fg">
                          {money(f.amount)}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-primary-strong">
                          {n.percent(ratio)}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="ms-14 h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-700"
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section
        aria-label="Filter investments"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="investment-search" className="sr-only">
            Search investments
          </label>
          <input
            id="investment-search"
            placeholder="Search description, source, or person…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg py-2.5 pe-4 ps-10 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="investment-category" className="sr-only">
            Filter by source
          </label>
          <select
            id="investment-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pe-4 ps-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">All sources</option>
            {INVESTMENT_CATEGORIES.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* The table below is a WINDOW: at most MAX_TRANSACTIONS_PER_TYPE rows,
            oldest dropped first — which on this page means the seed round — and
            there is no pagination to reach them with. Renders nothing until the
            window is actually short of the ledger (transactions-ledger-001). */}
        <LedgerTruncationNotice
          shown={investments.length}
          total={rollups.investment.count}
          noun="investments"
        />
        {filtered.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={
              investments.length === 0 ? "No investments yet" : "No investments match your filters"
            }
            description={
              investments.length === 0
                ? "Log founder contributions or external funding to track your runway."
                : "Try adjusting your search or filter."
            }
            action={
              investments.length === 0 && (
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add first investment
                </button>
              )
            }
          />
        ) : (
          <div className="scrollbar-thin hidden overflow-x-auto md:block">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Description
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Source
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Added by
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Date
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-end font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Amount
                  </th>
                  <th scope="col" className="px-6 py-3.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                  >
                    <td className="px-6 py-4">
                      <p className="text-sm font-medium text-fg">{t.description}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full border border-forest/30 bg-forest/10 px-2.5 py-0.5 text-xs font-medium text-forest-strong">
                        {t.category}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Avatar name={t.addedByName} size="xs" />
                        <span className="text-sm text-fg">{t.addedByName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs uppercase tracking-wider text-fg-muted">
                      {d.date(t.date)}
                    </td>
                    <td className="px-6 py-4 text-end">
                      <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums text-primary-strong">
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        {money(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-end">
                      <div className="inline-flex items-center gap-1">
                        {/* OUTSIDE the mine-or-admin fence below: discussing a
                            figure is not changing it, and `canSeeFinances` —
                            which every reader of this page has passed — is the
                            only predicate either server gate applies
                            (transactions-ledger-016). */}
                        <TransactionCommentButton
                          count={t.commentCount}
                          description={t.description}
                          onClick={() => setCommentingTxn(t)}
                        />
                        {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                          <>
                            {/* Same permission rule as delete, because a
                                correction moves money just as effectively. */}
                            <button
                              onClick={() => setEditingTxn(t)}
                              aria-label={`Edit investment ${t.description}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-primary/10 hover:text-primary-strong"
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button>
                            <button
                              onClick={() => handleDelete(t.id)}
                              aria-label={`Delete investment ${t.description}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile card fallback (F10). */}
        {filtered.length > 0 && (
          <ul className="divide-y divide-border md:hidden">
            {filtered.map((t) => (
              <li key={t.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm font-medium text-fg">{t.description}</p>
                  <span className="inline-flex shrink-0 items-center gap-1 font-mono text-sm font-bold tabular-nums text-primary-strong">
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    {money(t.amount)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-forest/30 bg-forest/10 px-2.5 py-0.5 text-xs font-medium text-forest-strong">
                    {t.category}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <Avatar name={t.addedByName} size="xs" /> {t.addedByName}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                    {d.date(t.date)}
                  </span>
                  <div className="ms-auto flex items-center gap-1">
                    <TransactionCommentButton
                      count={t.commentCount}
                      description={t.description}
                      onClick={() => setCommentingTxn(t)}
                    />
                    {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                      <>
                        <button
                          onClick={() => setEditingTxn(t)}
                          aria-label={`Edit investment ${t.description}`}
                          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-primary/10 hover:text-primary-strong"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          onClick={() => handleDelete(t.id)}
                          aria-label={`Delete investment ${t.description}`}
                          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportTransactionsModal
        type="investment"
        projects={projects}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          refresh();
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add new investment"
        description="Record capital injected into your company"
      >
        <TransactionForm
          type="investment"
          projects={projects}
          serverCurrency={currency}
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>

      {/* Correcting a row, rather than deleting and retyping it (money-016).
          Keyed on the row id so reopening on a different entry remounts the
          form with that row's values instead of the last one's. */}
      {editingTxn && (
        <Modal
          open={Boolean(editingTxn)}
          onClose={() => setEditingTxn(null)}
          title="Edit investment"
          description="Correct the amount, category, date or description. The change is recorded in the activity feed."
        >
          <TransactionForm
            key={editingTxn.id}
            type="investment"
            editing={editingTxn}
            serverCurrency={currency}
            onClose={() => setEditingTxn(null)}
            onSuccess={refresh}
          />
        </Modal>
      )}

      {/* The thread, same component and same shape as /expenses and /revenue.
          `onChanged={refresh}` is what keeps the row's count badge honest after
          a post or a delete. */}
      {commentingTxn && (
        <CommentThreadModal
          open={Boolean(commentingTxn)}
          onClose={() => {
            setCommentingTxn(null);
            setCommentDeepLinkId(null);
          }}
          highlightCommentId={commentDeepLinkId}
          target={{ transactionId: commentingTxn.id }}
          title={`Comments · ${commentingTxn.description}`}
          description={`${money(commentingTxn.amount)} — ${commentingTxn.category}`}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
