import type { Config } from "tailwindcss";

const config: Config = {
  // `.dark` is the app shell's switch (set on <html> by Providers). The
  // marketing page is theme-scoped instead — it carries data-theme on its own
  // root so it can stay light while the app is dark — so `dark:` utilities have
  // to respond to both, or shadows inside the landing never get their dark
  // treatment when a visitor flips the toggle.
  darkMode: ["variant", [".dark &", '[data-theme="dark"] &']],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surface tokens — driven by CSS variables in globals.css
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
        },
        card: "rgb(var(--card) / <alpha-value>)",
        fg: {
          DEFAULT: "rgb(var(--fg) / <alpha-value>)",
          muted: "rgb(var(--fg-muted) / <alpha-value>)",
        },
        border: "rgb(var(--border) / <alpha-value>)",
        input: "rgb(var(--input) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",

        // Glass — inverts per theme. Use with alpha: bg-glass/[0.04], border-glass/[0.08].
        glass: "rgb(var(--glass) / <alpha-value>)",

        // Accents
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          fg: "rgb(var(--primary-fg) / <alpha-value>)",
          soft: "rgb(var(--primary-soft) / <alpha-value>)",
          // Text-safe variant: darker on light, same as DEFAULT on dark.
          // Use for any `text-*` utility; keep DEFAULT for fills/borders.
          strong: "rgb(var(--primary-strong) / <alpha-value>)",
        },
        // Emerald ramp + neutral — the BRAND accents, deliberately narrow (see
        // the rebrand_project_colors migration). Categorical data does NOT use
        // these; it uses the `cat-*` ramp below, which exists because four
        // shades of one green cannot separate ten expense categories.
        // Same split as `primary`: DEFAULT for fills/borders/tints, `strong`
        // is the TEXT-ONLY variant that clears WCAG AA on its surface.
        forest: {
          DEFAULT: "rgb(var(--forest) / <alpha-value>)",
          strong: "rgb(var(--forest-strong) / <alpha-value>)",
        },
        mint: {
          DEFAULT: "rgb(var(--mint) / <alpha-value>)",
          strong: "rgb(var(--mint-strong) / <alpha-value>)",
        },
        slate: {
          DEFAULT: "rgb(var(--slate) / <alpha-value>)",
          strong: "rgb(var(--slate-strong) / <alpha-value>)",
        },

        // CATEGORICAL — ten hues for categorical DATA (chart marks, project
        // swatches), driven by --cat-1 … --cat-10 in globals.css, which carry a
        // light value AND a dark value. Spelled out one by one rather than
        // generated in a loop: Tailwind's content scanner only sees class
        // strings that exist as literals in the source, so a generated
        // `bg-cat-${n}` at a call site would compile to nothing. The literals
        // live in COLOR_CLASSES (components/projects/project-card.tsx), which
        // is inside the content globs.
        //
        // Same DEFAULT/strong split as everything above: `bg-cat-3` for fills
        // and tints (`bg-cat-3/10`), `text-cat-3-strong` for text. Not
        // semantic: `cat-3` is the third categorical hue, not a warning.
        "cat-1": {
          DEFAULT: "rgb(var(--cat-1) / <alpha-value>)",
          strong: "rgb(var(--cat-1-strong) / <alpha-value>)",
        },
        "cat-2": {
          DEFAULT: "rgb(var(--cat-2) / <alpha-value>)",
          strong: "rgb(var(--cat-2-strong) / <alpha-value>)",
        },
        "cat-3": {
          DEFAULT: "rgb(var(--cat-3) / <alpha-value>)",
          strong: "rgb(var(--cat-3-strong) / <alpha-value>)",
        },
        "cat-4": {
          DEFAULT: "rgb(var(--cat-4) / <alpha-value>)",
          strong: "rgb(var(--cat-4-strong) / <alpha-value>)",
        },
        "cat-5": {
          DEFAULT: "rgb(var(--cat-5) / <alpha-value>)",
          strong: "rgb(var(--cat-5-strong) / <alpha-value>)",
        },
        "cat-6": {
          DEFAULT: "rgb(var(--cat-6) / <alpha-value>)",
          strong: "rgb(var(--cat-6-strong) / <alpha-value>)",
        },
        "cat-7": {
          DEFAULT: "rgb(var(--cat-7) / <alpha-value>)",
          strong: "rgb(var(--cat-7-strong) / <alpha-value>)",
        },
        "cat-8": {
          DEFAULT: "rgb(var(--cat-8) / <alpha-value>)",
          strong: "rgb(var(--cat-8-strong) / <alpha-value>)",
        },
        "cat-9": {
          DEFAULT: "rgb(var(--cat-9) / <alpha-value>)",
          strong: "rgb(var(--cat-9-strong) / <alpha-value>)",
        },
        "cat-10": {
          DEFAULT: "rgb(var(--cat-10) / <alpha-value>)",
          strong: "rgb(var(--cat-10-strong) / <alpha-value>)",
        },

        // Semantic — DEFAULT for fills/borders/tints; `strong` is the text-safe
        // foreground (darker on light, brighter on dark), mirroring the accents.
        success: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          strong: "rgb(var(--success-strong) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--warning) / <alpha-value>)",
          strong: "rgb(var(--warning-strong) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--danger) / <alpha-value>)",
          strong: "rgb(var(--danger-strong) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--info) / <alpha-value>)",
          strong: "rgb(var(--info-strong) / <alpha-value>)",
        },
      },
      // `text-*` deliberately resolves differently from `bg-*` / `border-*` /
      // `ring-*` (audit a11y-003). Tailwind takes `text-{color}` from
      // `theme.textColor`, which defaults to `theme.colors`; declaring it here
      // re-points ONLY the text utility.
      //
      // Why it has to be done here and not at the call sites: the four semantic
      // DEFAULT tokens are tuned for FILLS. `--danger` is red-600 specifically
      // so that `bg-danger` + `text-white` (the delete-account and
      // delete-workspace confirm buttons) clears AA — and `.dark` therefore
      // leaves it alone, which is how dark mode ended up painting red-600
      // validation text on a #2a3642 card at 2.55:1. The `-strong` ramp exists
      // for exactly this, is defined per theme, and already clears AA in both;
      // the 103 `text-danger` / `text-warning` / `text-success` / `text-info`
      // call sites simply never adopted it. Mapping the utility fixes all of
      // them at once, keeps the fill ramp intact, and — unlike a
      // `.dark .text-danger` override in globals.css — automatically covers the
      // variant spellings too (`hover:text-danger`, 15 sites, compiles to
      // `.hover\:text-danger:hover` and would out-specify any such override).
      //
      // The failing numbers this closes, computed in
      // tests/lib/a11y/contrast.test.ts: text-danger 2.55:1 on a dark card;
      // text-warning 2.15:1 on light; text-success 2.54:1 on light; text-info
      // 3.35:1 dark and 3.68:1 light. `-strong` is 4.5:1+ on every resting
      // surface in both themes.
      //
      // `strong` is respelled alongside each DEFAULT so `text-*-strong` keeps
      // working without depending on how Tailwind deep-merges `extend`.
      textColor: {
        danger: {
          DEFAULT: "rgb(var(--danger-strong) / <alpha-value>)",
          strong: "rgb(var(--danger-strong) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--warning-strong) / <alpha-value>)",
          strong: "rgb(var(--warning-strong) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--success-strong) / <alpha-value>)",
          strong: "rgb(var(--success-strong) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--info-strong) / <alpha-value>)",
          strong: "rgb(var(--info-strong) / <alpha-value>)",
        },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
      },
      fontSize: {
        // Fluid type — clamps for responsive scaling without breakpoint jumps
        display: ["clamp(3rem, 8vw, 6rem)", { lineHeight: "1.05", letterSpacing: "-0.03em" }],
        h1: ["clamp(2rem, 4vw, 3rem)", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        h2: ["clamp(1.5rem, 2.5vw, 2rem)", { lineHeight: "1.15", letterSpacing: "-0.015em" }],
        meta: ["0.6875rem", { lineHeight: "1", letterSpacing: "0.1em" }],
      },
      zIndex: {
        base: "0",
        dropdown: "10",
        sticky: "20",
        overlay: "40",
        modal: "50",
        popover: "60",
        toast: "70",
      },
      animation: {
        "fade-in": "fadeIn 0.4s var(--ease-material)",
        "slide-up": "slideUp 0.4s var(--ease-out-quint)",
        "slide-down": "slideDown 0.4s var(--ease-out-quint)",
        "reveal-up": "revealUp 700ms var(--ease-norris)",
        shimmer: "shimmer 2s linear infinite",
        "pulse-soft": "pulseSoft 2s var(--ease-material) infinite",
        marquee: "marquee 30s linear infinite",
        "lamp-pulse": "lampPulse 3.5s var(--ease-material) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        slideDown: {
          "0%": { transform: "translateY(-20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        revealUp: {
          "0%": { transform: "translateY(110%)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        lampPulse: {
          "0%, 100%": { opacity: "0.85" },
          "50%": { opacity: "1" },
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic": "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "gradient-mesh":
          "radial-gradient(at 27% 37%, rgb(var(--primary) / 0.15) 0px, transparent 50%), radial-gradient(at 97% 21%, rgb(var(--forest) / 0.15) 0px, transparent 50%), radial-gradient(at 52% 99%, rgb(var(--mint) / 0.1) 0px, transparent 50%)",
        "lamp-glow":
          "radial-gradient(circle at center, rgb(var(--primary) / 0.18) 0%, rgb(var(--primary) / 0) 70%)",
      },
      boxShadow: {
        glow: "0 0 24px rgb(var(--primary) / 0.35)",
        "glow-lg": "0 0 48px rgb(var(--primary) / 0.45)",
        card: "0 2px 8px rgb(0 0 0 / 0.04), 0 1px 2px rgb(0 0 0 / 0.02)",
        "card-hover": "0 8px 24px rgb(0 0 0 / 0.10), 0 2px 4px rgb(0 0 0 / 0.04)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
