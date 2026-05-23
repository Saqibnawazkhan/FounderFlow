"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Crown,
  Mail,
  MoreVertical,
  Plus,
  Shield,
  Trash2,
  User as UserIcon,
  UserPlus,
  Users,
} from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { Avatar } from "@/components/ui/avatar";
import { cn, formatDate, formatCurrency } from "@/lib/utils";
import type { UserRole } from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";

export default function TeamPage() {
  const users = useStore((s) => s.getCompanyUsers());
  const transactions = useStore((s) => s.getCompanyTransactions());
  const tasks = useStore((s) => s.getCompanyTasks());
  const currentUser = useStore((s) => s.currentUser);
  const inviteUser = useStore((s) => s.inviteUser);
  const removeUser = useStore((s) => s.removeUser);
  const updateRole = useStore((s) => s.updateUserRole);

  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = currentUser?.role === "admin";

  function handleRoleChange(userId: string, role: UserRole) {
    if (!isAdmin) return;
    updateRole(userId, role);
    toast.success("Role updated");
  }

  function handleRemove(userId: string, name: string) {
    if (!confirm(`Remove ${name} from the team?`)) return;
    removeUser(userId);
    toast.success(`${name} removed`);
  }

  return (
    <div className="space-y-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Manage co-founders and team members.
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setInviteOpen(true)} className="btn-primary">
            <UserPlus className="h-4 w-4" /> Invite Member
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Total Members</p>
              <p className="text-2xl font-bold mt-1">{users.length}</p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Co-Founders</p>
              <p className="text-2xl font-bold mt-1">
                {users.filter((u) => u.role === "admin" || u.role === "cofounder").length}
              </p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center text-white">
              <Crown className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Team Members</p>
              <p className="text-2xl font-bold mt-1">{users.filter((u) => u.role === "member").length}</p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-white">
              <UserIcon className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Team list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {users.map((user, i) => {
          const userInvestments = transactions
            .filter((t) => t.addedBy === user.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const userExpenses = transactions
            .filter((t) => t.addedBy === user.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          const userTasks = tasks.filter((t) => t.assignedTo === user.id);
          const completedTasks = userTasks.filter((t) => t.status === "completed").length;

          return (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="card p-6 relative overflow-hidden"
            >
              {user.role === "admin" && (
                <div className="absolute top-4 right-4">
                  <span className="badge bg-gradient-to-r from-amber-500 to-orange-500 text-white">
                    <Crown className="h-3 w-3" /> Admin
                  </span>
                </div>
              )}

              <div className="flex items-start gap-4">
                <Avatar name={user.name} size="xl" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-lg truncate">{user.name}</h3>
                    {user.id === currentUser?.id && (
                      <span className="badge-info text-[10px]">You</span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500 truncate flex items-center gap-1 mt-0.5">
                    <Mail className="h-3 w-3" /> {user.email}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Joined {formatDate(user.createdAt)}
                  </p>

                  {isAdmin && user.id !== currentUser?.id && user.role !== "admin" ? (
                    <select
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.id, e.target.value as UserRole)}
                      className="mt-3 text-xs font-medium px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border-0 focus:outline-none"
                    >
                      <option value="cofounder">Co-Founder</option>
                      <option value="member">Team Member</option>
                    </select>
                  ) : (
                    <span className={cn(
                      "inline-flex items-center gap-1 mt-3 px-3 py-1 rounded-full text-xs font-medium",
                      user.role === "admin" && "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300",
                      user.role === "cofounder" && "bg-brand-100 dark:bg-brand-500/20 text-brand-700 dark:text-brand-300",
                      user.role === "member" && "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                    )}>
                      {user.role === "admin" && <Crown className="h-3 w-3" />}
                      {user.role === "cofounder" && <Shield className="h-3 w-3" />}
                      {user.role === "member" && <UserIcon className="h-3 w-3" />}
                      {ROLE_LABELS[user.role]}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
                <div>
                  <p className="text-xs text-slate-500">Invested</p>
                  <p className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums text-sm mt-0.5">
                    {formatCurrency(userInvestments)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Logged</p>
                  <p className="font-semibold text-amber-600 dark:text-amber-400 tabular-nums text-sm mt-0.5">
                    {formatCurrency(userExpenses)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Tasks</p>
                  <p className="font-semibold text-sm mt-0.5">
                    {completedTasks}/{userTasks.length}
                  </p>
                </div>
              </div>

              {isAdmin && user.id !== currentUser?.id && user.role !== "admin" && (
                <button
                  onClick={() => handleRemove(user.id, user.name)}
                  className="absolute bottom-4 right-4 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-slate-400 hover:text-red-500 transition"
                  aria-label="Remove member"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </motion.div>
          );
        })}
      </div>

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite team member" description="Add a co-founder or team member to your workspace">
        <InviteForm onClose={() => setInviteOpen(false)} />
      </Modal>
    </div>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const invite = useStore((s) => s.inviteUser);
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Full name</label>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="input"
          placeholder="Jane Doe"
          autoFocus
        />
      </div>
      <div>
        <label className="label">Email</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="input"
          placeholder="jane@company.com"
        />
      </div>
      <div>
        <label className="label">Temporary password</label>
        <input
          type="text"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          className="input font-mono"
          placeholder="At least 6 characters"
        />
        <p className="text-xs text-slate-500 mt-1">They can change this after first login.</p>
      </div>
      <div>
        <label className="label">Role</label>
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: "cofounder", label: "Co-Founder", desc: "Full access to finances and tasks", icon: Shield },
            { value: "member", label: "Team Member", desc: "Can view and add tasks", icon: UserIcon },
          ].map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setForm({ ...form, role: r.value as UserRole })}
              className={cn(
                "p-3 rounded-xl border text-left transition-all",
                form.role === r.value
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10 ring-2 ring-brand-500/20"
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
              )}
            >
              <r.icon className="h-4 w-4 mb-1 text-brand-500" />
              <p className="font-medium text-sm">{r.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{r.desc}</p>
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="btn-primary flex-1">
          {loading ? "Adding..." : "Add to team"}
        </button>
      </div>
    </form>
  );
}
