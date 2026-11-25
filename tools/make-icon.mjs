/**
 * Generates every icon the game ships: the iOS Home Screen icon, the manifest's, the tab favicons
 * and the App Store icon.
 *
 * The picture is rendered **in the engine** by `tools/icon/` — the real taxi mesh with the real
 * paint, glass and chrome finishes, lit by the game's sun — so when the car changes, re-running
 * this is the whole job. This script only serves that page through Vite's dev server, drives a
 * headless Chromium at it, and screenshots each size it lays out.
 *
 * Not part of `npm run check` — the icons are build artefacts you regenerate when the car's look
 * changes, then commit. Bump `CACHE_NAME` in `public/sw.js` alongside them: the icons are
 * unhashed and cache-first, so without it an installed copy keeps the old one.
 *
 *   node tools/make-icon.mjs
 *
 * Writes public/apple-touch-icon.png (180), public/icon-192.png, public/apple-touch-icon-512.png,
 * public/favicon-16.png, public/favicon-32.png and the asset catalogue's AppIcon-1024.png.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withIconPage } from './icon/page.mjs';

const outDir = path.resolve('public');
// The App Store icon does not belong in `public/` — it is a build input for Xcode, not a file the
// web bundle should be shipping a megabyte of. It goes straight into the asset catalogue instead.
const iosIconDir = path.resolve('ios/SimTaxi/Assets.xcassets/AppIcon.appiconset');

// Size → file. The App Store icon is one file for every slot since Xcode 14 — a single-size
// AppIcon.appiconset the toolchain downscales for the home screen, Settings and Spotlight. Two
// Apple rules it has to keep: **fully opaque** (App Store Connect rejects any alpha channel, which
// is why these are screenshots — see tools/icon/icon.js) and **square corners** (iOS applies its
// own superellipse mask; pre-rounded artwork shows double-rounded). The purple border the car sits
// in is sized for that mask to crop into.
const OUTPUTS = [
  [1024, path.join(iosIconDir, 'AppIcon-1024.png')],
  [512, path.join(outDir, 'apple-touch-icon-512.png')],
  [192, path.join(outDir, 'icon-192.png')],
  [180, path.join(outDir, 'apple-touch-icon.png')],
  [32, path.join(outDir, 'favicon-32.png')],
  [16, path.join(outDir, 'favicon-16.png')],
];

// `ICON_QUERY=?bg=flat node tools/make-icon.mjs` hands the page a query string (see tools/icon/icon.js).
const exitCode = await withIconPage(`/tools/icon/${process.env.ICON_QUERY ?? ''}`, async ({ cdp, evaluate }) => {
  await mkdir(outDir, { recursive: true });
  await mkdir(iosIconDir, { recursive: true });
  for (const [size, out] of OUTPUTS) {
    await evaluate(`window.__showIcon(${size}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    });
    await writeFile(out, Buffer.from(data, 'base64'));
    console.log(`wrote ${path.relative(process.cwd(), out)} (${size}×${size})`);
  }
});
process.exit(exitCode);
