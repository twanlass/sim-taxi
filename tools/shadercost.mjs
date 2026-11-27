/**
 * What each render pipeline the boot builds costs the GPU driver to compile, one at a time.
 *
 *   CHROME=/path/to/chrome node tools/shadercost.mjs --url http://localhost:5173 [--query 'x=classic'] [--cold]
 *
 * A cold first load is mostly the driver compiling shaders (on an M-series Mac, ~7 of ~9.3 s), and
 * a boot cannot say which shaders: three builds them inside one long task, interleaved with its own
 * JavaScript. So this splits the two. It boots the game once and records every
 * `createRenderPipeline` descriptor it was handed, WGSL and all. Then, in a fresh browser on a blank
 * page with none of the game loaded, it creates those pipelines again, serially, timing each — once
 * against an empty driver cache and once more against the warm one. The difference is that
 * pipeline's compile, and nothing else is in it.
 *
 * `--cold` (macOS) empties Chrome's Metal caches before the replay and does a throwaway WebGPU launch
 * first: the first launch after a clear pays to rebuild Chrome's *own* shaders, and without the
 * throwaway that lands on the first few pipelines timed. Without `--cold` the first pass runs against
 * whatever the OS has cached, which after the boot it just did is everything.
 *
 * No `--use-webgpu-adapter=swiftshader` unless `CHROME_FLAGS` asks for it: the point is the real
 * driver. Headless SwiftShader numbers rank the shaders by its own compiler, which is not Metal's.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9344;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const baseUrl = arg('url', 'http://localhost:5173');
const query = arg('query', '');
const SEED = arg('seed', '7');
const COLD = process.argv.includes('--cold');
const OUT = arg('out', null);
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

async function withChrome(fn) {
  const profile = await mkdtemp(join(tmpdir(), 'taxi-shadercost-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--enable-unsafe-webgpu',
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
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    return await fn(client, evaluate);
  } finally {
    client?.close();
    chrome.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

// Before the game's scripts: keep each pipeline's descriptor, with modules as indices into `codes`.
// No regex and no backslash in here (see tools/links.mjs).
const PROBE = `
(() => {
  globalThis.__gpuOffscreen = true;
  const log = { codes: [], pipes: [] };
  globalThis.__shadercost = log;
  if (!globalThis.GPUDevice) return;
  const index = new Map();
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const module = createModule.call(this, desc);
    if (!index.has(desc.code)) { index.set(desc.code, log.codes.length); log.codes.push(desc.code); }
    module.__code = index.get(desc.code);
    return module;
  };
  const stage = (s) => s && { module: s.module.__code, entryPoint: s.entryPoint, buffers: s.buffers, targets: s.targets };
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync']) {
    const create = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (desc) {
      log.pipes.push({ vertex: stage(desc.vertex), fragment: stage(desc.fragment), primitive: desc.primitive,
        depthStencil: desc.depthStencil, multisample: desc.multisample });
      return create.call(this, desc);
    };
  }
})();
`;

async function capture() {
  return withChrome(async (client, evaluate) => {
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    const sep = baseUrl.includes('?') ? '&' : '?';
    await client.send('Page.navigate', { url: `${baseUrl}${sep}perf&seed=${SEED}&run=${SEED}${query ? `&${query}` : ''}` });
    const until = Date.now() + 240000;
    while (Date.now() < until && !(await evaluate("performance.getEntriesByName('taxi:ready').length > 0"))) await sleep(200);
    return JSON.parse(await evaluate('JSON.stringify(window.__shadercost)'));
  });
}

// A blank page on its own origin (localhost is a secure context), which fetches the capture.
function serve(data) {
  const body = JSON.stringify(data);
  const server = createServer((req, res) => {
    if (req.url === '/data.json') { res.setHeader('content-type', 'application/json'); res.end(body); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>shadercost</title>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const REPLAY = `
(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features].filter((f) => f !== 'core-features-and-limits') });
  if (window.__warmOnly) { return 'warm'; }
  const data = await (await fetch('/data.json')).json();
  const modules = new Map();
  const mod = (i) => { if (!modules.has(i)) modules.set(i, device.createShaderModule({ code: data.codes[i] })); return modules.get(i); };
  const times = [];
  const errors = [];
  for (const p of data.pipes) {
    const desc = { layout: 'auto', vertex: { ...p.vertex, module: mod(p.vertex.module) }, primitive: p.primitive, multisample: p.multisample };
    if (p.fragment) desc.fragment = { ...p.fragment, module: mod(p.fragment.module) };
    if (p.depthStencil) desc.depthStencil = p.depthStencil;
    const t = performance.now();
    try { await device.createRenderPipelineAsync(desc); } catch (e) { errors.push(String(e.message).slice(0, 200)); }
    times.push(performance.now() - t);
  }
  return JSON.stringify({ times, errors });
})()
`;

async function replay(url, warmOnly = false) {
  return withChrome(async (client, evaluate) => {
    await client.send('Page.navigate', { url });
    await sleep(500);
    if (warmOnly) await evaluate('window.__warmOnly = true');
    const out = await evaluate(REPLAY, true);
    return warmOnly ? null : JSON.parse(out);
  });
}

function clearMetalCaches() {
  const dir = execSync('getconf DARWIN_USER_CACHE_DIR').toString().trim();
  for (const sub of ['com.apple.metal', 'com.apple.metalfe', 'com.apple.gpuarchiver']) {
    execSync(`rm -rf "${dir}com.google.Chrome.helper/${sub}"`);
  }
}

// What a fragment shader carries, read off its text.
const count = (code, needle) => code.split(needle).length - 1;
function tags(code) {
  const lean = code.split('\n').filter((l) => l.trim()).join('\n');
  return {
    bytes: lean.length,
    pcf: count(code, 'textureSampleCompare'),
    hash: count(code, '43758.5453'),
    lut: count(code, 'texture_3d'),
    texSamples: count(code, 'textureSample('),
  };
}

const data = await capture();
console.log(`captured ${data.pipes.length} pipelines over ${data.codes.length} modules (${query || 'default'})`);
const server = await serve(data);
const url = `http://127.0.0.1:${server.address().port}/`;
if (COLD) {
  if (platform() !== 'darwin') throw new Error('--cold clears the Metal cache, which is macOS only');
  clearMetalCaches();
  await replay(url, true);
}
const cold = await replay(url);
const warm = await replay(url);
server.close();
if (cold.errors.length) console.log(`${cold.errors.length} pipelines failed to replay, e.g. ${cold.errors[0]}`);

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const rows = data.pipes.map((p, i) => {
  const frag = p.fragment ? data.codes[p.fragment.module] : '';
  return { i, cost: cold.times[i] - warm.times[i], cold: cold.times[i], vs: p.vertex.module, fs: p.fragment?.module ?? -1,
    targets: p.fragment?.targets?.length ?? 0, ...tags(frag), vbytes: data.codes[p.vertex.module].length };
});
console.log(`replay: first pass ${Math.round(sum(cold.times))} ms, warm ${Math.round(sum(warm.times))} ms, compile ${Math.round(sum(rows.map((r) => r.cost)))} ms`);
const by = (key) => {
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k) ?? { n: 0, ms: 0 };
    g.n++; g.ms += r.cost;
    groups.set(k, g);
  }
  return [...groups].sort((a, b) => b[1].ms - a[1].ms).map(([k, g]) => `${k}: ${g.n} pipes ${Math.round(g.ms)} ms`).join(' · ');
};
console.log(`by PCF taps   ${by((r) => r.pcf)}`);
console.log(`by hash noise ${by((r) => (r.hash ? 'noise' : 'none'))}`);
console.log(`by targets    ${by((r) => r.targets)}`);
console.log(`by frag size  ${by((r) => `${Math.floor(r.bytes / 25000) * 25}k+`)}`);
// Modules compiled into more than one pipeline: what each pays per extra pipeline.
const perFrag = new Map();
for (const r of rows) perFrag.set(r.fs, [...(perFrag.get(r.fs) ?? []), r.cost]);
const repeats = [...perFrag.values()].filter((xs) => xs.length > 1);
console.log(`${repeats.length} fragment modules are in more than one pipeline: first ${Math.round(sum(repeats.map((x) => x[0])))} ms, the rest ${Math.round(sum(repeats.flatMap((x) => x.slice(1))))} ms over ${sum(repeats.map((x) => x.length - 1))} pipelines`);
console.log('top 20:');
for (const r of [...rows].sort((a, b) => b.cost - a.cost).slice(0, 20)) {
  console.log(`  #${r.i} ${Math.round(r.cost)} ms  fs ${r.fs} ${Math.round(r.bytes / 1000)}k  pcf ${r.pcf} hash ${r.hash} tex ${r.texSamples} targets ${r.targets}  vs ${r.vs} ${Math.round(r.vbytes / 1000)}k`);
}
if (OUT) await writeFile(OUT, JSON.stringify({ rows, codes: data.codes }));
