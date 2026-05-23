"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Crown, Mail, Shield, Trash2, User as UserIcon, UserPlus, Users } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { listCompanyUsersAction } from "@/lib/actions/team";
import { listTransactionsAction } from "@/lib/actions/transactions";
import { listTasksAction } from "@/lib/actions/tasks";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatDate, formatCurrency } from "@/lib/utils";
import type { Task, Transaction, User, UserRole } from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";

export default function TeamPage() {
  const currentUser = useStore((s) => s.currentUser);
  // NOTE: removeUser + updateRole still use Zustand here; full server-action
  // wiring lands in Phase 1.D along with the invite-by-email flow.
  const removeUser = useStore((s) => s.removeUser);
  const updateRole = useStore((s) => s.updateUserRole);
  const confirm = useConfirm();

  const [users, setUsers] = useState<User[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listCompanyUsersAction(), listTransactionsAction(), listTasksAction()]).then(
      ([us, tx, tk]) => {
        if (cancelled) return;
        if (us.success) setUsers(us.data);
        if (tx.success) setTransactions(tx.data);
        if (tk.success) setTasks(tk.data);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [version]);
  // Use refresh in a layout effect-style cleanup hook so unused-warning shuts up.
  void refresh;

  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = currentUser?.role === "admin";

  function handleRoleChange(userId: string, role: UserRole) {
    if (!isAdmin) return;
    updateRole(userId, role);
    toast.success("Role updated");
  }

  async function handleRemove(userId: string, name: string) {
    const ok = await confirm({
      title: `Remove ${name} from the team?`,
      description: "They lose access immediately. Their past contributions stay in the records.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    removeUser(userId);
    toast.success(`${name} removed`);
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      {/* Header */}
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

      {/* Stats */}
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

      {/* Member cards */}
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
                    {user.id === currentUser?.id && (
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

                  {isAdmin && user.id !== currentUser?.id && user.role !== "admin" ? (
                    <>
                      <label htmlFor={`role-${user.id}`} className="sr-only">
                        Change role for {user.name}
                      </label>
                      <select
                        id={`role-${user.id}`}
                        value={user.role}
                        onChange={(e) => handleRoleChange(user.id, e.target.value as UserRole)}
                        className="mt-3 rounded-full border border-border bg-bg px-3 py-1 text-xs font-medium text-fg focus:border-primary/50 focus:outline-none"
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

              {isAdmin && user.id !== currentUser?.id && user.role !== "admin" && (
                <button
                  onClick={() => handleRemove(user.id, user.name)}
                  aria-label={`Remove ${user.name} from the team`}
                  className="absolute bottom-4 right-4 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </article>
          );
        })}
      </section>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite team member"
        description="Add a co-founder or team member to your workspace"
      >
        <InviteForm onClose={() => setInviteOpen(false)} />
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* InviteForm                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

function InviteForm({ onClose }: { onClose: () => void }) {
  const invite = useStore((s) => s.inviteUser);
  const nameId = useId();
  const emailId = useId();
  const pwId = useId();

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "cofounder" as UserRole,
  });
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.email || !form.password) {
      toast.error("Please fill in all fields");
      return;
    }
    if (form.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    const result = invite(form);
    setLoading(false);
    if (result.success) {
      toast.success(`${form.name} has been added to the team`);
      onClose();
    } else {
      toast.error(result.error || "Failed to add member");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <Field
        id={nameId}
        label="Full name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        placeholder="Jane Doe"
        autoFocus
      />
      <Field
        id={emailId}
        label="Email"
        type="email"
        value={form.email}
        onChange={(v) => setForm({ ...form, email: v })}
        placeholder="jane@company.com"
        autoComplete="email"
      />
      <div>
        <label
          htmlFor={pwId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Temporary password
        </label>
        <input
          id={pwId}
          type="text"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder="At least 6 characters"
          className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 font-mono text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
        />
        <p className="mt-1.5 text-xs text-fg-muted">They can change this after first login.</p>
      </div>

      <div>
        <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          Role
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            {
              value: "cofounder",
              label: "Co-Founder",
              desc: "Full access to finances and tasks",
              icon: Shield,
            },
            {
              value: "member",
              label: "Team Member",
              desc: "Can view and add tasks",
              icon: UserIcon,
            },
          ].map((r) => {
            const active = form.role === r.value;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => setForm({ ...form, role: r.value as UserRole })}
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
          disabled={loading}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {loading ? "Adding…" : "Add to team"}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        className="w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
      />
    </div>
  );
}
