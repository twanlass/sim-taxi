/**
 * Cut the recorded footage into the trailer: titles, beat punch-ins and flashes rendered per
 * frame in Chromium off `compose.html`, then muxed with the soundtrack by ffmpeg.
 *
 *   node tools/hype/compose.mjs --frames ./hype/frames --out ./hype/sim-taxi-trailer.mp4
 *
 * Needs an ffmpeg with libx264: FFMPEG=/path/to/ffmpeg, or `pip install imageio-ffmpeg` and it is
 * found automatically.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';
import { EDIT } from './edit.mjs';
import { BEAT, FPS, SECTIONS, TOTAL } from './timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const framesDir = resolve(arg('frames', './hype/frames'));
const outFile = resolve(arg('out', './hype/sim-taxi-trailer.mp4'));
const work = resolve(arg('work', join(dirname(outFile), 'compose')));
const only = arg('only', null);   // "a,b" seconds — render a sub-range for a quick look

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    return execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
  } catch {
    return 'ffmpeg';
  }
}
const FFMPEG = findFfmpeg();

// The fonts are OFL and fetched rather than committed, like everything else here that isn't code.
const FONTS = {
  'anton.woff2': 'https://fonts.gstatic.com/s/anton/v27/1Ptgg87LROyAm3Kz-C8.woff2',
  'bungee.woff2': 'https://fonts.gstatic.com/s/bungee/v17/N0bU2SZBIuF2PU_0DXR1.woff2',
};

await mkdir(join(work, 'fonts'), { recursive: true });
for (const [name, url] of Object.entries(FONTS)) {
  const path = join(work, 'fonts', name);
  try { await access(path); } catch {
    const res = spawnSync('curl', ['-sfL', '-o', path, url]);
    if (res.status !== 0) throw new Error(`could not fetch ${url}`);
  }
}
await copyFile(join(here, 'compose.html'), join(work, 'compose.html'));
const outFrames = join(work, 'out');
await rm(outFrames, { recursive: true, force: true });
await mkdir(outFrames, { recursive: true });

// Which footage frame shows at edit time t.
function sourceAt(t) {
  const shot = EDIT.shots.find((s) => t >= s.at && t < s.at + s.dur);
  if (!shot) return null;
  const i = shot.from + Math.floor((t - shot.at) * FPS * (shot.speed ?? 1));
  return pathToFileURL(join(framesDir, shot.scene, `${String(i).padStart(5, '0')}.jpg`)).href;
}

const sections = SECTIONS.map((s) => ({ ...s, punch: EDIT.punch[s.name] ?? 0 }));
const [from, to] = only ? only.split(',').map(Number) : [0, TOTAL];

const browser = await launch({ width: 1280, height: 720, port: 9355 });
try {
  const page = await browser.open(pathToFileURL(join(work, 'compose.html')).href, { game: false });
  const fonts = await page.evaluate(`setup(${JSON.stringify({
    titles: EDIT.titles, flashes: EDIT.flashes, sections, beat: BEAT, total: TOTAL, endCard: EDIT.endCard, endDim: EDIT.endDim,
  })})`);
  console.log(`compose: ${fonts} font faces loaded`);
  const n0 = Math.round(from * FPS);
  const n1 = Math.round(to * FPS);
  for (let n = n0; n < n1; n++) {
    const t = n / FPS;
    await page.evaluate(`render(${t}, ${JSON.stringify(sourceAt(t))})`);
    await writeFile(join(outFrames, `${String(n - n0).padStart(5, '0')}.jpg`), await page.shoot());
    if (n % 150 === 0) console.log(`compose ${t.toFixed(1)}s`);
  }
  await page.close();
} finally {
  await browser.close();
}

// The soundtrack, then the mux.
const wav = join(work, 'music.wav');
execFileSync('node', [join(here, 'music.mjs'), wav], { stdio: 'inherit' });
execFileSync(FFMPEG, [
  '-loglevel', 'error', '-y',
  '-framerate', String(FPS), '-i', join(outFrames, '%05d.jpg'),
  '-ss', String(from), '-i', wav,
  '-map', '0:v', '-map', '1:a', '-shortest',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-af', `afade=t=out:st=${Math.max(0, to - from - 1.5)}:d=1.5`,
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart',
  outFile,
], { stdio: 'inherit' });
console.log(`wrote ${outFile}`);
