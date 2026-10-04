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

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

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

// A bare name has to be resolved against PATH, not waved through. The old `!c.startsWith('/')`
// test accepted `chromium` unconditionally, so on a Mac — which has no `chromium` anywhere — the
// list never reached the /Applications entry below it. `spawn` then failed with stdio ignored and
// the only symptom was "chromium never opened its debugging port" 30 seconds later.
const onPath = (name) => spawnSync('/bin/sh', ['-c', `command -v "$1"`, '_', name]).status === 0;
const CHROME_BIN = process.env.CHROME ?? [
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  'chromium', 'chromium-browser', 'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((c) => (c.startsWith('/') ? existsSync(c) : onPath(c)));
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


const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const pageUrl = new URL('/tools/icon/', server.resolvedUrls.local[0]).href;

const profile = await mkdtemp(path.join(tmpdir(), 'icon-chrome-'));
// WebGL under headless needs SwiftShader, same flags as tools/shoot.mjs.
const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-sandbox', '--hide-scrollbars', '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); up = true; break; } catch { await sleep(150); }
  }
  if (!up) throw new Error('chromium never opened its debugging port');

  const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: pageUrl });

  // Wait for the page to say it has drawn, and surface a thrown error rather than timing out on it.
  const readyBy = Date.now() + 120000;
  for (;;) {
    const state = await evaluate(`document.body?.dataset.iconReady ?? (window.__iconError ?? null)`).catch(() => null);
    if (state === '1') break;
    if (state) throw new Error(state);
    if (Date.now() > readyBy) throw new Error('the icon page never finished drawing');
    await sleep(250);
  }

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
  cdp.close();
} catch (err) {
  console.error(`make-icon failed: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
  await server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
