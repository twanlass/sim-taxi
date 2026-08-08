/**
 * Screenshot harness driven over the Chrome DevTools Protocol.
 *
 * The obvious approach — `chrome --headless --screenshot --virtual-time-budget=N` — is a guess
 * dressed up as a deadline: it fires after N ms of virtual time whether or not the scene has
 * been drawn, and when it fires early you get a blank PNG with no explanation. Under the
 * software renderer used for headless WebGL that happened constantly.
 *
 * This drives the browser explicitly instead: navigate, wait for the page to *say* it has
 * finished drawing (document.body.dataset.shotReady), then capture. Console output and uncaught
 * exceptions are forwarded to stdout, so a failure reports itself rather than showing up as an
 * empty image.
 *
 * No dependencies — Node's built-in WebSocket is enough to speak CDP.
 *
 *   node tools/shoot.mjs --url http://localhost:4173 --out ./shots --shots 0,1,2,3
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Overridable because the CI/sandbox boxes this runs on are Linux, where Chromium lives
// somewhere else entirely (e.g. CHROME=/opt/pw-browsers/chromium).
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Landscape by default, since that is the framing the shots were composed in. Overridable because
// the game is played on a phone: in portrait the frustum is sized by height and the framing is a
// different picture entirely — `--width 430 --height 932` is an iPhone.
const WIDTH = Number(arg('width', '1280'));
const HEIGHT = Number(arg('height', '800'));

const baseUrl = arg('url', 'http://localhost:4173');
const outDir = arg('out', './shots');
const shots = arg('shots', '0,1,2,3').split(',').map((s) => s.trim()).filter(Boolean);
const settleMs = Number(arg('settle', '250'));
const timeoutMs = Number(arg('timeout', '120000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 120)}`);
  }
}

/** Minimal CDP client: send commands, await matching ids, dispatch events to listeners. */
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
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
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

const profile = await mkdtemp(join(tmpdir(), 'lowpoly-chrome-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  // Headless has no GPU, so WebGL runs through SwiftShader. Without these flags the context
  // fails to create and every render is silently empty.
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  // Containers without a usable user namespace (and anything running as root) need
  // --no-sandbox here. Kept in an env var so the ordinary desktop run keeps its sandbox:
  //   CHROME=/opt/pw-browsers/chromium CHROME_FLAGS=--no-sandbox node tools/shoot.mjs
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;

try {
  // Wait for the debugging endpoint rather than sleeping a fixed amount.
  let endpoint = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      endpoint = await fetchJson('/json/version');
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!endpoint) throw new Error('Chrome never exposed its debugging port');

  await mkdir(outDir, { recursive: true });

  for (const shot of shots) {
    // /json/new only accepts PUT in current Chrome builds.
    const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    const client = connect(target.webSocketDebuggerUrl);
    await client.ready;

    const problems = [];
    client.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        problems.push(`EXCEPTION ${d.exception?.description ?? d.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        problems.push(`console.error ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        problems.push(`log ${msg.params.entry.text}`);
      }
    });

    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });

    // Built through URL rather than by concatenation so a base that already carries query params
    // keeps them: `--url 'http://localhost:4173/?run=7'` picks which situation gets shot.
    const shotUrl = new URL(baseUrl);
    shotUrl.searchParams.set('shot', shot);
    const url = shotUrl.href;
    await client.send('Page.navigate', { url });

    // Poll for the page's own ready flag — the only signal that actually means "drawn".
    const shotDeadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < shotDeadline) {
      const { result } = await client.send('Runtime.evaluate', {
        expression: 'document.body?.dataset?.shotReady === "true"',
        returnByValue: true,
      });
      if (result.value === true) { ready = true; break; }
      await sleep(250);
    }

    if (!ready) {
      console.log(`shot ${shot}: TIMED OUT waiting for shotReady`);
      exitCode = 1;
    }

    await sleep(settleMs);

    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = join(outDir, `shot-${shot}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));

    const bytes = Buffer.from(data, 'base64').length;
    console.log(`shot ${shot}: ${file} (${(bytes / 1024).toFixed(0)} KB)${ready ? '' : ' [not ready]'}`);
    problems.forEach((p) => console.log(`  ${p}`));

    client.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
  }
} catch (err) {
  console.error(`harness failed: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(exitCode);
