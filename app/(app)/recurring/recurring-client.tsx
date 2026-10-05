"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDown, ArrowUp, Calendar, Pause, Play, Plus, Repeat, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  createRecurringRuleAction,
  deleteRecurringRuleAction,
  toggleRecurringRuleAction,
} from "@/lib/actions/recurring";
import { z } from "zod";
import {
  recurringAmountField,
  recurringDayOfMonthField,
  recurringDayOfWeekField,
  type NewRecurringRuleInput,
} from "@/lib/schemas/recurring";

/**
 * Form-level schema: a flat object that always has BOTH day fields, with
 * runtime refinement that the correct one is set for the chosen frequency.
 * We need this because react-hook-form keeps both fields registered at all
 * times (so toggling the segmented control doesn't drop user input), but
 * the server-side NewRecurringRuleSchema is a discriminated union and
 * rejects payloads that carry the wrong day field.
 *
 * At submit time we narrow this flat shape into the discriminated union
 * before calling the server action.
 *
 * `amount` is IMPORTED from the server schema rather than restated (money-002).
 * A restated copy is how this mirror ended up without the scale rule while the
 * transaction form had it: 0.004 passed every rule here, and a `Decimal(12, 2)`
 * column stored the rule and its seed expense as 0.00 — then re-posted 0.00
 * every month, silently.
 */
const FormSchema = z
  .object({
    type: z.enum(["expense", "investment"]),
    amount: recurringAmountField,
    category: z.string().min(1, "Pick a category"),
    description: z.string().trim().max(500),
    // The optional project tag (money-005). `""` is the "no project" option; it
    // is narrowed to `undefined` in `onSubmit` rather than here, because the
    // <select> needs a string to hold.
    projectId: z.string().optional(),
    frequency: z.enum(["monthly", "weekly"]),
    // Also IMPORTED, not restated (finance-planning-016). The restated copies
    // carried no messages at all, so clearing the pre-filled "Day of month"
    // input — which `valueAsNumber` turns into `NaN` — rendered Zod's own
    // "Expected number, received nan" under the label, and the object
    // refinement below never ran to say anything better (a refinement is
    // skipped once the inner object fails).
    dayOfMonth: recurringDayOfMonthField.optional(),
    dayOfWeek: recurringDayOfWeekField.optional(),
  })
  .refine((d) => (d.frequency === "monthly" ? d.dayOfMonth != null : d.dayOfWeek != null), {
    message: "Pick a day for the chosen frequency",
    path: ["dayOfMonth"],
  });

type FormSchemaInput = z.infer<typeof FormSchema>;
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatUtcDate } from "@/lib/utils";
import { nextDueDateFor } from "@/lib/recurring/materialize";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";
import type { RecurringRuleClient } from "@/lib/queries/recurring";
import { canManageRecurringRule } from "@/lib/recurring/manage-gate";
import { useCurrency, useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Props = {
  rules: RecurringRuleClient[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  /**
   * The projects this caller may file spend against, from `listProjectOptions()`
   * in the page's Server Component (money-005). An empty list renders no picker
   * — the tag is optional and a workspace with no projects has nothing to pick.
   *
   * REQUIRED rather than defaulted so `tsc` refuses a page that forgets to pass
   * it: a picker with nothing to offer is the same unreachable-server-path bug
   * this prop exists to close.
   */
  projects: { id: string; name: string }[];
  /**
   * The SERVER's clock at render time, for the next-due date on each card
   * (finance-planning-020).
   *
   * A prop rather than `useMemo(() => new Date())` for the reason time-011
   * records: that memo runs once on the server and again at hydration — two
   * different instants — so the two renders disagree whenever they fall either
   * side of a UTC midnight and React logs a mismatch. Taking the instant from
   * the RSC makes them identical by construction, and `router.refresh()` brings
   * a fresh one, where a memo would have frozen "today" at first mount for ever.
   *
   * REQUIRED rather than defaulted, like `projects` above: a defaulted clock is
   * one a page can silently forget to pass, and the fallback would reintroduce
   * exactly the mismatch this closes.
   */
  serverNowMs: number;
};

export function RecurringClient({
  rules,
  currentUserId,
  currentUserRole,
  projects,
  serverNowMs,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleToggle(rule: RecurringRuleClient) {
    setPendingId(rule.id);
    const res = await toggleRecurringRuleAction({ ruleId: rule.id, active: !rule.active });
    setPendingId(null);
    if (res.success) {
      toast.success(rule.active ? "Rule paused" : "Rule resumed");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleDelete(rule: RecurringRuleClient) {
    const ok = await confirm({
      title: "Delete this recurring rule?",
      description:
        "Past transactions generated by this rule stay in history; only the future schedule stops.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setPendingId(rule.id);
    const res = await deleteRecurringRuleAction(rule.id);
    setPendingId(null);
    if (res.success) {
      toast.success("Rule deleted");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="forest">On schedule</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Recurring
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Rent, salaries, subscriptions — set them up once and they post on their own. A daily job
            creates the next instance when it&apos;s due.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New rule
        </button>
      </header>

      {rules.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Repeat}
            title="No recurring rules yet"
            description="Set up a monthly office rent or a weekly subscription and stop logging it by hand."
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> Add first rule
              </button>
            }
          />
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              serverNowMs={serverNowMs}
              pending={pendingId === rule.id}
              onToggle={() => handleToggle(rule)}
              onDelete={() => handleDelete(rule)}
            />
          ))}
        </section>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New recurring rule"
        description="Pick how often and which day — we'll create the first transaction right away."
        size="lg"
      >
        <NewRuleForm
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

function RuleCard({
  rule,
  currentUserId,
  currentUserRole,
  serverNowMs,
  pending,
  onToggle,
  onDelete,
}: {
  rule: RecurringRuleClient;
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  serverNowMs: number;
  pending: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const money = useMoney();
  const n = useNumberFormat();
  // The same decision the two server actions make, imported rather than
  // mirrored (finance-planning-013): once the creator has been deactivated, the
  // creator-or-admin rule names somebody who can never sign in again, and a
  // co-founder was left looking at a standing charge with no Pause and no
  // Delete. CLAUDE.md asks the two layers to agree; a copied expression is how
  // they stop agreeing.
  const canManage = canManageRecurringRule(
    { addedBy: rule.addedBy, authorRemoved: rule.authorRemoved },
    { id: currentUserId, role: currentUserRole }
  );
  const frequencyLabel =
    rule.frequency === "monthly"
      ? `Monthly · day ${rule.dayOfMonth}`
      : `Weekly · ${DAY_NAMES[rule.dayOfWeek ?? 0]}`;

  /* ── When does this charge next? (finance-planning-020) ─────────────────── *
   * The card used to answer nothing. `nextDueDateFor` is the materializer's own
   * calendar — the same window, the same short-month clamp — so the date here
   * is the date the nightly job will act on rather than a second calculation
   * that can drift away from it.
   *
   * `authorRemoved` is the one state the schedule cannot see. The cron suspends
   * such a rule and writes NOTHING (no stamp, no `active: false`), so the row
   * still looks live; naming a next-due date here would contradict the notice
   * a few lines below that says the rule has stopped posting. A paused rule
   * needs no special case — `isRuleDueOn` already refuses to fire it, so the
   * walk comes back null on its own.
   */
  const nextDue = useMemo(
    () =>
      rule.authorRemoved
        ? null
        : nextDueDateFor(
            {
              active: rule.active,
              frequency: rule.frequency,
              dayOfMonth: rule.dayOfMonth,
              dayOfWeek: rule.dayOfWeek,
              startDate: new Date(rule.startDate),
              lastMaterializedAt: rule.lastMaterializedAt
                ? new Date(rule.lastMaterializedAt)
                : null,
            },
            new Date(serverNowMs)
          ),
    [rule, serverNowMs]
  );
  const todayUtcMs = useMemo(() => {
    const now = new Date(serverNowMs);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }, [serverNowMs]);

  let scheduleLine: string;
  let scheduleTone: string;
  if (nextDue === null) {
    // Paused is the founder's own decision, so it is named; the other way in
    // here is the suspension above, which the red notice explains. There is a
    // third, unreachable through the zod union today: an ACTIVE rule that can
    // never fire — monthly with a null `dayOfMonth`, an unrecognised
    // `frequency` — which would render in this same muted, deliberately-idle
    // weight. If the frequency enum ever grows, that case needs a louder
    // string of its own, because a broken rule must not read as a quiet one.
    scheduleLine = rule.active ? "Nothing scheduled" : "Paused · nothing scheduled";
    scheduleTone = "text-fg-muted";
  } else if (nextDue.getTime() > todayUtcMs) {
    scheduleLine = `Next due ${formatUtcDate(nextDue)}`;
    scheduleTone = "font-bold text-fg";
  } else {
    // A due date at or before today means the job has not posted it yet, and a
    // date that has already PASSED is the only visible evidence of a run that
    // has been failing for a month. That one is red.
    //
    // Today is neutral, and the reason is not "the run has not happened yet":
    // the materializer's slot is 00:05 UTC (`vercel.json`), so that window is
    // five minutes, not a few hours. It is neutral because two ordinary states
    // land here for the whole UTC day and neither is a fault — those five
    // minutes, and a rule RESUMED today after being paused across its due day,
    // which the cron skipped while it was inactive and will post at the next
    // 00:05. Crying wolf at the second of those is worse than waiting a day:
    // the line already says "not posted yet" out loud, and tomorrow it turns
    // red on its own.
    scheduleLine = `Due ${formatUtcDate(nextDue)} · not posted yet`;
    scheduleTone = nextDue.getTime() < todayUtcMs ? "font-bold text-danger" : "font-bold text-fg";
  }

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-surface p-6 transition-opacity",
        rule.active ? "border-border" : "border-border/40 opacity-70"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider",
                rule.type === "expense"
                  ? "border-mint/30 bg-mint/10 text-mint-strong"
                  : "border-primary/30 bg-primary/10 text-primary-strong"
              )}
            >
              {rule.type === "expense" ? (
                <ArrowDown className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ArrowUp className="h-3 w-3" aria-hidden="true" />
              )}
              {rule.type}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-forest/30 bg-forest/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-forest-strong">
              <Repeat className="h-3 w-3" aria-hidden="true" /> {rule.frequency}
            </span>
            {!rule.active && (
              <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg-muted">
                Paused
              </span>
            )}
            {rule.authorRemoved && (
              <span className="rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-danger">
                Author removed
              </span>
            )}
          </div>
          <h3 className="truncate text-lg font-bold text-fg">{rule.category}</h3>
          {rule.description && (
            <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{rule.description}</p>
          )}
        </div>
        <p
          className={cn(
            "shrink-0 font-mono text-lg font-bold tabular-nums",
            rule.type === "expense" ? "text-mint-strong" : "text-primary-strong"
          )}
        >
          {money(rule.amount)}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-xs">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">Frequency</p>
          <p className="mt-1 flex items-center gap-1 font-medium text-fg">
            <Calendar className="h-3 w-3 text-fg-muted" aria-hidden="true" />
            {frequencyLabel}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">Created</p>
          <p className="mt-1 flex items-center gap-1.5 font-medium text-fg">
            <Avatar name={rule.addedByName} size="xs" />
            <span className="truncate">{rule.addedByName.split(" ")[0]}</span>
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">Generated</p>
          <p className="mt-1 font-medium text-fg">
            {n.number(rule.materializedCount)} txn{rule.materializedCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* finance-planning-020. The schedule, in the two facts a founder needs:
          when the money next leaves, and how far the job has already got.

          "COVERED THROUGH", NOT "LAST FIRED" — the label was false. Since the
          finance-planning-004 fix, `seedStampFor` stamps `lastMaterializedAt`
          FORWARD past the current period's occurrence (the seed transaction has
          already paid for it), so a day-15 rule created on the 3rd carries
          `2026-10-15` while its only posted row is dated the 3rd: the card
          printed a FUTURE date in the past tense. What the stamp actually means
          is "the scheduler owes nothing up to and including this day", which is
          also what explains the next-due date above it. The posting count lives
          in `Generated` and never needed this line.

          `formatUtcDate`, not `toLocaleDateString` (money-007): the stamp is a
          UTC-midnight date-only value, so a viewer west of UTC was shown the day
          before — `14/10/2026` for a stamp of `2026-10-15`. */}
      <div className="mt-3 space-y-1 font-mono text-[10px] uppercase tracking-wider">
        <p className={scheduleTone}>{scheduleLine}</p>
        {rule.lastMaterializedAt && (
          <p className="text-fg-muted">Covered through {formatUtcDate(rule.lastMaterializedAt)}</p>
        )}
      </div>

      {/* finance-planning-013. The nightly job suspends this rule — it posts
          nothing and changes nothing — so the card has to say so. Without this
          line the only place the change shows up is the customer's own books,
          a month later. */}
      {rule.authorRemoved && (
        <p className="mt-3 text-xs text-danger">
          {rule.addedByName.split(" ")[0]} was deactivated, so this rule has stopped posting. Delete
          it, or set the same charge up again under your own name.
        </p>
      )}

      {canManage && (
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
          <button
            onClick={onToggle}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-50"
          >
            {rule.active ? (
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
            aria-label={`Delete rule for ${rule.category}`}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
          </button>
        </div>
      )}
    </article>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* NewRuleForm                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

function NewRuleForm({
  projects,
  onClose,
  onCreated,
}: {
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const amountId = useId();
  const categoryId = useId();
  const projectFieldId = useId();
  const dayId = useId();
  const descId = useId();

  // money-011 — a rule's amount is entered in the workspace's currency, and this
  // one gets re-posted every month, so a mislabelled field compounds. Same source
  // as the `useMoney()` the rule cards render with.
  const currency = useCurrency();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormSchemaInput>({
    resolver: zodResolver(FormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      type: "expense",
      amount: undefined as unknown as number,
      category: EXPENSE_CATEGORIES[0],
      description: "",
      // "No project" is the default. Never the first project: that would file
      // rent against a budget nobody chose, and send an over-budget alert about
      // it (money-005).
      projectId: "",
      frequency: "monthly",
      dayOfMonth: 1,
    },
  });

  const type = watch("type");
  const frequency = watch("frequency");
  const categories = useMemo(
    () => (type === "expense" ? EXPENSE_CATEGORIES : INVESTMENT_CATEGORIES),
    [type]
  );

  async function onSubmit(data: FormSchemaInput) {
    // The optional project tag (money-005). `undefined`, NOT `""`: the action
    // parses the tag off the raw input with `.trim().min(1).nullish()`
    // (lib/actions/recurring.ts:53), so a literal empty string is refused as
    // "Invalid project" and an untagged rule could not be created at all.
    const projectId = data.projectId && data.projectId.length > 0 ? data.projectId : undefined;

    // Narrow the flat form shape into the discriminated union the server
    // action expects. The FormSchema refinement above already guaranteed
    // the right day field is set for the chosen frequency.
    const payload: NewRecurringRuleInput =
      data.frequency === "monthly"
        ? {
            type: data.type,
            amount: data.amount,
            category: data.category,
            description: data.description,
            projectId,
            frequency: "monthly",
            dayOfMonth: data.dayOfMonth ?? 1,
          }
        : {
            type: data.type,
            amount: data.amount,
            category: data.category,
            description: data.description,
            projectId,
            frequency: "weekly",
            dayOfWeek: data.dayOfWeek ?? 1,
          };

    const res = await createRecurringRuleAction(payload);
    if (res.success) {
      toast.success("Rule created — first transaction logged");
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
        <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          Type
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(["expense", "investment"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setValue("type", t, { shouldValidate: false });
                // Reset category to a valid one for the new type.
                setValue(
                  "category",
                  (t === "expense" ? EXPENSE_CATEGORIES : INVESTMENT_CATEGORIES)[0]
                );
              }}
              aria-pressed={type === t}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
                type === t
                  ? "border-primary/50 bg-primary/[0.06] text-fg ring-2 ring-primary/20"
                  : "border-border text-fg-muted hover:border-primary/30 hover:text-fg"
              )}
            >
              {t === "expense" ? "Expense" : "Investment"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={amountId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Amount ({currency})
          </label>
          <input
            id={amountId}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            {...register("amount", { valueAsNumber: true })}
            className={inputClass(!!errors.amount)}
          />
          {errors.amount && <p className="mt-1.5 text-xs text-danger">{errors.amount.message}</p>}
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
            {...register("category")}
            className={inputClass(!!errors.category)}
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
      </div>

      {/*
        The project tag (money-005). Every Budget belongs to a Project and the
        threshold check returns early on a null project, so an untagged rule can
        never trip an 80%/100% alert however much it posts — and recurring spend
        (rent, salaries, subscriptions) is exactly what a founder caps. The whole
        server path already carried the tag; this field is what reaches it.

        Hidden when the workspace has no projects: the tag is optional and there
        would be nothing to pick. Native <select> with the same `inputClass` as
        the Category select beside it, matching the project picker in
        components/transactions/transaction-form.tsx.
      */}
      {projects.length > 0 && (
        <div>
          <label
            htmlFor={projectFieldId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Project{" "}
            <span className="font-sans normal-case tracking-normal text-fg-muted/60">
              (optional)
            </span>
          </label>
          <select
            id={projectFieldId}
            {...register("projectId")}
            className={inputClass(!!errors.projectId)}
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
          <p className="mt-1.5 text-xs text-fg-muted">
            Tagged spend counts toward that project&apos;s budget, on the first posting and on every
            one the daily job creates after it.
          </p>
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
        <input
          id={descId}
          placeholder="Office rent / Team subscription / etc."
          {...register("description")}
          className={inputClass(!!errors.description)}
        />
        {errors.description && (
          <p className="mt-1.5 text-xs text-danger">{errors.description.message}</p>
        )}
      </div>

      <div>
        <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          Frequency
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(["monthly", "weekly"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setValue("frequency", f, { shouldValidate: false });
                if (f === "monthly") {
                  setValue("dayOfMonth", 1);
                  setValue("dayOfWeek", undefined);
                } else {
                  setValue("dayOfWeek", 1); // Monday default
                  setValue("dayOfMonth", undefined);
                }
              }}
              aria-pressed={frequency === f}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
                frequency === f
                  ? "border-primary/50 bg-primary/[0.06] text-fg ring-2 ring-primary/20"
                  : "border-border text-fg-muted hover:border-primary/30 hover:text-fg"
              )}
            >
              {f === "monthly" ? "Monthly" : "Weekly"}
            </button>
          ))}
        </div>
      </div>

      {frequency === "monthly" ? (
        <div>
          <label
            htmlFor={dayId}
            className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Day of month
          </label>
          <input
            id={dayId}
            type="number"
            inputMode="numeric"
            min="1"
            max="31"
            {...register("dayOfMonth", { valueAsNumber: true })}
            className={inputClass(!!errors.dayOfMonth)}
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            If a month has fewer days (e.g. 31 in Feb), the rule fires on the last day instead.
          </p>
          {errors.dayOfMonth && (
            <p className="mt-1.5 text-xs text-danger">{errors.dayOfMonth.message}</p>
          )}
        </div>
      ) : (
        <div>
          <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
            Day of week
          </p>
          <div className="grid grid-cols-7 gap-1.5">
            {DAY_NAMES.map((name, i) => {
              const active = watch("dayOfWeek") === i;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setValue("dayOfWeek", i, { shouldValidate: false })}
                  aria-pressed={active}
                  className={cn(
                    "rounded-lg border px-1 py-2 text-xs font-medium transition-all",
                    active
                      ? "border-primary/50 bg-primary/[0.06] text-fg ring-2 ring-primary/20"
                      : "border-border text-fg-muted hover:border-primary/30 hover:text-fg"
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
          {errors.dayOfWeek && (
            <p className="mt-1.5 text-xs text-danger">{errors.dayOfWeek.message}</p>
          )}
        </div>
      )}

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
          {isSubmitting ? "Creating…" : "Create rule"}
        </button>
      </div>
    </form>
  );
}
