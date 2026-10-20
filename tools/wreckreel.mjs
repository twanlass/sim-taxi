/**
 * Films the wreck a frame at a time, for looking at the explosion on a phone. Shot 12 stages a real
 * crash (see `shot.wreckAt` in main.js); this opens it at `wreckAt=0` and then steps the wreck's own
 * pools on through `window.__wreckStep`, capturing each frame, so the whole blast comes out of one
 * staging at an even frame rate whatever the software renderer manages in real time.
 *
 *   CHROME=/opt/pw-browsers/chromium CHROME_FLAGS=--no-sandbox \
 *     node tools/wreckreel.mjs --url 'http://localhost:4173/?rain=night' --out ./reel --mp4 reel.mp4
 *
 * `--seconds` (2.6, the run-end hold) and `--fps` (30) size the take; `--width/--height/--dpr`
 * default to a portrait phone. `--mp4` needs ffmpeg on the PATH and writes H.264 yuv420p with
 * faststart, which is what plays inline on an iPhone.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg('url', 'http://localhost:4173');
const outDir = arg('out', './reel');
const mp4 = arg('mp4', null);
const seconds = Number(arg('seconds', '2.6'));
const fps = Number(arg('fps', '30'));
const WIDTH = Number(arg('width', '390'));
const HEIGHT = Number(arg('height', '844'));
const DPR = Number(arg('dpr', '2'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return JSON.parse(await res.text());
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log(`EXCEPTION ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
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

const profile = await mkdtemp(join(tmpdir(), 'wreckreel-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars', '--no-first-run',
  '--disable-extensions',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); break; } catch { await sleep(200); }
  }
  await mkdir(outDir, { recursive: true });
  const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: DPR, mobile: true,
  });
  const url = new URL(baseUrl);
  url.searchParams.set('shot', url.searchParams.get('shot') ?? '12');
  url.searchParams.set('wreckAt', '0');
  await client.send('Page.navigate', { url: url.href });

  const eval_ = async (expression) => (await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })).result.value;
  const readyBy = Date.now() + 180000;
  while (Date.now() < readyBy && !(await eval_('document.body?.dataset?.shotReady === "true" && !!window.__wreckStep'))) {
    await sleep(250);
  }
  if (!(await eval_('!!window.__wreckStep'))) throw new Error('no __wreckStep — is this a wreck shot?');

  const step = Math.round(60 / fps);
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) {
    // Two animation frames after the step so the canvas has presented before the capture.
    if (f > 0) await eval_(`(window.__wreckStep(${step}), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, `f${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }
  console.log(`wreckreel: ${frames} frames in ${outDir}`);
  client.close();

  if (mp4) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(outDir, 'f%04d.png'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
      '-movflags', '+faststart', mp4]);
    console.log(`wreckreel: ${mp4}`);
  }
} catch (err) {
  console.error(`wreckreel: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
}
process.exit(exitCode);
