/**
 * Full-bleed wrapper for /chat.
 *
 * WHY THIS EXISTS: the app shell's <main> pads every page (`p-4 md:p-6
 * lg:p-8`) because ordinary pages are documents. Chat is a *surface* — a
 * channel rail and a message list that own their own edges, with a composer
 * flush to the bottom of the viewport. Rather than strip the padding from
 * <main> (which would reflow all 14 other routes), this layout cancels it
 * locally with matching negative margins.
 *
 * The height is `100% + 2 × padding`, not `h-full`: negative margins pull the
 * box over <main>'s padding but don't grow it, so plain `h-full` would leave
 * a gap the height of one padding step at the bottom. The three breakpoints
 * mirror `p-4 / md:p-6 / lg:p-8` exactly — change one, change both.
 */

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="-m-4 h-[calc(100%+2rem)] md:-m-6 md:h-[calc(100%+3rem)] lg:-m-8 lg:h-[calc(100%+4rem)]">
      {children}
    </div>
  );
}
