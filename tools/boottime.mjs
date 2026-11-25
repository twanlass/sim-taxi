/**
 * How long a WebGPU boot takes to reach `taxi:ready`, headless — and whether two builds of the game
 * write the same shaders.
 *
 *   CHROME=/path/to/chrome node tools/boottime.mjs --url http://localhost:4173 --runs 3
 *   CHROME=... node tools/boottime.mjs --runs 3 --compare 'nodememo=classic' ''
 *
 * Each run is a fresh browser (a fresh profile, so nothing is cached between them), pinned to one
 * city and one run seed so that every run builds the same materials. It prints the `?perf` startup
 * marks — boot, the game's import, the renderer, the module evaluated, the warm-up's end — and the
 * median `taxi:ready`.
 *
 * `--compare A B` runs both query strings the same number of times, prints both medians, and
 * checks that every WGSL module each of them handed `createShaderModule` is the same text in the
 * same order. That is the test for a change that is meant to make three's node builder *faster*
 * without changing what it writes (util/nodememo.js): a speed-up that moved one character of one
 * shader fails here, and nowhere else would.
 *
 * **What the seconds are.** Headless Chromium runs WebGPU on SwiftShader, so anything the GPU does is
 * slow and anything JavaScript does is roughly a desktop's. The boot is mostly JavaScript (three
 * building node graphs into WGSL), so the *split* and the *difference* between two builds are worth
 * reading and the absolute number is not a phone's. The flags and the `__gpuOffscreen` switch are
 * the ones docs/testing.md gives for headless WebGPU: without the switch the canvas cannot present
 * and the device is lost half a second in.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9343;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const baseUrl = arg('url', 'http://localhost:4173');
const RUNS = Number(arg('runs', 3));
const SEED = arg('seed', '7');
const compareAt = process.argv.indexOf('--compare');
const variants = compareAt === -1 ? [arg('query', '')] : [process.argv[compareAt + 1] ?? '', process.argv[compareAt + 2] ?? ''];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Before the page's own scripts. No regex and no backslash in here (see tools/links.mjs).
const PROBE = `
(() => {
  globalThis.__gpuOffscreen = true;
  const log = { codes: [] };
  globalThis.__boottime = log;
  if (globalThis.GPUDevice) {
    const create = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
      log.codes.push(desc && desc.code);
      return create.call(this, desc);
    };
  }
})();
`;

async function boot(query) {
  const profile = await mkdtemp(join(tmpdir(), 'taxi-boottime-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
    ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
    'about:blank',
  ], { stdio: 'ignore' });
  let client;
  try {
    const deadline = Date.now() + 30000;
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
        target = JSON.parse(await res.text());
      } catch { await sleep(200); }
    }
    if (!target) throw new Error('chrome never came up');
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    const sep = baseUrl.includes('?') ? '&' : '?';
    await client.send('Page.navigate', { url: `${baseUrl}${sep}perf&seed=${SEED}&run=${SEED}${query ? `&${query}` : ''}` });
    const evaluate = async (expression) => (await client.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      if (await evaluate("performance.getEntriesByName('taxi:ready').length > 0")) break;
      await sleep(100);
    }
    const ready = await evaluate("performance.getEntriesByName('taxi:ready')[0]?.startTime ?? null");
    if (ready === null) throw new Error(`never reached taxi:ready (${query || 'no query'})`);
    const result = JSON.parse(await evaluate(`JSON.stringify({
      renderer: window.__taxi && window.__taxi.renderer,
      marks: (window.__perfCapture && window.__perfCapture.save && (window.__perfCapture.save('boottime'), window.__perfCapture.last.notes) || [])
        .filter((n) => typeof n[1] === 'string' && n[1].indexOf('link ') !== 0),
      codes: window.__boottime.codes,
    })`));
    return { ready, ...result };
  } finally {
    client?.close();
    chrome.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = variants.map(() => []);
// Interleaved, so a machine that slows down over the minutes this takes slows both sides alike.
for (let r = 0; r < RUNS; r++) {
  for (let v = 0; v < variants.length; v++) {
    const run = await boot(variants[v]);
    results[v].push(run);
    const marks = run.marks.map(([t, name]) => `${name} ${t}`).join(' · ');
    console.log(`[${variants[v] || 'default'}] run ${r + 1}: taxi:ready ${Math.round(run.ready)} ms (${run.renderer}) — ${marks}`);
  }
}
for (let v = 0; v < variants.length; v++) {
  const times = results[v].map((x) => Math.round(x.ready));
  console.log(`[${variants[v] || 'default'}] median ${median(times)} ms of ${times.join(', ')} · ${results[v][0].codes.length} shader modules`);
}
if (variants.length === 2) {
  const a = results[0][0].codes;
  const b = results[1][0].codes;
  const firstDiff = a.findIndex((code, i) => code !== b[i]);
  if (a.length === b.length && firstDiff === -1) {
    console.log(`shaders identical: ${a.length} modules, same text, same order`);
  } else {
    console.log(`shaders DIFFER: ${a.length} vs ${b.length} modules, first difference at module ${firstDiff === -1 ? a.length : firstDiff}`);
    process.exitCode = 1;
  }
}
