/**
 * Display typeface for the marketing surface only.
 *
 * The app shell runs on Inter, which is the correct, invisible choice for
 * dense product UI — but it is also the single most over-used typeface in SaaS
 * marketing, and it makes a landing page read as a template. Outfit carries the
 * headlines instead: geometric, a little more opinionated, and distinct enough
 * that the brand voice is not the browser default.
 *
 * Imported only by `app/page.tsx`, so the extra woff2 ships on `/` and on no
 * other route. Body copy stays Inter — mixing a display face with a neutral
 * text face is the point, not an oversight.
 */

import { Outfit } from "next/font/google";

export const display = Outfit({
  subsets: ["latin"],
  display: "swap",
  weight: ["600", "700"],
  variable: "--font-display",
});
