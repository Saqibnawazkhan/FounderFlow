"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Building2,
  Crown,
  LogOut,
  Moon,
  Palette,
  Shield,
  Sun,
  User,
  Database,
} from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { Avatar } from "@/components/ui/avatar";
import { cn, formatDate } from "@/lib/utils";

export default function SettingsPage() {
  const router = useRouter();
  const currentUser = useStore((s) => s.currentUser);
  const companies = useStore((s) => s.companies);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const logout = useStore((s) => s.logout);

  const company = companies.find((c) => c.id === currentUser?.companyId);

  function handleLogout() {
    if (!confirm("Are you sure you want to sign out?")) return;
    logout();
    toast.success("Signed out");
    router.push("/login");
  }

  function handleResetData() {
    if (!confirm("Clear all data and reset to demo? This cannot be undone.")) return;
    if (typeof window !== "undefined") {
      localStorage.removeItem("founderflow-storage");
      window.location.href = "/login";
    }
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-1">
          Manage your account, workspace, and preferences.
        </p>
      </div>

      {/* Profile */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="card p-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <User className="h-5 w-5 text-brand-500" />
          <h2 className="text-lg font-semibold">Your Profile</h2>
        </div>
        <div className="flex items-center gap-4 mb-6">
          <Avatar name={currentUser?.name || ""} size="xl" />
          <div>
            <p className="font-bold text-lg">{currentUser?.name}</p>
            <p className="text-sm text-slate-500">{currentUser?.email}</p>
            <p className="text-xs text-slate-400 mt-1">
              Joined {currentUser ? formatDate(currentUser.createdAt) : ""}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Role</p>
            <div className="mt-1 flex items-center gap-2">
              {currentUser?.role === "admin" && <Crown className="h-4 w-4 text-amber-500" />}
              {currentUser?.role === "cofounder" && <Shield className="h-4 w-4 text-brand-500" />}
              {currentUser?.role === "member" && <User className="h-4 w-4 text-emerald-500" />}
              <p className="font-medium text-sm">
                {currentUser?.role === "admin"
                  ? "Admin Founder"
                  : currentUser?.role === "cofounder"
                  ? "Co-Founder"
                  : "Team Member"}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">User ID</p>
            <p className="font-mono text-xs mt-1 text-slate-400">{currentUser?.id.slice(0, 12)}...</p>
          </div>
        </div>
      </motion.div>

      {/* Company */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="card p-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <Building2 className="h-5 w-5 text-brand-500" />
          <h2 className="text-lg font-semibold">Company</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Name</p>
            <p className="font-medium mt-1">{company?.name}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Industry</p>
            <p className="font-medium mt-1">{company?.industry}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Currency</p>
            <p className="font-medium mt-1">{company?.currency}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Created</p>
            <p className="font-medium mt-1">{company ? formatDate(company.createdAt) : ""}</p>
          </div>
        </div>
      </motion.div>

      {/* Appearance */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="card p-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <Palette className="h-5 w-5 text-brand-500" />
          <h2 className="text-lg font-semibold">Appearance</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">Choose how FounderFlow looks for you.</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setTheme("light")}
            className={cn(
              "p-4 rounded-xl border-2 text-left transition-all",
              theme === "light"
                ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
                : "border-slate-200 dark:border-slate-700 hover:border-slate-300"
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <Sun className="h-5 w-5 text-amber-500" />
              {theme === "light" && <div className="h-2 w-2 rounded-full bg-brand-500" />}
            </div>
            <p className="font-semibold text-sm">Light</p>
            <p className="text-xs text-slate-500 mt-1">Clean, classic, energizing</p>
          </button>
          <button
            onClick={() => setTheme("dark")}
            className={cn(
              "p-4 rounded-xl border-2 text-left transition-all",
              theme === "dark"
                ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
                : "border-slate-200 dark:border-slate-700 hover:border-slate-300"
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <Moon className="h-5 w-5 text-violet-500" />
              {theme === "dark" && <div className="h-2 w-2 rounded-full bg-brand-500" />}
            </div>
            <p className="font-semibold text-sm">Dark</p>
            <p className="text-xs text-slate-500 mt-1">Easy on the eyes for long sessions</p>
          </button>
        </div>
      </motion.div>

      {/* Data */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="card p-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-5 w-5 text-brand-500" />
          <h2 className="text-lg font-semibold">Data & Storage</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          FounderFlow stores your data locally in your browser. To sync across devices, connect a backend.
        </p>
        <button onClick={handleResetData} className="btn-secondary text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">
          Reset workspace data
        </button>
      </motion.div>

      {/* Sign out */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
        className="card p-6 border-red-200 dark:border-red-500/20"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Sign out</h2>
            <p className="text-sm text-slate-500 mt-1">Sign out of your FounderFlow workspace.</p>
          </div>
          <button onClick={handleLogout} className="btn-danger">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </motion.div>
    </div>
  );
}
