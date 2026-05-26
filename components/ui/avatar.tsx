"use client";

import { cn, generateAvatar, getAvatarColor } from "@/lib/utils";

interface AvatarProps {
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeMap = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-16 w-16 text-lg",
};

export function Avatar({ name, size = "md", className }: AvatarProps) {
  const initials = generateAvatar(name);
  const color = getAvatarColor(name);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ring-2 ring-white dark:ring-slate-900",
        color,
        sizeMap[size],
        className
      )}
      title={name}
    >
      {initials}
    </div>
  );
}

export function AvatarGroup({
  names,
  max = 4,
  size = "sm",
}: {
  names: string[];
  max?: number;
  size?: AvatarProps["size"];
}) {
  const visible = names.slice(0, max);
  const remaining = names.length - max;

  return (
    <div className="flex -space-x-2">
      {visible.map((name, i) => (
        <Avatar
          key={`${name}-${i}`}
          name={name}
          size={size}
          className="ring-2 ring-white dark:ring-slate-900"
        />
      ))}
      {remaining > 0 && (
        <div
          className={cn(
            "flex items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 ring-2 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-900",
            sizeMap[size!]
          )}
        >
          +{remaining}
        </div>
      )}
    </div>
  );
}
