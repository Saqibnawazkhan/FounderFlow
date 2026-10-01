"use client";

import { forwardRef, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Clock,
  Crown,
  Mail,
  MailWarning,
  RotateCcw,
  Send,
  Shield,
  Trash2,
  User as UserIcon,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  inviteUserAction,
  reactivateUserAction,
  removeUserAction,
  resendInviteAction,
  revokeInviteAction,
  updateUserRoleAction,
} from "@/lib/actions/team";
import { InviteUserSchema, type InviteUserInput } from "@/lib/schemas/user";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/hooks/useMoney";
import type {
  DeactivatedUser,
  PendingInvite,
  Task,
  Transaction,
  User,
  UserRole,
} from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";
import { canSeeFinances } from "@/lib/auth/role-gates";
import { useDateFormat, useNumberFormat } from "@/lib/i18n/use-t";

type Props = {
  users: User[];
  transactions: Transaction[];
  tasks: Task[];
  pendingInvites: PendingInvite[];
  deactivatedUsers: DeactivatedUser[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
};

export function TeamClient({
  users,
  transactions,
  tasks,
  pendingInvites,
  deactivatedUsers,
  currentUserId,
  currentUserRole,
}: Props) {
  const router = useRouter();
  const money = useMoney();
  const n = useNumberFormat();
  const d = useDateFormat();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingInviteId, setPendingInviteId] = useState<string | null>(null);
  /**
   * acct-016 on the Reactivate button. Scoped to the row that was pressed.
   *
   * `reactivateUserAction` refuses a restore that would overrun the plan's seat
   * cap with a three-option instruction — "Upgrade to Team in Settings, or
   * deactivate someone else, to restore <name>", built by `seatLimitMessage` — and
   * `toast.error(res.error)` was the whole delivery, at a toaster duration of
   * 3500ms (components/providers.tsx:186). Of the six toast-only handlers in this
   * file this was the worst: the button is at the bottom of a long page, the
   * toast is at the top of the viewport, and there is no dialog for the copy to
   * live in, so 3.5 seconds later nothing on the screen recorded that anything
   * had happened at all.
   *
   * Keyed by user id rather than held as one page-level string so the alert
   * renders in the row the admin actually pressed — a shared banner at the top of
   * the roster would be off-screen for exactly the click that produces it.
   *
   * The other four handlers keep their toast, deliberately. Each one's only
   * instruction-shaped message is unreachable from this UI, and the reasoning is
   * written out in tests/app/team/invite-error-surface.test.tsx so it can be
   * re-checked rather than taken on trust.
   */
  const [reactivateError, setReactivateError] = useState<{
    userId: string;
    message: string;
  } | null>(null);

  const isAdmin = currentUserRole === "admin";
  // Members don't see the per-member finance/task footer (invested, logged,
  // task tallies) for teammates — the server also withholds the transaction
  // data, this hides the cells.
  const showMemberStats = canSeeFinances(currentUserRole);

  // RSC refresh hook: server actions already call revalidatePath('/team'), so
  // router.refresh() picks up the new data on this tree without a full nav.
  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleRoleChange(userId: string, role: UserRole) {
    if (!isAdmin) return;
    // Promoting to admin grants billing + workspace-delete power — confirm it.
    // The <select> is controlled by the real role, so a cancel just snaps back.
    if (role === "admin") {
      const target = users.find((u) => u.id === userId);
      const ok = await confirm({
        title: `Make ${target?.name ?? "this member"} an admin?`,
        description:
          "Admins can manage billing, invite or remove anyone, change roles, and delete the workspace. You can change their role back later.",
        confirmLabel: "Make admin",
      });
      if (!ok) return;
    }
    setPendingUserId(userId);
    const res = await updateUserRoleAction({ userId, role });
    setPendingUserId(null);
    if (res.success) {
      toast.success("Role updated");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleRemove(userId: string, name: string) {
    const ok = await confirm({
      title: `Deactivate ${name}?`,
      description:
        "They lose access immediately, but their tasks, expenses, and activity stay in the records. You can reactivate them later.",
      confirmLabel: "Deactivate",
      tone: "danger",
    });
    if (!ok) return;
    setPendingUserId(userId);
    const res = await removeUserAction(userId);
    setPendingUserId(null);
    if (res.success) {
      toast.success(`${name} deactivated`);
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleReactivate(userId: string, name: string) {
    setPendingUserId(userId);
    // Cleared before the attempt, not after it: a refusal left sitting under a
    // fresh press reads as a second failure for the same reason.
    setReactivateError(null);
    const res = await reactivateUserAction(userId);
    setPendingUserId(null);
    if (res.success) {
      toast.success(`${name} reactivated`);
      refresh();
    } else {
      // The toast stays — it is what pulls the eye to the row. It is no longer
      // the only copy.
      setReactivateError({ userId, message: res.error });
      toast.error(res.error);
    }
  }

  async function handleResend(inviteId: string, email: string) {
    setPendingInviteId(inviteId);
    const res = await resendInviteAction(inviteId);
    setPendingInviteId(null);
    if (res.success) {
      if (res.data.emailSent) {
        toast.success(`Invite re-sent to ${email}`);
      } else {
        toast.success(
          `Invite refreshed. Email didn't send — copy this link: ${res.data.inviteUrl}`,
          {
            duration: 12_000,
          }
        );
        // eslint-disable-next-line no-console
        console.info("[invite] fallback URL:", res.data.inviteUrl);
      }
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleRevoke(inviteId: string, name: string) {
    const ok = await confirm({
      title: `Revoke ${name}'s invite?`,
      description: "Their invite link stops working immediately. You can always invite them again.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    setPendingInviteId(inviteId);
    const res = await revokeInviteAction(inviteId);
    setPendingInviteId(null);
    if (res.success) {
      toast.success("Invite revoked");
      refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="forest">Roster</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Team</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Manage co-founders and team members.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Invite member
          </button>
        )}
      </header>

      <section aria-label="Team metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total members"
          value={users.length.toString()}
          icon={Users}
          tone="primary"
          deltaLabel="In this workspace"
        />
        <DashboardStat
          label="Co-founders"
          value={users
            .filter((u) => u.role === "admin" || u.role === "cofounder")
            .length.toString()}
          icon={Crown}
          tone="forest"
          deltaLabel="Founder access"
        />
        <DashboardStat
          label="Team members"
          value={users.filter((u) => u.role === "member").length.toString()}
          icon={UserIcon}
          tone="mint"
          deltaLabel="Limited access"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {users.map((user) => {
          const userInvestments = transactions
            .filter((t) => t.addedBy === user.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const userExpenses = transactions
            .filter((t) => t.addedBy === user.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          const userTasks = tasks.filter((t) => t.assignedTo === user.id);
          const completedTasks = userTasks.filter((t) => t.status === "completed").length;

          return (
            <article
              key={user.id}
              className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6"
            >
              {user.role === "admin" && (
                <div className="absolute end-4 top-4">
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-primary-strong">
                    <Crown className="h-3 w-3" aria-hidden="true" /> Admin
                  </span>
                </div>
              )}

              <div className="flex items-start gap-4">
                <Avatar name={user.name} size="xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-lg font-bold text-fg">{user.name}</h3>
                    {user.id === currentUserId && (
                      <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg-muted">
                        You
                      </span>
                    )}
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-fg-muted">
                    <Mail className="h-3 w-3" aria-hidden="true" /> {user.email}
                  </p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                    Joined {d.date(user.createdAt)}
                  </p>

                  {isAdmin && user.id !== currentUserId ? (
                    <>
                      <label htmlFor={`role-${user.id}`} className="sr-only">
                        Change role for {user.name}
                      </label>
                      <select
                        id={`role-${user.id}`}
                        value={user.role}
                        disabled={pendingUserId === user.id}
                        onChange={(e) => handleRoleChange(user.id, e.target.value as UserRole)}
                        className="mt-3 rounded-full border border-border bg-bg px-3 py-1 text-xs font-medium text-fg focus:border-primary/50 focus:outline-none disabled:opacity-60"
                      >
                        <option value="admin">Admin</option>
                        <option value="cofounder">Co-Founder</option>
                        <option value="member">Team Member</option>
                      </select>
                    </>
                  ) : (
                    <span
                      className={cn(
                        "mt-3 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                        user.role === "admin" &&
                          "border-primary/30 bg-primary/10 text-primary-strong",
                        user.role === "cofounder" &&
                          "border-forest/30 bg-forest/10 text-forest-strong",
                        user.role === "member" && "border-mint/30 bg-mint/10 text-mint-strong"
                      )}
                    >
                      {user.role === "admin" && <Crown className="h-3 w-3" aria-hidden="true" />}
                      {user.role === "cofounder" && (
                        <Shield className="h-3 w-3" aria-hidden="true" />
                      )}
                      {user.role === "member" && (
                        <UserIcon className="h-3 w-3" aria-hidden="true" />
                      )}
                      {ROLE_LABELS[user.role]}
                    </span>
                  )}
                </div>
              </div>

              {showMemberStats && (
                <div className="mt-6 grid grid-cols-3 gap-2 border-t border-border pt-5">
                  <Cell label="Invested" value={money(userInvestments)} tone="primary" />
                  <Cell label="Logged" value={money(userExpenses)} tone="mint" />
                  <Cell
                    label="Tasks"
                    value={`${n.number(completedTasks)}/${n.number(userTasks.length)}`}
                    tone="forest"
                  />
                </div>
              )}

              {isAdmin && user.id !== currentUserId && (
                <button
                  onClick={() => handleRemove(user.id, user.name)}
                  disabled={pendingUserId === user.id}
                  aria-label={`Deactivate ${user.name}`}
                  title="Deactivate"
                  className="absolute bottom-4 end-4 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </article>
          );
        })}
      </section>

      {isAdmin && pendingInvites.length > 0 && (
        <section aria-label="Pending invites" className="space-y-4">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-forest-strong" aria-hidden="true" />
            <h2 className="text-lg font-bold tracking-tight">Pending invites</h2>
            <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
              {n.number(pendingInvites.length)}
            </span>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {pendingInvites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={invite.name} size="md" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold text-fg">{invite.name}</p>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                        {ROLE_LABELS[invite.role as UserRole] ?? invite.role}
                      </span>
                      {invite.expired ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                          <MailWarning className="h-3 w-3" aria-hidden="true" /> Expired
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-forest/30 bg-forest/10 px-2 py-0.5 text-[10px] font-medium text-forest-strong">
                          <Clock className="h-3 w-3" aria-hidden="true" /> Awaiting
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-fg-muted">
                      <Mail className="h-3 w-3" aria-hidden="true" /> {invite.email}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">
                      {invite.expired ? "Expired" : "Expires"} {d.date(invite.expiresAt)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                  <button
                    onClick={() => handleResend(invite.id, invite.email)}
                    disabled={pendingInviteId === invite.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:border-primary/40 hover:text-primary-strong disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    {pendingInviteId === invite.id ? "Sending…" : "Resend"}
                  </button>
                  <button
                    onClick={() => handleRevoke(invite.id, invite.name)}
                    disabled={pendingInviteId === invite.id}
                    aria-label={`Revoke ${invite.name}'s invite`}
                    title="Revoke invite"
                    className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAdmin && deactivatedUsers.length > 0 && (
        <section aria-label="Deactivated members" className="space-y-4">
          <div className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-fg-muted" aria-hidden="true" />
            <h2 className="text-lg font-bold tracking-tight">Deactivated</h2>
            <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
              {n.number(deactivatedUsers.length)}
            </span>
          </div>
          <p className="-mt-2 text-sm text-fg-muted">
            Removed members keep their history. Reactivate to restore access with their previous
            role. They&apos;re permanently purged 90 days after deactivation.
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {deactivatedUsers.map((du) => (
              /* The row is a column so the refusal can sit under it; the
                 identity/button pair keeps the layout it had, in the inner div. */
              <li key={du.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="opacity-60">
                      <Avatar name={du.name} size="md" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-semibold text-fg">{du.name}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                          {ROLE_LABELS[du.role as UserRole] ?? du.role}
                        </span>
                      </div>
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-fg-muted">
                        <Mail className="h-3 w-3" aria-hidden="true" /> {du.email}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">
                        Deactivated {d.date(du.deactivatedAt)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleReactivate(du.id, du.name)}
                    disabled={pendingUserId === du.id}
                    className="inline-flex shrink-0 items-center gap-1.5 self-end rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:border-primary/40 hover:text-primary-strong disabled:opacity-50 sm:self-auto"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {pendingUserId === du.id ? "Restoring…" : "Reactivate"}
                  </button>
                </div>
                {/* role="alert", the shape app/forgot-password/page.tsx:277 uses:
                    a failure the admin just caused, so interrupting is correct. */}
                {reactivateError?.userId === du.id && (
                  <p role="alert" className="mt-3 text-xs font-medium text-danger">
                    {reactivateError.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite team member"
        description="Add a co-founder or team member to your workspace"
      >
        <InviteForm
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            refresh();
            setInviteOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "primary" | "forest" | "mint";
}) {
  const toneClass =
    tone === "forest"
      ? "text-forest-strong"
      : tone === "mint"
        ? "text-mint-strong"
        : "text-primary-strong";
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">{label}</p>
      <p
        className={cn("mt-1 min-w-0 truncate font-mono text-sm font-bold tabular-nums", toneClass)}
      >
        {value}
      </p>
    </div>
  );
}

/* InviteForm — RHF + zod, unchanged from the pre-RSC version. */

function InviteForm({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const nameId = useId();
  const emailId = useId();
  /**
   * acct-016. The server's refusal, kept on the screen.
   *
   * `inviteUserAction` no longer answers an address collision with one flat
   * sentence: it distinguishes a deactivated teammate from a deleted account and
   * hands back an instruction for each (the two `existing?.deletedAt` branches of
   * `inviteUserAction`), and it refuses a seat-cap overrun with a third
   * (`seatLimitMessage`). All three ask the admin to go
   * and DO something — reactivate from the Deactivated list, contact support,
   * upgrade in Settings — and `toast.error(res.error)` was the whole delivery, at
   * a toaster duration of 3500ms (components/providers.tsx:186). An instruction
   * the reader cannot re-read is an instruction they cannot follow.
   *
   * Rendered inside the dialog, next to the field whose value caused it, so the
   * remedy and the fix are in one place. The toast still fires, because it is what
   * draws the eye back to a dialog that may have been scrolled past; it is no
   * longer the only copy. Same shape as app/forgot-password/page.tsx:277.
   *
   * NO CLEAR-ON-CLOSE HERE, and that is not an omission. `Modal` is a Radix
   * Dialog whose content is unmounted when `open` goes false (no `forceMount`),
   * so this whole component — state included — is discarded on every one of the
   * three close paths: Cancel, the X, and Escape/overlay. An explicit clear wired
   * to the Cancel handler alone would cover one of the three and read as if it
   * covered all of them. tests/app/team/invite-error-surface.test.tsx asserts the
   * reopened dialog is clean, so if `forceMount` is ever added the gap shows up
   * as a failing test rather than as a stale refusal.
   */
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserInput>({
    resolver: zodResolver(InviteUserSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { name: "", email: "", role: "cofounder" },
  });

  const role = watch("role");
  const nameValue = watch("name");

  async function onSubmit(data: InviteUserInput) {
    // Cleared before the attempt, not after it: a refusal left sitting under a
    // fresh submission reads as a second failure for the same reason.
    setFormError(null);
    const res = await inviteUserAction(data);
    if (res.success) {
      // Two failure modes funnel into emailSent=false:
      //   1. GMAIL_USER / GMAIL_APP_PASSWORD not set (dev or misconfigured
      //      prod) → console log includes "[email:dev-stub]"
      //   2. The SMTP send was rejected (auth failure, rate limit, bad
      //      sender) → console log includes the nodemailer error message
      // Either way we show the URL so the admin can share it out-of-band.
      if (res.data.emailSent) {
        toast.success(`Invite emailed to ${res.data.email}`);
      } else {
        toast.success(`Invite created. Email didn't send — copy this link: ${res.data.inviteUrl}`, {
          duration: 12_000,
        });
        // eslint-disable-next-line no-console
        console.info("[invite] fallback URL:", res.data.inviteUrl);
      }
      onInvited();
    } else {
      setFormError(res.error);
      toast.error(res.error);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <TeamField
        id={nameId}
        label="Full name"
        placeholder="Jane Doe"
        autoFocusInput
        error={errors.name?.message}
        {...register("name")}
      />
      <TeamField
        id={emailId}
        label="Email"
        type="email"
        placeholder="jane@company.com"
        autoComplete="email"
        error={errors.email?.message}
        {...register("email")}
      />
      <p className="-mt-2 text-xs text-fg-muted">
        We&apos;ll email them a one-time link to set their own password. The invite expires in 7
        days.
      </p>

      <div>
        <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          Role
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            {
              value: "cofounder" as const,
              label: "Co-Founder",
              desc: "Full access to finances and tasks",
              icon: Shield,
            },
            {
              value: "member" as const,
              label: "Team Member",
              desc: "Can view and add tasks",
              icon: UserIcon,
            },
          ].map((r) => {
            const active = role === r.value;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() =>
                  setValue("role", r.value, { shouldValidate: true, shouldDirty: true })
                }
                aria-pressed={active}
                className={cn(
                  "rounded-xl border p-3 text-start transition-all",
                  active
                    ? "border-primary/50 bg-primary/[0.06] ring-2 ring-primary/20"
                    : "border-border hover:border-primary/30"
                )}
              >
                <r.icon
                  className={cn("mb-1.5 h-4 w-4", active ? "text-primary-strong" : "text-fg-muted")}
                  aria-hidden="true"
                />
                <p className="text-sm font-semibold text-fg">{r.label}</p>
                <p className="mt-0.5 text-xs text-fg-muted">{r.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* role="alert", the shape app/forgot-password/page.tsx:277 uses: a submit
          failure the admin just caused, so announcing it immediately is correct. */}
      {formError && (
        <p role="alert" className="text-xs font-medium text-danger">
          {formError}
        </p>
      )}

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
          {isSubmitting
            ? "Adding…"
            : nameValue?.trim()
              ? `Add ${nameValue.trim().split(" ")[0]} to team`
              : "Add to team"}
        </button>
      </div>
    </form>
  );
}

type TeamFieldProps = {
  id: string;
  label: string;
  error?: string;
  autoFocusInput?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "autoFocus">;

const TeamField = forwardRef<HTMLInputElement, TeamFieldProps>(function TeamField(
  { id, label, error, type = "text", autoFocusInput, ...rest },
  ref
) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocusInput}
        {...rest}
        className={cn(
          "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:bg-surface focus:outline-none",
          error ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
        )}
      />
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
