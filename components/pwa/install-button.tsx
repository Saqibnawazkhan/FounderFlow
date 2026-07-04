"use client";

/**
 * PWA install control (S11). Captures the `beforeinstallprompt` event the
 * browser fires when the app meets installability criteria, and surfaces a
 * button that triggers the native prompt. Falls back to a hint on platforms
 * that never fire the event (iOS Safari), and reports "installed" when we're
 * already running standalone or the `appinstalled` event fires.
 *
 * All copy is passed in so the strings stay in the i18n dictionary.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Download } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallAppButton({
  label,
  installedLabel,
  unavailableLabel,
}: {
  label: string;
  installedLabel: string;
  unavailableLabel: string;
}) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Already running as an installed app → nothing to offer.
    if (window.matchMedia?.("(display-mode: standalone)").matches) {
      setInstalled(true);
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault(); // stash it; we trigger the prompt on the button click
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    // A single beforeinstallprompt event can only be used once.
    setDeferred(null);
  }

  if (installed) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-primary-strong">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {installedLabel}
      </p>
    );
  }

  if (!deferred) {
    // Installable but the browser hasn't offered a prompt yet, or a platform
    // (iOS) that installs via the Share sheet instead.
    return <p className="text-xs text-fg-muted">{unavailableLabel}</p>;
  }

  return (
    <button
      type="button"
      onClick={handleInstall}
      className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
    >
      <Download className="h-4 w-4" aria-hidden="true" /> {label}
    </button>
  );
}
