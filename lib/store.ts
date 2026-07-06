"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { v4 as uuid } from "uuid";
import type {
  User,
  Company,
  Transaction,
  Task,
  Activity,
  ActivityMetadata,
  Notification,
  ActivityType,
  TaskStatus,
} from "./types";
import { seedData } from "./seed";
import type { Locale } from "@/lib/i18n/strings";

interface AppState {
  initialized: boolean;
  currentUser: User | null;
  users: User[];
  companies: Company[];
  /** The signed-in user's REAL company (name + industry), fetched from the DB
   * on mount by CompanyHydrator. Distinct from the demo `companies` seed array;
   * this is what the sidebar shows for an authenticated (non-demo) user. */
  currentCompany: { name: string; industry: string } | null;
  transactions: Transaction[];
  tasks: Task[];
  activities: Activity[];
  notifications: Notification[];
  theme: "light" | "dark";
  /** UI locale — drives the string dictionary + html lang/dir. */
  locale: Locale;
  /** Mobile sidebar open/close. Lifted to the store so the topbar burger can
   * open the sidebar without prop-drilling through layout. */
  mobileNavOpen: boolean;
  /** Desktop sidebar collapsed vs expanded. Persisted so the choice survives
   * a page reload. Mobile always uses the drawer overlay regardless. */
  sidebarCollapsed: boolean;

  init: () => void;
  setMobileNavOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setLocale: (locale: Locale) => void;
  /**
   * Adopt a user identity that came from Auth.js (via getSession on mount).
   * Skips the demo-seed path so a real session never overlaps the local
   * demo workspace.
   */
  hydrateUser: (user: User | null) => void;
  /** Adopt the real company for the sidebar/topbar (set by CompanyHydrator). */
  hydrateCompany: (company: { name: string; industry: string } | null) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;

  signup: (data: {
    name: string;
    email: string;
    password: string;
    companyName: string;
    industry: string;
  }) => { success: boolean; error?: string };
  login: (email: string, password: string) => { success: boolean; error?: string };
  logout: () => void;
  loginDemo: () => void;

  inviteUser: (data: { name: string; email: string; password: string; role: User["role"] }) => {
    success: boolean;
    error?: string;
  };
  removeUser: (userId: string) => void;
  updateUserRole: (userId: string, role: User["role"]) => void;

  addTransaction: (
    data: Omit<Transaction, "id" | "companyId" | "addedBy" | "addedByName" | "createdAt">
  ) => void;
  deleteTransaction: (id: string) => void;

  addTask: (
    data: Omit<
      Task,
      | "id"
      | "companyId"
      | "assignedBy"
      | "assignedByName"
      | "assignedByName"
      | "createdAt"
      | "completedAt"
    >
  ) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  deleteTask: (id: string) => void;

  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;

  getCompanyUsers: () => User[];
  getCompanyTransactions: () => Transaction[];
  getCompanyTasks: () => Task[];
  getCompanyActivities: () => Activity[];
  getUserNotifications: () => Notification[];
}

const noopStorage: Storage = {
  length: 0,
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {},
};

function logActivity(
  state: AppState,
  type: ActivityType,
  message: string,
  metadata?: ActivityMetadata
): Activity[] {
  if (!state.currentUser) return state.activities;
  const activity: Activity = {
    id: uuid(),
    companyId: state.currentUser.companyId,
    type,
    message,
    userId: state.currentUser.id,
    userName: state.currentUser.name,
    metadata,
    createdAt: new Date().toISOString(),
  };
  return [activity, ...state.activities];
}

function notifyAllUsers(
  state: AppState,
  data: {
    title: string;
    message: string;
    type: Notification["type"];
    category?: Notification["category"];
    link?: string;
  },
  excludeUserId?: string
): Notification[] {
  const companyUsers = state.users.filter(
    (u) => u.companyId === state.currentUser?.companyId && u.id !== excludeUserId
  );
  const newNotifs: Notification[] = companyUsers.map((u) => ({
    id: uuid(),
    userId: u.id,
    companyId: state.currentUser!.companyId,
    title: data.title,
    message: data.message,
    type: data.type,
    category: data.category ?? "system",
    read: false,
    link: data.link,
    createdAt: new Date().toISOString(),
  }));
  return [...newNotifs, ...state.notifications];
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      initialized: false,
      currentUser: null,
      users: [],
      companies: [],
      currentCompany: null,
      transactions: [],
      tasks: [],
      activities: [],
      notifications: [],
      theme: "dark",
      locale: "en" as Locale,
      mobileNavOpen: false,
      sidebarCollapsed: false,

      init: () => {
        const state = get();
        if (state.initialized) return;
        const seed = seedData();
        set({
          initialized: true,
          users: state.users.length === 0 ? seed.users : state.users,
          companies: state.companies.length === 0 ? seed.companies : state.companies,
          transactions: state.transactions.length === 0 ? seed.transactions : state.transactions,
          tasks: state.tasks.length === 0 ? seed.tasks : state.tasks,
          activities: state.activities.length === 0 ? seed.activities : state.activities,
          notifications:
            state.notifications.length === 0 ? seed.notifications : state.notifications,
        });
      },

      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),

      toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setLocale: (locale) => set({ locale }),

      hydrateUser: (user) => {
        const current = get().currentUser;
        // Skip the set() call entirely when nothing meaningful changed —
        // the Providers effect can fire repeatedly during session refresh,
        // and an unconditional set was looping subscribers (React #185).
        const sameIdentity =
          current?.id === user?.id &&
          current?.email === user?.email &&
          current?.companyId === user?.companyId &&
          current?.role === user?.role;
        if (sameIdentity) return;
        set({ currentUser: user });
      },

      hydrateCompany: (company) => set({ currentCompany: company }),

      setTheme: (theme) => {
        set({ theme });
        if (typeof document !== "undefined") {
          document.documentElement.classList.toggle("dark", theme === "dark");
        }
      },

      toggleTheme: () => {
        const newTheme = get().theme === "light" ? "dark" : "light";
        get().setTheme(newTheme);
      },

      signup: ({ name, email, password, companyName, industry }) => {
        const state = get();
        if (state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
          return { success: false, error: "Email already registered" };
        }
        const companyId = uuid();
        const userId = uuid();
        const company: Company = {
          id: companyId,
          name: companyName,
          industry,
          currency: "PKR",
          createdAt: new Date().toISOString(),
          ownerId: userId,
        };
        const user: User = {
          id: userId,
          name,
          email,
          password,
          role: "admin",
          companyId,
          createdAt: new Date().toISOString(),
        };
        const activity: Activity = {
          id: uuid(),
          companyId,
          type: "company_created",
          message: `${name} created the company "${companyName}"`,
          userId,
          userName: name,
          createdAt: new Date().toISOString(),
        };
        set({
          currentUser: user,
          users: [...state.users, user],
          companies: [...state.companies, company],
          activities: [activity, ...state.activities],
        });
        return { success: true };
      },

      login: (email, password) => {
        const state = get();
        const user = state.users.find(
          (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
        );
        if (!user) {
          return { success: false, error: "Invalid email or password" };
        }
        set({ currentUser: user });
        return { success: true };
      },

      logout: () => {
        set({ currentUser: null, currentCompany: null });
      },

      loginDemo: () => {
        const state = get();
        let demoUser = state.users.find((u) => u.email === "demo@founderflow.app");
        if (!demoUser) {
          const seed = seedData();
          demoUser = seed.users[0];
          set({
            users: seed.users,
            companies: seed.companies,
            transactions: seed.transactions,
            tasks: seed.tasks,
            activities: seed.activities,
            notifications: seed.notifications,
          });
        }
        set({ currentUser: demoUser });
      },

      inviteUser: ({ name, email, password, role }) => {
        const state = get();
        if (!state.currentUser) return { success: false, error: "Not authenticated" };
        if (state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
          return { success: false, error: "Email already registered" };
        }
        const user: User = {
          id: uuid(),
          name,
          email,
          password,
          role,
          companyId: state.currentUser.companyId,
          createdAt: new Date().toISOString(),
        };
        const newActivities = logActivity(
          state,
          "user_joined",
          `${state.currentUser.name} added ${name} as ${role === "admin" ? "Admin Founder" : role === "cofounder" ? "Co-Founder" : "Team Member"}`,
          { kind: "user", invitedUser: name, role }
        );
        const newNotifs = notifyAllUsers(
          state,
          {
            title: "New Team Member",
            message: `${name} has joined the team`,
            type: "info",
            link: "/team",
          },
          state.currentUser.id
        );
        set({
          users: [...state.users, user],
          activities: newActivities,
          notifications: newNotifs,
        });
        return { success: true };
      },

      removeUser: (userId) => {
        const state = get();
        if (!state.currentUser || state.currentUser.role !== "admin") return;
        const user = state.users.find((u) => u.id === userId);
        if (!user) return;
        const newActivities = logActivity(
          state,
          "user_removed",
          `${state.currentUser.name} removed ${user.name} from the team`,
          { kind: "user", invitedUser: user.name, role: user.role }
        );
        set({
          users: state.users.filter((u) => u.id !== userId),
          activities: newActivities,
        });
      },

      updateUserRole: (userId, role) => {
        const state = get();
        if (!state.currentUser || state.currentUser.role !== "admin") return;
        const target = state.users.find((u) => u.id === userId);
        if (!target) return;
        const newActivities = logActivity(
          state,
          "user_role_changed",
          `${state.currentUser.name} changed ${target.name}'s role to ${role}`,
          { kind: "user", invitedUser: target.name, role, previousRole: target.role }
        );
        set({
          users: state.users.map((u) => (u.id === userId ? { ...u, role } : u)),
          activities: newActivities,
        });
      },

      addTransaction: (data) => {
        const state = get();
        if (!state.currentUser) return;
        const transaction: Transaction = {
          ...data,
          id: uuid(),
          companyId: state.currentUser.companyId,
          addedBy: state.currentUser.id,
          addedByName: state.currentUser.name,
          createdAt: new Date().toISOString(),
        };
        const isExpense = data.type === "expense";
        const message = isExpense
          ? `${state.currentUser.name} added expense of ${data.amount.toLocaleString()} PKR for ${data.category}`
          : `${state.currentUser.name} added investment of ${data.amount.toLocaleString()} PKR`;
        const newActivities = logActivity(
          state,
          isExpense ? "expense_added" : "investment_added",
          message,
          { kind: "transaction", amount: data.amount, category: data.category }
        );
        const newNotifs = notifyAllUsers(
          state,
          {
            title: isExpense ? "New Expense" : "New Investment",
            message: `${state.currentUser.name} ${isExpense ? "logged" : "added"} ${data.amount.toLocaleString()} PKR`,
            type: isExpense ? "warning" : "success",
            link: isExpense ? "/expenses" : "/investments",
          },
          state.currentUser.id
        );
        set({
          transactions: [transaction, ...state.transactions],
          activities: newActivities,
          notifications: newNotifs,
        });
      },

      deleteTransaction: (id) => {
        const state = get();
        if (!state.currentUser) return;
        const t = state.transactions.find((tr) => tr.id === id);
        if (!t) return;
        const newActivities = logActivity(
          state,
          "transaction_deleted",
          `${state.currentUser.name} deleted a ${t.type} of ${t.amount.toLocaleString()} PKR`
        );
        set({
          transactions: state.transactions.filter((tr) => tr.id !== id),
          activities: newActivities,
        });
      },

      addTask: (data) => {
        const state = get();
        if (!state.currentUser) return;
        const task: Task = {
          ...data,
          id: uuid(),
          companyId: state.currentUser.companyId,
          assignedBy: state.currentUser.id,
          assignedByName: state.currentUser.name,
          createdAt: new Date().toISOString(),
        };
        const newActivities = logActivity(
          state,
          "task_assigned",
          `${state.currentUser.name} assigned "${data.title}" to ${data.assignedToName}`
        );
        const assignee = state.users.find((u) => u.id === data.assignedTo);
        let newNotifs = state.notifications;
        if (assignee && assignee.id !== state.currentUser.id) {
          const notif: Notification = {
            id: uuid(),
            userId: assignee.id,
            companyId: state.currentUser.companyId,
            title: "New Task Assigned",
            message: `${state.currentUser.name} assigned you "${data.title}"`,
            type: "info",
            category: "task",
            read: false,
            link: "/tasks",
            createdAt: new Date().toISOString(),
          };
          newNotifs = [notif, ...state.notifications];
        }
        set({
          tasks: [task, ...state.tasks],
          activities: newActivities,
          notifications: newNotifs,
        });
      },

      updateTaskStatus: (id, status) => {
        const state = get();
        if (!state.currentUser) return;
        const task = state.tasks.find((t) => t.id === id);
        if (!task) return;
        const updated: Task = {
          ...task,
          status,
          completedAt: status === "completed" ? new Date().toISOString() : undefined,
        };
        const message =
          status === "completed"
            ? `${state.currentUser.name} completed "${task.title}"`
            : `${state.currentUser.name} updated "${task.title}" to ${status.replace("_", " ")}`;
        const newActivities = logActivity(
          state,
          status === "completed" ? "task_completed" : "task_updated",
          message
        );
        let newNotifs = state.notifications;
        if (status === "completed" && task.assignedBy !== state.currentUser.id) {
          const notif: Notification = {
            id: uuid(),
            userId: task.assignedBy,
            companyId: state.currentUser.companyId,
            title: "Task Completed",
            message: `${state.currentUser.name} completed "${task.title}"`,
            type: "success",
            category: "task",
            read: false,
            link: "/tasks",
            createdAt: new Date().toISOString(),
          };
          newNotifs = [notif, ...state.notifications];
        }
        set({
          tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
          activities: newActivities,
          notifications: newNotifs,
        });
      },

      deleteTask: (id) => {
        const state = get();
        if (!state.currentUser) return;
        const task = state.tasks.find((t) => t.id === id);
        if (!task) return;
        const newActivities = logActivity(
          state,
          "task_deleted",
          `${state.currentUser.name} deleted task "${task.title}"`
        );
        set({
          tasks: state.tasks.filter((t) => t.id !== id),
          activities: newActivities,
        });
      },

      markNotificationRead: (id) => {
        set((state) => ({
          notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        }));
      },

      markAllNotificationsRead: () => {
        const state = get();
        if (!state.currentUser) return;
        set({
          notifications: state.notifications.map((n) =>
            n.userId === state.currentUser?.id ? { ...n, read: true } : n
          ),
        });
      },

      clearNotifications: () => {
        const state = get();
        if (!state.currentUser) return;
        set({
          notifications: state.notifications.filter((n) => n.userId !== state.currentUser?.id),
        });
      },

      getCompanyUsers: () => {
        const state = get();
        if (!state.currentUser) return [];
        return state.users.filter((u) => u.companyId === state.currentUser?.companyId);
      },

      getCompanyTransactions: () => {
        const state = get();
        if (!state.currentUser) return [];
        return state.transactions
          .filter((t) => t.companyId === state.currentUser?.companyId)
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      },

      getCompanyTasks: () => {
        const state = get();
        if (!state.currentUser) return [];
        return state.tasks
          .filter((t) => t.companyId === state.currentUser?.companyId)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      },

      getCompanyActivities: () => {
        const state = get();
        if (!state.currentUser) return [];
        return state.activities
          .filter((a) => a.companyId === state.currentUser?.companyId)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      },

      getUserNotifications: () => {
        const state = get();
        if (!state.currentUser) return [];
        return state.notifications
          .filter((n) => n.userId === state.currentUser?.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      },
    }),
    {
      name: "founderflow-storage",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : noopStorage
      ),
      partialize: (state) => ({
        currentUser: state.currentUser,
        currentCompany: state.currentCompany,
        users: state.users,
        companies: state.companies,
        transactions: state.transactions,
        tasks: state.tasks,
        activities: state.activities,
        notifications: state.notifications,
        theme: state.theme,
        locale: state.locale,
        sidebarCollapsed: state.sidebarCollapsed,
        initialized: state.initialized,
      }),
    }
  )
);

/**
 * Subscribes to the persist-rehydration lifecycle. Returns `false` until
 * Zustand has finished reading localStorage and applied it to the store —
 * after that, `true`.
 *
 * Why this exists: any component that gates its render on `currentUser?.role`
 * sees `undefined` (and our `?? "member"` fallback) for ~50ms after page
 * load before persist hydrates. That makes admins briefly look like members,
 * which can hide nav items / finance pages on first paint. Components that
 * need to be hydration-aware should gate on this hook instead.
 */
export function useStoreHasHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated());
  useEffect(() => {
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true));
    setHydrated(useStore.persist.hasHydrated());
    return unsub;
  }, []);
  return hydrated;
}
