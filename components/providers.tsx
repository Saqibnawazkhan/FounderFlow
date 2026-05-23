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
          className: "!font-sans",
          style: {
            background: "rgb(var(--surface))",
            color: "rgb(var(--fg))",
            border: "1px solid rgb(var(--border))",
            borderRadius: "12px",
            padding: "12px 16px",
            fontSize: "14px",
            fontWeight: 500,
            boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
          },
          success: {
            iconTheme: { primary: "rgb(var(--primary))", secondary: "rgb(var(--primary-fg))" },
          },
          error: {
            iconTheme: { primary: "rgb(var(--danger))", secondary: "#fff" },
          },
        }}
      />
    </>
  );
}
