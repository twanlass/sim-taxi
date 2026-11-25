/**
 * Trailer footage, filmed offline: each beat is a real run of the game, stepped one fixed frame at a
 * time in headless Chromium, with the game's own audio rendered in lockstep (tools/trailer/page-init.js)
 * and the moment found and framed by tools/trailer/director.js. See docs/testing.md#trailer-footage.
 *
 *   npx vite --port 5173 &                                   # or a preview build
 *   node tools/trailer.mjs --beats drift,bigair --out trailer-out
 *   node tools/trailer.mjs --cut --out trailer-out           # stitch what is there into the two cuts
 *
 * Each beat runs twice from the same seeds. A quick pass with nothing captured finds the frame its
 * moment lands on; a second pass replays to a little before it and captures from there. Every frame
 * is 1/60 s of game time however long the software renderer takes over it (~1 s at 886×1920), so the
 * two passes agree and the footage plays at true speed.
 *
 * Per beat it writes `<out>/<beat>/m00000.jpg…` (60 fps, the canvas alone: the trailer master, HUD
 * off), `a00000.jpg…` (30 fps, the composited page with the HUD: the App Store preview) and
 * `audio.wav` (the game's mix over the same span, music muted — the cut lays one song under all of
 * it so the radio does not jump at every cut).
 *
 * Flags: `--url` (http://localhost:5173), `--width/--height` CSS px (443×960) at `--dpr` (2) →
 * 886×1920, `--find-only` (pass one only, prints the frame), `--seed`/`--run` to override a beat's.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const URL_BASE = arg('url', 'http://localhost:5173');
const OUT = arg('out', join(root, 'trailer-out'));
const WIDTH = Number(arg('width', '443'));
const HEIGHT = Number(arg('height', '960'));
const DPR = Number(arg('dpr', '2'));
const FPS = 60;

// Common to every beat: pinned, uncapped, no governor, no squall, straight into a run.
const BASE = 'title=off&vignette=off&intro=classic&tutorial=off&governor=off&squall=off&fps=60&splash=classic';

/**
 * The beats, in cut order. `pre`/`post` are seconds either side of the moment; `zoom` is the
 * camera's frustum half-height (PLAY_ZOOM is 52; the pinch range is 14–150, so every framing here is
 * one a player can reach). `cut` is how much of the take the rough cut keeps.
 */
export const BEATS = [
  { name: 'loco', query: 'bot=loco', seed: 71624, run: 7, pre: 0.4, post: 2.4, zoom: 30, max: 90 },
  { name: 'pickup', query: 'bot=fares', seed: 71624, run: 7, pre: 1.6, post: 1.4, zoom: 26, max: 70 },
  { name: 'drift', query: 'bot=drift', seed: 71624, run: 7, pre: 1.0, post: 2.0, zoom: 28, max: 90 },
  { name: 'bigair', query: 'bot=bigair', seed: 71624, run: 7, pre: 0.9, post: 2.3, zoom: 34, max: 100 },
  // The drift onto the bridge and the Big Air off it, in one take: ~6 s with the UI (`a` frames).
  { name: 'bigroll', query: 'bot=bigroll', seed: 71624, run: 3, pre: 3.0, post: 3.0, zoom: 30, max: 60, solo: true },
  // The bank job end to end, with the UI: the last of the cut, the robber's line, the getaway with
  // the cops coming on. The game's own cameras frame it (no zoom pin), so the cut stays the cut.
  // From the bank cut (the shove) to seven seconds of the helicopter on the taxi (`until`: the
  // director's end), at play zoom.
  { name: 'heist', query: 'bot=robbery', seed: 71624, run: 2, pre: 0.4, post: 1.0, until: true, zoom: 0, max: 200, solo: true },
  { name: 'mega', query: '', seed: 71624, run: 7, pre: 1.4, post: 2.6, zoom: 40, max: 70 },
  { name: 'robbery', query: 'bot=robbery', seed: 71624, run: 7, pre: 0.3, post: 3.0, zoom: 36, max: 140 },
  { name: 'cops', query: 'bot=cops', seed: 71624, run: 7, pre: 0.5, post: 2.8, zoom: 34, max: 100 },
  { name: 'crash', query: 'bot=crash', seed: 71624, run: 7, pre: 0.8, post: 2.8, zoom: 30, max: 40 },
  { name: 'title', query: '', seed: 71624, run: 7, pre: 0, post: 2.5, zoom: 0, max: 30, title: true },
];

const pageInit = readFileSync(join(here, 'trailer/page-init.js'), 'utf8');
const director = readFileSync(join(here, 'trailer/director.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wavCache = arg('wav-cache', join(root, 'trailer-out', '.wav'));
const sources = readdirSync(join(root, 'assets/audio')).filter((f) => f.endsWith('.m4a'));
/** The WAV for a served .m4a, by its name with or without Vite's content hash (`name-AbC123.m4a`). */
function wavFor(served) {
  const stem = served.replace(/\.m4a$/, '');
  const src = sources.find((f) => f.slice(0, -4) === stem)
    ?? sources.filter((f) => stem.startsWith(`${f.slice(0, -4)}-`)).sort((p, q) => q.length - p.length)[0];
  if (!src) return null;
  const out = join(wavCache, `${src.slice(0, -4)}.wav`);
  if (!existsSync(out)) {
    mkdirSync(wavCache, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(root, 'assets/audio', src), '-ar', '48000', '-ac', '2', out]);
  }
  return readFileSync(out);
}

async function openBeat(browser, beat) {
  const seed = Number(arg('seed', beat.seed));
  const run = Number(arg('run', beat.run));
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
  // Music off in the game's own settings: the cut lays one song under every beat.
  await context.addInitScript(() => {
    try { localStorage.setItem('simTaxi.settings', JSON.stringify({ music: 0, effects: 1, tips: false })); } catch {}
  });
  // Headless Chromium has no AAC decoder, so the game's .m4a files are served as WAV, decoded once
  // by ffmpeg into `wavCache` — the same recordings, a container the browser can read.
  await context.route(/\.m4a(\?.*)?$/, async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    const body = wavFor(file);
    if (body) await route.fulfill({ status: 200, contentType: 'audio/wav', body });
    else await route.continue();
  });
  await context.addInitScript({ content: pageInit });
  await context.addInitScript({ content: director });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [page] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 240)}`); });
  const base = beat.title ? BASE.replace('title=off&', '') : BASE;
  const query = [base, `dpr=${DPR}`, `seed=${seed}`, `run=${run}`, `trailer=${beat.name}`,
    beat.zoom ? `trailerzoom=${beat.zoom}` : '', `trailermax=${beat.max + 20}`, beat.query].filter(Boolean).join('&');
  await page.goto(`${URL_BASE}/?${query}`, { timeout: 180_000 });
  // Pump the boot: modules load on wall time, the warm-up yields on frames.
  for (let i = 0; i < 6000; i++) {
    const ok = await page.evaluate(async () => {
      await window.__trailer.step(1);
      return Boolean(window.__taxi?.warmedUp);
    });
    if (ok) break;
    await sleep(15);
  }
  // A real gesture: the title's Play, or anywhere on the city. This is what makes the AudioContext.
  if (beat.title) await page.mouse.click(WIDTH / 2, HEIGHT * 0.9);
  else await page.mouse.click(4, HEIGHT / 2);
  await page.evaluate(() => window.__taxi.holdRender(true));
  const cdp = await context.newCDPSession(page);
  return { page, context, cdp, query };
}

/** Steps until the director reports the beat's moment; answers its frame (counted from the gesture). */
async function findMoment(page, beat) {
  const limit = beat.max * FPS;
  for (let f = 0; f < limit; f++) {
    const r = await page.evaluate(async () => { await window.__trailer.step(1); return window.__director.update(); });
    if (r.error) throw new Error(r.error);
    if (r.event) {
      console.log('  at the moment', JSON.stringify(await page.evaluate(() => window.__director.info())).slice(0, 300));
      // Play on through the rest of the take: a ram after the moment spoils it as much as one before.
      // A beat with an `until` runs on to the director's `end` (plus `post`) rather than a fixed length.
      const at = await page.evaluate(() => window.__director.frames);
      let after = Math.round(beat.post * FPS);
      if (beat.until) {
        let k = 0;
        for (; k < limit - f; k++) {
          const e = await page.evaluate(async () => { await window.__trailer.step(1); return window.__director.update(); });
          if (e.end) break;
          if (k % 600 === 0 && k) console.log(`  …+${k / FPS}s`, JSON.stringify(await page.evaluate(() => window.__director.info())).slice(0, 300));
        }
        if (k >= limit - f) { console.log('  the take never reached its end'); return -1; }
        console.log('  at the end', JSON.stringify(await page.evaluate(() => window.__director.info())).slice(0, 400));
        after += k + 1;
      }
      for (let k = beat.until ? Math.round(beat.post * FPS) : 0; k > 0; k--) {
        await page.evaluate(async () => { await window.__trailer.step(1); window.__director.update(); });
      }
      if (!beat.until) for (let k = 0; k < after; k++) {
        await page.evaluate(async () => { await window.__trailer.step(1); window.__director.update(); });
      }
      const stalls = await page.evaluate(() => window.__director.stalls());
      const rams = stalls.filter((s) => s >= at - Math.round(beat.pre * FPS) - 30 && s <= at + after);
      if (rams.length) console.log(`  the taxi rams something ${rams.length}× inside the take (at +${rams.map((s) => ((s - at) / FPS).toFixed(1)).join(', +')}s)`);
      return rams.length && !flag('allow-rams') ? -2 : { f, after };
    }
    if (f % (beat.name === "mega" ? 120 : 600) === 0 && f) console.log(`  …${f / FPS}s`, JSON.stringify(await page.evaluate(() => window.__director.info())));
  }
  return -1;
}

async function shootBeat(browser, beat) {
  // `--runs 3,5,8`: run seeds to try in turn until one gives the moment with no ram inside the take.
  const runs = (arg('runs', null)?.split(',').map(Number)) ?? [Number(arg('run', beat.run))];
  let moment = -1;
  let after = 0;
  let a;
  for (const run of runs) {
    beat = { ...beat, run };
    console.log(`\n${beat.name}: finding the moment (run ${run})`);
    a = await openBeat(browser, beat);
    const found = await findMoment(a.page, beat);
    moment = typeof found === 'object' ? found.f : found;
    after = found?.after ?? 0;
    await a.context.close();
    if (moment >= 0) break;
  }
  if (moment < 0) { console.log(`  ${beat.name}: no clean moment inside ${beat.max}s — skipped`); return null; }
  console.log(`  moment at frame ${moment} (${(moment / FPS).toFixed(2)}s)`);
  if (flag('find-only')) return { moment };

  const from = Math.max(0, moment - Math.round(beat.pre * FPS));
  const to = moment + after;
  const dir = join(OUT, beat.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`  capturing frames ${from}–${to}`);
  a = await openBeat(browser, beat);
  const { page, cdp } = a;
  let seenAt = -1;
  for (let f = 0; f < from; f++) {
    const r = await page.evaluate(async () => { await window.__trailer.step(1); return window.__director.update(); });
    if (r.event && seenAt < 0) seenAt = f;
  }
  await page.evaluate(() => window.__taxi.holdRender(false));
  const audioFrom = await page.evaluate(() => window.__trailer.audioTime);
  const started = Date.now();
  for (let f = from, k = 0; f < to; f++, k++) {
    const r = await page.evaluate(async () => {
      await window.__trailer.step(1);
      const d = window.__director.update();
      // The biggest canvas is the city (the first is an 84px icon). Read in the same task as the
      // draw, before the buffer is cleared.
      const canvas = [...document.querySelectorAll('canvas')].sort((p, q) => q.width * q.height - p.width * p.height)[0];
      return { ...d, jpg: canvas.toDataURL('image/jpeg', 0.93).split(',')[1] };
    });
    if (r.event && seenAt < 0) seenAt = f;
    writeFileSync(join(dir, `m${String(k).padStart(5, '0')}.jpg`), Buffer.from(r.jpg, 'base64'));
    // `--ui60`: the composited page (HUD and all) on every frame rather than every other.
    if (k % 2 === 0 || flag('ui60')) {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 93, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: DPR },
      });
      writeFileSync(join(dir, flag('ui60') ? `u${String(k).padStart(5, '0')}.jpg` : `a${String(k / 2).padStart(5, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
    }
    if (k % 30 === 0) console.log(`  frame ${k}/${to - from}  ${((Date.now() - started) / 1000 / (k + 1)).toFixed(2)}s/frame`);
  }
  const seconds = (to - from) / FPS;
  const wav = await page.evaluate(([s, e]) => window.__trailer.audio(s, e), [audioFrom, audioFrom + seconds]);
  if (wav) writeFileSync(join(dir, 'audio.wav'), Buffer.from(wav, 'base64'));
  const drift = seenAt < 0 ? 'not seen' : seenAt - moment;
  writeFileSync(join(dir, 'take.json'), JSON.stringify({ ...beat, query: a.query, moment, from, to, replayDrift: drift }, null, 2));
  console.log(`  ${beat.name}: ${to - from} frames, replay landed the moment ${drift === 0 ? 'on the same frame' : `off by ${drift}`}`);
  await a.context.close();
  return { moment, from, to };
}

// --- The cut -----------------------------------------------------------------------------------

/**
 * Stitches each beat's take (in BEATS order, skipping any not shot) into:
 *   preview-886x1920-30fps.mp4 — App Store app preview: H.264 High@4.0, 30 fps, stereo AAC 256k
 *   master-60fps.mp4           — the trailer master, HUD off
 * Short dissolves between beats (Apple: "straightforward transitions, like dissolves and fades").
 * Audio: each beat's game mix, crossfaded the same way, over one of the game's own songs.
 */
function cut() {
  const song = arg('song', join(root, 'assets/audio/27_MUS_upbeat.m4a'));
  const songAt = Number(arg('song-at', '0'));
  const XF = 0.25;
  const named = arg('beats', null)?.split(',');
  const takes = BEATS.filter((b) => (named ? named.includes(b.name) : !b.solo)).map((b) => ({ b, dir: join(OUT, b.name) }))
    .filter(({ dir }) => existsSync(join(dir, 'take.json')));
  if (!takes.length) throw new Error(`no takes in ${OUT}`);
  for (const [prefix, fps, name, extra] of [
    ['a', 30, 'preview-886x1920-30fps.mp4', ['-profile:v', 'high', '-level', '4.0', '-b:v', '11M', '-maxrate', '12M', '-bufsize', '24M']],
    ['m', 60, 'master-60fps.mp4', ['-crf', '14', '-preset', 'slow']],
  ]) {
    const inputs = [];
    const lens = [];
    for (const { dir } of takes) {
      const n = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).length;
      lens.push(n / fps);
      inputs.push('-framerate', String(fps), '-i', join(dir, `${prefix}%05d.jpg`));
    }
    for (const { dir } of takes) inputs.push('-i', join(dir, 'audio.wav'));
    inputs.push('-i', song);
    const N = takes.length;
    let v = '';
    let a = '';
    let vPrev = '[0:v]';
    let aPrev = `[${N}:a]`;
    let offset = 0;
    for (let k = 0; k < N; k++) v += `[${k}:v]scale=886:1920:flags=lanczos,setsar=1,fps=${fps},format=yuv420p[v${k}];`;
    vPrev = '[v0]';
    for (let k = 1; k < N; k++) {
      offset += lens[k - 1] - XF;
      v += `${vPrev}[v${k}]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[vx${k}];`;
      a += `${aPrev}[${N + k}:a]acrossfade=d=${XF}[ax${k}];`;
      vPrev = `[vx${k}]`;
      aPrev = `[ax${k}]`;
    }
    const total = lens.reduce((s, l) => s + l, 0) - XF * (N - 1);
    // The song sits under the game at -9 dB, fades in over half a second and out over the last 1.5.
    a += `[${2 * N}:a]atrim=start=${songAt},asetpts=PTS-STARTPTS,aresample=48000,volume=0.35,`
      + `afade=t=in:d=0.5,afade=t=out:st=${(total - 1.5).toFixed(3)}:d=1.5[song];`;
    a += `${aPrev}[song]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`;
    const filter = `${v}${a}`.replace(/;$/, '');
    const out = join(OUT, prefix === 'm' && fps === 60 ? name : name);
    const scaleFix = prefix === 'm' ? filter : filter;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', scaleFix,
      '-map', vPrev, '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra,
      '-r', String(fps), '-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000',
      '-movflags', '+faststart', '-t', total.toFixed(3), out], { stdio: 'inherit' });
    console.log(`${out}: ${total.toFixed(2)}s`);
  }
}

if (flag('cut')) {
  cut();
} else {
  // `solo` beats are clips of their own, shot only when named.
  const want = (arg('beats', BEATS.filter((b) => !b.solo).map((b) => b.name).join(','))).split(',');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    for (const beat of BEATS.filter((b) => want.includes(b.name))) {
      try { await shootBeat(browser, beat); } catch (error) { console.log(`  ${beat.name} failed: ${error.message}`); }
    }
  } finally {
    await browser.close();
  }
}
