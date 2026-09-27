// One-off (untracked scratch tooling, like _shot-landing.mjs): regenerate every
// icon/logo asset in public/ + app/ from the supplied brand artwork.
//
// The artwork we were given is a 1774x887 PNG holding two icon tiles side by
// side on a SOLID BLACK sheet (it has no alpha channel at all): a black tile on
// the left, and the EMERALD tile (black "f" mark knocked into an emerald
// rounded square) on the right. We use the right one: it reads on both the
// charcoal dark theme and on white surfaces.
//
// Because the sheet is opaque, we can't just crop it -- an opaque black square
// would show behind the rounded corners. So we rebuild the tile instead:
//   1. find the emerald tile by its colour (bbox of green pixels) and measure
//      the corner radius off the shape itself;
//   2. lift the "f" glyph out as an alpha mask (the glyph is black on emerald,
//      so the green channel ramps 148 -> 0 across the antialiased edges);
//   3. repaint: emerald rounded square + black glyph, with real transparency
//      outside the rounded corners.
// That also lets us normalise the tile to the brand emerald (see EMERALD).
//
// Resizing is done by system Chrome via puppeteer-core (already a devDep) --
// everything is drawn into a <canvas>, progressively halved down to the target
// size for crisp edges, and read back with canvas.toDataURL(). That keeps us
// off sharp/jimp: no new npm dependency. favicon.ico is assembled by hand
// (PNG-payload ICO, which every modern browser accepts).
//
// Usage:  node scripts/_gen-brand-assets.mjs [path-to-source.png]
//         KEEP_ARTWORK_GREEN=1 node scripts/_gen-brand-assets.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Session scratchpad copy of the supplied lockup; override with argv[2] / SRC.
const SRC =
  process.argv[2] ??
  process.env.SRC ??
  "C:/Users/USER/AppData/Local/Temp/claude/c--Users-USER-FounderFlow/a350ed98-2437-4633-a2cf-29400c1d6a28/scratchpad/brand/2-1.png";

const srcDataUrl = `data:image/png;base64,${readFileSync(SRC).toString("base64")}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.goto("data:text/html," + encodeURIComponent("<!doctype html><meta charset=utf-8>"));

const GLYPH = "#000000"; // the supplied mark is pure black, not #1F2933
const info = await page.evaluate(
  async (dataUrl, keepArtworkGreen, glyph) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    const sheet = document.createElement("canvas");
    sheet.width = img.naturalWidth;
    sheet.height = img.naturalHeight;
    const sx = sheet.getContext("2d", { willReadFrequently: true });
    sx.drawImage(img, 0, 0);
    const D = sx.getImageData(0, 0, sheet.width, sheet.height).data;
    const at = (x, y) => (y * sheet.width + x) * 4;
    const isGreen = (i) => D[i + 1] > 80 && D[i + 1] > D[i] + 30 && D[i + 1] > D[i + 2] + 30;

    // 1. Locate the emerald tile in the right-hand half by colour.
    const half = sheet.width >> 1;
    let x0 = sheet.width;
    let y0 = sheet.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < sheet.height; y++) {
      for (let x = half; x < sheet.width; x++) {
        if (isGreen(at(x, y))) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);

    // 2. Corner radius = the first row whose left edge has reached the bbox side.
    let radius = 0;
    for (let y = y0; y < y0 + side / 2; y++) {
      let left = -1;
      for (let x = x0; x <= x1; x++) {
        if (isGreen(at(x, y))) {
          left = x;
          break;
        }
      }
      if (left >= 0 && left <= x0 + 1) {
        radius = y - y0;
        break;
      }
    }

    // 3. Tile background colour, sampled just inside the top edge, mid-width.
    const bgPix = at(x0 + (side >> 1), y0 + Math.round(side * 0.06));
    const artworkGreen =
      "#" +
      [D[bgPix], D[bgPix + 1], D[bgPix + 2]]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    const emerald = keepArtworkGreen ? artworkGreen : "#10B981"; // brand Emerald Green

    // 4. Lift the glyph as an alpha mask: green channel 148 (emerald) -> 0 (mark).
    const bgG = D[bgPix + 1];
    const mask = document.createElement("canvas");
    mask.width = side;
    mask.height = side;
    const mctx = mask.getContext("2d");
    const mimg = mctx.createImageData(side, side);
    const gr = parseInt(glyph.slice(1, 3), 16);
    const gg = parseInt(glyph.slice(3, 5), 16);
    const gb = parseInt(glyph.slice(5, 7), 16);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const s = at(x0 + x, y0 + y);
        const o = (y * side + x) * 4;
        mimg.data[o] = gr;
        mimg.data[o + 1] = gg;
        mimg.data[o + 2] = gb;
        mimg.data[o + 3] = Math.max(0, Math.min(255, Math.round((255 * (bgG - D[s + 1])) / bgG)));
      }
    }
    mctx.putImageData(mimg, 0, 0);

    // 5. Repaint the tile at full resolution with transparent corners. The glyph
    //    is clipped well inside the rounded square so neither the sheet's black
    //    background nor the tile edge's black->green antialiasing (both of which
    //    the mask reads as "glyph") can leak in as a dark rim. The mark itself
    //    sits ~20% in from the edge, so a 2% inset costs us nothing.
    const tile = document.createElement("canvas");
    tile.width = side;
    tile.height = side;
    const tctx = tile.getContext("2d");
    tctx.beginPath();
    tctx.roundRect(0, 0, side, side, radius);
    tctx.fillStyle = emerald;
    tctx.fill();
    const pad = Math.round(side * 0.02);
    tctx.save();
    tctx.beginPath();
    tctx.roundRect(pad, pad, side - pad * 2, side - pad * 2, Math.max(0, radius - pad));
    tctx.clip();
    tctx.drawImage(mask, 0, 0);
    tctx.restore();
    window.__tile = tile;

    // 6. Progressive-halving resize -> PNG data URL. `bg` (apple-touch only)
    //    fills the rounded-off corners so the icon is fully opaque.
    window.__render = (size, bg) => {
      let cur = tile;
      while (cur.width / 2 > size) {
        const next = document.createElement("canvas");
        next.width = Math.max(1, Math.round(cur.width / 2));
        next.height = next.width;
        const nctx = next.getContext("2d");
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = "high";
        nctx.drawImage(cur, 0, 0, next.width, next.height);
        cur = next;
      }
      const out = document.createElement("canvas");
      out.width = size;
      out.height = size;
      const octx = out.getContext("2d");
      if (bg) {
        octx.fillStyle = bg;
        octx.fillRect(0, 0, size, size);
      }
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(cur, 0, 0, size, size);
      return out.toDataURL("image/png");
    };

    return { x0, y0, side, radius, artworkGreen, emerald };
  },
  srcDataUrl,
  process.env.KEEP_ARTWORK_GREEN === "1",
  GLYPH,
);

const EMERALD = info.emerald;
console.log(
  `${path.basename(SRC)} -> tile ${info.side}px at (${info.x0},${info.y0}), r=${info.radius}, ` +
    `artwork green ${info.artworkGreen} -> ${EMERALD}, glyph ${GLYPH}`,
);

/** Render the tile at `size` px; `bg` fills the rounded-off corners. */
const render = async (size, bg = null) => {
  const url = await page.evaluate((s, b) => window.__render(s, b), size, bg);
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
};

/** Pure-Node ICO: 6-byte header, 16-byte dir entry per image, then PNG payloads. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette colours
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

const written = [];
const write = (rel, buf) => {
  writeFileSync(path.join(ROOT, rel), buf);
  written.push([rel, buf.length]);
};

// --- raster icons -----------------------------------------------------------
write("public/android-chrome-512x512.png", await render(512));
write("public/android-chrome-192x192.png", await render(192));
write("public/apple-touch-icon.png", await render(180, EMERALD)); // opaque: iOS ignores alpha
write("public/brand-mark.png", await render(96));
write("public/brand-mark@2x.png", await render(192));

// --- favicon.ico (16 / 32 / 48) ---------------------------------------------
const ico = [];
for (const size of [16, 32, 48]) ico.push({ size, buf: await render(size) });
write("public/favicon.ico", buildIco(ico));

// --- vector wrappers --------------------------------------------------------
// The supplied artwork is raster, so these "SVG" icons embed the mark as a
// base64 PNG rather than a traced path. It has to be an inline data: URI -- an
// SVG used as a favicon/app icon can't fetch an external href.
//
// HONEST ABOUT THE UPSCALE. This comment used to claim "the PNG is rendered at
// exactly the size the <image> occupies, so nothing is up-scaled". That was
// false: render(256) below goes into an <image> declared 512x512, so the
// shipped mark is a 2x upscale of a 256px raster. Raising it to render(512)
// roughly quadruples a payload that is already ~69KB on every page load, which
// trades a soft edge for a worse one. Both options are bad because the input is
// a raster pretending to be a vector.
//
// The real fix is a hand-authored vector -- the mark is a charcoal stem around
// an emerald counter-form, which is a handful of paths and would be under 1KB
// at any size. That is a design task, not a build-script change, so it is
// recorded rather than bodged. Until then the upscale is stated, not hidden.
const inset = Math.round(512 * 0.1); // 80% safe area => 10% padding per side
const markInner = 512 - inset * 2;

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>FounderFlow</title>
  <!-- Thin wrapper around the raster brand mark (emerald tile, black "f").
       Generated by scripts/_gen-brand-assets.mjs - edit the artwork, not this. -->
  <image x="0" y="0" width="512" height="512" href="data:image/png;base64,${(await render(256)).toString("base64")}"/>
</svg>
`;
// ONE FILE ONLY. Writing this to app/icon.svg as well used to be the cause of
// FaultsAudit N12: in the App Router a file at app/icon.svg IS the route
// /icon.svg, and public/icon.svg is served at that same path -- two owners for
// one URL, and Next answered it with a 500 on every page load. app/layout.tsx
// now points its metadata at the public copy. Do not re-add the second write.
write("public/icon.svg", Buffer.from(iconSvg, "utf8"));

// Maskable: full-bleed emerald (Android's adaptive mask crops the corners) with
// the mark at 80% of the canvas, centred inside the safe area.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>FounderFlow</title>
  <!-- Full-bleed background so Android adaptive-icon masks always paint corner-to-corner. -->
  <rect width="512" height="512" fill="${EMERALD}"/>
  <!-- Mark at 80%, centred in the recommended safe zone. Generated by scripts/_gen-brand-assets.mjs. -->
  <image x="${inset}" y="${inset}" width="${markInner}" height="${markInner}" href="data:image/png;base64,${(await render(markInner)).toString("base64")}"/>
</svg>
`;
write("public/icon-maskable.svg", Buffer.from(maskableSvg, "utf8"));

await browser.close();
for (const [rel, bytes] of written) console.log(`${String(bytes).padStart(8)}  ${rel}`);
