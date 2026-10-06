/**
 * What a frame costs: GL work per render pass, and the frame loop's own JavaScript.
 *
 *   CHROME=/path/to/chrome node tools/perf.mjs --url http://localhost:5173/ --seconds 15
 *
 * Boots the game at a phone's viewport with 22 cars (`?title=off&debug&cars=22` unless `--url`
 * already carries a query), waits for the opening to hand the taxi over, keeps it routed to fares,
 * and reports over `--seconds` of play:
 *
 *   - **per frame** — draw calls, triangles, program switches, uniform calls, buffer bytes
 *     uploaded, each as a median and a p95;
 *   - **per pass** — the same draws split by framebuffer and viewport, which is how the shadow
 *     map (2048²), the AO prepass and the bloom (half res) and the main render tell themselves
 *     apart;
 *   - **JS per frame** — a CPU profile with every native WebGL call taken out, so what is left is
 *     the game plus three's own bookkeeping, inclusive by function.
 *
 * **Counts are exact on any GPU; times are not.** Headless runs on SwiftShader, which rasterises
 * in software and stalls the GL calls that wait on it, so wall-clock frame times here are
 * meaningless — that is why the profile drops native GL frames, and why `--small` (the default:
 * DPR 1, `?shadows=256&msaa=off&dpr=1`) shrinks the raster work enough for frames to arrive at
 * all. Draw calls and three's per-draw JS do not depend on resolution. For the GPU side, load
 * `?diag` on a phone and bisect with `?shadows=1024`, `?ao=off`, `?msaa=off`, `?bloom=off`.
 *
 * Written for the perf pass that found three re-resolving ~100 programs a frame (see
 * `countInEveryPass` in util/geo.js) and 27 empty effect pools still drawing (util/emptypools.js).
 * Point it at the dev server: the minified build has no function names to report.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9420;
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : f; };
const SMALL = arg('small', '1') !== '0';
const base = arg('url', 'http://localhost:5173/');
const url = base.includes('?') ? base
  : `${base}?title=off&debug&cars=22${SMALL ? '&shadows=256&msaa=off&dpr=1' : ''}`;
const SECONDS = Number(arg('seconds', 15));
const TOP = Number(arg('top', 25));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps the GL entry points before the page's first script runs, and closes a frame each time the
// game's own `frame` callback returns.
const INJECT = `(() => {
  const P = window.__perf = { frames: [] };
  const fresh = () => ({ draws: 0, tris: 0, programs: 0, uniforms: 0, uploadBytes: 0, passes: [] });
  P.cur = fresh();
  const pass = () => { const c = P.cur; if (!c.passes.length) c.passes.push({ fb: 'screen', draws: 0, tris: 0 }); return c.passes[c.passes.length - 1]; };
  const tris = (mode, count, n) => (mode === 4 ? count / 3 : mode === 5 ? count - 2 : 0) * (n || 1);
  const draw = (t) => { P.cur.draws++; P.cur.tris += t; const p = pass(); p.draws++; p.tris += t; };
  let fbIds = 0;
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const pr = C.prototype;
    const wrap = (name, fn) => { const o = pr[name]; if (o) pr[name] = function (...a) { fn(...a); return o.apply(this, a); }; };
    wrap('drawElements', (m, c) => draw(tris(m, c)));
    wrap('drawArrays', (m, f, c) => draw(tris(m, c)));
    wrap('drawElementsInstanced', (m, c, t, o, n) => draw(tris(m, c, n)));
    wrap('drawArraysInstanced', (m, f, c, n) => draw(tris(m, c, n)));
    wrap('useProgram', () => { P.cur.programs++; });
    wrap('viewport', (x, y, w, h) => { pass().vp = w + 'x' + h; });
    wrap('bindFramebuffer', (t, fb) => { if (t === 0x8D40 || t === 0x8CA9) P.cur.passes.push({ fb: fb ? (fb.__perfId ??= 'fb' + ++fbIds) : 'screen', draws: 0, tris: 0 }); });
    wrap('bufferSubData', (t, o, d, so, len) => { P.cur.uploadBytes += len ? len * (d.BYTES_PER_ELEMENT || 1) : (d?.byteLength || 0); });
    for (const u of Object.getOwnPropertyNames(pr).filter((k) => k.startsWith('uniform'))) wrap(u, () => { P.cur.uniforms++; });
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    cb(t);
    if (cb.name === 'frame') { P.frames.push(P.cur); P.cur = fresh(); }
  });
})();`;

const dir = await mkdtemp(join(tmpdir(), 'taxi-perf-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=390,844',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: SMALL ? 1 : 3, mobile: true,
});
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
await send('Page.navigate', { url });
for (let i = 0; i < 240; i++) {
  if (await ev('Boolean(window.__taxi?.traffic?.taxi)').catch(() => false)) break;
  await sleep(250);
}
for (let i = 0; i < 120; i++) {
  if (await ev('window.__taxi.traffic.taxi.staged === false')) break;
  await sleep(500);
}
await sleep(1500);

// Keep the taxi on a job, so the frame is the one a player sees rather than an idle city.
const drive = setInterval(() => {
  ev(`(() => { const t = window.__taxi; if (t.traffic.taxi.pendingTarget || !t.fares.state.fares.length) return;
    const p = t.targetScreenPosition(); const c = ${'document.querySelectorAll("canvas")'};
    const game = [...c].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    game.dispatchEvent(new MouseEvent('click', { clientX: p.x, clientY: p.y, bubbles: true })); })()`).catch(() => {});
}, 1500);

await ev('window.__perf.frames.length = 0');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
await sleep(SECONDS * 1000);
const { profile } = await send('Profiler.stop');
clearInterval(drive);
const frames = JSON.parse(await ev('JSON.stringify(window.__perf.frames)'));
ws.close();
chrome.kill();

const sorted = (k) => frames.map((f) => f[k]).sort((a, b) => a - b);
const at = (k, q) => sorted(k)[Math.min(frames.length - 1, Math.floor(frames.length * q))];
console.log(`${url}\n${frames.length} frames in ${SECONDS}s (SwiftShader: counts exact, times not)\n`);
for (const k of ['draws', 'tris', 'programs', 'uniforms', 'uploadBytes']) {
  console.log(`  ${k.padEnd(12)} median ${String(Math.round(at(k, 0.5))).padStart(8)}   p95 ${String(Math.round(at(k, 0.95))).padStart(8)}`);
}
const byPass = new Map();
for (const f of frames) {
  for (const p of f.passes) {
    if (!p.draws) continue;
    const key = `${p.fb} ${p.vp ?? ''}`;
    const row = byPass.get(key) ?? { draws: 0, tris: 0 };
    row.draws += p.draws;
    row.tris += p.tris;
    byPass.set(key, row);
  }
}
console.log('\nper pass, average a frame:');
for (const [key, v] of [...byPass].sort((a, b) => b[1].draws - a[1].draws)) {
  console.log(`  ${key.padEnd(22)} ${(v.draws / frames.length).toFixed(1).padStart(6)} draws ${(v.tris / frames.length / 1000).toFixed(1).padStart(7)}k tris`);
}

// JS per frame, inclusive, with native frames (the GL calls SwiftShader stalls in) left out.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map();
profile.samples.forEach((s, i) => self.set(s, (self.get(s) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const inclusive = new Map();
let js = 0;
for (const [id, us] of self) {
  const cf = byId.get(id).callFrame;
  if (!cf.url && cf.functionName !== '(garbage collector)') continue;
  js += us;
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const c = byId.get(cur).callFrame;
    if (!c.url && c.functionName !== '(garbage collector)') continue;
    const key = `${c.functionName || '(anon)'}  ${c.url.split('/').pop().split('?')[0]}:${c.lineNumber + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inclusive.set(key, (inclusive.get(key) ?? 0) + us);
  }
}
console.log(`\nJS ${(js / 1000 / frames.length).toFixed(2)} ms a frame (incl. GC), inclusive:`);
[...inclusive].sort((a, b) => b[1] - a[1]).slice(0, TOP)
  .forEach(([key, us]) => console.log(`  ${(us / 1000 / frames.length).toFixed(3).padStart(7)} ms  ${key}`));
process.exit(0);
