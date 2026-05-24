"use client";

import {
  Building2,
  Crown,
  Database,
  Languages,
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
import type { Company, User as UserType } from "@/lib/types";
import { useT } from "@/lib/i18n/use-t";
import type { Locale } from "@/lib/i18n/strings";

type Props = {
  user: UserType;
  company: Company;
};

export function SettingsClient({ user, company }: Props) {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const logout = useStore((s) => s.logout);
  const confirm = useConfirm();
  const t = useT();

  async function handleLogout() {
    const ok = await confirm({
      title: t.settings.signOutConfirmTitle,
      description: t.settings.signOutConfirmDesc,
      confirmLabel: t.common.signOut,
      tone: "primary",
    });
    if (!ok) return;
    await logoutAction();
    logout();
    toast.success(t.settings.signedOutToast);
    window.location.href = "/login";
  }

  async function handleResetData() {
    const ok = await confirm({
      title: t.settings.resetConfirmTitle,
      description: t.settings.resetConfirmDesc,
      confirmLabel: t.settings.resetConfirmLabel,
      tone: "danger",
    });
    if (!ok) return;
    // Local-storage reset is a holdover from the prototype; real data lives in
    // Supabase now so this only clears UI prefs. Wipe + redirect for a clean slate.
    if (typeof window !== "undefined") {
      localStorage.removeItem("founderflow-storage");
      window.location.href = "/login";
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <PillBadge tone="cyan">{t.settings.workspaceBadge}</PillBadge>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          {t.settings.title}
        </h1>
        <p className="mt-2 text-sm text-fg-muted md:text-base">{t.settings.subtitle}</p>
      </header>

      <Section icon={User} label={t.settings.profile}>
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size="xl" />
          <div>
            <p className="text-lg font-bold text-fg">{user.name}</p>
            <p className="text-sm text-fg-muted">{user.email}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
              {t.settings.joined} {formatDate(user.createdAt)}
            </p>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6 border-t border-border pt-5">
          <DataCell label={t.settings.role}>
            <div className="flex items-center gap-2">
              {user.role === "admin" && (
                <Crown className="h-4 w-4 text-primary-strong" aria-hidden="true" />
              )}
              {user.role === "cofounder" && (
                <Shield className="h-4 w-4 text-cyan-strong" aria-hidden="true" />
              )}
              {user.role === "member" && (
                <User className="h-4 w-4 text-pink-strong" aria-hidden="true" />
              )}
              <p className="text-sm font-semibold text-fg">
                {user.role === "admin"
                  ? t.settings.adminFounderRole
                  : user.role === "cofounder"
                    ? t.settings.cofounderRole
                    : t.settings.teamMemberRole}
              </p>
            </div>
          </DataCell>
          <DataCell label={t.settings.userId}>
            <p className="font-mono text-xs text-fg-muted">{user.id.slice(0, 12)}…</p>
          </DataCell>
        </div>
      </Section>

      <Section icon={Building2} label={t.settings.company}>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <DataCell label={t.settings.name}>
            <p className="text-sm font-semibold text-fg">{company.name}</p>
          </DataCell>
          <DataCell label={t.settings.industryLabel}>
            <p className="text-sm font-semibold text-fg">{company.industry}</p>
          </DataCell>
          <DataCell label={t.settings.currency}>
            <p className="font-mono text-sm font-bold text-primary-strong">{company.currency}</p>
          </DataCell>
          <DataCell label={t.settings.created}>
            <p className="font-mono text-xs uppercase tracking-wider text-fg">
              {formatDate(company.createdAt)}
            </p>
          </DataCell>
        </div>
      </Section>

      <Section icon={Palette} label={t.settings.appearance}>
        <p className="mb-4 text-sm text-fg-muted">{t.settings.appearanceNote}</p>
        <div className="grid grid-cols-2 gap-3">
          <ThemeChoice
            active={theme === "light"}
            onSelect={() => setTheme("light")}
            icon={Sun}
            label={t.settings.light}
            desc={t.settings.lightDesc}
          />
          <ThemeChoice
            active={theme === "dark"}
            onSelect={() => setTheme("dark")}
            icon={Moon}
            label={t.settings.dark}
            desc={t.settings.darkDesc}
          />
        </div>
      </Section>

      <Section icon={Languages} label={t.settings.language}>
        <p className="mb-4 text-sm text-fg-muted">{t.settings.languageNote}</p>
        <div className="grid grid-cols-2 gap-3">
          <LocaleChoice
            active={locale === "en"}
            onSelect={() => setLocale("en")}
            code="en"
            label={t.settings.english}
            desc={t.settings.englishDesc}
          />
          <LocaleChoice
            active={locale === "ur"}
            onSelect={() => setLocale("ur")}
            code="ur"
            label={t.settings.urdu}
            desc={t.settings.urduDesc}
          />
        </div>
      </Section>

      <Section icon={Database} label={t.settings.dataStorage}>
        <p className="mb-4 text-sm text-fg-muted">{t.settings.dataNote}</p>
        <button
          onClick={handleResetData}
          className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-5 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/15"
        >
          {t.settings.resetLocalPrefs}
        </button>
      </Section>

      <Section icon={LogOut} label={t.settings.signOutSection} tone="danger">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg-muted">{t.settings.signOutNote}</p>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-danger/90 active:scale-95"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> {t.common.signOut}
          </button>
        </div>
      </Section>
    </div>
  );
}

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

// LocaleChoice mirrors ThemeChoice but renders the language code as a 2-char
// badge instead of an icon — keeps the toggle compact and recognisable across
// scripts (EN renders LTR Latin, اردو needs RTL).
function LocaleChoice({
  active,
  onSelect,
  code,
  label,
  desc,
}: {
  active: boolean;
  onSelect: () => void;
  code: Locale;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      lang={code}
      className={cn(
        "rounded-xl border p-4 text-left transition-all",
        active
          ? "border-primary/50 bg-primary/[0.06] ring-2 ring-primary/20"
          : "border-border hover:border-primary/30"
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span
          className={cn(
            "font-mono text-[10px] font-bold uppercase tracking-[0.18em]",
            active ? "text-primary-strong" : "text-fg-muted"
          )}
        >
          {code}
        </span>
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </div>
      <p className="text-sm font-semibold text-fg">{label}</p>
      <p className="mt-1 text-xs text-fg-muted">{desc}</p>
    </button>
  );
}
