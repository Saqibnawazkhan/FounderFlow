"use client";

/**
 * Modal — Radix Dialog wrapper with the FounderFlow theme.
 *
 * Why Radix instead of bare Framer Motion (the old impl):
 *   - role="dialog" + aria-modal baked in (audit flaw #14)
 *   - focus trap + focus return when closed (audit flaw #14)
 *   - Escape + outside-click already wired
 *   - Body scroll lock via Radix's own logic (no global side effect that
 *     stacks across instances like our old document.body.style.overflow)
 *   - Cross-fade animations via data-state attributes — respect
 *     prefers-reduced-motion automatically through globals.css overrides
 *
 * Public API preserved so the 5 sites that already use <Modal title=... /> keep
 * working without code changes:
 *   - open, onClose, title, description?, children, size?
 *
 * For raw access (e.g. ConfirmDialog) export the Radix primitives directly via
 * Modal.Root / Modal.Content.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Hide the default close button (e.g. for destructive confirms). */
  hideClose?: boolean;
}

const sizeMap: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  hideClose = false,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        {/* Overlay — fades in/out via data-state */}
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-overlay bg-bg/70 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          )}
        />
        {/* Content — slide-up + fade. Radix handles focus trap and aria-* */}
        <Dialog.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-modal w-[calc(100%-2rem)]",
            "translate-x-[-50%] translate-y-[-50%]",
            "flex max-h-[90vh] flex-col overflow-hidden rounded-2xl",
            "border border-border bg-surface shadow-card-hover",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "duration-200",
            sizeMap[size]
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border p-6 pb-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold tracking-tight text-fg">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-sm text-fg-muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
            {!hideClose && (
              <Dialog.Close
                aria-label="Close"
                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Dialog.Close>
            )}
          </div>
          <div className="scrollbar-thin overflow-y-auto p-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
