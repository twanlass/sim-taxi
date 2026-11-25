/**
 * The harness behind the in-engine icon renders (tools/make-icon.mjs, tools/make-inline-icons.mjs):
 * serves a page through Vite's dev server, drives a headless Chromium at it over CDP, and waits for
 * the page to set `data-icon-ready` (or report `window.__iconError`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

// A bare name has to be resolved against PATH, not waved through. The old `!c.startsWith('/')`
// test accepted `chromium` unconditionally, so on a Mac — which has no `chromium` anywhere — the
// list never reached the /Applications entry below it. `spawn` then failed with stdio ignored and
// the only symptom was "chromium never opened its debugging port" 30 seconds later.
const onPath = (name) => spawnSync('/bin/sh', ['-c', `command -v "$1"`, '_', name]).status === 0;

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

/**
 * Open `pagePath` (e.g. `/tools/icon/?bg=flat`) and run `work({ cdp, evaluate })` once it is drawn.
 * Tears everything down afterwards, and answers the process exit code.
 */
export async function withIconPage(pagePath, work, { width = 1024, height = 1024 } = {}) {
  const chromeBin = process.env.CHROME ?? [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    'chromium', 'chromium-browser', 'google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((c) => (c.startsWith('/') ? existsSync(c) : onPath(c)));
  if (!chromeBin) throw new Error('no chromium binary found');

  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const pageUrl = new URL(pagePath, server.resolvedUrls.local[0]).href;
  const profile = await mkdtemp(path.join(tmpdir(), 'icon-chrome-'));
  // WebGL under headless needs SwiftShader, same flags as tools/shoot.mjs.
  const chrome = spawn(chromeBin, [
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
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
    await work({ cdp, evaluate });
    cdp.close();
  } catch (err) {
    console.error(`${path.basename(process.argv[1])} failed: ${err.message}`);
    exitCode = 1;
  } finally {
    chrome.kill();
    await server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  return exitCode;
}
