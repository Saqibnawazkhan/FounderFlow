import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Playfair_Display } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

const serif = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: {
    default: "FounderFlow — Co-Founder Company Management",
    template: "%s · FounderFlow",
  },
  description:
    "Manage and track every part of your startup in one place. Built for co-founders to align on finances, tasks, and momentum.",
  keywords: ["startup", "co-founder", "management", "expense tracker", "task management"],
  manifest: "/manifest.json",
  applicationName: "FounderFlow",
  // Explicit icon set. `app/icon.svg` covers Next.js's file-based metadata,
  // but bare `/favicon.ico` and legacy Safari need the URL spelled out. The
  // duplicate `public/icon.svg` (identical to `app/icon.svg`) exists so the
  // manifest + service-worker precache resolve at the literal URL.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/android-chrome-192x192.png", type: "image/png", sizes: "192x192" },
    ],
    shortcut: "/icon.svg",
    // iOS home-screen icon must be a PNG — SVG apple-touch-icons don't render.
    apple: "/apple-touch-icon.png",
  },
  // PWA / iOS: tell Safari this is a standalone web app so the user gets the
  // "Add to Home Screen" experience without browser chrome on launch.
  appleWebApp: {
    capable: true,
    title: "FounderFlow",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  openGraph: {
    title: "FounderFlow — Co-Founder Company Management",
    description: "Finances, tasks, and momentum in one place. Built for co-founders.",
    url: "/",
    siteName: "FounderFlow",
    type: "website",
    // The actual PNG comes from app/opengraph-image.tsx, which Next.js
    // auto-wires — listing it here would double up the tag.
  },
  twitter: {
    card: "summary_large_image",
    title: "FounderFlow",
    description: "Co-founder company management.",
  },
};

export const viewport: Viewport = {
  // Match the manifest background so the iOS status bar / Android nav-bar
  // blend seamlessly with the app shell in installed PWA mode.
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  // Disable user-zoom only on installed PWA — feels app-like, not webby.
  // Browser still allows zoom on the regular browser visit.
  viewportFit: "cover",
};

/**
 * Sync theme bootstrap — runs in <head> before first paint so we don't flash
 * the wrong theme. Reads the persisted Zustand snapshot from localStorage and
 * applies the `dark` class to <html> immediately. Falls back to dark (the
 * store's initial state) when storage is empty or unavailable.
 */
const themeBootstrap = `
(function () {
  try {
    var raw = localStorage.getItem('founderflow-storage');
    var theme = 'dark';
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.state && parsed.state.theme) theme = parsed.state.theme;
    }
    if (theme === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${mono.variable} ${serif.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        {/* Skip-to-content: hidden until keyboard-focused, then jumps past
            the sidebar + topbar chrome. Every /main is tagged with id="main"
            by the app-shell layout so this lands somewhere useful. */}
        <a
          href="#main"
          className="sr-only rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-modal"
        >
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
