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
import { useDateFormat, useT } from "@/lib/i18n/use-t";
import { splitAroundPlaceholder, type Locale } from "@/lib/i18n/strings";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { formatDuration } from "@/lib/time/thresholds";
import type { AccountStats } from "@/lib/queries/stats";
// Type-only: lib/queries/billing.ts is server-only (it imports the Prisma
// client), so a VALUE import here would drag Prisma into the client bundle.
import type { BillingCharge, BillingSummary } from "@/lib/queries/billing";
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
import { BillingConfirmation } from "./billing-confirmation";
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
  billing: BillingSummary | null;
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
  const d = useDateFormat();
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
  // Which export is in flight, so the two buttons don't both say "Preparing…".
  const [exporting, setExporting] = useState<null | "workspace" | "me">(null);
  const canDeleteWorkspace = user.role === "admin";
  // Same gate the /api/export route enforces server-side: only finance-
  // seeing roles can pull a full-WORKSPACE JSON (a member export would
  // leak every transaction past the app's finance wall).
  //
  // The PERSONAL export below is deliberately NOT gated — acct-009. Until
  // 2026-09-29 this flag decided whether the Data & storage section offered
  // anything at all, so a member's only data operation on this page was
  // "Delete my account". The route now answers ?scope=me for every role and
  // builds a different payload from different queries, so widening who may
  // export did not widen what a member sees; this gate still guards only the
  // workspace file.
  const canExport = canSeeFinances(user.role as Role);

  function refresh() {
    startTransition(() => router.refresh());
  }

  // bill-021. The return-from-checkout handling used to live here: one
  // `router.refresh()` in the same tick as a toast promising the plan would
  // "update in a moment", `[]` deps, and nothing that ever looked again. The
  // webhook that writes the plan is a separate delivery, so that promise was
  // routinely broken while an Upgrade button sat on screen. It now belongs to
  // `BillingConfirmation`, rendered inside the billing card, which polls to a
  // bounded window and reports an unconfirmed payment as such.
  //
  // Note that the old comment said "Stripe Checkout". Billing is LemonSqueezy —
  // Stripe does not onboard Pakistan-based sellers and there is no Stripe
  // handler in this repo.

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

  /**
   * Both exports go through here; the server decides what each one contains.
   *
   * `scope` is passed to the route, never used to shape the payload on this
   * side — a UI that filtered an over-broad response would be the security bug
   * this finding is about. /api/export?scope=me never reads the money tables at
   * all for a caller who may not see them.
   */
  async function handleExport(scope: "workspace" | "me") {
    // Fetch-then-blob (rather than a bare <a href>) so a 403/500 surfaces
    // as a toast instead of navigating the user to a raw JSON error page.
    setExporting(scope);
    try {
      const res = await fetch(`/api/export?scope=${scope}`);
      // An expired session gets a 307 → /login (public, returns 200 HTML).
      // fetch follows it, so res.ok would be true — guard on redirect +
      // content-type so we don't hand the user login HTML named .json with
      // a success toast. (Adversarial review finding, 2026-07-04.)
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || res.redirected || !contentType.includes("application/json")) {
        throw new Error("export-failed");
      }
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const name =
        scope === "me" ? `founderflow-my-data-${stamp}.json` : `founderflow-export-${stamp}.json`;
      downloadFile(blob, name, "application/json");
      toast.success(t.settings.exportReadyToast);
    } catch {
      toast.error(t.settings.exportFailedToast);
    } finally {
      setExporting(null);
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
          value={d.date(stats.memberSince)}
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
              {t.settings.joined} {d.date(user.createdAt)}
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
                {d.date(company.createdAt)}
              </p>
            </DataCell>
          </div>
        </Section>
      )}

      {/* Billing is the workspace owner's concern — admin only. And `billing`
          is null for anyone who may not see money (A43), so this is two
          independent conditions rather than one restated twice: the server
          decides who the DATA reaches, this decides who the CARD reaches. */}
      {user.role === "admin" && billing && (
        <Section icon={CreditCard} label="Plan & billing">
          <BillingSection billing={billing} workspaceCurrency={company.currency} />
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

      {/* id: the anchor the danger zone's acct-018 hint links to. */}
      <Section icon={Database} label={t.settings.dataStorage} id="data-storage">
        <p className="mb-4 text-sm text-fg-muted">{t.settings.dataNote}</p>
        {canExport && (
          <div className="mb-4 flex flex-col items-start gap-3 rounded-xl border border-border bg-bg/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">{t.settings.exportWorkspace}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{t.settings.exportWorkspaceDesc}</p>
            </div>
            <button
              onClick={() => handleExport("workspace")}
              disabled={exporting !== null}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-bold text-primary-strong transition-colors hover:bg-primary/20 active:scale-95 disabled:opacity-60"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting === "workspace"
                ? t.settings.exportPreparing
                : t.settings.exportWorkspaceAction}
            </button>
          </div>
        )}
        {/* acct-009 — every role, including a member, can take a copy of their
            own data. NOT inside the danger zone (where the audit suggested it):
            a download destroys nothing, and acct-007 is this page's own record
            of what dressing a harmless action in danger red costs. It sits with
            the workspace export because "Data & storage" is the section a
            person looks in for exactly this.

            i18n debt, deliberate: lib/i18n/strings.ts belongs to another agent
            this batch, so these three labels are English literals for now —
            the same shape HandleSection below already ships. The keys to add
            are settings.exportMine / exportMineDesc / exportMineAction. */}
        <div className="mb-4 flex flex-col items-start gap-3 rounded-xl border border-border bg-bg/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">Export my data</p>
            <p className="mt-0.5 text-xs text-fg-muted">
              A JSON copy of everything this workspace holds about you — your profile, your tasks,
              your tracked time, your comments and your notification settings. Take it before you
              delete your account.
            </p>
          </div>
          <button
            onClick={() => handleExport("me")}
            disabled={exporting !== null}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-bold text-primary-strong transition-colors hover:bg-primary/20 active:scale-95 disabled:opacity-60"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {exporting === "me" ? t.settings.exportPreparing : "Download my data"}
          </button>
        </div>
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
        <p className="mb-2 text-sm text-fg-muted">{t.settings.dangerZoneNote}</p>
        {/* acct-018. The offer has to be visible where the decision is made. The
            export cards are two sections up and were mentioned nowhere here, so
            "take a copy first" only reached whoever happened to scroll past them.
            A LINK, not just a sentence, and pointing UP at Data & storage rather
            than moving the card down here — acct-007 is this page's own record of
            what dressing a harmless action in danger red cost. */}
        <DangerZoneExportHint />
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

      <DeleteAccountModal
        open={deleteAccountOpen}
        onClose={() => setDeleteAccountOpen(false)}
        // acct-018. The modal's own hint has to name the right FILE, and only the
        // workspace export contains the transactions its sole-founder branch
        // destroys. `deletesWorkspace` is computed from `otherUsers === 0` alone
        // (lib/actions/account.ts) and never consults the role, so the modal is told
        // whether this reader can actually reach that card instead of assuming the
        // last live user is an admin.
        canExportWorkspace={canExport}
      />
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
  id,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "danger";
  action?: React.ReactNode;
  /** Anchor target, so another part of the page can link to this section. */
  id?: string;
  children: React.ReactNode;
}) {
  const toneText = tone === "danger" ? "text-danger" : "text-primary-strong";
  const toneFill = tone === "danger" ? "bg-danger/10" : "bg-primary/10";
  return (
    // scroll-mt: the app shell has a sticky topbar, so an un-offset anchor jump
    // lands the section's heading underneath it.
    <section id={id} className="scroll-mt-24 rounded-2xl border border-border bg-surface p-6">
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
 * acct-018. The danger zone's pointer at the two export cards in Data & storage.
 *
 * WHY A COMPONENT AND NOT A LINE OF JSX. The copy contains a `{dataSection}`
 * placeholder where the link goes, so that Urdu can put the section name where
 * Urdu puts it instead of having an English-shaped sentence with a link bolted on
 * the end. Rendering that means splitting the string, which is three statements,
 * not an expression.
 *
 * WHAT THIS LINE DELIBERATELY DOES NOT SAY: anything about what the file
 * contains. At this point the page does not know whether "Delete my account" will
 * tombstone one user or run the whole-workspace cascade, and `?scope=me` omits
 * every money table — so the precise version is in the confirmation dialogs,
 * which do know. See lib/i18n/strings.ts.
 *
 * WHY `splitAroundPlaceholder` AND NOT `.split()`. A raw split on a locale that
 * inlined the section name and lost the token returns ONE element, so `after` is
 * `undefined` and this rendered the entire sentence followed by a bare
 * "Data & storage" hyperlink hanging off its end. Both shipped locales carry the
 * token and every locale in DICTIONARIES is swept for it by
 * tests/app/settings/danger-zone-export-pointer.test.ts — this branch is the
 * fallback for the locale that has not been written yet, and it drops the LINK
 * rather than mangling the sentence.
 */
function DangerZoneExportHint() {
  const t = useT();
  const parts = splitAroundPlaceholder(t.settings.dangerZoneExportHint, "{dataSection}");
  if (!parts) {
    return <p className="mb-4 text-sm text-fg-muted">{t.settings.dangerZoneExportHint}</p>;
  }
  return (
    <p className="mb-4 text-sm text-fg-muted">
      {parts.before}
      <a
        href="#data-storage"
        className="font-semibold text-primary-strong underline decoration-dotted underline-offset-2 transition-colors hover:text-primary"
      >
        {t.settings.dataStorage}
      </a>
      {parts.after}
    </p>
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
            className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 font-mono text-sm text-fg-muted"
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
              "w-full rounded-xl border bg-bg py-2.5 pe-4 ps-8 font-mono text-sm text-fg focus:bg-surface focus:outline-none disabled:opacity-60",
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

/**
 * The charge as the customer's bank would print it (bill-016).
 *
 * PREFERS THE PROVIDER'S OWN STRING. `total_formatted` comes off the invoice
 * payload already rendered by LemonSqueezy, so it needs no assumption about
 * where the symbol goes or how many minor units the currency has.
 *
 * THE FALLBACK IS WHERE THE CARE IS. `amountMinor` is in the currency's MINOR
 * unit, and dividing by 100 is only right for currencies that have two of them:
 * a ¥1,500 charge rendered as ¥15 is a tenfold understatement presented as
 * fact, which is worse than showing nothing. So the exponent is asked of `Intl`
 * (`maximumFractionDigits` under `style: "currency"` is the currency's own digit
 * count — 2 for USD, 0 for JPY).
 *
 * WHAT AN UNKNOWN CURRENCY ACTUALLY DOES, because this used to say "an unknown
 * code returns null so the caller shows the currency statement with no figure
 * attached" and that is only half true. Measured rather than reasoned about:
 * `Intl.NumberFormat` throws `RangeError` only for a MALFORMED code — "Q" does,
 * and the try/catch below duly answers null. A well-formed but UNKNOWN code does
 * not throw: "QQQ" resolves and formats "QQQ 10.00", assuming two minor units.
 * So the real failure mode for an unrecognised currency is a figure computed on
 * a guessed exponent, which is the thing this fallback exists to avoid, not the
 * no-figure path it claimed. It is reachable only because `readInvoiceCharge`
 * validates the field with `currency.length === 0` rather than a three-letter
 * shape — that boundary is pinned in tests/lib/queries/billing-summary.test.ts,
 * with a note to change that case if the validation is ever tightened. Provider
 * data makes it near-unreachable in practice; the wrong reason was the defect.
 *
 * `Math.pow` rather than `**` is a readability choice and nothing more. This
 * used to justify it with "tsconfig sets `lib` but no `target`, so tsc emits
 * ES5", which is wrong twice: tsconfig.json sets `"noEmit": true`, so tsc emits
 * nothing at all, and TypeScript downlevels `**` for an ES5 target without
 * complaint anyway — only bigint operands need es2016+. The genuine ES5 trap in
 * this repo is `matchAll` in a for…of, spreading a Set or a Map, and named
 * capture groups, which DO fail `npm run typecheck` while passing vitest. That
 * rule is real; it just has nothing to do with this line.
 *
 * The locale is fixed at "en" on purpose, and this is NOT the same decision as
 * `useNumberFormat()`. That hook exists so no component names a locale tag when
 * formatting the WORKSPACE's own numbers. This is a foreign-currency total
 * inside a hardcoded-English sentence, and it is the provider's own figure
 * rather than ours — the same argument the date marker in `BillingSection`
 * makes, and the same one `formatAmountForMessage` in lib/utils.ts rests on.
 */
function formatChargeAmount(charge: BillingCharge): string | null {
  if (charge.formatted) return charge.formatted;
  try {
    const nf = new Intl.NumberFormat("en", { style: "currency", currency: charge.currency });
    const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format(charge.amountMinor / Math.pow(10, digits));
  } catch {
    return null;
  }
}

/**
 * The sentence that reconciles the billing currency with the reporting currency.
 *
 * THE FINDING, in one line: `Company.currency` is PKR by default and is printed
 * on this same page, and LemonSqueezy — a merchant of record, which is why it
 * works for a Pakistan-based seller at all — charges the card in its own store
 * currency. Nothing on any screen joined those two facts, so a USD line on a
 * bank statement had nothing in the product to match it against.
 *
 * It names LemonSqueezy rather than FounderFlow because LemonSqueezy is the name
 * that actually appears on the statement.
 *
 * The mismatch clause is CONDITIONAL. Telling a workspace that already reports
 * in the billing currency that its currencies differ would be the same class of
 * confidently-wrong copy as bill-005's "Renews" on a cancelled subscription,
 * pointed the other way.
 */
function billingCurrencyNote(args: {
  isTeam: boolean;
  billingCurrency: string;
  workspaceCurrency: string;
}): string {
  const subject = args.isTeam ? "Billed" : "Team is billed";
  const who = `${subject} in ${args.billingCurrency} by LemonSqueezy, our merchant of record`;
  if (args.billingCurrency === args.workspaceCurrency) return `${who}.`;
  const tense = args.isTeam ? "appears" : "will appear";
  return (
    `${who} - this workspace reports in ${args.workspaceCurrency}, ` +
    `so the charge ${tense} as ${args.billingCurrency} on your statement.`
  );
}

export function BillingSection({
  billing,
  workspaceCurrency,
}: {
  billing: BillingSummary;
  /**
   * `Company.currency` — what every other number in this product is reported
   * in. Passed in rather than read from the summary because the point of it
   * here is the COMPARISON with `billing.billingCurrency` (bill-016).
   */
  workspaceCurrency: string;
}) {
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
    // locale-free-date-ok: the bare helper, not `useDateFormat()`. The sentence
    // this date lands in ("Renews …", "Payment failed - update your card by
    // …") is hardcoded English in lib/billing/plan.ts, so localising only the
    // date would half-translate it — the same argument `formatAmountForMessage`
    // in lib/utils.ts is built on. Localise the sentence first, then this.
    formatDate
  );

  // bill-016. Read, not assumed: `lastCharge` is lifted out of the LemonSqueezy
  // invoice payload this app already stores. Null when the workspace has never
  // been billed, or when those bytes could not be read as an invoice — in which
  // case the currency note below still renders and no figure is shown.
  const charge = billing.lastCharge;
  const chargeAmount = charge ? formatChargeAmount(charge) : null;
  // locale-free-date-ok: the same reasoning as the period notice above, and for
  // the same sentence. This date lands inside hardcoded English ("Last charge
  // $10.00 USD on …") and it is the date on a LemonSqueezy invoice rather than
  // one of the workspace's own records. Localising only the date would
  // half-translate the line; localise the whole billing card first, which needs
  // the copy in lib/billing/plan.ts to move too.
  const chargeDate = charge ? formatDate(new Date(charge.chargedAt)) : null;

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
        {/*
          bill-021. The plan above is the SERVER's answer; this is what fills the
          gap between the charge and the webhook that writes it. Rendered here
          rather than at the top of the page on purpose: the sentence it replaces
          is the plan line directly above it, so a customer reading "Solo (Free)"
          reads "confirming your plan" in the same glance.
        */}
        <BillingConfirmation plan={billing.plan} />
        {/*
          bill-016. The card used to show a plan name, a status token and a date
          — no amount, no currency, no route to a receipt — while the Company
          card on this same page prints `currency: PKR`. Everything below is READ
          (`billing.lastCharge` comes from the stored LemonSqueezy invoice
          payload; see lib/queries/billing.ts) rather than typed in, because a
          hardcoded figure is a lie on the day the variant price changes.

          Gated on `configured`: a deployment with no LemonSqueezy keys has no
          merchant and takes no money, so claiming a USD charge there would be
          inventing a billing relationship.
        */}
        {billing.configured && (
          <>
            {charge && chargeAmount && (
              <p className="mt-1.5 text-xs text-fg-muted">
                Last charge{" "}
                <span className="font-mono font-semibold text-fg">
                  {chargeAmount} {charge.currency}
                </span>{" "}
                on {chargeDate}
              </p>
            )}
            <p className="mt-1.5 text-xs text-fg-muted">
              {billingCurrencyNote({
                isTeam,
                billingCurrency: billing.billingCurrency,
                workspaceCurrency,
              })}
              {/*
                The route to receipts is the customer portal behind the button in
                this card — NOT the `urls.invoice_url` on the stored payload,
                which is a short-lived hosted link and would be dead by the time
                anyone read it. The label is quoted verbatim so the reader can
                find it, the same discipline as the export hints in
                lib/i18n/strings.ts; tests/app/settings/billing-price.test.tsx
                fails if the button is renamed without this following it.

                `hasCustomer` as well as `isTeam`: a hand-comped Team workspace
                (the demo workspace, anyone the operator upgraded by hand) has no
                LemonSqueezy customer, so that button answers "No billing account
                yet — upgrade first.". Sending them there for an invoice would be
                a smaller copy of the defect this whole row is about — a
                confident instruction that leads nowhere.
              */}
              {isTeam && billing.hasCustomer
                ? " Invoices and receipts are under “Manage billing”."
                : ""}
            </p>
          </>
        )}
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
        "rounded-xl border p-4 text-start transition-all",
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
        "rounded-xl border p-4 text-start transition-all",
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
