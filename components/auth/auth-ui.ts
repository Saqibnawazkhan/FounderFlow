/**
 * Shared class vocabulary for the public auth surfaces (login, signup,
 * forgot-password, reset-password).
 *
 * These pages sit next to the landing page in a visitor's session — you click
 * "Start free" and land on /signup — so they use the same surface language:
 * light-first, `border-border` on `bg-surface` rather than glass tints,
 * rounded-xl rather than pills, and a tinted drop shadow rather than an accent
 * glow. Keeping the strings here means a change lands on all four at once
 * instead of drifting file by file.
 *
 * Pair with `data-marketing data-theme="light"` on the page root (see
 * `authShell`) so the tokens resolve light regardless of the app shell's theme.
 */

/** Page root. Combine with the display font variable. */
export const authShell = "min-h-screen bg-bg text-fg";

/* NOTE ON RADII: this project overrides Tailwind's scale with tokens, and the
 * result inverts — `rounded-xl` is --radius-xl (48px, a pill) while
 * `rounded-2xl` is stock Tailwind (16px). Buttons want the pill; inputs and
 * panels want 2xl. Check the rendered radius before reaching for a bigger-
 * sounding name. */

/** Field label — sentence case. The old mono/uppercase/0.18em treatment read as
 *  a status chip rather than a form label. */
export const authLabel = "mb-2 block text-sm font-medium text-fg";

export const authInputBase =
  "w-full rounded-2xl border bg-surface px-4 py-3 text-sm text-fg transition-colors " +
  "placeholder:text-fg-muted focus:outline-none";

export const authInputIdle = "border-border focus:border-primary/60";

export const authInputError = "border-danger/60 focus:border-danger";

export const authPrimaryButton =
  "group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary " +
  "px-5 py-3.5 text-sm font-bold text-primary-fg " +
  "shadow-[0_6px_24px_rgb(var(--primary)_/_0.26)] transition-all " +
  "hover:scale-[1.01] hover:shadow-[0_8px_30px_rgb(var(--primary)_/_0.34)] " +
  "active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100";

export const authSecondaryButton =
  "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border " +
  "bg-surface px-5 py-3.5 text-sm font-semibold text-fg transition-colors " +
  "hover:bg-surface-hover active:scale-[0.98]";

/** The showcase column beside the form. */
export const authAside =
  "relative hidden overflow-hidden border-s border-border bg-surface " +
  "lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24";
