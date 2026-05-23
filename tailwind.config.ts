import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
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
        cyan: {
          DEFAULT: "rgb(var(--cyan) / <alpha-value>)",
          strong: "rgb(var(--cyan-strong) / <alpha-value>)",
        },
        pink: {
          DEFAULT: "rgb(var(--pink) / <alpha-value>)",
          strong: "rgb(var(--pink-strong) / <alpha-value>)",
        },

        // Semantic
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",

        // Brand/accent aliases kept temporarily for legacy callers (sidebar, etc.).
        // TODO Phase 3.B: rip these out once legacy components are migrated.
        brand: {
          50: "rgb(var(--primary) / 0.05)",
          100: "rgb(var(--primary) / 0.1)",
          200: "rgb(var(--primary) / 0.2)",
          300: "rgb(var(--primary) / 0.3)",
          400: "rgb(var(--primary) / 0.5)",
          500: "rgb(var(--primary))",
          600: "rgb(var(--primary-soft))",
          700: "rgb(var(--primary-soft))",
          800: "rgb(var(--primary-soft))",
          900: "rgb(var(--primary-soft))",
          950: "rgb(var(--primary-soft))",
        },
        accent: {
          50: "rgb(var(--cyan) / 0.05)",
          100: "rgb(var(--cyan) / 0.1)",
          200: "rgb(var(--cyan) / 0.2)",
          300: "rgb(var(--cyan) / 0.3)",
          400: "rgb(var(--cyan) / 0.5)",
          500: "rgb(var(--cyan))",
          600: "rgb(var(--cyan))",
          700: "rgb(var(--cyan))",
          800: "rgb(var(--cyan))",
          900: "rgb(var(--cyan))",
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
          "radial-gradient(at 27% 37%, rgb(var(--primary) / 0.15) 0px, transparent 50%), radial-gradient(at 97% 21%, rgb(var(--cyan) / 0.15) 0px, transparent 50%), radial-gradient(at 52% 99%, rgb(var(--pink) / 0.1) 0px, transparent 50%)",
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
  plugins: [],
};

export default config;
