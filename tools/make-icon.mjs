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
const BG        = '#A46BFF';   // a purple that is already game canon
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
const LIFT = 0.32;                          // CHASSIS_LIFT in src/geometry/wheels.js
const BODY_Y0 = 0.38 + LIFT, BODY_Y1 = 1.18 + LIFT;
const CABIN_L = CAR_LEN * 0.5, CABIN_W = CAR_W * 0.86, CABIN_CX = -0.2;
const CABIN_Y0 = 1.15 + LIFT, CABIN_Y1 = 1.75 + LIFT;
const SIGN_X0 = -0.475, SIGN_X1 = 0.275, SIGN_Y0 = 1.75 + LIFT, SIGN_Y1 = 2.09 + LIFT, SIGN_Z0 = -0.2, SIGN_Z1 = 0.2;
const WHEEL_R = 0.64;

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
  const stripeY0 = 0.71 + LIFT, stripeY1 = 0.93 + LIFT;
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

// ----- Rasterize to PNGs via headless Chromium over CDP -----
// One chromium instance, many targets. Chromium's `--screenshot` flag misbehaves at small window
// sizes (16/32) — it clamps the viewport to a minimum and captures a blank frame — so we drive
// it explicitly with Emulation.setDeviceMetricsOverride, same pattern as tools/shoot.mjs.

const CHROME_BIN = [
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  'chromium', 'chromium-browser', 'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((c) => !c.startsWith('/') || existsSync(c));
if (!CHROME_BIN) throw new Error('no chromium binary found');

const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function fetchJson(pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { method });
  return JSON.parse(await res.text());
}

// One shared shell page: the SVG scales to whatever viewport CDP dials up, so we don't need a
// per-size HTML file. `preserveAspectRatio` guarantees square output; the fallback body colour
// covers any subpixel bleed at the borders.
const shell = path.join(tmpdir(), `sim-taxi-icon-shell.html`);
const shellSvg = svg
  .replace(/width="\d+"/, `width="100%"`)
  .replace(/height="\d+"/, `height="100%"`)
  .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" ');
await writeFile(shell,
`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;background:${BG};}
svg{display:block;width:100%;height:100%;}</style>
</head><body>${shellSvg}</body></html>`);

const profile = await (await import('node:fs/promises')).mkdtemp(path.join(tmpdir(), 'icon-chrome-'));
const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
  '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  // Wait for the debugging endpoint to come up rather than sleeping a fixed amount.
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); up = true; break; } catch { await sleep(150); }
  }
  if (!up) throw new Error('chromium never opened its debugging port');

  async function rasterize(out, size) {
    const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    const cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    try {
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size, height: size, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
      await cdp.send('Page.navigate', { url: `file://${shell}` });
      // A short settle after loadEventFired is enough — no image loads, just inline SVG.
      await new Promise((resolve) => {
        const done = () => resolve();
        cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
        const t = setTimeout(done, 2000);
        cdp.send('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
          .then(() => { clearTimeout(t); done(); });
      });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(out, Buffer.from(data, 'base64'));
      console.log(`wrote ${out} (${size}×${size})`);
    } finally {
      cdp.close();
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`).catch(() => {});
    }
  }

  // apple-touch-icon: iOS home screen (180 is the current standard).
  await rasterize(path.join(outDir, 'apple-touch-icon.png'), 180);
  // Larger source for Android home-screen / PWA installs.
  await rasterize(path.join(outDir, 'apple-touch-icon-512.png'), 512);
  // Tab favicons. Two sizes because the browser picks whichever is closer to its target rather
  // than downscaling one big source — 16 for the tab, 32 for retina and the bookmarks list.
  await rasterize(path.join(outDir, 'favicon-16.png'), 16);
  await rasterize(path.join(outDir, 'favicon-32.png'), 32);
} catch (err) {
  console.error(`rasterize failed: ${err.message}`);
  console.error('The SVG was written; you can convert to PNG by other means if needed.');
  exitCode = 1;
} finally {
  chrome.kill();
  if (!process.env.KEEP_ICON_SCRATCH) await unlink(shell).catch(() => {});
  await (await import('node:fs/promises')).rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
