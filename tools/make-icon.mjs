/**
 * Generates the home-screen icon: a low-poly 3/4-view taxi on the game's purple, matching the
 * palette in src/palette.js so the icon reads as the same visual family as the game itself.
 *
 * Not part of `npm run check` — the icon is a build artefact you regenerate when the design
 * changes, then commit `public/apple-touch-icon.png` (and its .svg source) alongside the code.
 *
 *   node tools/make-icon.mjs        # writes public/apple-touch-icon.svg + .png (180) + -512.png
 *
 * The SVG is authored analytically rather than screenshotting the game mesh: at 180px, per-face
 * flat shading with hand-picked bright/mid/dark tones survives the resample better than
 * MeshLambert output baked through WebGL and downscaled.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ----- Design constants (mirrors src/palette.js taxi entries) -----
const BG        = '#A46BFF';   // fareColors[2] — a purple that is already game canon
const BODY_TOP  = '#FCD658';   // taxiBody lit from above
const BODY_X    = '#F5C130';   // taxiBody, base tone (front face)
const BODY_Z    = '#D9A81E';   // taxiBody in shadow (near side)
const GLASS_TOP = '#3E4650';
const GLASS_X   = '#2E3640';   // carGlass
const GLASS_Z   = '#242A34';
const SIGN_TOP  = '#F2F0E8';   // taxiSign
const SIGN_X    = '#D6D3C6';
const SIGN_Z    = '#C0BDB0';
const CHECKER   = '#2B2B30';   // taxiTrim
const TIRE      = '#141419';
const HUB       = '#3A3D45';

// ----- Geometry (world units — same numbers as src/geometry/taxi.js) -----
const CAR_LEN = 3.4;
const CAR_W   = 1.7;
const BODY_Y0 = 0.38, BODY_Y1 = 1.18;
const CABIN_L = CAR_LEN * 0.5, CABIN_W = CAR_W * 0.86, CABIN_CX = -0.2;
const CABIN_Y0 = 1.15, CABIN_Y1 = 1.75;
const SIGN_X0 = -0.475, SIGN_X1 = 0.275, SIGN_Y0 = 1.75, SIGN_Y1 = 2.09, SIGN_Z0 = -0.2, SIGN_Z1 = 0.2;
const WHEEL_R = 0.32;

// ----- Iso projection (30° / 30°). +x maps to right-down, +z to left-down, +y up.
// Camera is on the +x, +y, +z octant so the top, +x front, and +z side faces are visible.
const SIZE = 512;
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const U   = 66;

// Projection origin picked after eyeballing the bounding box below; see FIT comment.
const OX = SIZE / 2 - 6;
const OY = SIZE * 0.58;

const project = (x, y, z) => [
  OX + (x - z) * COS * U,
  OY + (x + z) * SIN * U - y * U,
];

const fmt = (n) => n.toFixed(1);
const poly = (pts) => pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');

// ----- Draw a box: emit the three iso-visible faces. Order is bottom-up in paint order:
// top, +x-face (front), +z-face (near side) — none of these three overlap each other. Draw the
// next object (cabin, sign) after the previous box entirely so painter's order is correct.
function boxFaces(x0, x1, y0, y1, z0, z1, cTop, cFront, cSide) {
  const p = (X, Y, Z) => project(X, Y, Z);
  return [
    { pts: [p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)], fill: cTop },
    { pts: [p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)], fill: cFront },
    { pts: [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], fill: cSide },
  ];
}

// ----- Wheel disc: cylinder axle along z, so the visible face is a circle in the x-y plane at
// z = wheel front. Sample it as a 22-gon and project each vertex — under iso that yields the
// correct ellipse without an SVG transform matrix.
function wheelDisc(cx, cy, cz, r, segments = 22) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(project(cx + r * Math.cos(a), cy + r * Math.sin(a), cz));
  }
  return pts;
}

// ----- Compose the taxi -----
const layers = [];

// 1. Body
layers.push(...boxFaces(-CAR_LEN / 2, CAR_LEN / 2, BODY_Y0, BODY_Y1, -CAR_W / 2, CAR_W / 2,
                        BODY_TOP, BODY_X, BODY_Z));

// 2. Checker stripe on the near (+z) side of the body. Six equal cells (3 dark, 3 body-yellow) —
// enough to read as "chequer" at 180px without moiré. The stripe sits just proud of the body face
// so it draws cleanly over it.
{
  const stripeZ = CAR_W / 2 + 0.005;
  const stripeY0 = 0.71, stripeY1 = 0.93;
  const stripeL = CAR_LEN * 0.82;
  const cells = 6;
  const step = stripeL / cells;
  const startX = -stripeL / 2;
  for (let i = 0; i < cells; i++) {
    if (i % 2 !== 0) continue;   // paint dark cells only; the gap shows the yellow body
    const x0 = startX + i * step;
    const x1 = x0 + step;
    layers.push({
      pts: [project(x0, stripeY0, stripeZ), project(x1, stripeY0, stripeZ),
            project(x1, stripeY1, stripeZ), project(x0, stripeY1, stripeZ)],
      fill: CHECKER,
    });
  }
}

// 3. Wheels: near side only. Nudge the disc a hair past the body's +z face (0.85) so the tire
// sits in front of the sill and reads as a wheel rather than a decal.
{
  const wz = CAR_W / 2 + 0.02;
  for (const wx of [-CAR_LEN * 0.3, CAR_LEN * 0.3]) {
    layers.push({ pts: wheelDisc(wx, WHEEL_R, wz, WHEEL_R),        fill: TIRE });
    layers.push({ pts: wheelDisc(wx, WHEEL_R, wz + 0.001, WHEEL_R * 0.42), fill: HUB });
  }
}

// 4. Cabin
layers.push(...boxFaces(CABIN_CX - CABIN_L / 2, CABIN_CX + CABIN_L / 2,
                        CABIN_Y0, CABIN_Y1,
                        -CABIN_W / 2, CABIN_W / 2,
                        GLASS_TOP, GLASS_X, GLASS_Z));

// 5. Roof sign
layers.push(...boxFaces(SIGN_X0, SIGN_X1, SIGN_Y0, SIGN_Y1, SIGN_Z0, SIGN_Z1,
                        SIGN_TOP, SIGN_X, SIGN_Z));

// FIT check — dump the projected bounding box so a future tweak can re-center by tweaking OX/OY/U.
if (process.env.DEBUG_ICON) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) for (const [x, y] of l.pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  console.log(`bounds x[${minX.toFixed(1)}, ${maxX.toFixed(1)}] y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
}

// ----- Emit SVG -----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
  <g shape-rendering="geometricPrecision">
${layers.map((l) => `    <polygon points="${poly(l.pts)}" fill="${l.fill}"/>`).join('\n')}
  </g>
</svg>
`;

const outDir = path.resolve('public');
await mkdir(outDir, { recursive: true });
const svgPath = path.join(outDir, 'apple-touch-icon.svg');
await writeFile(svgPath, svg);
console.log(`wrote ${svgPath}`);

// ----- Rasterize to PNGs via headless Chromium -----
// iOS wants a PNG for apple-touch-icon; we also ship a 512px variant so browsers that pick a
// larger icon (Android home-screen, PWA) get a clean source rather than upscaling 180.
async function rasterize(out, size) {
  // Prefer an absolute path if present (Playwright-managed Chromium under /opt/pw-browsers on
  // web sessions), fall back to PATH lookups for local developer machines.
  const candidates = [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    'chromium', 'chromium-browser', 'google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const bin = candidates.find((c) => !c.startsWith('/') || existsSync(c));
  if (!bin) throw new Error('no chromium binary found');

  // Pointing chromium at the raw SVG makes it screenshot at the viewBox's intrinsic size
  // (512×512) regardless of --window-size, and referencing the SVG via <img src="file:…"> in a
  // shell races the screenshot against the image load — small windows land a partial capture
  // whose background is chromium's default (white) rather than the SVG's purple. The
  // combination that actually renders is: inline the SVG into the shell (no external load
  // needed), size html/body to the target and paint the fallback background purple, and give
  // chromium a virtual time budget so layout is done before capture.
  const inlineSvg = svg
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`);
  const shell = path.join(tmpdir(), `sim-taxi-icon-${size}.html`);
  await writeFile(shell,
`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${size},height=${size},initial-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;overflow:hidden;width:${size}px;height:${size}px;background:${BG};}
svg{display:block;}</style>
</head><body>${inlineSvg}</body></html>`);

  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    `--screenshot=${out}`,
    `--window-size=${size},${size}`,
    `--force-device-scale-factor=1`,
    `--virtual-time-budget=3000`,
    `--default-background-color=00000000`,
    `file://${shell}`,
  ];
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`chromium exit ${code}`)));
      proc.on('error', reject);
    });
    console.log(`wrote ${out} (${size}×${size})`);
  } finally {
    if (!process.env.KEEP_ICON_SCRATCH) await unlink(shell).catch(() => {});
  }
}

try {
  await rasterize(path.join(outDir, 'apple-touch-icon.png'), 180);
  await rasterize(path.join(outDir, 'apple-touch-icon-512.png'), 512);
} catch (err) {
  console.error(`rasterize failed: ${err.message}`);
  console.error('The SVG was written; you can convert to PNG by other means if needed.');
  process.exit(1);
}
