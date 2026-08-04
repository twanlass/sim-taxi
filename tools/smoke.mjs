/**
 * Browser smoke test. The Node probe covers the simulation's logic far more thoroughly and much
 * faster; this only checks the things that require a real page — that it boots, that the render
 * loop advances the sim, that signals cycle, and that camera controls respond.
 *
 *   node tools/smoke.mjs --url http://localhost:4173
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same overrides as tools/shoot.mjs — see docs/testing.md.
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTRA_FLAGS = process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : [];
const PORT = 9338;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const baseUrl = arg('url', 'http://localhost:4173');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function fetchJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return JSON.parse(await res.text());
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    ready,
    errors,
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

const profile = await mkdtemp(join(tmpdir(), 'taxi-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', ...EXTRA_FLAGS,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,600',
  '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let client;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); break; } catch { await sleep(200); }
  }

  const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: baseUrl });

  const evaluate = async (expression) => {
    const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value;
  };

  const bootDeadline = Date.now() + 120000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    if (await evaluate('Boolean(window.__taxi)')) { booted = true; break; }
    await sleep(300);
  }
  check('game boots', booted);
  if (!booted) throw new Error('never booted');

  check('taxi exists', (await evaluate('Boolean(window.__taxi.traffic.taxi)')));

  // --- Tap the taxi: it should select.
  // Synthetic DOM click rather than CDP's Input domain. Input.dispatchMouseEvent is accepted in
  // this headless configuration but never synthesises a DOM click — the page observes nothing at
  // all — so it silently tests neither the picker nor anything else. This does exercise the real
  // listener, raycast and hit-test path; it just doesn't cover Chrome's OS-level input plumbing.
  const clickAt = async (pt) => {
    await evaluate("(() => { const c = document.querySelector('canvas');"
      + " c.dispatchEvent(new MouseEvent('click', { clientX: " + Math.round(pt.x)
      + ", clientY: " + Math.round(pt.y) + ", bubbles: true, cancelable: true })); })()");
    await sleep(300);
  };

  check('the taxi is always selected', await evaluate('window.__taxi.isSelected()'));

  // Tapping the taxi, or empty ground, must not be able to turn selection off any more.
  await clickAt(JSON.parse(await evaluate('JSON.stringify(window.__taxi.taxiScreenPosition())')));
  await clickAt({ x: 12, y: 12 });
  check('selection cannot be turned off', await evaluate('window.__taxi.isSelected()'));

  // --- Tap the fare marker: it should produce a route.
  const targetPt = JSON.parse(await evaluate('JSON.stringify(window.__taxi.targetScreenPosition())'));
  await clickAt(targetPt);

  const routeLen = await evaluate('window.__taxi.traffic.taxi.route.length');
  const hasTarget = await evaluate('Boolean(window.__taxi.traffic.taxi.pendingTarget)');
  check('tapping the fare routes the taxi', hasTarget, `route ${routeLen} turns`);

  // --- The taxi should be consuming that route as it drives.
  // Poll rather than sample a fixed window: the taxi may be legitimately stopped at a red for
  // several seconds, and under software rendering sim time advances only a fraction of real time.
  const start = JSON.parse(await evaluate(
    'JSON.stringify({x: window.__taxi.traffic.taxi.x, z: window.__taxi.traffic.taxi.z})'));
  let travelled = 0;
  for (let attempt = 0; attempt < 20 && travelled <= 1; attempt++) {
    await sleep(1000);
    const now = JSON.parse(await evaluate(
      'JSON.stringify({x: window.__taxi.traffic.taxi.x, z: window.__taxi.traffic.taxi.z})'));
    travelled = Math.hypot(now.x - start.x, now.z - start.z);
  }
  check('the taxi drives', travelled > 1, `moved ${travelled.toFixed(1)} units`);

  check('signals still hold for the taxi',
    (await evaluate('window.__taxi.traffic.stats.violations')) === 0);

  // --- Drag pans, tap does not. The two share one gesture, so both halves need asserting: this
  // is the check that would catch drag-panning eating taps, which is what sank the first attempt
  // at a movable camera here. (The old version of this check compared a literal against null and
  // could not fail.)
  const camTarget = () => evaluate(
    'JSON.stringify(window.__taxi.camera.state.target.toArray())');

  const dragFrom = async (x, y, dx, dy) => {
    await evaluate(`(() => {
      const c = document.querySelector('canvas');
      const ev = (type, cx, cy) => c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, isPrimary: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      c.setPointerCapture = () => {};
      ev('pointerdown', ${x}, ${y});
      for (let s = 1; s <= 6; s++) ev('pointermove', ${x} + ${dx} * s / 6, ${y} + ${dy} * s / 6);
      ev('pointerup', ${x} + ${dx}, ${y} + ${dy});
    })()`);
    await sleep(200);
  };

  const beforeDrag = await camTarget();
  await dragFrom(450, 300, 120, 80);
  check('dragging pans the camera', (await camTarget()) !== beforeDrag);

  // A press that never crosses the slop must leave the camera exactly where it was.
  const beforeTap = await camTarget();
  await dragFrom(450, 300, 3, 2);
  check('a tap does not pan the camera', (await camTarget()) === beforeTap);

  check('no uncaught exceptions', client.errors.length === 0, client.errors.join(' | '));
} catch (err) {
  check('smoke run completed', false, err.message);
} finally {
  client?.close();
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
