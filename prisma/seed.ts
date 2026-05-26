/**
 * Seed script — populates the database with demo data so the app has something
 * to render on first run. Mirrors lib/seed.ts but writes through Prisma with
 * bcrypt-hashed passwords (audit flaw #1 — never store plaintext).
 *
 * Run: npx prisma db seed   (configured in package.json under "prisma.seed")
 */

import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Seeding database…");

  // Wipe in dependency order so re-running the seed is idempotent.
  await db.comment.deleteMany();
  await db.timeEntry.deleteMany();
  await db.notification.deleteMany();
  await db.activity.deleteMany();
  await db.task.deleteMany();
  await db.budget.deleteMany();
  await db.recurringRule.deleteMany();
  await db.transaction.deleteMany();
  await db.inviteToken.deleteMany();
  // Drop projects BEFORE users, since Project.supervisorId references User.
  await db.project.deleteMany();
  // Break the User -> Company FK before deleting either.
  await db.user.deleteMany();
  await db.company.deleteMany();

  const hash = (pw: string) => bcrypt.hashSync(pw, 12);

  // Create the founder first without companyId, then create the company
  // owned by them, then update the founder to point at the company. SQLite
  // can't defer FKs, so we do it in two steps via raw upsert.
  const founderId = "demo-saqib";
  const aliId = "demo-ali";
  const ahmedId = "demo-ahmed";
  const fatimaId = "demo-fatima";
  const sarahId = "demo-sarah";
  const companyId = "demo-nimbus";

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
