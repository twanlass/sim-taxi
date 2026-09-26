/**
 * A frame-stepped browser for recording footage of the real game.
 *
 * The headless browser renders WebGL through SwiftShader at a couple of frames a second, so
 * anything recorded against the wall clock comes out as a slideshow. This takes the clock away
 * from the page instead: a script injected before the bundle runs replaces `performance.now`,
 * `Date.now` and `requestAnimationFrame` with a virtual clock that only moves when we say so.
 * Each `step()` advances it by exactly one output frame and runs the page's queued rAF callbacks —
 * `THREE.Clock` reads `performance.now`, so the game sees a steady 30fps however long the frame
 * took to draw — and then we screenshot what it drew.
 *
 * What it cannot reach: CSS transitions and Web Animations run on the compositor's own timeline,
 * so HUD motion is on wall time. It lands finished rather than wrong, which is fine for a trailer.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page before any of its own scripts. Kept as a function so it is real JS, then
// stringified — it must not close over anything.
function virtualClock() {
  let now = 0;
  const dateBase = Date.now();
  let nextId = 1;
  let queue = new Map();
  performance.now = () => now;
  Date.now = () => dateBase + now;
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  // The live game only preserves its drawing buffer in shot mode. A screenshot taken after the
  // rAF that drew it has returned needs the buffer to still be there.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs ?? {}), preserveDrawingBuffer: true };
    return getContext.call(this, type, attrs);
  };
  window.__clock = {
    get now() { return now; },
    step(ms) {
      now += ms;
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) {
        try { cb(now); } catch (err) { console.error(err?.stack ?? String(err)); }
      }
    },
  };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  return {
    ready,
    on: (fn) => listeners.add(fn),
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

export async function launch({ width, height, port = 9344 }) {
  const profile = await mkdtemp(join(tmpdir(), 'hype-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await (await fetch(`${base}/json/version`)).json(); break; } catch {
      if (Date.now() > deadline) throw new Error('Chrome never exposed its debugging port');
      await sleep(200);
    }
  }

  async function open(url, { fps = 30, game = true } = {}) {
    const target = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
    const client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    client.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.log(`  page exception: ${d.exception?.description ?? d.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        console.log(`  console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (game) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${virtualClock})();` });
    await client.send('Page.navigate', { url });

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    };

    // The bundle is a module: wait for it to have built the city and published its hook.
    const bootDeadline = Date.now() + 120000;
    while (!(await evaluate(game ? 'Boolean(window.__taxi && window.__clock)' : 'document.readyState === "complete"'))) {
      if (Date.now() > bootDeadline) throw new Error('game never booted');
      await sleep(200);
    }

    const frameMs = 1000 / fps;
    return {
      evaluate,
      /** Advance the page by `n` frames without looking at them. */
      async advance(n, js = '') {
        await evaluate(`(() => { for (let i = 0; i < ${n}; i++) { ${js}; __clock.step(${frameMs}); } })()`);
      },
      /** Advance one frame, then take the picture. */
      async frame(js = '') {
        await evaluate(`(() => { ${js}; __clock.step(${frameMs}); })()`);
        const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        return Buffer.from(data, 'base64');
      },
      /** Take the picture without touching the clock. */
      async shoot(quality = 94) {
        const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality });
        return Buffer.from(data, 'base64');
      },
      async close() {
        client.close();
        await fetch(`${base}/json/close/${target.id}`).catch(() => {});
      },
    };
  }

  return {
    open,
    async close() {
      chrome.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
