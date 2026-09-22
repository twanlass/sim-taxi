/**
 * How many shaders the game compiles **while it is being played**.
 *
 * Three links a material's program lazily, on the frame that first draws it, and a link is a
 * synchronous stall on the main thread — single-digit milliseconds on a desktop, tens of them on a
 * phone. So a program compiled at boot costs nothing anybody notices (it is behind the wipe and the
 * vignette) and the same program compiled 90 seconds in is a hitch, arriving by definition at the
 * moment something interesting started happening. This tool counts which is which.
 *
 *   CHROME=/path/to/chrome node tools/links.mjs --url http://localhost:5173 --seconds 90
 *
 * It wraps `linkProgram` on the context before the page's first script runs, so nothing in `src/`
 * has to know it exists. What it reports is the count either side of the boot, and the shader type
 * of everything on the late side.
 *
 * **The number is not a timing.** Headless runs on SwiftShader, which rasterises in software at a
 * few frames a second, so the wall-clock stamps are a slow-motion version of a real run and the
 * frame times are meaningless. The *count* is not: what compiles, and whether it compiles before or
 * after the game starts, is the same on any GPU.
 *
 * Two findings this was written for, both since fixed, and both worth knowing the shape of:
 *
 *   - **A light inside a hidden group.** The police cruiser's two siren lamps used to sit under the
 *     group that `group.visible = false` hid between runs. Three collects lights with
 *     `traverseVisible`, so hiding the car took them out of the scene's light count — and the light
 *     count is in every lit material's program cache key. Every lit material in the city relinked
 *     on the frame the cop appeared, and again on the frame it left: 22 programs and then 9.
 *   - **A cache key that was unique per material.** `game/bloom.js` keyed each lamp's emissive copy
 *     off a counter, so every lamp had a program to itself — and a program is deleted when its last
 *     material is, which `unmarkEmissive` does. Every pooled marker relinked a shader each time it
 *     came back.
 *
 * Both read as "the game stutters sometimes" and neither is visible in a profile of the frame loop,
 * because the work is inside the driver.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same env overrides as tools/shoot.mjs and tools/smoke.mjs.
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9342;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const baseUrl = arg('url', 'http://localhost:4173');
const SECONDS = Number(arg('seconds', 90));
const BUDGET = Number(arg('budget', 12));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJson = async (path, method = 'GET') =>
  JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method })).text());

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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

// Injected before the page's own scripts. Nothing in here may use a regex or a backslash escape:
// it travels as a template literal and both are a good way to end up with a probe that silently
// never runs — which looks exactly like a page that never booted.
const PROBE = `
(() => {
  const log = { links: [], tags: [], t0: performance.now() };
  globalThis.__links = log;
  const srcOf = new WeakMap();
  const shadersOf = new WeakMap();
  for (const proto of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!proto) continue;
    const P = proto.prototype;
    const shaderSource = P.shaderSource;
    P.shaderSource = function (shader, source) {
      srcOf.set(shader, source);
      return shaderSource.call(this, shader, source);
    };
    const attachShader = P.attachShader;
    P.attachShader = function (program, shader) {
      const list = shadersOf.get(program) || [];
      list.push(shader);
      shadersOf.set(program, list);
      return attachShader.call(this, program, shader);
    };
    const linkProgram = P.linkProgram;
    P.linkProgram = function (program) {
      let tag = '?';
      try {
        let src = '';
        for (const shader of (shadersOf.get(program) || [])) src += srcOf.get(shader) || '';
        const line = src.split(String.fromCharCode(10))
          .find((l) => l.indexOf('#define SHADER_TYPE') === 0);
        tag = line ? line.slice(20).trim() : 'shader';
      } catch (err) { tag = 'unreadable'; }
      log.links.push(Math.round(performance.now() - log.t0));
      log.tags.push(tag);
      return linkProgram.call(this, program);
    };
  }
})();
`;

const profile = await mkdtemp(join(tmpdir(), 'taxi-links-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,600',
  '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
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
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await client.send('Page.navigate', { url: baseUrl });

  const evaluate = async (expression) => {
    const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value;
  };

  const bootDeadline = Date.now() + 180000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    if (await evaluate('Boolean(window.__taxi)')) { booted = true; break; }
    await sleep(300);
  }
  if (!booted) throw new Error('never booted');
  // The line between "boot" and "the run": everything linked up to the frame `window.__taxi` was
  // published is load, and the player is looking at a wipe. Everything after it is the game.
  const bootAt = await evaluate('Math.round(performance.now() - __links.t0)');

  await sleep(SECONDS * 1000);

  const links = JSON.parse(await evaluate('JSON.stringify(__links.links)'));
  const tags = JSON.parse(await evaluate('JSON.stringify(__links.tags)'));
  const late = links.map((t, i) => [t, i]).filter(([t]) => t > bootAt);

  console.log(`${links.length} programs linked · ${links.length - late.length} at boot `
    + `· ${late.length} during the run (${SECONDS}s of wallclock)`);

  if (late.length) {
    const byType = new Map();
    for (const [, i] of late) byType.set(tags[i], (byType.get(tags[i]) ?? 0) + 1);
    for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}x  ${type}`);
    }
    // Bursts are what hurt: one link is a dropped frame, twenty in a row is a visible freeze.
    const bucket = new Map();
    for (const [t] of late) {
      const s = Math.floor(t / 1000);
      bucket.set(s, (bucket.get(s) ?? 0) + 1);
    }
    const worst = Math.max(...bucket.values());
    console.log(`  worst second: ${worst} links`);
  }

  if (late.length > BUDGET) {
    console.log(`FAIL  ${late.length} mid-run links against a budget of ${BUDGET}`);
    exitCode = 1;
  } else {
    console.log(`PASS  within the budget of ${BUDGET}`);
  }
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  client?.close();
  chrome.kill();
}
process.exit(exitCode);
