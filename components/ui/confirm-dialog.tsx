"use client";

/**
 * ConfirmDialog + useConfirm — themed replacement for window.confirm().
 *
 * Why:
 *   - native confirm() blocks the JS thread, can't be themed, can't be
 *     keyboard-trapped or screen-reader-friendly, and breaks design cohesion
 *     (audit flaw #29)
 *
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: "Delete this expense?",
 *     description: "This action cannot be undone.",
 *     confirmLabel: "Delete",
 *     tone: "danger",
 *   });
 *   if (!ok) return;
 *
 * Mount <ConfirmDialogHost /> once at the app root (already wired in
 * components/providers.tsx). The hook just talks to that singleton via a
 * tiny pub/sub.
 */

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary" | "warning";
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

// Tiny event bus that lives in module scope so useConfirm() can dispatch and
// the singleton host can subscribe without prop-drilling a context.
type Listener = (p: PendingConfirm) => void;
const listeners = new Set<Listener>();

function emit(p: PendingConfirm) {
  if (listeners.size === 0) {
    console.warn("ConfirmDialogHost is not mounted; falling back to native confirm()");
    p.resolve(window.confirm(`${p.opts.title}\n\n${p.opts.description ?? ""}`));
    return;
  }
  listeners.forEach((l) => l(p));
}

export function useConfirm() {
  return useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => emit({ opts, resolve }));
  }, []);
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    const handler: Listener = (p) => setPending(p);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  function close(ok: boolean) {
    if (!pending) return;
    pending.resolve(ok);
    setPending(null);
  }

  const tone = pending?.opts.tone ?? "danger";
  const toneFill =
    tone === "danger" ? "bg-danger/10" : tone === "warning" ? "bg-warning/10" : "bg-primary/10";
  const toneText =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-primary-strong";
  const ToneIcon =
    tone === "danger"
      ? AlertTriangle
      : tone === "warning"
        ? AlertTriangle
        : tone === "primary"
          ? CheckCircle2
          : Info;
  const confirmClass =
    tone === "danger"
      ? "bg-danger text-white hover:bg-danger/90"
      : tone === "warning"
        ? "bg-warning text-bg hover:bg-warning/90"
        : "bg-primary text-primary-fg hover:bg-primary-soft";

  return (
    <Modal
      open={pending !== null}
      onClose={() => close(false)}
      title={pending?.opts.title ?? ""}
      size="sm"
      hideClose
    >
      <div className="flex items-start gap-4">
        <div
          className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", toneFill)}
        >
          <ToneIcon className={cn("h-5 w-5", toneText)} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          {pending?.opts.description && (
            <p className="text-sm leading-relaxed text-fg-muted">{pending.opts.description}</p>
          )}
        </div>
      </div>

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => close(false)}
          className="flex-1 rounded-full border border-border bg-bg px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
        >
          {pending?.opts.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          onClick={() => close(true)}
          autoFocus
          className={cn(
            "flex-1 rounded-full px-5 py-2.5 text-sm font-bold shadow-sm transition-all active:scale-95",
            confirmClass
          )}
        >
          {pending?.opts.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );
}
