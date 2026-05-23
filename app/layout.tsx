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
  openGraph: {
    title: "FounderFlow — Co-Founder Company Management",
    description: "Finances, tasks, and momentum in one place. Built for co-founders.",
    url: "/",
    siteName: "FounderFlow",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FounderFlow",
    description: "Co-founder company management.",
  },
};

export const viewport: Viewport = {
  themeColor: "#b6f425",
  width: "device-width",
  initialScale: 1,
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
