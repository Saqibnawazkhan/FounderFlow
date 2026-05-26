/**
 * Seed script — populates the database with demo data so the app has something
 * to render on first run. Mirrors lib/seed.ts but writes through Prisma with
 * bcrypt-hashed passwords (audit flaw #1 — never store plaintext).
 *
 * Run: `SEED_RESET=true npx prisma db seed` (or `npm run db:seed:local`).
 *
 * SAFETY (Tier 1 — see CLAUDE.md):
 *   1. The script refuses to run unless `SEED_RESET=true` is set. This stops
 *      `prisma migrate reset` (which auto-fires the seed) and any IDE
 *      mis-click from silently nuking data.
 *   2. If `DATABASE_URL` looks like a Supabase pooler URL (i.e. production),
 *      the script refuses even with SEED_RESET unless
 *      `SEED_RESET_ALLOW_PROD=true` is ALSO set. Two-key launch.
 *   3. Every deleteMany() is scoped to `DEMO_COMPANY_ID`. Real signup users
 *      live under different companyIds and are mathematically out of reach
 *      even if 1 + 2 are bypassed.
 *
 * Why all three: defense in depth. Past incident — running this script
 * against a `.env` pointed at production wiped a live signup's account.
 * Not happening again.
 */

import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// All demo rows live under this single companyId. Every wipe + create
// references it, so the seed script's blast radius is exactly one
// workspace. A real signup gets a cuid companyId, never this one.
const DEMO_COMPANY_ID = "demo-nimbus";

function guardOrExit(): void {
  const dbUrl = process.env.DATABASE_URL ?? "";
  // Supabase URLs include "supabase.co" (legacy) or "supabase.com" and the
  // pooler subdomain "pooler.supabase". Match any of them. False positives
  // here are intentional — better to refuse on a paranoid match than wipe
  // a prod connection that uses an exotic hostname.
  const looksLikeProd = /supabase\.(com|co)/i.test(dbUrl) || /pooler\.supabase/i.test(dbUrl);

  if (process.env.SEED_RESET !== "true") {
    console.error("\n  ✗ Seed refused — SEED_RESET is not set to 'true'.\n");
    console.error("  This script wipes every row in the demo workspace and re-creates");
    console.error("  it from scratch. That's destructive. Run it deliberately:\n");
    console.error("    SEED_RESET=true npx prisma db seed");
    console.error("    # or");
    console.error("    npm run db:seed:local\n");
    process.exit(1);
  }

  if (looksLikeProd && process.env.SEED_RESET_ALLOW_PROD !== "true") {
    console.error("\n  ✗ Seed refused — DATABASE_URL looks like a production Supabase URL.\n");
    console.error(`  URL: ${dbUrl.replace(/:[^:@]+@/, ":****@")}`);
    console.error("\n  Running the seed here would delete demo-workspace rows in production.");
    console.error("  If you ABSOLUTELY mean to do that, set BOTH:");
    console.error("    SEED_RESET=true");
    console.error("    SEED_RESET_ALLOW_PROD=true");
    console.error("\n  This guard exists because a previous accident wiped a real");
    console.error("  signup's data. Don't bypass without a runbook.\n");
    process.exit(1);
  }

  if (looksLikeProd) {
    console.warn(
      "\n  ⚠ WARNING: seeding against what looks like a PRODUCTION database.\n" +
        "  Only the demo workspace (companyId=" +
        DEMO_COMPANY_ID +
        ") will be touched.\n"
    );
  }
}

async function main() {
  guardOrExit();
  console.log("Seeding database…");

  // Wipe ONLY the demo workspace. Scoping by companyId means a real signup's
  // company + every row they own is untouchable even if someone bypasses
  // the env guard above. Order matters for FKs; same dependency order as
  // before but each delete is filtered.
  const demoScope = { where: { companyId: DEMO_COMPANY_ID } };
  await db.comment.deleteMany(demoScope);
  await db.timeEntry.deleteMany(demoScope);
  await db.notification.deleteMany(demoScope);
  await db.activity.deleteMany(demoScope);
  await db.task.deleteMany(demoScope);
  await db.budget.deleteMany(demoScope);
  await db.recurringRule.deleteMany(demoScope);
  await db.transaction.deleteMany(demoScope);
  await db.inviteToken.deleteMany(demoScope);
  // Drop projects BEFORE users, since Project.supervisorId references User.
  await db.project.deleteMany(demoScope);
  // User has companyId required, so the scoped filter works the same way.
  await db.user.deleteMany(demoScope);
  // Company is the root — wipe by id, not companyId.
  await db.company.deleteMany({ where: { id: DEMO_COMPANY_ID } });

  const hash = (pw: string) => bcrypt.hashSync(pw, 12);

  // Create the founder first without companyId, then create the company
  // owned by them, then update the founder to point at the company. SQLite
  // can't defer FKs, so we do it in two steps via raw upsert.
  const founderId = "demo-saqib";
  const aliId = "demo-ali";
  const ahmedId = "demo-ahmed";
  const fatimaId = "demo-fatima";
  const sarahId = "demo-sarah";
  const companyId = DEMO_COMPANY_ID;

  // Two-step to break the User <-> Company circular FK:
  //   1. Create the company (ownerId is nullable, so this is fine)
  //   2. Create the founding user pointing at the company
  //   3. Set the company's ownerId to the user
  await db.company.create({
    data: {
      id: companyId,
      name: "Nimbus Labs",
      industry: "SaaS / B2B Software",
      currency: "PKR",
    },
  });
  await db.user.create({
    data: {
      id: founderId,
      name: "Saqib Nawaz",
      email: "demo@founderflow.app",
      passwordHash: hash("demo123"),
      role: "admin",
      companyId,
    },
  });
  await db.company.update({
    where: { id: companyId },
    data: { ownerId: founderId },
  });

  // Other founders + team members
  await db.user.createMany({
    data: [
      {
        id: aliId,
        name: "Ali Raza",
        email: "ali@nimbus.app",
        passwordHash: hash("demo123"),
        role: "cofounder",
        companyId,
      },
      {
        id: ahmedId,
        name: "Ahmed Khan",
        email: "ahmed@nimbus.app",
        passwordHash: hash("demo123"),
        role: "cofounder",
        companyId,
      },
      {
        id: fatimaId,
        name: "Fatima Sheikh",
        email: "fatima@nimbus.app",
        passwordHash: hash("demo123"),
        role: "member",
        companyId,
      },
      {
        id: sarahId,
        name: "Sarah Malik",
        email: "sarah@nimbus.app",
        passwordHash: hash("demo123"),
        role: "member",
        companyId,
      },
    ],
  });

  const userNames: Record<string, string> = {
    [founderId]: "Saqib Nawaz",
    [aliId]: "Ali Raza",
    [ahmedId]: "Ahmed Khan",
    [fatimaId]: "Fatima Sheikh",
    [sarahId]: "Sarah Malik",
  };

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // Projects — distribute the seeded tasks across three so the /projects
  // page has real variety. Supervisor assignments mix admin/cofounder/member
  // tiers so we can verify the project-permission gates in the smoke.
  const launchProjectId = "demo-project-launch";
  const customerProjectId = "demo-project-customer";
  const opsProjectId = "demo-project-ops";

  await db.project.createMany({
    data: [
      {
        id: launchProjectId,
        companyId,
        name: "Launch v2",
        description: "Public launch of the v2 product including marketing site + analytics.",
        supervisorId: aliId, // cofounder
        status: "active",
        color: "primary",
        createdBy: founderId,
      },
      {
        id: customerProjectId,
        companyId,
        name: "Customer success Q3",
        description: "Beta cohort onboarding, top-10 interviews, NPS reporting.",
        supervisorId: ahmedId, // cofounder
        status: "active",
        color: "cyan",
        createdBy: founderId,
      },
      {
        id: opsProjectId,
        companyId,
        name: "Internal ops",
        description: "Hiring, CI/CD, internal tooling. Run by Sarah (member supervisor).",
        supervisorId: sarahId, // member-as-supervisor — exercises the elevated-permission path
        status: "active",
        color: "pink",
        createdBy: founderId,
      },
    ],
  });

  // Investments
  const investments = [
    {
      addedBy: founderId,
      amount: 500_000,
      category: "Seed Capital",
      description: "Personal seed contribution",
      date: daysAgo(90),
    },
    {
      addedBy: founderId,
      amount: 250_000,
      category: "Personal Investment",
      description: "Q2 top-up",
      date: daysAgo(45),
    },
    {
      addedBy: aliId,
      amount: 350_000,
      category: "Personal Investment",
      description: "Founder commitment",
      date: daysAgo(75),
    },
    {
      addedBy: ahmedId,
      amount: 300_000,
      category: "Personal Investment",
      description: "Initial stake",
      date: daysAgo(60),
    },
    {
      addedBy: founderId,
      amount: 100_000,
      category: "Revenue Reinvestment",
      description: "Customer payments routed back",
      date: daysAgo(15),
    },
  ];

  // Expenses
  const expenses = [
    {
      addedBy: founderId,
      amount: 75_000,
      category: "Office Rent",
      description: "May 2026 office rent",
      date: daysAgo(20),
    },
    {
      addedBy: aliId,
      amount: 45_000,
      category: "Software",
      description: "Annual SaaS subscriptions",
      date: daysAgo(30),
    },
    {
      addedBy: ahmedId,
      amount: 30_000,
      category: "Marketing",
      description: "LinkedIn ads campaign",
      date: daysAgo(10),
    },
    {
      addedBy: founderId,
      amount: 22_000,
      category: "Equipment",
      description: "MacBook for Sarah",
      date: daysAgo(35),
    },
    {
      addedBy: fatimaId,
      amount: 8_500,
      category: "Food & Beverages",
      description: "Team lunch + offsite snacks",
      date: daysAgo(7),
    },
    {
      addedBy: aliId,
      amount: 60_000,
      category: "Salaries",
      description: "Contractor payment - design",
      date: daysAgo(25),
    },
    {
      addedBy: ahmedId,
      amount: 18_000,
      category: "Travel",
      description: "Karachi client meeting flights",
      date: daysAgo(40),
    },
    {
      addedBy: sarahId,
      amount: 12_000,
      category: "Marketing",
      description: "Conference booth materials",
      date: daysAgo(50),
    },
    {
      addedBy: founderId,
      amount: 9_500,
      category: "Legal & Accounting",
      description: "Lawyer retainer",
      date: daysAgo(55),
    },
    {
      addedBy: aliId,
      amount: 5_000,
      category: "Utilities",
      description: "Office internet + power",
      date: daysAgo(12),
    },
  ];

  await db.transaction.createMany({
    data: [
      ...investments.map((i) => ({
        ...i,
        companyId,
        type: "investment",
        addedByName: userNames[i.addedBy],
      })),
      ...expenses.map((e) => ({
        ...e,
        companyId,
        type: "expense",
        addedByName: userNames[e.addedBy],
      })),
    ],
  });

  // Tasks
  await db.task.createMany({
    data: [
      {
        companyId,
        projectId: launchProjectId,
        title: "Prepare investor pitch deck v2",
        description: "Update financials section, add traction metrics from Q1",
        status: "in_progress",
        priority: "high",
        assignedTo: founderId,
        assignedToName: userNames[founderId],
        assignedBy: aliId,
        assignedByName: userNames[aliId],
        deadline: daysAgo(-7),
      },
      {
        companyId,
        projectId: launchProjectId,
        title: "Finalize Q3 product roadmap",
        description: "Sync with engineering on capacity, prioritize top 3 features",
        status: "pending",
        priority: "urgent",
        assignedTo: aliId,
        assignedToName: userNames[aliId],
        assignedBy: founderId,
        assignedByName: userNames[founderId],
        deadline: daysAgo(-3),
      },
      {
        companyId,
        projectId: customerProjectId,
        title: "Customer interviews — top 10 users",
        description: "Identify pain points and feature requests for v2.0",
        status: "in_progress",
        priority: "medium",
        assignedTo: ahmedId,
        assignedToName: userNames[ahmedId],
        assignedBy: founderId,
        assignedByName: userNames[founderId],
        deadline: daysAgo(-14),
      },
      {
        companyId,
        projectId: launchProjectId,
        title: "Design new landing page",
        description: "Hero section, pricing, testimonials. Mobile-first.",
        status: "pending",
        priority: "high",
        assignedTo: sarahId,
        assignedToName: userNames[sarahId],
        assignedBy: aliId,
        assignedByName: userNames[aliId],
        deadline: daysAgo(-10),
      },
      {
        companyId,
        projectId: opsProjectId,
        title: "Hire backend engineer",
        description: "Source 5 candidates, conduct technical interviews",
        status: "pending",
        priority: "high",
        assignedTo: founderId,
        assignedToName: userNames[founderId],
        assignedBy: founderId,
        assignedByName: userNames[founderId],
        deadline: daysAgo(-21),
      },
      {
        companyId,
        projectId: opsProjectId,
        title: "Setup CI/CD pipeline",
        description: "Migrate from manual deploys to GitHub Actions",
        status: "completed",
        priority: "medium",
        assignedTo: ahmedId,
        assignedToName: userNames[ahmedId],
        assignedBy: aliId,
        assignedByName: userNames[aliId],
        deadline: daysAgo(5),
        completedAt: daysAgo(2),
      },
      {
        companyId,
        projectId: customerProjectId,
        title: "Launch beta with 20 customers",
        description: "Onboarding, feedback loop, dashboard for usage",
        status: "completed",
        priority: "urgent",
        assignedTo: aliId,
        assignedToName: userNames[aliId],
        assignedBy: founderId,
        assignedByName: userNames[founderId],
        deadline: daysAgo(15),
        completedAt: daysAgo(10),
      },
      {
        companyId,
        projectId: customerProjectId,
        title: "Setup analytics dashboard",
        description: "Mixpanel + custom dashboard for product metrics",
        status: "completed",
        priority: "medium",
        assignedTo: sarahId,
        assignedToName: userNames[sarahId],
        assignedBy: aliId,
        assignedByName: userNames[aliId],
        deadline: daysAgo(30),
        completedAt: daysAgo(25),
      },
    ],
  });

  // Welcome notifications
  await db.notification.createMany({
    data: [
      {
        userId: founderId,
        companyId,
        title: "Welcome to FounderFlow",
        message: "Your workspace is ready. Start by exploring the dashboard.",
        type: "info",
        link: "/dashboard",
      },
      {
        userId: founderId,
        companyId,
        title: "Ali Raza added an investment",
        message: "PKR 350,000 contributed as personal investment",
        type: "success",
        read: true,
        link: "/investments",
      },
    ],
  });

  console.log("Seed complete:", {
    company: 1,
    users: 5,
    transactions: investments.length + expenses.length,
    tasks: 8,
    notifications: 2,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
