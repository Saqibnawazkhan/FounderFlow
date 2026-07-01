import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = "PKR"): string {
  // Intl.NumberFormat handles PKR natively — the previous special case was
  // producing a subtly different glyph pattern from other currencies (custom
  // "PKR " prefix vs the CLDR-standard non-breaking-space output). Unifying
  // under one Intl path fixes audit row F12: currency rendering is now
  // consistent across every currency the workspace picks.
  //
  // Post-processing:
  //  • Non-breaking space (U+00A0) → regular space so copy-paste, downstream
  //    tests, and CSV exports don't have to know about NBSP.
  //  • Negative CLDR output is "-PKR 12,345"; the previous inline format was
  //    "PKR -12,345". Reorder so we don't regress the user-facing look while
  //    keeping the one Intl call for grouping + currency-code lookup.
  const formatted = ((): string => {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      // Guard for the pathological case where the caller passes a non-ISO
      // 4217 code (e.g. a stale seed value). Fall back to a plain number.
      return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount)}`;
    }
  })().replace(/ /g, " ");
  if (amount < 0 && formatted.startsWith(`-${currency}`)) {
    return `${currency} -${formatted.slice(currency.length + 1).trimStart()}`;
  }
  return formatted;
}

export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

export function formatDate(date: string | Date): string {
  return format(new Date(date), "MMM dd, yyyy");
}

export function formatDateTime(date: string | Date): string {
  return format(new Date(date), "MMM dd, yyyy 'at' h:mm a");
}

export function formatRelativeTime(date: string | Date): string {
  const d = new Date(date);
  if (isToday(d)) {
    return `Today at ${format(d, "h:mm a")}`;
  }
  if (isYesterday(d)) {
    return `Yesterday at ${format(d, "h:mm a")}`;
  }
  const distance = formatDistanceToNow(d, { addSuffix: true });
  return distance;
}

export function generateAvatar(name: string): string {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return initials || "U";
}

export function getAvatarColor(name: string): string {
  const colors = [
    "from-pink-500 to-rose-500",
    "from-purple-500 to-indigo-500",
    "from-blue-500 to-cyan-500",
    "from-emerald-500 to-teal-500",
    "from-amber-500 to-orange-500",
    "from-red-500 to-pink-500",
    "from-violet-500 to-purple-500",
    "from-sky-500 to-blue-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function downloadFile(content: string | Blob, filename: string, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
