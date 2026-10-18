/**
 * What a whole frame costs to *draw*, GPU included, one flag set at a time.
 *
 *   CHROME=/opt/pw-browsers/chromium CHROME_FLAGS=--no-sandbox node tools/gpucost.mjs \
 *     [--url http://localhost:5173/] [--dpr 2] [--frames 12] [--flags "ao=off" "msaa=off" ...]
 *
 * Freezes shot 0 at play zoom (`?shot=0&view=0,0,52`), then redraws it `--frames` times, each one
 * closed by a one-pixel `readPixels` so the wall time includes the raster work rather than only its
 * submission. One page load per flag set (MSAA and AO are compiled in); the first row is the
 * baseline. tools/perf.mjs counts what a frame *asks for*; this times what it costs.
 *
 * **SwiftShader is not a phone, in two ways.** It rasterises on the CPU, so the rows are relative
 * costs — fragment work times pixels — and not milliseconds an iPhone will spend; a tile-based GPU
 * makes MSAA and depth-only passes cheaper than this shows. And it **does not skip a branch** that
 * every fragment fails, so it charges a shader for code behind a test that a real GPU never runs:
 * the painterly road path cost a third of the frame here as a uniform `if` (PAINT_KIND in
 * util/geo.js), and a branch-only saving such as the edge fog's early-out reads as nothing at all.
 * Per-pass timing with `gl.finish()` at each framebuffer switch was tried first and attributed the
 * whole frame to the last pass: under ANGLE on SwiftShader, `finish` does not wait for the raster.
 *
 * Written for the 2026-10-18 perf pass. Its first table, at 390×844 DPR 2:
 * msaa=off −23%, painterly=classic −35%, edgefog=classic −17%, shadows=off −13%, shadows=1024 −4%,
 * bloom=off −6%, ao=off −2%, dpr=1 −59%.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9421;
const argv = process.argv.slice(2);
const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : f; };
const BASE = arg('url', 'http://localhost:5173/');
const DPR = Number(arg('dpr', 2));
const FRAMES = Number(arg('frames', 12));
const VIEW = arg('view', '0,0,52');
const fi = argv.indexOf('--flags');
const SETS = ['', ...(fi === -1 ? [] : argv.slice(fi + 1).filter((a) => !a.startsWith('--')))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'taxi-gpu-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=390,844',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ') : []), 'about:blank',
], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const { res, rej } = pending.get(m.id);
  pending.delete(m.id);
  m.error ? rej(new Error(m.error.message)) : res(m.result);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true });

const MEASURE = `(async () => {
  const gl = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    .getContext('webgl2');
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const one = () => { sync(); const t0 = performance.now(); window.__taxi.redraw(); sync(); return performance.now() - t0; };
  for (let i = 0; i < 3; i++) one();
  const runs = []; for (let i = 0; i < ${FRAMES}; i++) runs.push(one());
  runs.sort((x, y) => x - y);
  return { total: runs[runs.length >> 1], canvas: gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight };
})()`;

const rows = [];
for (const flags of SETS) {
  const url = `${BASE}?shot=0&view=${VIEW}${flags ? '&' + flags : ''}`;
  await send('Page.navigate', { url });
  for (let i = 0; i < 240; i++) {
    if (await ev('document.body.dataset.shotReady === "true"').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(4000);
  const r = await ev(MEASURE).catch((e) => ({ error: String(e) }));
  rows.push({ flags: flags || 'baseline', ...r });
  console.log(JSON.stringify({ flags: flags || 'baseline', ...r }));
}
ws.close();
chrome.kill();
const base = rows[0].total;
console.log('\nflags'.padEnd(40) + 'ms/frame  vs base');
for (const r of rows) console.log(`${r.flags.padEnd(39)} ${r.total?.toFixed(1).padStart(7)}  ${((r.total / base - 1) * 100).toFixed(0).padStart(5)}%`);
process.exit(0);
