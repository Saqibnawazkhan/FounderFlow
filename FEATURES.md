# FounderFlow — Feature & Architecture Reference

> Living map of what this app does and where each thing lives, so changes can
> be scoped, made, and audited quickly. Update this file when you add a
> feature, page, server action, model, or cron. Keep it in sync with
> [CLAUDE.md](CLAUDE.md) (operating rules) and [BUGS.md](BUGS.md) (known issues).

Last synced with codebase: 2026-07-01.

---

## 1. What FounderFlow is

A multi-tenant SaaS workspace for startup founders to run their company:
track **finances** (expenses, investments, recurring transactions, budgets),
manage **work** (projects, tasks, time tracking), coordinate the **team**
(invites, roles), and stay informed (activity feed, notifications, reports).

Each **Company** is one tenant. All data is scoped by `companyId`. Users
belong to exactly one company.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14.2 (App Router, server actions) |
| Language | TypeScript 5.5 |
| DB / ORM | PostgreSQL (Supabase) via Prisma 6 |
| Auth | Auth.js / NextAuth 5 beta (JWT sessions, Credentials provider) |
| Validation | Zod (schemas in `lib/schemas/`) |
| Styling | Tailwind CSS 3.4 + design tokens in `app/globals.css` |
| UI motion | Framer Motion |
| Client state | Zustand (`lib/store.ts`) |
| Forms | react-hook-form + `@hookform/resolvers` (zod) |
| Charts | Recharts |
| Drag & drop | dnd-kit (task board) |
| Email | Nodemailer (invites) |
| Errors | Sentry (`sentry.*.config.ts`, `lib/sentry-server.ts`) |
| Export | jsPDF + jspdf-autotable, xlsx (reports) |
| PWA | `public/manifest.json`, `public/sw.js`, offline page |
| Tests | Vitest + Testing Library; Puppeteer smoke scripts |
| Hosting | Vercel (crons in `vercel.json`) |

---

## 3. Roles & permissions

Defined in [lib/auth/role-gates.ts](lib/auth/role-gates.ts) and
[lib/auth/project-permissions.ts](lib/auth/project-permissions.ts).

### Company-level roles
| Role | Capabilities |
|---|---|
| `admin` | Founder. Full access + team role changes + user removal. |
| `cofounder` | Full access incl. finances. **Cannot** change roles or remove users. |
| `member` | Tasks, time, team (read), notifications, settings **only**. No finance surfaces. |

**Finance surfaces hidden from members** (routes blocked in `MEMBER_BLOCKED_ROUTES`):
`/dashboard`, `/expenses`, `/investments`, `/recurring`, `/budgets`,
`/reports`, `/activities`. Enforced in **two layers**:
1. Middleware ([middleware.ts](middleware.ts) + [auth.config.ts](auth.config.ts)) — redirects members to `/tasks`.
2. Server actions — re-check on every write (a forged request can't bypass).

The sidebar ([components/layout/sidebar.tsx](components/layout/sidebar.tsx)) hides blocked links (cosmetic; middleware is the real gate).

### Per-project elevation (the "supervisor escape hatch")
Each `Project` has one `supervisorId`. A **member** who supervises a project
gets elevated rights **inside that project only**:
- `canManageProject` — manage its tasks, budgets, status, rename.
- `canSeeProjectFinances` — see that project's budgets + tagged transactions.
- Still **cannot** reach global `/budgets`, `/expenses`, `/investments`.
- **Cannot** reassign the supervisor (admin/cofounder only).

Member project **visibility**: a member sees a project iff they supervise it
OR have ≥1 assigned task in it (no `ProjectMember` table — derived).

---

## 4. Pages / routes

All app pages live under `app/(app)/` behind auth. Each page follows the
pattern `page.tsx` (server: fetch + guard) → `*-client.tsx` (interactive UI),
with `loading.tsx` skeletons.

| Route | Purpose | Member access |
|---|---|---|
| `/` | Public marketing landing page | Public |
| `/login`, `/signup` | Auth flows | Public |
| `/invite/[token]` | Accept email invite, set own password | Public (token) |
| `/offline` | PWA offline fallback | Public |
| `/dashboard` | Finance overview + charts | ❌ Blocked |
| `/expenses` | Expense list, add/delete, charts | ❌ Blocked |
| `/investments` | Investment list, add/delete | ❌ Blocked |
| `/recurring` | Recurring transaction rules | ❌ Blocked |
| `/budgets` | Per-category monthly budget caps | ❌ Blocked |
| `/reports` | Financial reports, PDF/Excel export | ❌ Blocked |
| `/activities` | Company activity feed | ❌ Blocked |
| `/projects` | Project list (filter by status) | ✅ (own projects) |
| `/projects/[id]` | Project detail: tasks, budgets, time, activity | ✅ (if member) |
| `/tasks` | Task board (dnd-kit), assign/status | ✅ |
| `/time` | Time tracking (clock in/out, entries) | ✅ |
| `/team` | Team roster, invite, roles | ✅ (read) |
| `/notifications` | Notification center | ✅ |
| `/settings` | Profile, password, company settings | ✅ |

---

## 5. Feature areas in detail

### 5.1 Finance — Transactions (expenses & investments)
- Model: `Transaction` (`type: "expense" | "investment"`).
- Actions: `addTransactionAction`, `deleteTransactionAction`, `listTransactionsAction` — [lib/actions/transactions.ts](lib/actions/transactions.ts).
- Optional `projectId` tag → counts against that project's budgets. Null = company-global only.
- `ruleId` set when materialized from a recurring rule (🔁 badge in UI).
- Adding an expense triggers **budget threshold checks** ([lib/budgets/check.ts](lib/budgets/check.ts)).

### 5.2 Finance — Recurring rules
- Model: `RecurringRule` (`frequency: "monthly" | "weekly"`, uses `dayOfMonth`/`dayOfWeek`).
- Actions: create/toggle/delete — [lib/actions/recurring.ts](lib/actions/recurring.ts).
- Materializer logic: [lib/recurring/materialize.ts](lib/recurring/materialize.ts).
- Daily cron `/api/cron/materialize-recurring` (00:05 UTC) creates due transactions; idempotent via `lastMaterializedAt`.
- Creating a rule also seeds an immediate transaction for instant feedback.

### 5.3 Finance — Budgets
- Model: `Budget` (per-category monthly cap, scoped to a project).
- Actions: create/update/delete — [lib/actions/budgets.ts](lib/actions/budgets.ts).
- Threshold logic: [lib/budgets/threshold.ts](lib/budgets/threshold.ts) — fires **warning at 80%**, **alert at 100%**, once per month each (`lastWarnedMonth`/`lastAlertedMonth` sentinels `YYYY-MM`).
- Crossing a threshold fans out `Notification`s to company members.

### 5.4 Projects
- Model: `Project` (status: `active | on_hold | completed | archived`; `color` slug; optional `targetEndDate` → overdue chip).
- Actions: create/update/change-supervisor/delete — [lib/actions/projects.ts](lib/actions/projects.ts).
- Owns tasks, budgets, time entries, optionally transactions.
- `onDelete: Restrict` on tasks & budgets — a project can't be deleted while it has them.
- The `add_projects` migration back-filled a **"General" project** per company for legacy rows.

### 5.5 Tasks
- Model: `Task` (status `pending | in_progress | completed`; priority `low|medium|high|urgent`; required `projectId`).
- Actions: list/add/update-status/delete — [lib/actions/tasks.ts](lib/actions/tasks.ts).
- UI: drag-and-drop board (dnd-kit); form [components/tasks/task-form.tsx](components/tasks/task-form.tsx).
- Denormalized `assignedToName`/`assignedByName` for fast reads.

### 5.6 Time tracking
- Model: `TimeEntry` (`clockOutAt = null` means active). Optional project/task tag.
- Actions: clock in/out, heartbeat, auto-close, edit, delete — [lib/actions/time.ts](lib/actions/time.ts).
- **Auto-close pipeline**: client heartbeats every 5 min; at 12h idle shows "still working?" modal; auto-closes after 30 min unresponsive. Hourly-style cron `/api/cron/sweep-time-entries` (00:10 UTC) is the safety net for closed tabs.
- Permissions: members clock/delete own entries but **can't** hand-edit times; admin/cofounder can edit any entry (audit-trailed via `editedBy`/`editedAt`).
- Clock widget: [components/time/clock-widget.tsx](components/time/clock-widget.tsx).

### 5.7 Team & invites
- Actions: list users, invite, update role, remove, accept invite — [lib/actions/team.ts](lib/actions/team.ts).
- Model: `InviteToken` (single-use, 7-day expiry). Admins **don't** set passwords — invitee sets their own via emailed one-time link (`/invite/[token]`). Closes audit flaw #7.
- Email templates: [lib/email/templates/invite.ts](lib/email/templates/invite.ts), sender [lib/email/send.ts](lib/email/send.ts).

### 5.8 Comments (@mentions)
- Model: `Comment` — attaches to **either** a Task or a Transaction (XOR).
- Actions: create/list/delete — [lib/actions/comments.ts](lib/actions/comments.ts).
- `@first-last` mentions parsed ([lib/comments/mentions.ts](lib/comments/mentions.ts)), resolved userIds stored in `mentions` JSON, each mentioned user gets a notification. Author never self-pinged.
- UI: [components/comments/comment-thread.tsx](components/comments/comment-thread.tsx).

### 5.9 Activity feed
- Model: `Activity` (typed events, optional `projectId`, JSON `metadata`).
- Query/action: [lib/actions/activities.ts](lib/actions/activities.ts), [lib/queries/activities.ts](lib/queries/activities.ts).
- Hidden from members (leaks finance events). Per-project activity tab filters by `projectId`.

### 5.10 Notifications
- Model: `Notification` (`type: info|success|warning|danger`, optional `link`, optional `projectId`).
- Actions: list/mark-read/mark-all-read/clear — [lib/actions/notifications.ts](lib/actions/notifications.ts).
- Sidebar polls unread count every 30s. Read-side strips non-project finance notifications for members.

### 5.11 Reports
- `/reports` — charts + PDF (jsPDF) and Excel (xlsx) export. [app/(app)/reports/](app/(app)/reports/).

### 5.12 Settings & profile
- Profile edit, password change — [lib/actions/profile.ts](lib/actions/profile.ts).
- Company edit — [lib/actions/company.ts](lib/actions/company.ts).
- `lastSignInAt` shown so users can spot rogue logins.

### 5.13 Auth
- Signup/login/logout — [lib/actions/auth.ts](lib/actions/auth.ts).
- Signup creates Company → owner User → sets `Company.ownerId` (breaks circular FK).
- Passwords: bcrypt (`passwordHash`, never raw). Full config: [lib/auth.ts](lib/auth.ts).

---

## 6. Data model (Prisma)

Source: [prisma/schema.prisma](prisma/schema.prisma). Postgres; enums stored
as documented strings (zod is the boundary source of truth).

```
Company 1─┬─N User            (owner is one User, User.companyId required)
          ├─N Project         (supervisorId, creator)
          ├─N Transaction     (optional projectId, optional ruleId)
          ├─N RecurringRule
          ├─N Budget          (required projectId)
          ├─N Task            (required projectId)
          ├─N TimeEntry       (optional projectId/taskId)
          ├─N Activity        (optional projectId)
          ├─N Notification     (optional projectId)
          ├─N Comment         (XOR taskId/transactionId)
          └─N InviteToken
```

Delete semantics worth knowing:
- Company delete cascades everything.
- `Task.projectId` / `Budget.projectId` — `onDelete: Restrict` (block project delete).
- `Transaction/TimeEntry/Activity/Notification.projectId` — `SetNull` (history survives).
- `Transaction.ruleId` — `SetNull` (history survives rule delete).
- User delete: `supervisedProjects` `SetNull` (project survives; actions reassign immediately).

Migrations in [prisma/migrations/](prisma/migrations/); `add_projects` is the
canonical hand-written back-fill example.

---

## 7. Server actions (write surface)

All in `lib/actions/`, all return `ActionResult<T>` (see [lib/types.ts](lib/types.ts)). Validated with zod schemas from `lib/schemas/`.

| Domain | Actions |
|---|---|
| auth | signup, login, logout |
| transactions | list, add, delete |
| recurring | create, toggle, delete |
| budgets | create, update, delete |
| projects | create, update, changeSupervisor, delete |
| tasks | list, add, updateStatus, delete |
| time | getOpenEntry, clockIn, clockOut, autoCloseEntry, heartbeat, deleteTimeEntry, updateTimeEntry, sweepAutoCloseEntries |
| team | listCompanyUsers, invite, updateUserRole, removeUser, acceptInvite |
| comments | create, list, delete |
| notifications | list, markRead, markAllRead, clear |
| activities | list |
| profile | updateProfile, changePassword |
| company | updateCompany |

Read side lives in `lib/queries/` (session, stats, and per-domain queries).

---

## 8. Cron jobs

Scheduled in [vercel.json](vercel.json); auth via `CRON_SECRET` bearer header (fail-closed).

| Endpoint | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/materialize-recurring` | `5 0 * * *` (00:05) | Create due recurring transactions (idempotent). Returns 206 on partial failure. |
| `/api/cron/sweep-time-entries` | `10 0 * * *` (00:10) | Auto-close stale open time entries. |

---

## 9. Cross-cutting concerns

- **i18n**: [lib/i18n/strings.ts](lib/i18n/strings.ts) + `use-t` hook. Nav labels keyed, not hard-coded.
- **Rate limiting**: [lib/rate-limit.ts](lib/rate-limit.ts).
- **Client IP**: [lib/client-ip.ts](lib/client-ip.ts).
- **Env validation**: [lib/env.ts](lib/env.ts).
- **PWA**: [public/manifest.json](public/manifest.json), [public/sw.js](public/sw.js), `/offline`.
- **SEO**: `app/robots.ts`, `app/sitemap.ts`.
- **Design tokens**: `app/globals.css` (project color slugs map here). Landing components in [components/landing/](components/landing/).

---

## 10. Testing & verification

- Unit/integration: Vitest in [tests/](tests/) — schemas, role gates, project permissions, budgets/time thresholds, recurring materializer, mentions, rate limit, utils, components.
- Smoke: Puppeteer `scripts/smoke-*.mjs` (auth, finance, projects, time, team, invite, i18n, etc.).
- Screenshot scripts: `scripts/screenshot-*.mjs`.
- **Before pushing** (per CLAUDE.md): `npm run typecheck` → `npm run build` → `npm test` → targeted smoke for auth/finance/projects.
- CI: [.github/workflows/ci.yml](.github/workflows/ci.yml). Pre-commit: husky + lint-staged.

---

## 11. Database safety (⚠️ read before destructive commands)

Local `.env` `DATABASE_URL` points at **production Supabase** — there is no
separate dev DB yet. See [CLAUDE.md](CLAUDE.md) for the full runbook. Summary:
- `npm run db:seed:local` / `npm run db:reset:local` — guarded; refuse against production.
- Seed guard ([prisma/seed.ts](prisma/seed.ts)): needs `SEED_RESET=true`, refuses Supabase URLs unless `SEED_RESET_ALLOW_PROD=true` too, and every `deleteMany` is scoped to `companyId: "demo-nimbus"`.
- **Do not** bypass the guard. If you need to reseed prod, that's the cue to build Tier 2 (env separation) / Tier 3 (soft delete, backups) first.

---

## 12. Conventions (from CLAUDE.md)

- Server actions → `lib/actions/`; queries → `lib/queries/`; zod → `lib/schemas/`; auth helpers → `lib/auth/`.
- Permission gates in two layers (middleware for routes, server actions for writes) — both must agree.
- Members never see finance pages; per-project supervisors get an in-project escape hatch.
- Back-fill migrations are hand-written (`add_projects` is canonical).
- Page pattern: `page.tsx` (server guard/fetch) + `*-client.tsx` (UI) + `loading.tsx`.
