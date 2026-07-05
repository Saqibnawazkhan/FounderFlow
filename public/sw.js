/*
 * FounderFlow service worker — minimal, hand-rolled.
 *
 * Strategy:
 *   • Install: precache the shell (offline page, manifest, icon)
 *   • Fetch:
 *       - POST / non-GET     → pass through (NEVER cache mutations or auth)
 *       - /api/* requests    → pass through (cookies, Server Actions, etc.)
 *       - Same-origin GET    → stale-while-revalidate, cache successful 200s
 *       - Cross-origin       → pass through (fonts.googleapis.com, etc.)
 *       - Fetch failure on   → return the cached /offline page
 *         document requests
 *
 * Why hand-rolled instead of Workbox/serwist:
 *   • Single file, ~80 lines, no build-time generation
 *   • Auth + Server Actions are very session-sensitive — explicit pass-through
 *     for /api/* + non-GET avoids subtle staleness bugs
 *   • Easy to read in 5 minutes if it ever needs surgery
 *
 * Lifecycle: bumping CACHE_VERSION invalidates the old cache on next install.
 * Update by editing CACHE_VERSION below and redeploying.
 */

// Bumped to v3 when the manifest gained raster PNG icons (S11 / PWA
// installability): the old v2 shell cache still held the SVG-only manifest,
// so returning users would have kept reading it and Chrome would never offer
// install. The version bump forces a fresh install + precache of the new
// manifest and its icons, and the activate handler purges the v2 caches.
const CACHE_VERSION = "ff-v3";
const RUNTIME_CACHE = `ff-runtime-${CACHE_VERSION}`;
const SHELL_CACHE = `ff-shell-${CACHE_VERSION}`;

// Minimal precache — the offline page + the manifest + the icons Chrome needs
// for installability (192 + 512 PNG) plus the SVG icons for crisp rendering.
// The rest of the static asset graph gets cached on demand via stale-while-revalidate.
const SHELL_URLS = [
  "/offline",
  "/manifest.json",
  "/icon.svg",
  "/icon-maskable.svg",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Nuke any old version caches when the SW updates.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.endsWith(CACHE_VERSION))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Pass-through: non-GET, cross-origin, auth/api routes, RSC payloads.
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/data/") ||
    url.search.includes("_rsc=")
  ) {
    return; // browser handles natively
  }

  // Document navigations → network first, fall back to /offline on failure.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("/offline").then((cached) => cached || new Response("Offline", { status: 503 }))
      )
    );
    return;
  }

  // Static assets (chunks, images, fonts hosted on us) → stale-while-revalidate.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const fetchPromise = fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(req, response.clone());
          }
          return response;
        })
        .catch(() => cached); // network failed → cached if we have it
      return cached || fetchPromise;
    })
  );
});
