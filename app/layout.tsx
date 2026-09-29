import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Playfair_Display } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { appOrigin } from "@/lib/env";

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
  // `appOrigin()` is the one decision for the public origin (prodready-004).
  //
  // Be precise about what this changed, because the honest answer is "less than
  // it looks" and the overclaim would be worse than the bug. WHATWG `new URL()`
  // normalises an empty path to "/", so for a bare origin
  // `new URL("https://host/")` and `new URL("https://host")` are the SAME
  // metadataBase: every canonical and og:url tag this app emits is byte-identical
  // before and after. Next resolves the relative `"/"` values in this file and in
  // app/page.tsx via `path.posix.join(metadataBase.pathname, url)` and then
  // collapses a "/" pathname back to the bare origin
  // (next/dist/lib/metadata/resolvers/resolve-url.js), so the doubled slash that
  // the e-mail call sites suffered never reached a meta tag.
  //
  // What it does change:
  //   - A reverse-proxied sub-path origin (`https://host/app/`) produced a
  //     canonical of `https://host/app/` while every e-mail link and sitemap
  //     entry said `https://host/app`. Those now agree.
  //   - `?? ` let an EMPTY NEXT_PUBLIC_APP_URL through to `new URL("")`, which
  //     throws `TypeError: Invalid URL` from the root layout — i.e. every page in
  //     the app 500s, on a build that went green. Importing lib/env moves that
  //     failure to the build, with the variable named.
  //   - The root layout is on every route, so lib/env's production assertion
  //     (a loopback origin on a production deploy) now covers the whole app
  //     rather than only /robots.txt and /sitemap.xml.
  metadataBase: new URL(appOrigin()),
  title: {
    default: "FounderFlow — Co-Founder Company Management",
    template: "%s · FounderFlow",
  },
  description:
    "Manage and track every part of your startup in one place. Built for co-founders to align on finances, tasks, and momentum.",
  keywords: ["startup", "co-founder", "management", "expense tracker", "task management"],
  manifest: "/manifest.json",
  applicationName: "FounderFlow",
  // Explicit icon set, and deliberately NO `app/icon.svg`.
  //
  // In the App Router a file at `app/icon.svg` IS the route `/icon.svg`, and
  // `public/icon.svg` claims that same URL. Next resolved the collision by
  // serving an error page, so `/icon.svg` 500'd on every page load. That was
  // not cosmetic: `public/sw.js` precaches `/icon.svg` via `cache.addAll`,
  // which rejects atomically on any non-2xx, so the install handler never
  // settled and the entire offline / PWA layer silently never came up.
  //
  // The `public/` copy is the one that survives, because deleting the `app/`
  // one costs nothing: Next only falls back to the file-based icon convention
  // when this `icons` block is absent (next/dist/lib/metadata/resolve-metadata
  // -> `hasIconsProperty`). With `icon` spelled out below, `app/icon.svg` was
  // already emitting zero <link> tags — it was pure collision. Meanwhile every
  // literal reference wants a plain static file at that URL: `manifest.json`,
  // the SW precache, and the auth allowlists in `auth.config.ts` +
  // `middleware.ts`.
  //
  // Recorded here because manifest.json cannot carry a comment: both SVG
  // entries there declare `"sizes": "512x512"`, not `"any"`. These files are
  // base64 PNGs inside an <svg> wrapper, not traced vectors, so `"any"` would
  // promise resolution independence the asset does not have and invite Chrome
  // to upscale a raster into the install splash screen.
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
  themeColor: "#1F2933",
  width: "device-width",
  initialScale: 1,
  // Disable user-zoom only on installed PWA — feels app-like, not webby.
  // Browser still allows zoom on the regular browser visit.
  viewportFit: "cover",
};

/**
 * Sync shell bootstrap — runs in <head> before first paint so we don't flash
 * the wrong theme OR the wrong text direction. Reads the persisted Zustand
 * snapshot from localStorage and applies the `dark` class, `lang` and `dir` to
 * <html> immediately. Falls back to dark + en/ltr (the store's initial state)
 * when storage is empty or unavailable.
 *
 * Why `dir` belongs here and not only in Providers (audit S20): locale lives in
 * the client store, so the server cannot know it and renders `dir="ltr"`. The
 * Providers effect that syncs `dir` runs AFTER hydration, which meant an Urdu
 * user got a full left-to-right first paint on every single page load and then
 * watched the entire shell jump to the other side once React woke up. Mirroring
 * the sidebar (below) would have made that flash far more violent, not less.
 * Setting it pre-paint is the same trick the theme already relied on.
 *
 * `LOCALES`, `RTL_LOCALES` and `PARTIAL_LOCALES` are duplicated from
 * lib/i18n/strings.ts (SUPPORTED_LOCALES and LOCALE_TRANSLATION_STATUS) because
 * an inline <head> script cannot import. tests/lib/layout/rtl.test.ts parses the
 * RTL literal out of the source, tests/app/shell/prepaint-locale.test.tsx parses
 * LOCALES and tests/lib/i18n/document-language.test.ts parses PARTIAL_LOCALES,
 * so adding a third locale can't silently leave the pre-paint path behind.
 *
 * ── `dir` AND `lang` ARE TWO DECISIONS, NOT ONE (i18n-001) ─────────────────
 *
 * `dir` follows the locale outright: an Urdu user's shell really is Urdu and has
 * to mirror. `lang` follows the document's PREDOMINANT language, which is still
 * English — 559 English literals across 56 files are untranslated — because
 * lang="ur" makes NVDA/JAWS/VoiceOver apply Urdu grapheme-to-phoneme rules to
 * the whole document AND suppress their own per-utterance script detection, so
 * the English majority becomes noise. `documentLangForLocale` in
 * lib/i18n/strings.ts is the canonical form of this rule and
 * components/providers.tsx applies it post-hydration; PARTIAL_LOCALES below is
 * the same rule pre-paint, so a screen reader reading the document before
 * hydration — or a session where hydration never completes — gets the same
 * answer instead of a stale lang="ur".
 *
 * A consequence worth stating: for a partial locale `lang` now never changes
 * from the server's `lang="en"` at all, so this script rewrites only `dir`. That
 * REMOVES one of the two attribute mismatches `suppressHydrationWarning` was
 * covering rather than adding one.
 *
 * ── WHY IT ALSO READS A COOKIE (i18n-002) ─────────────────────────────────
 *
 * Reading only localStorage made this script useless in exactly the case its
 * own comment above describes. A new phone, a private window or cleared site
 * data has no persisted snapshot, so it fell through to en/ltr, and
 * components/layout/preference-hydrator.tsx then learned the real locale from
 * the user's row — after hydration, after a server round-trip — and flipped the
 * whole document. The durable value lives on `User.locale`, so on a first visit
 * the locale is only knowable SERVER-SIDE, from the session.
 *
 * It does not follow that the ROOT LAYOUT should resolve it server-side. <html>
 * is rendered here and nowhere else, and this is the single root layout for
 * every route including `/`; calling `cookies()` or `auth()` in it opts the
 * whole app out of static generation, marketing page included, which is a large
 * permanent cost for one attribute. The split that avoids it: the value is
 * PRODUCED server-side (written as a cookie when the session is created, from
 * `User.locale` / `User.theme`) and CONSUMED here, pre-paint, where the
 * attributes are already decided. Same guarantee, no rendering cost.
 *
 * `ff_locale` / `ff_theme` are deliberately NOT HttpOnly — this script has to
 * read them — which is also why the value is validated against LOCALES rather
 * than written onto <html> as-is. They carry a UI language and a colour scheme,
 * no identity and no secret.
 *
 * Storage wins over the cookie when both are present. The reverse would match
 * what PreferenceHydrator does after hydration, but it would make a language
 * toggle in THIS browser repaint in the old language on the next load for as
 * long as the cookie lagged — a regression on a path that works today. With
 * storage-first, a browser that has a preference behaves exactly as before and
 * the only case that changes is the empty one, which is the bug.
 *
 * The JSON.parse now sits in its own try: a corrupt storage entry used to throw
 * out of the whole function, leaving `lang` and `dir` UNSET rather than falling
 * back to anything.
 */
const shellBootstrap = `
(function () {
  function readCookie(name) {
    try {
      var all = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < all.length; i++) {
        var pair = all[i];
        var eq = pair.indexOf('=');
        if (eq < 1) continue;
        if (pair.slice(0, eq).trim() === name) return decodeURIComponent(pair.slice(eq + 1));
      }
    } catch (e) {}
    return null;
  }

  var theme = null;
  var locale = null;
  try {
    var raw = localStorage.getItem('founderflow-storage');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.state) {
        if (parsed.state.theme) theme = parsed.state.theme;
        if (parsed.state.locale) locale = parsed.state.locale;
      }
    }
  } catch (e) {}

  if (!theme) theme = readCookie('ff_theme');
  if (!locale) locale = readCookie('ff_locale');

  var LOCALES = ['en', 'ur'];
  var RTL_LOCALES = ['ur'];
  // i18n-001: dir follows the locale, lang follows the document's PREDOMINANT
  // language. PARTIAL_LOCALES mirrors LOCALE_TRANSLATION_STATUS in
  // lib/i18n/strings.ts (an inline head script cannot import) and a locale
  // listed here keeps lang="en", because most of the product is still English
  // and Urdu phonemes over English text are unintelligible. No backticks in
  // this string, ever: it is a template literal, and one closes it.
  var PARTIAL_LOCALES = ['ur'];
  if (LOCALES.indexOf(locale) === -1) locale = 'en';
  // Same coercion as getMyAppearanceAction: anything that is not 'light' is
  // dark, which is the store's initial state.
  if (theme !== 'light') theme = 'dark';

  try {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    document.documentElement.lang = PARTIAL_LOCALES.indexOf(locale) !== -1 ? 'en' : locale;
    document.documentElement.dir = RTL_LOCALES.indexOf(locale) !== -1 ? 'rtl' : 'ltr';
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* `dir` is explicit so the server HTML is never direction-ambiguous. Both
       it and `lang` are rewritten pre-paint by shellBootstrap when the stored
       locale is RTL; `suppressHydrationWarning` — already here for the theme
       class — covers the resulting attribute mismatch on this element. */
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      className={`${inter.variable} ${mono.variable} ${serif.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: shellBootstrap }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        {/* Skip-to-content: hidden until keyboard-focused, then jumps past
            the sidebar + topbar chrome.
            This comment used to claim "Every /main is tagged with id=\"main\" by
            the app-shell layout so this lands somewhere useful". That was true of
            the app shell and false of everything else (a11y-008): this link is in
            the ROOT layout, so it also renders on /, /login, /signup,
            /forgot-password, /reset-password, /verify-email,
            /verify-email-change, /invite/[token], /offline, /not-found and the
            error boundaries — and `id="main"` existed in exactly one file, so on
            all of those `document.getElementById("main")` was null and activating
            the link moved no focus at all. It only appended `#main` to the URL,
            which is invisible to sighted QA because the link itself does focus.
            Every route this agent owns now renders `<main id="main" tabIndex={-1}>`;
            tests/app/shell/skip-link-target.test.tsx renders each of them and
            performs the same getElementById the browser does, and sweeps app/ so
            a new route cannot ship without a target. */}
        <a
          href="#main"
          className="sr-only rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-fg focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-modal"
        >
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
