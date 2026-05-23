"use client";

import { useEffect } from "react";
import { Toaster } from "react-hot-toast";
import { useStore } from "@/lib/store";

export function Providers({ children }: { children: React.ReactNode }) {
  const init = useStore((s) => s.init);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  return (
    <>
      {children}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3500,
          style: {
            background: theme === "dark" ? "#1e1e2e" : "#fff",
            color: theme === "dark" ? "#f8fafc" : "#0f172a",
            border: `1px solid ${theme === "dark" ? "#2e2e44" : "#e2e8f0"}`,
            borderRadius: "12px",
            padding: "12px 16px",
            fontSize: "14px",
            fontWeight: 500,
            boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
          },
          success: {
            iconTheme: { primary: "#10b981", secondary: "#fff" },
          },
          error: {
            iconTheme: { primary: "#ef4444", secondary: "#fff" },
          },
        }}
      />
    </>
  );
}
