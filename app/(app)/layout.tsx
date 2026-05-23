"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const currentUser = useStore((s) => s.currentUser);
  const initialized = useStore((s) => s.initialized);

  useEffect(() => {
    if (initialized && !currentUser) {
      router.replace("/login");
    }
  }, [currentUser, initialized, router]);

  if (!currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-pulse rounded-xl bg-primary" />
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Loading workspace…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col lg:ml-64">
        <Topbar />
        <main className="flex-1 overflow-x-hidden p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
