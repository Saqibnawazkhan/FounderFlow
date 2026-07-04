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
import { cn, formatDate, formatCurrency } from "@/lib/utils";
import type {
  DeactivatedUser,
  PendingInvite,
  Task,
  Transaction,
  User,
  UserRole,
} from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";

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
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingInviteId, setPendingInviteId] = useState<string | null>(null);

  const isAdmin = currentUserRole === "admin";

  // RSC refresh hook: server actions already call revalidatePath('/team'), so
  // router.refresh() picks up the new data on this tree without a full nav.
  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleRoleChange(userId: string, role: UserRole) {
    if (!isAdmin) return;
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
    const res = await reactivateUserAction(userId);
    setPendingUserId(null);
    if (res.success) {
      toast.success(`${name} reactivated`);
      refresh();
    } else {
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
          <PillBadge tone="cyan">Roster</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Team</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Manage co-founders and team members.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
          tone="cyan"
          deltaLabel="Founder access"
        />
        <DashboardStat
          label="Team members"
          value={users.filter((u) => u.role === "member").length.toString()}
          icon={UserIcon}
          tone="pink"
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
                <div className="absolute right-4 top-4">
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
                    Joined {formatDate(user.createdAt)}
                  </p>

                  {isAdmin && user.id !== currentUserId && user.role !== "admin" ? (
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
                        user.role === "cofounder" && "border-cyan/30 bg-cyan/10 text-cyan-strong",
                        user.role === "member" && "border-pink/30 bg-pink/10 text-pink-strong"
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

              <div className="mt-6 grid grid-cols-3 gap-2 border-t border-border pt-5">
                <Cell label="Invested" value={formatCurrency(userInvestments)} tone="primary" />
                <Cell label="Logged" value={formatCurrency(userExpenses)} tone="pink" />
                <Cell label="Tasks" value={`${completedTasks}/${userTasks.length}`} tone="cyan" />
              </div>

              {isAdmin && user.id !== currentUserId && user.role !== "admin" && (
                <button
                  onClick={() => handleRemove(user.id, user.name)}
                  disabled={pendingUserId === user.id}
                  aria-label={`Deactivate ${user.name}`}
                  title="Deactivate"
                  className="absolute bottom-4 right-4 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
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
            <Send className="h-4 w-4 text-cyan-strong" aria-hidden="true" />
            <h2 className="text-lg font-bold tracking-tight">Pending invites</h2>
            <span className="rounded-full bg-glass/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
              {pendingInvites.length}
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
                        <span className="inline-flex items-center gap-1 rounded-full border border-cyan/30 bg-cyan/10 px-2 py-0.5 text-[10px] font-medium text-cyan-strong">
                          <Clock className="h-3 w-3" aria-hidden="true" /> Awaiting
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-fg-muted">
                      <Mail className="h-3 w-3" aria-hidden="true" /> {invite.email}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">
                      {invite.expired ? "Expired" : "Expires"} {formatDate(invite.expiresAt)}
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
              {deactivatedUsers.length}
            </span>
          </div>
          <p className="-mt-2 text-sm text-fg-muted">
            Removed members keep their history. Reactivate to restore access with their previous
            role. They&apos;re permanently purged 90 days after deactivation.
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {deactivatedUsers.map((du) => (
              <li
                key={du.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
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
                      Deactivated {formatDate(du.deactivatedAt)}
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
  tone: "primary" | "cyan" | "pink";
}) {
  const toneClass =
    tone === "cyan"
      ? "text-cyan-strong"
      : tone === "pink"
        ? "text-pink-strong"
        : "text-primary-strong";
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">{label}</p>
      <p className={cn("mt-1 font-mono text-sm font-bold tabular-nums", toneClass)}>{value}</p>
    </div>
  );
}

/* InviteForm — RHF + zod, unchanged from the pre-RSC version. */

function InviteForm({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const nameId = useId();
  const emailId = useId();

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
    const res = await inviteUserAction(data);
    if (res.success) {
      // Two failure modes funnel into emailSent=false:
      //   1. RESEND_API_KEY not set (dev or misconfigured prod) → console
      //      log includes "[email:dev-stub]"
      //   2. Resend rejected the send (rate limit, bad sender domain, etc.)
      //      → console log includes the Resend error message
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
                  "rounded-xl border p-3 text-left transition-all",
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
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
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
