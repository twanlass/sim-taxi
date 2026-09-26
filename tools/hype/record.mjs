/**
 * Record the trailer's footage from the real game, frame-stepped. See tools/hype/README.md.
 *
 *   node tools/hype/record.mjs --url http://localhost:4173 --out ./hype/frames [scene ...]
 *
 * Each scene is its own page load with the city and the situation pinned, so a re-record gives
 * back the same footage. Frames land as JPEGs in <out>/<scene>/, with a status log beside them
 * that the edit reads to find its beats.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const base = arg('url', 'http://localhost:4173');
const outRoot = arg('out', './hype/frames');
const width = Number(arg('width', '1280'));
const height = Number(arg('height', '720'));
const FPS = 30;
const DT = 1 / FPS;

const SEED = arg('seed', '4242');
const RUN = arg('run', '9001');

const pilotSource = await readFile(join(here, 'pilot.js'), 'utf8');

const url = (extra = '') => `${base}/?seed=${SEED}&run=${RUN}${extra}`;

/**
 * The scenes. `setup` runs uncaptured; `frames` is how many to keep; `cue(i)` returns JS to run
 * before frame i (camera moves, boost holds) or '' for none.
 */
const SCENES = {
  // The city rising out of the ground, the depot door, the taxi bumping out into traffic.
  opening: {
    url: url(),
    pilot: false,
    frames: 12 * FPS,
  },

  // Ordinary play, close on the taxi, holding Loco Mode on the straights. On the default seeds
  // this take drives past the bank with an empty seat and gets the whole robbery — there is no
  // separate heist scene because staging one (warping the cooldown, steering at the bank) got the
  // cab stuck behind the drawbridge, and the real thing was already on film.
  play: {
    url: url('&tutorial=off&vignette=off'),
    async setup(p) {
      await p.evaluate(`Object.assign(__hype.s, { zoom: 17 }); __hype.snap();`);
      await p.advance(45, '__hype.tick(' + DT + ')');
    },
    frames: 50 * FPS,
  },

  // The lifting span, close, with the tug going through.
  drawbridge: {
    url: url('&tutorial=off&vignette=off'),
    async setup(p) {
      await p.evaluate(`
        const d = __taxi.drawbridge;
        Object.assign(__hype.s, { fixed: [d.span.cx, (d.span.z0 + d.span.z1) / 2], zoom: 13, boost: 'off' });
        __hype.hud(false);
        __hype.snap();
        __taxi.boats?.settle();
        d.request();
      `);
      await p.advance(20, '__hype.tick(' + DT + ')');
    },
    frames: 16 * FPS,
  },

  // A slow drift across the city at mid zoom, no HUD: the establishing shots.
  drift: {
    url: url('&tutorial=off&vignette=off'),
    async setup(p) {
      await p.evaluate(`Object.assign(__hype.s, { fixed: [-40, -30], zoom: 24, lerp: 1, boost: 'off' });
        __hype.hud(false); __hype.snap();`);
      await p.advance(60, '__hype.tick(' + DT + ')');
    },
    // Two passes: along the river, then down over the park and the bank side.
    cue: (i) => {
      const u = i / (12 * FPS);
      const [x, z] = u < 1 ? [-40 + 80 * u, -30 + 50 * u] : [30 - 60 * (u - 1), 30 - 10 * (u - 1)];
      const zoom = u < 1 ? 24 - 6 * u : 18 + 10 * (u - 1);
      return `__hype.s.fixed = [${x}, ${z}]; __hype.s.zoom = ${zoom}; __hype.s.zoomLerp = 1;`;
    },
    frames: 24 * FPS,
  },

  // Loco Mode held down in traffic until something gives.
  crash: {
    url: url('&tutorial=off&vignette=off'),
    async setup(p) {
      await p.evaluate(`Object.assign(__hype.s, { zoom: 15, boost: 'auto', boostMin: 2.5, boostMax: 4, boostGap: 0.4 });
        __taxi.traffic.taxi.hp = 1; __hype.snap();`);
      await p.advance(30, '__hype.tick(' + DT + ')');
    },
    stopAfterCrash: 5 * FPS,
    frames: 45 * FPS,
  },
};

const wanted = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const names = wanted.length ? wanted : Object.keys(SCENES);

const browser = await launch({ width, height });
try {
  for (const name of names) {
    const scene = SCENES[name];
    if (!scene) throw new Error(`no scene "${name}"`);
    const dir = join(outRoot, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const t0 = Date.now();
    const p = await browser.open(scene.url, { fps: FPS });
    if (scene.pilot !== false) {
      await p.evaluate(pilotSource);
      // The trailer is the city, not the chrome: the HUD goes unless a scene asks for it.
      await p.evaluate(`__hype.hud(${Boolean(scene.hud)})`);
    }
    // Let the first frames build the city before anything is timed.
    await p.advance(2);
    if (scene.setup) await scene.setup(p);

    const log = [];
    let st = null;
    let crashedAt = null;
    for (let i = 0; i < scene.frames; i++) {
      const cue = scene.cue?.(i, st) ?? '';
      const tick = scene.pilot === false ? '' : `__hype.tick(${DT});`;
      const jpg = await p.frame(`${cue};${tick}`);
      await writeFile(join(dir, `${String(i).padStart(5, '0')}.jpg`), jpg);
      if (scene.pilot !== false && i % 5 === 0) {
        st = await p.evaluate('__hype.status()');
        log.push({ i, ...st });
      }
      if (i % 150 === 0) {
        console.log(`${name} ${i}/${scene.frames} ${((Date.now() - t0) / 1000).toFixed(0)}s ${st ? JSON.stringify(st) : ''}`);
      }
      if (st?.crashed && scene.stopAfterCrash) {
        crashedAt ??= i;
        if (i - crashedAt > scene.stopAfterCrash) break;
      }
      if (st?.over && !scene.stopAfterCrash && log.filter((l) => l.over).length > 60) break;
    }
    await writeFile(join(dir, 'log.json'), JSON.stringify(log));
    await p.close();
    console.log(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
} finally {
  await browser.close();
}
