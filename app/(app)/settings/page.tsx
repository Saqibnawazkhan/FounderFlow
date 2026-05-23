"use client";

import { useRouter } from "next/navigation";
import {
  Building2,
  Crown,
  Database,
  LogOut,
  Moon,
  Palette,
  Shield,
  Sun,
  User,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { logoutAction } from "@/lib/actions/auth";
import { Avatar } from "@/components/ui/avatar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatDate } from "@/lib/utils";

export default function SettingsPage() {
  const router = useRouter();
  const currentUser = useStore((s) => s.currentUser);
  const companies = useStore((s) => s.companies);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const logout = useStore((s) => s.logout);
  const confirm = useConfirm();

  const company = companies.find((c) => c.id === currentUser?.companyId);

  async function handleLogout() {
    const ok = await confirm({
      title: "Sign out?",
      description: "You can sign back in any time.",
      confirmLabel: "Sign out",
      tone: "primary",
    });
    if (!ok) return;
    await logoutAction();
    logout();
    toast.success("Signed out");
    window.location.href = "/login";
  }

  async function handleResetData() {
    const ok = await confirm({
      title: "Reset workspace data?",
      description:
        "All transactions, tasks, activity, and team members will be wiped. This cannot be undone.",
      confirmLabel: "Reset everything",
      tone: "danger",
    });
    if (!ok) return;
    if (typeof window !== "undefined") {
      localStorage.removeItem("founderflow-storage");
      window.location.href = "/login";
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <header>
        <PillBadge tone="cyan">Workspace</PillBadge>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Settings
        </h1>
        <p className="mt-2 text-sm text-fg-muted md:text-base">
          Manage your account, workspace, and preferences.
        </p>
      </header>

      {/* Profile */}
      <Section icon={User} label="Profile">
        <div className="flex items-center gap-4">
          <Avatar name={currentUser?.name || ""} size="xl" />
          <div>
            <p className="text-lg font-bold text-fg">{currentUser?.name}</p>
            <p className="text-sm text-fg-muted">{currentUser?.email}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
              Joined {currentUser ? formatDate(currentUser.createdAt) : ""}
            </p>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6 border-t border-border pt-5">
          <DataCell label="Role">
            <div className="flex items-center gap-2">
              {currentUser?.role === "admin" && (
                <Crown className="h-4 w-4 text-primary-strong" aria-hidden="true" />
              )}
              {currentUser?.role === "cofounder" && (
                <Shield className="h-4 w-4 text-cyan-strong" aria-hidden="true" />
              )}
              {currentUser?.role === "member" && (
                <User className="h-4 w-4 text-pink-strong" aria-hidden="true" />
              )}
              <p className="text-sm font-semibold text-fg">
                {currentUser?.role === "admin"
                  ? "Admin Founder"
                  : currentUser?.role === "cofounder"
                    ? "Co-Founder"
                    : "Team Member"}
              </p>
            </div>
          </DataCell>
          <DataCell label="User ID">
            <p className="font-mono text-xs text-fg-muted">{currentUser?.id.slice(0, 12)}…</p>
          </DataCell>
        </div>
      </Section>

      {/* Company */}
      <Section icon={Building2} label="Company">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <DataCell label="Name">
            <p className="text-sm font-semibold text-fg">{company?.name}</p>
          </DataCell>
          <DataCell label="Industry">
            <p className="text-sm font-semibold text-fg">{company?.industry}</p>
          </DataCell>
          <DataCell label="Currency">
            <p className="font-mono text-sm font-bold text-primary-strong">{company?.currency}</p>
          </DataCell>
          <DataCell label="Created">
            <p className="font-mono text-xs uppercase tracking-wider text-fg">
              {company ? formatDate(company.createdAt) : ""}
            </p>
          </DataCell>
        </div>
      </Section>

      {/* Appearance */}
      <Section icon={Palette} label="Appearance">
        <p className="mb-4 text-sm text-fg-muted">Choose how FounderFlow looks for you.</p>
        <div className="grid grid-cols-2 gap-3">
          <ThemeChoice
            active={theme === "light"}
            onSelect={() => setTheme("light")}
            icon={Sun}
            label="Light"
            desc="Clean, classic, energizing"
          />
          <ThemeChoice
            active={theme === "dark"}
            onSelect={() => setTheme("dark")}
            icon={Moon}
            label="Dark"
            desc="Easy on the eyes for long sessions"
          />
        </div>
      </Section>

      {/* Data */}
      <Section icon={Database} label="Data & storage">
        <p className="mb-4 text-sm text-fg-muted">
          FounderFlow stores your data locally in your browser. To sync across devices, connect a
          backend.
        </p>
        <button
          onClick={handleResetData}
          className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-5 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/15"
        >
          Reset workspace data
        </button>
      </Section>

      {/* Sign out */}
      <Section icon={LogOut} label="Sign out" tone="danger">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg-muted">Sign out of your FounderFlow workspace.</p>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-danger/90 active:scale-95"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
          </button>
        </div>
      </Section>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Section + helpers                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function Section({
  icon: Icon,
  label,
  tone = "primary",
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "danger";
  children: React.ReactNode;
}) {
  const toneText = tone === "danger" ? "text-danger" : "text-primary-strong";
  const toneFill = tone === "danger" ? "bg-danger/10" : "bg-primary/10";
  return (
    <section className="rounded-2xl border border-border bg-surface p-6">
      <div className="mb-5 flex items-center gap-3">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", toneFill)}>
          <Icon className={cn("h-4 w-4", toneText)} aria-hidden="true" />
        </div>
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-fg-muted">
          {label}
        </h2>
      </div>
      {children}
    </section>
  );
}

function DataCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ThemeChoice({
  active,
  onSelect,
  icon: Icon,
  label,
  desc,
}: {
  active: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "rounded-xl border p-4 text-left transition-all",
        active
          ? "border-primary/50 bg-primary/[0.06] ring-2 ring-primary/20"
          : "border-border hover:border-primary/30"
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <Icon
          className={cn("h-5 w-5", active ? "text-primary-strong" : "text-fg-muted")}
          aria-hidden="true"
        />
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </div>
      <p className="text-sm font-semibold text-fg">{label}</p>
      <p className="mt-1 text-xs text-fg-muted">{desc}</p>
    </button>
  );
}
