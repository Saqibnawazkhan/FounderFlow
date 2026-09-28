"use client";

/**
 * Settings client. Sections, in order:
 *   1. Header + 3 stat cards (time tracked, last sign-in, member since)
 *   2. Profile — read-only summary + "Edit profile" + "Change password" buttons
 *   3. Handle — the @mention address, edited in place (see HandleSection)
 *   4. Company — read-only summary + "Edit company" button (admin/cofounder ONLY)
 *   5. Appearance, Language, Data & storage, Sign out
 *
 * Members never see the Company section — they can't see finances and the
 * company card includes currency, which is finance-adjacent context. The
 * server action enforces the same rule; this is the visual half.
 */

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AtSign,
  Building2,
  CalendarDays,
  Clock,
  CreditCard,
  Crown,
  Database,
  Download,
  KeyRound,
  Languages,
  LogIn,
  LogOut,
  Moon,
  Bell,
  Palette,
  Pencil,
  Save,
  Shield,
  Skull,
  Smartphone,
  Sun,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { logoutAction } from "@/lib/actions/auth";
import { updateAppearanceAction } from "@/lib/actions/appearance";
import { getMyHandleAction, updateHandleAction } from "@/lib/actions/profile";
import { HandleSchema } from "@/lib/schemas/profile";
import { PushToggle } from "@/components/push/push-toggle";
import { NotificationMatrix } from "@/components/settings/notification-matrix";
import type { NotificationMatrixRow } from "@/lib/queries/notification-preferences";
import { InstallAppButton } from "@/components/pwa/install-button";
import { Avatar } from "@/components/ui/avatar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, downloadFile, formatDate } from "@/lib/utils";
import type { Company, User as UserType } from "@/lib/types";
import { useT } from "@/lib/i18n/use-t";
import type { Locale } from "@/lib/i18n/strings";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { formatDuration } from "@/lib/time/thresholds";
import type { AccountStats } from "@/lib/queries/stats";
import type { BillingSummary } from "@/lib/queries/billing";
import {
  createCheckoutSessionAction,
  createBillingPortalSessionAction,
} from "@/lib/actions/billing";
import {
  describeBillingPeriod,
  FREE_MEMBER_LIMIT,
  PLAN_LABELS,
  type BillingNoticeTone,
} from "@/lib/billing/plan";
import { useNumberFormat } from "@/lib/i18n/use-t";
import { EditProfileModal } from "./edit-profile-modal";
import { ChangePasswordModal } from "./change-password-modal";
import { ChangeEmailModal } from "./change-email-modal";
import { EditCompanyModal } from "./edit-company-modal";
import { DeleteAccountModal } from "./delete-account-modal";
import { DeleteWorkspaceModal } from "./delete-workspace-modal";

type Props = {
  user: UserType;
  company: Company;
  stats: AccountStats;
  billing: BillingSummary;
  notifyMatrix: NotificationMatrixRow[];
};

export function SettingsClient({ user, company, stats, billing, notifyMatrix }: Props) {
  const router = useRouter();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const logout = useStore((s) => s.logout);
  const confirm = useConfirm();
  const t = useT();
  const n = useNumberFormat();
  const [, startTransition] = useTransition();

  const canEditCompany = canSeeFinances(user.role as Role);

  // S6: apply the choice instantly (store → localStorage + <html> class),
  // then persist to the DB so it follows the user to other devices. The
  // write is fire-and-forget — a failed save just means the pref stays local.
  function chooseTheme(next: "light" | "dark") {
    setTheme(next);
    void updateAppearanceAction({ theme: next });
  }
  function chooseLocale(next: Locale) {
    setLocale(next);
    void updateAppearanceAction({ locale: next });
  }

  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const canDeleteWorkspace = user.role === "admin";
  // Same gate the /api/export route enforces server-side: only finance-
  // seeing roles can pull a full-workspace JSON (a member export would
  // leak every transaction past the app's finance wall).
  const canExport = canSeeFinances(user.role as Role);

  function refresh() {
    startTransition(() => router.refresh());
  }

  // Stripe Checkout redirects back to /settings?billing=success|cancelled.
  // The webhook updates the plan asynchronously, so refresh a beat later.
  useEffect(() => {
    const billingParam = new URLSearchParams(window.location.search).get("billing");
    if (billingParam === "success") {
      toast.success("Payment received — your plan will update in a moment.");
      startTransition(() => router.refresh());
      window.history.replaceState({}, "", "/settings");
    } else if (billingParam === "cancelled") {
      toast("Checkout cancelled — no charge made.");
      window.history.replaceState({}, "", "/settings");
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogout() {
    const ok = await confirm({
      title: t.settings.signOutConfirmTitle,
      description: t.settings.signOutConfirmDesc,
      confirmLabel: t.common.signOut,
      tone: "primary",
    });
    if (!ok) return;
    // Only clear local Zustand state on a confirmed server sign-out.
    // Previously we wiped the local store regardless, leaving a valid
    // session cookie alive — next reload put the user back in.
    const res = await logoutAction();
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    logout();
    toast.success(t.settings.signedOutToast);
    window.location.href = "/login";
  }

  /**
   * acct-007. Clears this device's UI preferences — and nothing else, which is
   * what the copy now says.
   *
   * WHAT THIS USED TO BE: the same two statements under a danger-red dialog
   * titled "Reset workspace data?" promising "All transactions, tasks, activity,
   * and team members will be wiped. This cannot be undone." It wiped one
   * localStorage key. The strings are fixed in lib/i18n/strings.ts; the two
   * changes here are the honest ending.
   *
   * NO NAVIGATION TO /login. The session cookie is untouched, so /login bounced
   * the still-signed-in user straight back into the app and
   * components/providers.tsx re-hydrated their identity from the session — the
   * "reset" visibly did nothing. Reloading the page they are on is what makes the
   * cleared preferences visible (the persisted store is re-read on mount, so the
   * theme and sidebar return to their defaults) while leaving them signed in,
   * which is the whole truth about this button.
   */
  async function handleResetData() {
    const ok = await confirm({
      title: t.settings.resetConfirmTitle,
      description: t.settings.resetConfirmDesc,
      confirmLabel: t.settings.resetConfirmLabel,
      // Not "danger": clearing a theme preference is a harmless, repeatable
      // action, and dressing it in red is what made people back out of it.
      tone: "primary",
    });
    if (!ok) return;
    if (typeof window !== "undefined") {
      localStorage.removeItem("founderflow-storage");
      window.location.reload();
    }
  }

  async function handleExport() {
    // Fetch-then-blob (rather than a bare <a href>) so a 403/500 surfaces
    // as a toast instead of navigating the user to a raw JSON error page.
    setExporting(true);
    try {
      const res = await fetch("/api/export");
      // An expired session gets a 302 → /login (public, returns 200 HTML).
      // fetch follows it, so res.ok would be true — guard on redirect +
      // content-type so we don't hand the user login HTML named .json with
      // a success toast. (Adversarial review finding, 2026-07-04.)
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || res.redirected || !contentType.includes("application/json")) {
        throw new Error("export-failed");
      }
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadFile(blob, `founderflow-export-${stamp}.json`, "application/json");
      toast.success(t.settings.exportReadyToast);
    } catch {
      toast.error(t.settings.exportFailedToast);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <PillBadge tone="forest">{t.settings.workspaceBadge}</PillBadge>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          {t.settings.title}
        </h1>
        <p className="mt-2 text-sm text-fg-muted md:text-base">{t.settings.subtitle}</p>
      </header>

      {/* Stats — keeps the page useful at-a-glance even for members. */}
      <section aria-label={t.settings.stats} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={Clock}
          label={t.settings.totalTracked}
          value={formatDuration(stats.totalTrackedMs)}
          desc={`${n.number(stats.sessionCount)} ${t.settings.sessionCount.toLowerCase()}`}
          tone="primary"
        />
        <StatCard
          icon={LogIn}
          label={t.settings.lastSignIn}
          value={
            stats.lastSignInAt
              ? formatDistanceToNow(new Date(stats.lastSignInAt), { addSuffix: true })
              : t.settings.lastSignInNever
          }
          desc={
            stats.lastSignInAt
              ? new Date(stats.lastSignInAt).toLocaleString()
              : t.settings.lastSignInNever
          }
          tone="forest"
        />
        <StatCard
          icon={CalendarDays}
          label={t.settings.memberSince}
          value={formatDate(stats.memberSince)}
          desc={formatDistanceToNow(new Date(stats.memberSince), { addSuffix: true })}
          tone="mint"
        />
      </section>

      <Section
        icon={User}
        label={t.settings.profile}
        action={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setEmailOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            >
              <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
              {t.settings.changeEmail}
            </button>
            <button
              onClick={() => setPasswordOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              {t.settings.changePassword}
            </button>
            <button
              onClick={() => setProfileOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              {t.settings.editProfile}
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-fg">{user.name}</p>
            <p className="truncate text-sm text-fg-muted">{user.email}</p>
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
                <Shield className="h-4 w-4 text-forest-strong" aria-hidden="true" />
              )}
              {user.role === "member" && (
                <User className="h-4 w-4 text-mint-strong" aria-hidden="true" />
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

      {/* Sits under Profile because it IS profile — the half of your identity
          that the mention parser reads rather than the half people read. */}
      <Section icon={AtSign} label="Handle">
        <HandleSection name={user.name} />
      </Section>

      {/* Members can't see / edit company info — see lib/auth/role-gates. */}
      {canEditCompany && (
        <Section
          icon={Building2}
          label={t.settings.company}
          action={
            <button
              onClick={() => setCompanyOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              {t.settings.editCompany}
            </button>
          }
        >
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
      )}

      {/* Billing is the workspace owner's concern — admin only. */}
      {user.role === "admin" && (
        <Section icon={CreditCard} label="Plan & billing">
          <BillingSection billing={billing} />
        </Section>
      )}

      <Section icon={Bell} label="Notifications">
        <PushToggle />
        <div className="mt-6 border-t border-border pt-6">
          <NotificationMatrix initial={notifyMatrix} />
        </div>
      </Section>

      <Section icon={Palette} label={t.settings.appearance}>
        <p className="mb-4 text-sm text-fg-muted">{t.settings.appearanceNote}</p>
        <div className="grid grid-cols-2 gap-3">
          <ThemeChoice
            active={theme === "light"}
            onSelect={() => chooseTheme("light")}
            icon={Sun}
            label={t.settings.light}
            desc={t.settings.lightDesc}
          />
          <ThemeChoice
            active={theme === "dark"}
            onSelect={() => chooseTheme("dark")}
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
            onSelect={() => chooseLocale("en")}
            code="en"
            label={t.settings.english}
            desc={t.settings.englishDesc}
          />
          <LocaleChoice
            active={locale === "ur"}
            onSelect={() => chooseLocale("ur")}
            code="ur"
            label={t.settings.urdu}
            desc={t.settings.urduDesc}
          />
        </div>
      </Section>

      <Section icon={Smartphone} label={t.settings.installApp}>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-md text-sm text-fg-muted">{t.settings.installAppNote}</p>
          <InstallAppButton
            label={t.settings.installAppAction}
            installedLabel={t.settings.installAppInstalled}
            unavailableLabel={t.settings.installAppUnavailable}
          />
        </div>
      </Section>

      <Section icon={Database} label={t.settings.dataStorage}>
        <p className="mb-4 text-sm text-fg-muted">{t.settings.dataNote}</p>
        {canExport && (
          <div className="mb-4 flex flex-col items-start gap-3 rounded-xl border border-border bg-bg/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">{t.settings.exportWorkspace}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{t.settings.exportWorkspaceDesc}</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-bold text-primary-strong transition-colors hover:bg-primary/20 active:scale-95 disabled:opacity-60"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting ? t.settings.exportPreparing : t.settings.exportWorkspaceAction}
            </button>
          </div>
        )}
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

      <Section icon={Skull} label={t.settings.dangerZone} tone="danger">
        <p className="mb-4 text-sm text-fg-muted">{t.settings.dangerZoneNote}</p>
        <div className="space-y-3">
          <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">{t.settings.deleteAccount}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{t.settings.deleteAccountDesc}</p>
            </div>
            <button
              type="button"
              onClick={() => setDeleteAccountOpen(true)}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-bold text-danger transition-colors hover:bg-danger/20 active:scale-95"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t.settings.deleteAccountAction}
            </button>
          </div>
          {canDeleteWorkspace && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-fg">{t.settings.deleteWorkspace}</p>
                <p className="mt-0.5 text-xs text-fg-muted">{t.settings.deleteWorkspaceDesc}</p>
              </div>
              <button
                type="button"
                onClick={() => setDeleteWorkspaceOpen(true)}
                className="inline-flex shrink-0 items-center gap-2 rounded-full bg-danger px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-danger/90 active:scale-95"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t.settings.deleteWorkspaceAction}
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* Modals */}
      <EditProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        defaultName={user.name}
        defaultEmail={user.email}
        onSaved={() => {
          setProfileOpen(false);
          refresh();
        }}
      />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <ChangeEmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        currentEmail={user.email}
      />
      {canEditCompany && (
        <EditCompanyModal
          open={companyOpen}
          onClose={() => setCompanyOpen(false)}
          defaultName={company.name}
          defaultIndustry={company.industry}
          defaultCurrency={company.currency}
          onSaved={() => {
            setCompanyOpen(false);
            refresh();
          }}
        />
      )}

      <DeleteAccountModal open={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} />
      {canDeleteWorkspace && (
        <DeleteWorkspaceModal
          open={deleteWorkspaceOpen}
          onClose={() => setDeleteWorkspaceOpen(false)}
          workspaceName={company.name}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Layout helpers                                                          */
/* ─────────────────────────────────────────────────────────────────────── */

function Section({
  icon: Icon,
  label,
  tone = "primary",
  action,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "danger";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const toneText = tone === "danger" ? "text-danger" : "text-primary-strong";
  const toneFill = tone === "danger" ? "bg-danger/10" : "bg-primary/10";
  return (
    <section className="rounded-2xl border border-border bg-surface p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", toneFill)}>
            <Icon className={cn("h-4 w-4", toneText)} aria-hidden="true" />
          </div>
          <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-fg-muted">
            {label}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The @mention handle, edited in place.
 *
 * WHY IN PLACE AND NOT IN A MODAL, unlike name/email/company. Those are things
 * you already know about yourself; a handle is a concept this product has to
 * TEACH. Most people arrive with a machine-assigned one they have never seen
 * (the migration derived it from their email) and no idea that it is what
 * teammates type to reach them. Hidden behind an "Edit" button, it stays a
 * database column. On the page, with a live preview of the mention it
 * produces, it explains itself.
 *
 * WHY IT FETCHES ITS OWN VALUE. /settings receives `user` from
 * `getCurrentUser()`, and neither that query nor the client `User` type
 * carries `handle` yet (both are another agent's files this wave), so the
 * value comes from `getMyHandleAction` on mount. That costs a round trip and a
 * brief skeleton; when `User` grows the field, take it as a prop and delete
 * the effect.
 *
 * Save/error shape is the one the rest of settings uses: toast on the outcome,
 * inline text under the field for the reason (matching the modals' Field), and
 * the same zod schema the server re-parses, so the client cannot be the only
 * thing that says no.
 */
function HandleSection({ name }: { name: string }) {
  const inputId = useId();
  const [current, setCurrent] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `cancelled` rather than an AbortController: a server action isn't a
    // fetch we can abort, and the only hazard is setting state after unmount.
    let cancelled = false;
    void (async () => {
      const res = await getMyHandleAction();
      if (cancelled) return;
      if (!res.success) {
        setError(res.error);
      } else {
        setCurrent(res.data.handle);
        setValue(res.data.handle ?? "");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Normalise the two things people do to a handle field without meaning to:
  // paste it with its leading @, and type it the way they'd type a name. The
  // schema REJECTS both rather than rewriting them (see lib/schemas/profile),
  // so fixing them here is what keeps that strictness off the happy path —
  // what the preview shows is exactly what gets stored.
  function onChange(raw: string) {
    setValue(raw.replace(/@/g, "").toLowerCase());
    setError(null);
  }

  const dirty = value !== (current ?? "");
  // The live preview follows what's in the field, so the consequence of an
  // edit is visible before it's saved.
  const preview = value.trim() || current || "your-handle";

  async function save() {
    // Same schema the action re-parses — this only saves a round trip, it is
    // never the thing that decides.
    const parsed = HandleSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid handle");
      return;
    }
    setSaving(true);
    const res = await updateHandleAction({ handle: parsed.data });
    setSaving(false);
    if (!res.success) {
      // Inline as well as a toast: "that handle is taken" is a thing you fix
      // in the field you're looking at, not a thing you acknowledge.
      setError(res.error);
      toast.error(res.error);
      return;
    }
    setCurrent(res.data.handle);
    setValue(res.data.handle);
    setError(null);
    toast.success("Handle updated");
  }

  return (
    <div className="rounded-xl border border-border bg-bg/40 p-4">
      <label
        htmlFor={inputId}
        className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
      >
        Your handle
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-sm text-fg-muted"
          >
            @
          </span>
          <input
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={loading || saving}
            // A handle is a token, not prose: every one of these stops a
            // mobile keyboard from "helpfully" capitalising or correcting it
            // into something the mention parser can't read.
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={loading ? "Loading…" : "ali-khan"}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-help ${inputId}-err` : `${inputId}-help`}
            className={cn(
              "w-full rounded-xl border bg-bg py-2.5 pl-8 pr-4 font-mono text-sm text-fg focus:bg-surface focus:outline-none disabled:opacity-60",
              error
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          />
        </div>
        <button
          type="button"
          onClick={save}
          // Disabled while unchanged, which also keeps the one legacy edge
          // case out of reach: the backfill applied no length rule, so a
          // handle shorter or longer than the schema's bounds can exist and
          // keeps working — its owner is simply never asked to re-submit it
          // untouched.
          disabled={!dirty || saving || loading}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {saving ? "Saving…" : "Save handle"}
        </button>
      </div>

      {/* The one line that explains why this field exists at all. Someone
          whose name is written in Urdu can't guess it from the label. */}
      <p id={`${inputId}-help`} className="mt-2 text-xs text-fg-muted">
        Your handle is the name teammates type to tag you — separate from your display name, so a
        name written in any script still has an address anyone can type.
      </p>
      {error && (
        <p id={`${inputId}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <p className="mt-3 border-t border-border pt-3 text-xs text-fg-muted">
        In a comment or a chat message, {name} is{" "}
        <span className="font-mono text-sm font-bold text-primary-strong">@{preview}</span>
      </p>
    </div>
  );
}

/** Tone → class for the period sentence. Neutral keeps the muted body colour. */
function periodNoticeClass(tone: BillingNoticeTone | undefined): string {
  if (tone === "danger") return "font-medium text-danger";
  if (tone === "warning") return "font-medium text-warning-strong";
  return "text-fg-muted";
}

function BillingSection({ billing }: { billing: BillingSummary }) {
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const isTeam = billing.plan === "team";
  // `status` is this summary's name for `subscriptionStatus`; the notice reads
  // (plan, status, paid-through date) together — see lib/billing/plan.ts.
  const period = describeBillingPeriod(
    {
      plan: billing.plan,
      subscriptionStatus: billing.status,
      currentPeriodEnd: billing.currentPeriodEnd,
    },
    formatDate
  );

  async function upgrade() {
    setBusy("checkout");
    const res = await createCheckoutSessionAction();
    if (!res.success) {
      toast.error(res.error);
      setBusy(null);
      return;
    }
    window.location.href = res.data.url;
  }

  async function manage() {
    setBusy("portal");
    const res = await createBillingPortalSessionAction();
    if (!res.success) {
      toast.error(res.error);
      setBusy(null);
      return;
    }
    window.location.href = res.data.url;
  }

  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg/40 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-fg">
            {isTeam ? PLAN_LABELS.team : `${PLAN_LABELS.free} (Free)`}
          </p>
          {isTeam && billing.status && (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-primary-strong">
              {billing.status.replace("_", " ")}
            </span>
          )}
        </div>
        {/*
          bill-005. This was one branch for every status: isTeam, then a template
          literal reading "Renews <date>" whenever a date existed at all.
          `currentPeriodEnd` is `ends_at ?? renews_at`, and `ends_at` is set
          PRECISELY WHEN THE
          SUBSCRIPTION HAS BEEN CANCELLED — so the one case where the date means
          "your access stops" was the one case guaranteed to read "you will be
          charged again". It also hid a lapsed workspace behind a cheerful
          past-dated "Renews".

          The sentence now comes from `describeBillingPeriod`, which lives beside
          `effectivePlan` so the wording and the entitlement cannot drift apart,
          and which returns null only for a workspace that has never subscribed —
          the free-plan pitch below.
        */}
        <p className={cn("mt-0.5 text-xs", periodNoticeClass(period?.tone))}>
          {period
            ? period.text
            : `Up to ${FREE_MEMBER_LIMIT} members. Upgrade for unlimited co-founders and investor-ready extras.`}
        </p>
      </div>

      {!billing.configured ? (
        <span className="shrink-0 text-xs text-fg-muted">
          Billing isn&apos;t set up on this deployment.
        </span>
      ) : isTeam ? (
        <button
          onClick={manage}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-bg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover disabled:opacity-60"
        >
          <CreditCard className="h-4 w-4" aria-hidden="true" />
          {busy === "portal" ? "Opening…" : "Manage billing"}
        </button>
      ) : (
        <button
          onClick={upgrade}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          <CreditCard className="h-4 w-4" aria-hidden="true" />
          {busy === "checkout" ? "Starting…" : "Upgrade to Team"}
        </button>
      )}
    </div>
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

function StatCard({
  icon: Icon,
  label,
  value,
  desc,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  desc: string;
  tone: "primary" | "forest" | "mint";
}) {
  const toneText =
    tone === "forest"
      ? "text-forest-strong"
      : tone === "mint"
        ? "text-mint-strong"
        : "text-primary-strong";
  const toneFill =
    tone === "forest" ? "bg-forest/10" : tone === "mint" ? "bg-mint/10" : "bg-primary/10";
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          {label}
        </p>
        <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", toneFill)}>
          <Icon className={cn("h-3.5 w-3.5", toneText)} aria-hidden="true" />
        </div>
      </div>
      <p className="font-mono text-2xl font-bold tabular-nums text-fg">{value}</p>
      <p className="mt-1 truncate text-xs text-fg-muted" title={desc}>
        {desc}
      </p>
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
