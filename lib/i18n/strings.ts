/**
 * Lightweight i18n. Flat dictionary keyed by [locale][namespace.key]. No
 * next-intl, no [locale] route segment — locale lives in the Zustand store
 * (gets persisted in localStorage), html lang/dir is synced from Providers.
 *
 * Translating a new string:
 *   1. Add it to both `en` and `ur` below under an appropriate namespace
 *   2. Call `useT().nav.dashboard` (or whatever) in the component
 *
 * Translating a new page:
 *   • Open the page, find every string in JSX, add to dict, replace inline
 *   • Run `npm run typecheck` — TS will yell if a key is missing in either
 *     locale (because the type is derived from `en`)
 *
 * Why not next-intl: this app's pages are mostly auth-gated and not crawled,
 * so URL-based locale routing has no SEO upside. Cookie/store-based switch
 * + a flat dict is simpler to maintain for a ~50-string surface.
 */

export type Locale = "en" | "ur";

export const SUPPORTED_LOCALES: { code: Locale; label: string; dir: "ltr" | "rtl" }[] = [
  { code: "en", label: "English", dir: "ltr" },
  // اردو is right-to-left. Setting `dir: "rtl"` flips text alignment + most
  // inline flow automatically; absolute-positioned UI (sidebar drawer) gets
  // hand-touched in the components where it matters.
  { code: "ur", label: "اردو", dir: "rtl" },
];

/* English is the source of truth — the Strings type is derived from it, so
 * a missing key in `ur` is a TypeScript error. */
export const en = {
  common: {
    save: "Save",
    cancel: "Cancel",
    confirm: "Confirm",
    search: "Search expenses, tasks, team...",
    noResults: "No results",
    workspace: "Workspace",
    signOut: "Sign out",
  },
  nav: {
    dashboard: "Dashboard",
    chat: "Chat",
    // Sidebar-only: the collapsible group heading over the five money
    // surfaces. Has no route of its own.
    finance: "Finance",
    expenses: "Expenses",
    investments: "Investments",
    revenue: "Revenue",
    recurring: "Recurring",
    budgets: "Budgets",
    projects: "Projects",
    tasks: "Tasks",
    time: "Time",
    activity: "Activity",
    team: "Team",
    reports: "Reports",
    notifications: "Notifications",
    settings: "Settings",
  },
  breadcrumb: {
    home: "Home",
    project: "Project",
  },
  auth: {
    // Login form (3-part headings let us keep the inline lime emphasis word
    // distinct from the surrounding prose in both English and Urdu)
    welcomeBack: "Welcome back",
    signInHeadingPre: "Sign in to your ",
    signInHeadingEm: "workspace",
    signInHeadingPost: ".",
    signInTagline: "Pick up where your co-founder left off.",
    email: "Email",
    password: "Password",
    emailPlaceholder: "you@startup.com",
    passwordPlaceholderLogin: "Enter your password",
    showPassword: "Show password",
    hidePassword: "Hide password",
    signIn: "Sign in",
    signInLoading: "Signing in…",
    or: "or",
    tryDemo: "Try the live demo",
    newHere: "New here?",
    createWorkspace: "Create a workspace",
    welcomeBackToast: "Welcome back",
    loginFailedToast: "Login failed",
    networkErrorToast: "We couldn't reach the server. Check your connection and try again.",
    demoLoadedToast: "Loaded demo workspace",
    // Login showcase (right pane)
    loginShowcaseBadge: "Live workspace",
    loginShowcaseHeadingPre: "One shared source of ",
    loginShowcaseHeadingEm: "truth",
    loginShowcaseHeadingPost: ".",
    loginShowcaseDesc:
      "Every PKR, every task, every founder contribution — synced in real time across your team.",
    trackedLabel: "Tracked",
    runwayLabel: "Runway",
    loginFeature1: "Real-time expense & investment tracking",
    loginFeature2: "Role-based access for your whole team",
    loginFeature3: "Investor-ready PDF + Excel exports",

    // Signup form
    signUpShowcaseBadge: "Free for early-stage teams",
    signUpShowcaseHeadingPre: "Aligned co-founders in ",
    signUpShowcaseHeadingEm: "under a minute",
    signUpShowcaseHeadingPost: ".",
    signUpShowcaseDesc:
      "Set up your company, invite co-founders, and track finances and tasks together — in real time.",
    startupsLabel: "Startups",
    tasksDoneLabel: "Tasks done",
    cofounderDuosLabel: "Co-founder duos",
    stepYou: "01 · You",
    stepCompany: "02 · Company",
    stepBadgePre: "Step ",
    stepBadgePost: " of 2",
    signUpHeading1Pre: "Create your ",
    signUpHeading1Em: "account",
    signUpHeading1Post: ".",
    signUpHeading2Pre: "Tell us about your ",
    signUpHeading2Em: "company",
    signUpHeading2Post: ".",
    signUpStep1Note: "We'll use this to set up your founder profile.",
    signUpStep2Note: "You'll be the Admin Founder and can invite others next.",
    fullName: "Full name",
    fullNamePlaceholder: "Ayesha Raza",
    workEmail: "Work email",
    passwordPlaceholderSignup: "8+ chars, mixed case & a number",
    companyName: "Company name",
    companyNamePlaceholder: "Nimbus Labs",
    industry: "Industry",
    back: "Back",
    continue: "Continue",
    createWorkspaceCta: "Create workspace",
    creatingLoading: "Creating…",
    adminFounderNoteTitle: "You'll be the Admin Founder.",
    adminFounderNoteBody: " You can invite co-founders and team members from the dashboard.",
    haveAccount: "Already have an account?",
    welcomeToFFToast: "Welcome to FounderFlow",
    signupFailedToast: "Sign up failed",
    // Password reset — request + set flows
    forgotPassword: "Forgot password?",
    forgotPasswordTitle: "Reset your password",
    forgotPasswordTagline:
      "Enter your email and we'll send you a link to set a new password. The link expires in 15 minutes.",
    sendResetLink: "Send reset link",
    sendingResetLink: "Sending…",
    resetLinkSentTitle: "Check your inbox",
    resetLinkSentBody:
      "If an account matches that email, we've sent a link to reset your password. Follow it within 15 minutes.",
    backToSignIn: "Back to sign in",
    rememberPassword: "Remember your password?",
    resetPasswordTitle: "Set a new password",
    resetPasswordTagline:
      "Choose a password you don't use anywhere else. Mixed case + a digit, at least 8 characters.",
    newPassword: "New password",
    newPasswordPlaceholder: "At least 8 characters",
    setNewPassword: "Set new password",
    settingNewPassword: "Saving…",
    resetPasswordSuccessTitle: "Password reset",
    resetPasswordSuccessBody: "Sign in with your new password to continue.",
    resetLinkInvalidTitle: "This link isn't valid",
    resetLinkInvalidBody:
      "It may have expired or already been used. Request a fresh link and try again.",
    // Email verification (A2)
    verifyingTitle: "Confirming your email…",
    verifyingBody: "One moment while we verify your link.",
    verifiedTitle: "Email confirmed",
    verifiedBody: "Thanks — your email is verified. You're all set.",
    verifiedCta: "Go to dashboard",
    verifyInvalidTitle: "This link isn't valid",
    verifyInvalidBody:
      "It may have expired or already been used. Sign in and resend a fresh confirmation email.",
    verifyBannerTitle: "Confirm your email.",
    verifyBannerBody: "We sent a link to {email}. Confirm it to secure account recovery.",
    verifyResend: "Resend email",
    verifyResending: "Sending…",
    verifyResendToast: "Confirmation email sent",
    verifyAlreadyDone: "Your email is already verified",
    verifyDismiss: "Dismiss",
  },
  topbar: {
    profileSettings: "Profile & settings",
    teamManagement: "Team management",
    accountMenu: "Account menu",
    notificationsLabel: "Notifications",
    openMenu: "Open navigation menu",
    markAllRead: "Mark all read",
    noNotifications: "No notifications yet",
    viewAll: "View all notifications",
    signedOutToast: "Signed out",
  },
  projects: {
    badge: "Initiatives",
    title: "Projects",
    subtitle: "Group tasks and budgets under the initiatives your team is actually running.",
    newProject: "New project",
    noProjectsTitle: "No projects yet",
    noProjectsAdminDesc:
      "Create your first project to group tasks, budgets, and time under one roof.",
    noProjectsMemberDesc: "You're not on any projects yet — ask a founder to add you to one.",
    supervisor: "Supervisor",
    changeSupervisor: "Change supervisor",
    editProject: "Edit project",
    archiveProject: "Archive",
    deleteProject: "Delete",
    deleteConfirmTitle: "Delete this project?",
    deleteConfirmDesc:
      "Only empty projects can be deleted. Archive a project to keep its history intact.",
    archiveConfirmTitle: "Archive this project?",
    archiveConfirmDesc:
      "Archived projects stay readable but get hidden from the default list and stop accepting new tasks or budgets.",
    statusActive: "Active",
    statusOnHold: "On hold",
    statusCompleted: "Completed",
    statusArchived: "Archived",
    statusAll: "All",
    status: "Status",
    color: "Color",
    targetEndDate: "Target end date",
    targetEndDateOverdue: "Overdue",
    name: "Name",
    description: "Description",
    openTasks: "Open tasks",
    monthSpend: "Month-to-date spend",
    hoursTracked: "Hours tracked",
    members: "Members",
    tasks: "Tasks",
    budgets: "Budgets",
    projectCreatedToast: "Project created",
    projectSavedToast: "Project updated",
    supervisorChangedToast: "Supervisor changed",
    projectArchivedToast: "Project archived",
    projectDeletedToast: "Project deleted",
    unarchiveProject: "Restore",
    projectRestoredToast: "Project restored",

    /* The duplicate flow: the card affordance and its modal.
     *
     * `duplicateProject` is the short verb on the card button, matching its
     * neighbours above (`archiveProject: "Archive"`); `duplicateSubmit` is the
     * full-sentence confirm inside the modal, where a bare "Duplicate" next to
     * a Cancel would not say what is about to be duplicated.
     *
     * The three hints are the arguments for the three defaults, not decoration
     * — each one answers the question its checkbox raises, and a reader who
     * only sees the label would guess wrong on at least `keepAssignees`. */
    duplicateProject: "Duplicate",
    duplicateNameLabel: "New project name",
    /* Seeded into the name field as "<source> (copy)" — the fast path is one
     * click, and the user renames it if they care. Translated because it is
     * text they read and edit, not a marker the server looks for. */
    duplicateNameSuffix: "(copy)",
    duplicateCopyTasks: "Copy the task list",
    duplicateCopyTasksHint:
      "Tasks arrive reset to Pending — a copy is a plan, not a record of work done.",
    duplicateKeepAssignees: "Keep each task's assignee",
    duplicateKeepAssigneesHint:
      "Off by default: duplicating shouldn't hand colleagues work they never agreed to. Off assigns everything to you.",
    duplicateShiftDeadlines: "Shift deadlines to start today",
    duplicateShiftDeadlinesHint:
      "Keeps the gaps between deadlines, just moved forward — otherwise the copy lands entirely overdue.",
    duplicateNeverCopied: "Budgets, expenses, revenue, time entries and comments are never copied.",
    duplicateSubmit: "Duplicate project",
    duplicateSubmitting: "Duplicating…",
    projectDuplicatedToast: "Project duplicated",
  },
  settings: {
    workspaceBadge: "Workspace",
    title: "Settings",
    subtitle: "Manage your account, workspace, and preferences.",
    profile: "Profile",
    joined: "Joined",
    company: "Company",
    industryLabel: "Industry",
    appearance: "Appearance",
    appearanceNote: "Choose how FounderFlow looks for you.",
    light: "Light",
    lightDesc: "Clean, classic, energizing",
    dark: "Dark",
    darkDesc: "Easy on the eyes for long sessions",
    language: "Language",
    languageNote:
      "Change the interface language. Urdu is in beta — navigation, settings, and sign-in are translated; some pages are still in English while we finish coverage.",
    english: "English",
    urdu: "اردو",
    // "left-to-right" here is prose, not a Tailwind utility. The RTL sweep in
    // tests/lib/layout/rtl.test.ts used to scan this file and matched it as
    // one; the file has been removed from that scan instead, because a copy
    // file cannot contain a class and rewording correct customer-facing copy to
    // satisfy a regex is the wrong repair. Leave this sentence as it reads.
    englishDesc: "Default left-to-right layout",
    urduDesc: "Right-to-left · Beta (some pages still English)",
    dataStorage: "Data & storage",
    dataNote:
      "Your workspace data lives in Supabase. Clearing local data only wipes UI prefs (theme, sidebar state) — it does not delete server data.",
    exportWorkspace: "Export workspace",
    exportWorkspaceDesc:
      "Download a machine-readable JSON copy of everything in this workspace — projects, tasks, transactions, budgets, time, comments. Password hashes are never included.",
    exportWorkspaceAction: "Export JSON",
    exportPreparing: "Preparing…",
    exportReadyToast: "Export downloaded",
    exportFailedToast: "Couldn't export — try again",
    resetLocalPrefs: "Reset local preferences",
    signOutSection: "Sign out",
    signOutNote: "Sign out of your FounderFlow workspace.",
    role: "Role",
    userId: "User ID",
    name: "Name",
    currency: "Currency",
    created: "Created",
    adminFounderRole: "Admin Founder",
    cofounderRole: "Co-Founder",
    teamMemberRole: "Team Member",
    // Confirm dialogs
    signOutConfirmTitle: "Sign out?",
    signOutConfirmDesc: "You can sign back in any time.",
    // acct-007. This dialog used to read "Reset workspace data?" / "All
    // transactions, tasks, activity, and team members will be wiped. This cannot
    // be undone." / "Reset everything", in danger red — and then removed one
    // localStorage key. It contradicted the button that opens it ("Reset local
    // preferences") AND the section's own note four keys up. Both directions hurt:
    // a user who wanted their data gone believed it was, and a user clearing a
    // stuck theme was told they were about to destroy the company's books.
    resetConfirmTitle: "Reset local preferences?",
    resetConfirmDesc:
      "Theme, language and sidebar state on this device will be cleared. " +
      "Your workspace data isn't affected, and nothing is removed from the server.",
    resetConfirmLabel: "Clear preferences",
    signedOutToast: "Signed out",
    // Account stats
    stats: "Activity at a glance",
    totalTracked: "Time tracked",
    sessionCount: "Sessions",
    lastSignIn: "Last sign-in",
    lastSignInNever: "First sign-in",
    memberSince: "Member since",
    // Profile edit
    editProfile: "Edit profile",
    profileSaved: "Profile updated",
    changePassword: "Change password",
    // Change-email flow (S3)
    changeEmail: "Change email",
    changeEmailDesc:
      "Your current email is {email}. We'll send a confirmation link to the new address — the change only takes effect once you click it.",
    newEmail: "New email",
    changeEmailSend: "Send confirmation",
    changeEmailSentBody:
      "Confirmation sent to {email}. Click the link in that inbox to finish the change. Your current email stays active until then.",
    changeEmailConfirming: "Confirming your new email…",
    changeEmailDoneTitle: "Email changed",
    changeEmailDoneBody: "Your login email is updated. Use it next time you sign in.",
    changeEmailInvalidTitle: "This link isn't valid",
    changeEmailInvalidBody:
      "It may have expired or already been used. Request the change again from Settings.",
    // Install app (PWA)
    installApp: "Install app",
    installAppNote:
      "Add FounderFlow to your home screen or dock for a full-screen, app-like experience that works offline.",
    installAppAction: "Install FounderFlow",
    installAppInstalled: "FounderFlow is installed.",
    installAppUnavailable:
      "Your browser doesn't offer install here. On iOS, use Share → Add to Home Screen.",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    passwordChanged: "Password changed",
    passwordChangedSignOut: "Password changed — sign in again",
    saveChanges: "Save changes",
    cancel: "Cancel",
    saving: "Saving…",
    // Company edit
    editCompany: "Edit company",
    companySaved: "Company updated",
    // Sections only admin / cofounder see
    companyEditNoteAdmin: "Founders and co-founders can update these details.",
    // Danger zone — S2, GDPR/CCPA
    //
    // ## acct-011: none of this is permanent, and saying so cost us restores
    //
    // Every string below used to promise irreversibility — "there is no undo",
    // "This is permanent", "Permanently remove", "Not reversible." What the code
    // does instead: `deleteAccountAction` and `deleteWorkspaceAction` write a
    // `deletedAt` tombstone (lib/actions/account.ts, whose own header carries the
    // recovery SQL), the purge cron keeps tombstoned rows for RETENTION_DAYS = 90,
    // and that purge is DRY-RUN unless `PURGE_ENABLED === "true"` — which it is
    // not — so today nothing is erased at all. The one customer who most needs to
    // know there is a window was the one told, in the danger colour, that there
    // was nothing worth asking for.
    //
    // ## What these strings may and may not promise
    //
    //  • "access ends immediately" is TRUE and stays: auth and every scoped query
    //    filter `deletedAt: null`, and `sessionVersion` kills the live session, so
    //    the workspace is unreachable from the moment of the click.
    //  • "a recoverable copy for 90 days" is TRUE UNDER BOTH `PURGE_ENABLED`
    //    settings, because it is a FLOOR. With the purge off, rows outlive the
    //    window; with it on, the window is exactly what the cron enforces. That is
    //    the only reason a number may appear here at all.
    //  • Nothing here claims what happens on day 91. That sentence is the one
    //    whose truth depends on an env var nobody has set, and it is not the
    //    question being asked at click time. The security-notice email
    //    (lib/email/templates/security-notice.ts) carries the concrete deadline
    //    date instead — it is sent at the real `deletedAt`, is read at the START
    //    of the clock, and is the surface the customer will still have in 80 days.
    //    A date computed HERE, before the click, could not be the same instant the
    //    email will quote, and two surfaces naming two deadlines is a worse bug
    //    than the one being fixed.
    //  • Recovery is a manual SQL UPDATE by an operator, not a self-service
    //    button, so the copy points at support rather than at a control that does
    //    not exist.
    //
    // The "90" is held against the cron's own RETENTION_DAYS by
    // tests/lib/i18n/delete-copy.test.ts, in both locales. Latin digits in the
    // Urdu copy are the pinned decision, not an oversight — see the argument in
    // lib/i18n/numbering.ts.
    dangerZone: "Danger zone",
    dangerZoneNote:
      "These take effect the moment you confirm — access ends immediately. Nothing is erased " +
      "straight away, though: we keep a recoverable copy for 90 days, so contact support right " +
      "away if it was a mistake.",
    // acct-018. The export card is two sections up, and nobody scrolling towards
    // "Delete my account" reads it. This line is the pointer, and it deliberately
    // promises NOTHING about what the file contains: at this point on the page the
    // app does not yet know whether this account-delete tombstones one user or
    // runs the whole-workspace cascade, and `?scope=me` omits the money tables.
    // The precise, branch-aware version lives in the two confirmation dialogs
    // below, which do know. `{dataSection}` is replaced by a link to the
    // "Data & storage" section — a placeholder rather than an appended sentence so
    // Urdu keeps its own word order.
    dangerZoneExportHint:
      "Nothing here takes a copy for you. If you want one, download it from {dataSection} " +
      "above before you confirm — afterwards access ends immediately.",
    deleteAccount: "Delete my account",
    deleteAccountDesc:
      "Removes your user record and everything you own from the app. If you're the only person in this workspace, the workspace goes with you.",
    deleteAccountAction: "Delete account",
    deleteAccountConfirmDesc:
      "You'll be signed out and lose access immediately. We keep a recoverable copy for 90 days — " +
      "contact support right away if this is a mistake. Enter your password below to confirm.",
    // acct-018, the multi-user branch: the workspace survives, so the only file
    // that matters to the leaver is their own — and `?scope=me` does contain all
    // of it. Names the card's own label, because that is the text on the button
    // they are being sent to find.
    exportBeforeAccountDeleteHint:
      "Want your own copy first? Cancel, and use “Download my data” under Data & storage — " +
      "your profile, tasks, tracked time and comments.",
    // acct-013. Shown INSTEAD of the line above when the caller is the only member
    // of their workspace — the case where "Delete my account" runs the identical
    // whole-workspace cascade that "Delete this workspace" runs. FounderFlow's
    // target user is the solo founder, so this is not the rare branch: it is the
    // normal one. `{workspace}` is substituted by the modal.
    deleteAccountWorkspaceConfirmDesc:
      "You're the only person in {workspace}, so this deletes the whole workspace — " +
      "every transaction, task, budget and comment goes with it, and any active Team " +
      "subscription is cancelled. We keep a recoverable copy for 90 days; contact support " +
      "right away if this is a mistake. Type the workspace name exactly, then your password.",
    // acct-018, and the reason this key is not one undifferentiated "export first"
    // line. `personalExport` (app/api/export/route.ts) never queries Transaction,
    // Budget or RecurringRule in ANY role — money belongs to the workspace, not to
    // a person — while both whole-workspace branches destroy all three. So telling
    // a solo founder to "download your data" would hand them a file with none of
    // their ledger in it and call it their data. Shared by the sole-founder branch
    // of the account dialog and by the workspace dialog, because they destroy the
    // identical rows.
    //
    // QUOTES THE BUTTON, NOT THE CARD. This line used to send the reader for the
    // “Export workspace” file — which is the card's HEADING; the button under it
    // reads “Export JSON” (exportWorkspaceAction), so someone scanning for a
    // button with that label found none, in the one branch where the file they
    // are being sent for is the only copy of their ledger. The sibling hint
    // quotes “Download my data”, which really is button text, so both now name
    // the same kind of target. tests/app/settings/danger-zone-export-pointer.
    // test.ts reads both labels out of settings-client.tsx and fails if a button
    // is renamed without this copy following it.
    exportBeforeWorkspaceDeleteHint:
      "This deletes the whole workspace, and “Download my data” does not include its " +
      "transactions, budgets or recurring rules. To keep those, cancel and press " +
      "“Export JSON” under Data & storage first.",
    deleteAccountAndWorkspaceAction: "Delete account + workspace",
    passwordConfirm: "Enter your password",
    deleteWorkspace: "Delete this workspace",
    deleteWorkspaceDesc:
      "Ends access for the workspace and everyone on it — every transaction, task, budget and comment goes with it.",
    deleteWorkspaceAction: "Delete workspace",
    // acct-002: the delete now cancels the LemonSqueezy subscription, and this is
    // the last screen that can say so — afterwards every user is tombstoned and
    // "Manage billing" is unreachable.
    deleteWorkspaceConfirmDesc:
      "Everyone loses access immediately, and any active Team subscription is cancelled " +
      "so you stop being charged. We keep a recoverable copy for 90 days — contact support " +
      "right away if this is a mistake. Type the workspace name exactly, then your password.",
    workspaceNameConfirm: "Type the workspace name",
    accountDeletedToast: "Account deleted",
    workspaceDeletedToast: "Workspace deleted",
  },
};

/* Urdu translations. Style: conversational, modern, mixes English loan-words
 * where they're standard in Pakistani business usage (e.g. "Dashboard",
 * "Email", "Password"). This keeps the UI feeling native without sounding
 * like a 1990s government form. */
export const ur: typeof en = {
  common: {
    save: "محفوظ کریں",
    cancel: "منسوخ",
    confirm: "تصدیق کریں",
    search: "اخراجات، کام، ٹیم تلاش کریں...",
    noResults: "کوئی نتیجہ نہیں",
    workspace: "ورک اسپیس",
    signOut: "سائن آؤٹ",
  },
  nav: {
    dashboard: "ڈیش بورڈ",
    chat: "گفتگو",
    finance: "مالیات",
    expenses: "اخراجات",
    investments: "سرمایہ کاری",
    revenue: "آمدنی",
    recurring: "تکراری",
    budgets: "بجٹ",
    projects: "منصوبے",
    tasks: "کام",
    time: "ٹائم",
    activity: "سرگرمی",
    team: "ٹیم",
    reports: "رپورٹس",
    notifications: "اطلاعات",
    settings: "ترتیبات",
  },
  breadcrumb: {
    home: "ہوم",
    project: "منصوبہ",
  },
  auth: {
    welcomeBack: "خوش آمدید",
    signInHeadingPre: "اپنے ",
    signInHeadingEm: "ورک اسپیس",
    signInHeadingPost: " میں سائن ان کریں۔",
    signInTagline: "وہیں سے دوبارہ شروع کریں جہاں آپ کے کو فاؤنڈر نے چھوڑا تھا۔",
    email: "ای میل",
    password: "پاس ورڈ",
    emailPlaceholder: "you@startup.com",
    passwordPlaceholderLogin: "اپنا پاس ورڈ درج کریں",
    showPassword: "پاس ورڈ دکھائیں",
    hidePassword: "پاس ورڈ چھپائیں",
    signIn: "سائن ان",
    signInLoading: "سائن ان ہو رہا ہے…",
    or: "یا",
    tryDemo: "ڈیمو آزمائیں",
    newHere: "نئے یہاں؟",
    createWorkspace: "ورک اسپیس بنائیں",
    welcomeBackToast: "خوش آمدید",
    loginFailedToast: "سائن ان ناکام",
    networkErrorToast: "سرور تک رسائی نہیں ہو سکی۔ اپنا انٹرنیٹ چیک کریں اور دوبارہ کوشش کریں۔",
    demoLoadedToast: "ڈیمو ورک اسپیس لوڈ ہو گیا",
    loginShowcaseBadge: "لائیو ورک اسپیس",
    loginShowcaseHeadingPre: "ایک مشترکہ ",
    loginShowcaseHeadingEm: "سچائی",
    loginShowcaseHeadingPost: " کا ذریعہ۔",
    loginShowcaseDesc:
      "ہر روپیہ، ہر کام، ہر فاؤنڈر کی شراکت — آپ کی ٹیم میں حقیقی وقت میں ہم آہنگ۔",
    trackedLabel: "ٹریک کردہ",
    runwayLabel: "رن وے",
    loginFeature1: "اخراجات اور سرمایہ کاری کی ریئل ٹائم ٹریکنگ",
    loginFeature2: "پوری ٹیم کے لیے رول بیسڈ رسائی",
    loginFeature3: "انویسٹر ریڈی PDF اور ایکسل ایکسپورٹس",

    signUpShowcaseBadge: "ابتدائی ٹیموں کے لیے مفت",
    signUpShowcaseHeadingPre: "ایک منٹ سے کم میں ",
    signUpShowcaseHeadingEm: "ہم آہنگ",
    signUpShowcaseHeadingPost: " کو فاؤنڈرز۔",
    signUpShowcaseDesc:
      "اپنی کمپنی سیٹ اپ کریں، کو فاؤنڈرز کو دعوت دیں، اور مالیات اور کام ایک ساتھ حقیقی وقت میں ٹریک کریں۔",
    startupsLabel: "اسٹارٹ اپس",
    tasksDoneLabel: "مکمل کام",
    cofounderDuosLabel: "کو فاؤنڈر جوڑے",
    stepYou: "01 · آپ",
    stepCompany: "02 · کمپنی",
    stepBadgePre: "مرحلہ ",
    stepBadgePost: " از 2",
    signUpHeading1Pre: "اپنا ",
    signUpHeading1Em: "اکاؤنٹ",
    signUpHeading1Post: " بنائیں۔",
    signUpHeading2Pre: "ہمیں اپنی ",
    signUpHeading2Em: "کمپنی",
    signUpHeading2Post: " کے بارے میں بتائیں۔",
    signUpStep1Note: "ہم اسے آپ کا فاؤنڈر پروفائل بنانے کے لیے استعمال کریں گے۔",
    signUpStep2Note: "آپ ایڈمن فاؤنڈر ہوں گے اور دوسروں کو دعوت دے سکیں گے۔",
    fullName: "پورا نام",
    fullNamePlaceholder: "عائشہ رضا",
    workEmail: "آفس ای میل",
    passwordPlaceholderSignup: "کم از کم 8 حروف، بڑے/چھوٹے حروف اور ایک ہندسہ",
    companyName: "کمپنی کا نام",
    companyNamePlaceholder: "نمبس لیبز",
    industry: "صنعت",
    back: "واپس",
    continue: "جاری رکھیں",
    createWorkspaceCta: "ورک اسپیس بنائیں",
    creatingLoading: "بن رہا ہے…",
    adminFounderNoteTitle: "آپ ایڈمن فاؤنڈر ہوں گے۔",
    adminFounderNoteBody: " آپ ڈیش بورڈ سے کو فاؤنڈرز اور ٹیم ممبران کو دعوت دے سکتے ہیں۔",
    haveAccount: "پہلے سے اکاؤنٹ ہے؟",
    welcomeToFFToast: "FounderFlow میں خوش آمدید",
    signupFailedToast: "اکاؤنٹ نہیں بن سکا",
    // Password reset
    forgotPassword: "پاس ورڈ بھول گئے؟",
    forgotPasswordTitle: "اپنا پاس ورڈ ری سیٹ کریں",
    forgotPasswordTagline:
      "اپنا ای میل درج کریں، ہم نیا پاس ورڈ سیٹ کرنے کا لنک بھیج دیں گے۔ لنک ۱۵ منٹ میں ختم ہو جاتا ہے۔",
    sendResetLink: "ری سیٹ لنک بھیجیں",
    sendingResetLink: "بھیجا جا رہا ہے…",
    resetLinkSentTitle: "اپنا ان باکس چیک کریں",
    resetLinkSentBody:
      "اگر اس ای میل سے کوئی اکاؤنٹ منسلک ہے تو ری سیٹ لنک بھیج دیا گیا ہے۔ اسے ۱۵ منٹ میں استعمال کریں۔",
    backToSignIn: "سائن ان پر واپس",
    rememberPassword: "پاس ورڈ یاد آ گیا؟",
    resetPasswordTitle: "نیا پاس ورڈ سیٹ کریں",
    resetPasswordTagline:
      "کوئی نیا پاس ورڈ چنیں جو کہیں اور استعمال نہ کر رہے ہوں۔ چھوٹے اور بڑے حرف + ایک نمبر، کم از کم ۸ حروف۔",
    newPassword: "نیا پاس ورڈ",
    newPasswordPlaceholder: "کم از کم ۸ حروف",
    setNewPassword: "نیا پاس ورڈ سیٹ کریں",
    settingNewPassword: "محفوظ کیا جا رہا ہے…",
    resetPasswordSuccessTitle: "پاس ورڈ ری سیٹ ہو گیا",
    resetPasswordSuccessBody: "اپنے نئے پاس ورڈ سے سائن ان کریں۔",
    resetLinkInvalidTitle: "یہ لنک کارآمد نہیں ہے",
    resetLinkInvalidBody:
      "یہ لنک ختم ہو چکا ہے یا پہلے استعمال ہو چکا ہے۔ نیا لنک منگوا کر دوبارہ کوشش کریں۔",
    // Email verification
    verifyingTitle: "آپ کا ای میل تصدیق ہو رہا ہے…",
    verifyingBody: "ایک لمحہ، ہم آپ کا لنک تصدیق کر رہے ہیں۔",
    verifiedTitle: "ای میل تصدیق ہو گیا",
    verifiedBody: "شکریہ — آپ کا ای میل تصدیق ہو گیا ہے۔ سب تیار ہے۔",
    verifiedCta: "ڈیش بورڈ پر جائیں",
    verifyInvalidTitle: "یہ لنک کارآمد نہیں ہے",
    verifyInvalidBody:
      "یہ لنک ختم ہو چکا ہے یا پہلے استعمال ہو چکا ہے۔ سائن ان کر کے نیا تصدیقی ای میل منگوائیں۔",
    verifyBannerTitle: "اپنا ای میل تصدیق کریں۔",
    verifyBannerBody:
      "ہم نے {email} پر لنک بھیجا ہے۔ اکاؤنٹ ریکوری محفوظ بنانے کے لیے اس کی تصدیق کریں۔",
    verifyResend: "ای میل دوبارہ بھیجیں",
    verifyResending: "بھیجا جا رہا ہے…",
    verifyResendToast: "تصدیقی ای میل بھیج دیا گیا",
    verifyAlreadyDone: "آپ کا ای میل پہلے ہی تصدیق شدہ ہے",
    verifyDismiss: "بند کریں",
  },
  topbar: {
    profileSettings: "پروفائل اور ترتیبات",
    teamManagement: "ٹیم منیجمنٹ",
    accountMenu: "اکاؤنٹ مینو",
    notificationsLabel: "اطلاعات",
    openMenu: "نیویگیشن مینو کھولیں",
    markAllRead: "سب پڑھا ہوا نشان زد کریں",
    noNotifications: "ابھی کوئی اطلاع نہیں",
    viewAll: "تمام اطلاعات دیکھیں",
    signedOutToast: "سائن آؤٹ ہو گیا",
  },
  projects: {
    badge: "منصوبے",
    title: "منصوبے",
    subtitle: "کام اور بجٹ کو ان منصوبوں کے تحت گروپ کریں جنہیں آپ کی ٹیم اصل میں چلا رہی ہے۔",
    newProject: "نیا منصوبہ",
    noProjectsTitle: "ابھی کوئی منصوبہ نہیں",
    noProjectsAdminDesc: "اپنا پہلا منصوبہ بنائیں تاکہ کام، بجٹ اور وقت ایک جگہ گروپ ہو سکیں۔",
    noProjectsMemberDesc:
      "آپ ابھی کسی منصوبے پر نہیں ہیں — کسی فاؤنڈر سے درخواست کریں کہ آپ کو شامل کریں۔",
    supervisor: "سپروائزر",
    changeSupervisor: "سپروائزر تبدیل کریں",
    editProject: "منصوبہ ترمیم کریں",
    archiveProject: "آرکائیو",
    deleteProject: "حذف کریں",
    deleteConfirmTitle: "یہ منصوبہ حذف کریں؟",
    deleteConfirmDesc:
      "صرف خالی منصوبے حذف کیے جا سکتے ہیں۔ تاریخ محفوظ رکھنے کے لیے آرکائیو کریں۔",
    archiveConfirmTitle: "یہ منصوبہ آرکائیو کریں؟",
    archiveConfirmDesc:
      "آرکائیو شدہ منصوبے پڑھے جا سکتے ہیں لیکن ڈیفالٹ فہرست میں چھپ جاتے ہیں اور نئے کام یا بجٹ قبول نہیں کرتے۔",
    statusActive: "فعال",
    statusOnHold: "روک پر",
    statusCompleted: "مکمل",
    statusArchived: "آرکائیو شدہ",
    statusAll: "تمام",
    status: "اسٹیٹس",
    color: "رنگ",
    targetEndDate: "ہدف اختتامی تاریخ",
    targetEndDateOverdue: "تاخیر سے",
    name: "نام",
    description: "تفصیل",
    openTasks: "کھلے کام",
    monthSpend: "اس ماہ کا خرچ",
    hoursTracked: "ٹریک کردہ گھنٹے",
    members: "ممبران",
    tasks: "کام",
    budgets: "بجٹ",
    projectCreatedToast: "منصوبہ بنا دیا گیا",
    projectSavedToast: "منصوبہ اپ ڈیٹ ہو گیا",
    supervisorChangedToast: "سپروائزر تبدیل ہو گیا",
    projectArchivedToast: "منصوبہ آرکائیو ہو گیا",
    projectDeletedToast: "منصوبہ حذف ہو گیا",
    unarchiveProject: "بحال کریں",
    projectRestoredToast: "منصوبہ بحال ہو گیا",

    /* Duplicate flow. "نقل" (copy) carries the whole family, the way "منصوبہ"
     * carries the project family above — so the card button, the confirm and
     * the toast all read as one action rather than three words for it. */
    duplicateProject: "نقل بنائیں",
    duplicateNameLabel: "نئے منصوبے کا نام",
    duplicateNameSuffix: "(نقل)",
    duplicateCopyTasks: "کاموں کی فہرست نقل کریں",
    duplicateCopyTasksHint:
      "کام «زیر التوا» حالت میں آتے ہیں — نقل آنے والے کام کا خاکہ ہے، ہو چکے کام کا ریکارڈ نہیں۔",
    duplicateKeepAssignees: "ہر کام کا ذمہ دار برقرار رکھیں",
    duplicateKeepAssigneesHint:
      "بطور ڈیفالٹ بند: نقل بنانے سے ساتھیوں کو ایسا کام نہیں ملنا چاہیے جس پر وہ راضی ہی نہیں ہوئے۔ بند رہنے پر سب کچھ آپ کے نام ہو جاتا ہے۔",
    duplicateShiftDeadlines: "آخری تاریخیں آج سے شروع کریں",
    duplicateShiftDeadlinesHint:
      "آخری تاریخوں کے درمیان وقفے وہی رہتے ہیں، بس آگے کھسک جاتے ہیں — ورنہ نقل شروع ہوتے ہی پوری تاخیر سے ہوگی۔",
    duplicateNeverCopied: "بجٹ، اخراجات، آمدنی، ٹائم اندراجات اور تبصرے کبھی نقل نہیں ہوتے۔",
    duplicateSubmit: "منصوبے کی نقل بنائیں",
    duplicateSubmitting: "نقل بن رہی ہے…",
    projectDuplicatedToast: "منصوبے کی نقل بن گئی",
  },
  settings: {
    workspaceBadge: "ورک اسپیس",
    title: "ترتیبات",
    subtitle: "اپنا اکاؤنٹ، ورک اسپیس، اور ترجیحات کا انتظام کریں۔",
    profile: "پروفائل",
    joined: "شامل ہوئے",
    company: "کمپنی",
    industryLabel: "صنعت",
    appearance: "ظاہری شکل",
    appearanceNote: "اپنے لیے FounderFlow کی شکل منتخب کریں۔",
    light: "لائٹ",
    lightDesc: "صاف، کلاسک، توانائی بخش",
    dark: "ڈارک",
    darkDesc: "طویل کام کے لیے آنکھوں پر نرم",
    language: "زبان",
    languageNote:
      "انٹرفیس کی زبان تبدیل کریں۔ اردو بیٹا میں ہے — نیویگیشن، ترتیبات اور سائن اِن کا ترجمہ ہو چکا ہے؛ کچھ صفحات ابھی انگریزی میں ہیں۔",
    english: "English",
    urdu: "اردو",
    englishDesc: "ڈیفالٹ بائیں سے دائیں ترتیب",
    urduDesc: "دائیں سے بائیں · بیٹا (کچھ صفحات ابھی انگریزی)",
    dataStorage: "ڈیٹا اور اسٹوریج",
    dataNote:
      "آپ کا ورک اسپیس ڈیٹا Supabase پر محفوظ ہے۔ لوکل ڈیٹا صاف کرنا صرف UI ترجیحات (تھیم، سائڈبار اسٹیٹ) کو مٹاتا ہے — سرور ڈیٹا متاثر نہیں ہوتا۔",
    exportWorkspace: "ورک اسپیس ایکسپورٹ کریں",
    exportWorkspaceDesc:
      "اس ورک اسپیس کی ہر چیز کی مشین ریڈایبل JSON کاپی ڈاؤن لوڈ کریں — منصوبے، کام، ٹرانزیکشنز، بجٹ، ٹائم، تبصرے۔ پاس ورڈ ہیش کبھی شامل نہیں ہوتے۔",
    exportWorkspaceAction: "JSON ایکسپورٹ",
    exportPreparing: "تیار کیا جا رہا ہے…",
    exportReadyToast: "ایکسپورٹ ڈاؤن لوڈ ہو گیا",
    exportFailedToast: "ایکسپورٹ نہیں ہو سکا — دوبارہ کوشش کریں",
    resetLocalPrefs: "لوکل ترجیحات ری سیٹ کریں",
    signOutSection: "سائن آؤٹ",
    signOutNote: "اپنے FounderFlow ورک اسپیس سے سائن آؤٹ کریں۔",
    role: "کردار",
    userId: "یوزر ID",
    name: "نام",
    currency: "کرنسی",
    created: "بنایا گیا",
    adminFounderRole: "ایڈمن فاؤنڈر",
    cofounderRole: "کو فاؤنڈر",
    teamMemberRole: "ٹیم ممبر",
    signOutConfirmTitle: "سائن آؤٹ کریں؟",
    signOutConfirmDesc: "آپ کسی بھی وقت دوبارہ سائن ان کر سکتے ہیں۔",
    // acct-007: the Urdu copy carried the same false promise as the English, word
    // for word ("تمام ٹرانزیکشنز … مٹا دیے جائیں گے"). Corrected in both, because a
    // dialog that lies only to the Urdu reader is the same bug.
    resetConfirmTitle: "لوکل ترجیحات ری سیٹ کریں؟",
    resetConfirmDesc:
      "اس ڈیوائس پر تھیم، زبان اور سائیڈبار کی حالت صاف ہو جائے گی۔ " +
      "آپ کے ورک اسپیس کا ڈیٹا متاثر نہیں ہوگا اور سرور سے کچھ نہیں ہٹایا جائے گا۔",
    resetConfirmLabel: "ترجیحات صاف کریں",
    signedOutToast: "سائن آؤٹ ہو گیا",
    stats: "ایک نظر میں سرگرمی",
    totalTracked: "ٹریک شدہ وقت",
    sessionCount: "سیشنز",
    lastSignIn: "آخری سائن ان",
    lastSignInNever: "پہلی بار سائن ان",
    memberSince: "ممبر بنے",
    editProfile: "پروفائل ترمیم کریں",
    profileSaved: "پروفائل اپ ڈیٹ ہو گیا",
    changePassword: "پاس ورڈ تبدیل کریں",
    // Change-email flow (S3)
    changeEmail: "ای میل تبدیل کریں",
    changeEmailDesc:
      "آپ کا موجودہ ای میل {email} ہے۔ ہم نئے پتے پر تصدیقی لنک بھیجیں گے — تبدیلی تبھی نافذ ہوگی جب آپ اس پر کلک کریں گے۔",
    newEmail: "نیا ای میل",
    changeEmailSend: "تصدیق بھیجیں",
    changeEmailSentBody:
      "{email} پر تصدیق بھیج دی گئی۔ تبدیلی مکمل کرنے کے لیے اس ان باکس میں موجود لنک پر کلک کریں۔ تب تک آپ کا موجودہ ای میل فعال رہے گا۔",
    changeEmailConfirming: "آپ کا نیا ای میل تصدیق ہو رہا ہے…",
    changeEmailDoneTitle: "ای میل تبدیل ہو گیا",
    changeEmailDoneBody:
      "آپ کا لاگ ان ای میل اپ ڈیٹ ہو گیا ہے۔ اگلی بار سائن ان کرتے وقت یہی استعمال کریں۔",
    changeEmailInvalidTitle: "یہ لنک کارآمد نہیں ہے",
    changeEmailInvalidBody:
      "یہ لنک ختم ہو چکا ہے یا پہلے استعمال ہو چکا ہے۔ ترتیبات سے دوبارہ تبدیلی کی درخواست کریں۔",
    // Install app (PWA)
    installApp: "ایپ انسٹال کریں",
    installAppNote:
      "مکمل اسکرین، ایپ جیسے تجربے کے لیے FounderFlow کو اپنی ہوم اسکرین یا ڈاک میں شامل کریں جو آف لائن بھی کام کرے۔",
    installAppAction: "FounderFlow انسٹال کریں",
    installAppInstalled: "FounderFlow انسٹال ہو چکا ہے۔",
    installAppUnavailable:
      "آپ کا براؤزر یہاں انسٹال کی سہولت نہیں دیتا۔ iOS پر Share ← Add to Home Screen استعمال کریں۔",
    currentPassword: "موجودہ پاس ورڈ",
    newPassword: "نیا پاس ورڈ",
    confirmPassword: "نئے پاس ورڈ کی تصدیق کریں",
    passwordChanged: "پاس ورڈ تبدیل ہو گیا",
    passwordChangedSignOut: "پاس ورڈ تبدیل ہو گیا — دوبارہ سائن ان کریں",
    saveChanges: "تبدیلیاں محفوظ کریں",
    cancel: "منسوخ",
    saving: "محفوظ ہو رہا ہے…",
    editCompany: "کمپنی ترمیم کریں",
    companySaved: "کمپنی اپ ڈیٹ ہو گئی",
    companyEditNoteAdmin: "فاؤنڈرز اور کو فاؤنڈرز یہ تفصیلات اپ ڈیٹ کر سکتے ہیں۔",
    // Danger zone
    dangerZone: "خطرناک زون",
    // See the English block above for the acct-011 argument. The Urdu carried
    // the same two promises word for word: "ناقابلِ واپسی" (irreversible) and
    // "واپس نہیں کیا جا سکتا" (cannot be undone), so the Urdu reader was told the
    // identical untruth. "90" stays in Latin digits: lib/i18n/numbering.ts pins
    // every locale to `latn` on purpose.
    dangerZoneNote:
      "تصدیق کرتے ہی یہ کارروائیاں نافذ ہو جاتی ہیں اور رسائی فوراً ختم ہو جاتی ہے۔ لیکن کچھ بھی " +
      "فوری طور پر نہیں مٹایا جاتا: ہم 90 دن تک قابلِ بحالی کاپی محفوظ رکھتے ہیں، اس لیے " +
      "غلطی ہونے کی صورت میں فوراً سپورٹ سے رابطہ کریں۔",
    // acct-018. See the English key for the argument. «…» rather than “…” around
    // the Urdu section name: the guillemets mirror correctly in an RTL run, where
    // curly quotes can land on the wrong side. The English button label is left
    // unquoted and in Latin script because that is literally what the Urdu reader
    // sees on the card (FaultsAudit A35 — the three export labels are still
    // English literals), so quoting a translation they will not find would be a
    // worse instruction than naming the text on the button.
    dangerZoneExportHint:
      "یہاں کوئی چیز آپ کے لیے کاپی نہیں بناتی۔ اگر کاپی چاہیے تو تصدیق سے پہلے اوپر " +
      "{dataSection} سے ڈاؤن لوڈ کر لیں — اس کے بعد رسائی فوراً ختم ہو جاتی ہے۔",
    deleteAccount: "میرا اکاؤنٹ حذف کریں",
    deleteAccountDesc:
      "آپ کا یوزر ریکارڈ اور اس کی سب چیزیں ایپ سے ہٹا دی جائیں گی۔ اگر آپ اس ورک اسپیس کے واحد فرد ہیں تو ورک اسپیس بھی ساتھ چلا جائے گا۔",
    deleteAccountAction: "اکاؤنٹ حذف کریں",
    deleteAccountConfirmDesc:
      "آپ فوراً سائن آؤٹ ہو جائیں گے اور رسائی ختم ہو جائے گی۔ ہم 90 دن تک قابلِ بحالی کاپی " +
      "محفوظ رکھتے ہیں — اگر یہ غلطی سے ہو رہا ہے تو فوراً سپورٹ سے رابطہ کریں۔ " +
      "تصدیق کے لیے نیچے اپنا پاس ورڈ درج کریں۔",
    exportBeforeAccountDeleteHint:
      "پہلے اپنے ڈیٹا کی کاپی چاہیے؟ منسوخ کریں اور «ڈیٹا اور اسٹوریج» میں Download my data " +
      "سے فائل لے لیں — آپ کی پروفائل، کام، ٹریک کیا گیا ٹائم اور تبصرے۔",
    deleteAccountWorkspaceConfirmDesc:
      "آپ {workspace} میں واحد فرد ہیں، اس لیے یہ پورا ورک اسپیس حذف کر دے گا — ہر ٹرانزیکشن، " +
      "کام، بجٹ اور تبصرہ ساتھ چلا جائے گا، اور کوئی بھی فعال Team سبسکرپشن منسوخ کر دی جائے گی۔ " +
      "ہم 90 دن تک قابلِ بحالی کاپی محفوظ رکھتے ہیں؛ غلطی ہونے کی صورت میں فوراً سپورٹ سے رابطہ کریں۔ " +
      "ورک اسپیس کا نام بالکل ویسا ہی ٹائپ کریں، پھر اپنا پاس ورڈ۔",
    // Must keep ٹرانزیکشنز (transactions) and بجٹ (budgets) by name — that omission
    // IS the news in this sentence, and a softened translation that dropped the two
    // words would be the acct-011 failure again, one locale at a time.
    // tests/app/settings/danger-zone-export-pointer.test.ts holds both.
    //
    // The quoted label changed — and ONLY the label. See the English key: the
    // hint must name the text on the BUTTON, and in Urdu that is
    // exportWorkspaceAction, «JSON ایکسپورٹ», not the card heading
    // «ورک اسپیس ایکسپورٹ کریں» that used to stand here. The substitution is
    // deliberately a swap of one on-screen label for another inside the existing
    // sentence — the surrounding Urdu is untouched, because rewriting it is a
    // native reviewer's job and this repo does not ship Urdu it cannot read.
    exportBeforeWorkspaceDeleteHint:
      "یہ پورا ورک اسپیس حذف کر دیتا ہے، اور Download my data میں اس کے ٹرانزیکشنز، بجٹ یا " +
      "تکراری رولز شامل نہیں ہوتے۔ اگر وہ رکھنے ہیں تو منسوخ کریں اور پہلے «ڈیٹا اور اسٹوریج» " +
      "سے «JSON ایکسپورٹ» فائل حاصل کر لیں۔",
    deleteAccountAndWorkspaceAction: "اکاؤنٹ + ورک اسپیس حذف کریں",
    passwordConfirm: "پاس ورڈ درج کریں",
    deleteWorkspace: "یہ ورک اسپیس حذف کریں",
    deleteWorkspaceDesc:
      "ورک اسپیس اور اس کے تمام ٹیم ممبرز کی رسائی ختم ہو جائے گی، اور ہر ٹرانزیکشن، کام، بجٹ اور تبصرہ ساتھ چلا جائے گا۔",
    deleteWorkspaceAction: "ورک اسپیس حذف کریں",
    deleteWorkspaceConfirmDesc:
      "سب کو فوراً رسائی ختم ہو جائے گی، اور کوئی بھی فعال Team سبسکرپشن منسوخ کر دی جائے گی تاکہ " +
      "مزید چارج نہ ہو۔ ہم 90 دن تک قابلِ بحالی کاپی محفوظ رکھتے ہیں — اگر یہ غلطی سے " +
      "ہو رہا ہے تو فوراً سپورٹ سے رابطہ کریں۔ ورک اسپیس کا نام بالکل ویسا ہی ٹائپ کریں اور پھر " +
      "پاس ورڈ درج کریں۔",
    workspaceNameConfirm: "ورک اسپیس کا نام ٹائپ کریں",
    accountDeletedToast: "اکاؤنٹ حذف ہو گیا",
    workspaceDeletedToast: "ورک اسپیس حذف ہو گیا",
  },
};

export type Strings = typeof en;

export const DICTIONARIES: Record<Locale, Strings> = { en, ur };

export function getDirForLocale(locale: Locale): "ltr" | "rtl" {
  return SUPPORTED_LOCALES.find((l) => l.code === locale)?.dir ?? "ltr";
}

/**
 * Split a string around the FIRST occurrence of a `{placeholder}` token, so a
 * caller can render something of its own — a link, a bold name — in the gap the
 * translator chose. `null` when the token is absent.
 *
 * WHY THIS IS NOT `template.split(token)`. It is, underneath, but the caller has
 * to be able to tell the missing case apart. `"no token here".split("{x}")`
 * returns a one-element array, so `const [before, after] = …` hands back
 * `undefined` for `after` and a component that renders `{before}<a/>{after ?? ""}`
 * puts its anchor on the end of the whole sentence — a dangling link, in a locale
 * nobody is reading, from a translation that merely inlined the section name.
 * Both shipped locales carry the token and a test sweeps every locale in
 * DICTIONARIES for it, so this answer is the belt to that braces: a future locale
 * that loses the slot loses the LINK, not the sentence.
 *
 * Only the first occurrence is a slot. A second would render to the customer as
 * literal `{dataSection}`, which is why the sweep in
 * tests/app/settings/danger-zone-export-pointer.test.ts demands exactly one.
 */
export function splitAroundPlaceholder(
  template: string,
  token: string
): { before: string; after: string } | null {
  const at = template.indexOf(token);
  if (at < 0) return null;
  return { before: template.slice(0, at), after: template.slice(at + token.length) };
}

/** The locale this dictionary is authored in, and the fallback for everything. */
export const SOURCE_LOCALE: Locale = "en";

/**
 * Is the PRODUCT — not this dictionary — translated end to end for a locale?
 *
 * "complete" is a claim about the rendered app, which is why it cannot be derived
 * from the dictionary: `Strings = typeof en` already guarantees every key here
 * exists in both locales, so a purely dictionary-based check would report 100%
 * while most of the product is still hardcoded English JSX. Flip an entry to
 * "complete" only when its routes genuinely have no untranslated literal left;
 * `tests/lib/i18n/document-language.test.ts` pins what each value means.
 */
export const LOCALE_TRANSLATION_STATUS: Record<Locale, "complete" | "partial"> = {
  en: "complete",
  ur: "partial",
};

/**
 * The value for `<html lang>` — audit i18n-001.
 *
 * NOT the same decision as `getDirForLocale`, and conflating the two was the
 * bug. Direction is presentation: the user asked for Urdu, the shell (nav,
 * topbar, breadcrumbs, command palette, settings, auth) really is Urdu, and it
 * has to mirror. `lang` is a factual claim about the text a screen reader is
 * about to pronounce, and on a partially translated locale that claim was false
 * for most of the document.
 *
 * What the false claim cost: `lang="ur"` makes NVDA, JAWS and VoiceOver apply
 * Urdu grapheme-to-phoneme rules to the WHOLE document and suppresses their own
 * language auto-detection. English orthography under Urdu phoneme rules is not
 * accented English; it is unintelligible. That covered every untranslated screen
 * plus every hardcoded aria-label and toast — i.e. precisely the strings a
 * screen-reader user has no visual fallback for. Choosing Urdu in Settings made
 * the product worse than never translating it, and `User.locale` persists that
 * choice across devices.
 *
 * Under `SOURCE_LOCALE` all of that English is pronounced correctly, and the
 * translated Urdu strings are Arabic-script code points an English voice has no
 * rules for at all — so screen readers fall back to their own per-utterance
 * script detection there instead of being actively misdirected. Bounded, visible
 * degradation on the translated minority beats silent noise over the English
 * majority.
 *
 * This is the honest floor, not WCAG 3.1.2 compliance. Full compliance needs
 * `lang` on the parts that differ from the document language, which is the
 * follow-up tracked with the coverage numbers in the i18n-001 report. When a
 * locale's `LOCALE_TRANSLATION_STATUS` reaches "complete" this returns it
 * directly and the whole question goes away.
 */
export function documentLangForLocale(locale: Locale): Locale {
  return LOCALE_TRANSLATION_STATUS[locale] === "complete" ? locale : SOURCE_LOCALE;
}
