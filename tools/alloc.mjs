/**
 * How much garbage a frame of the simulation makes.
 *
 * Runs the headless loop `tools/soak.mjs` plays — signals, car physics, the fare board — under V8's
 * allocation sampler, and prints bytes per frame by the function that allocated them. No renderer,
 * so what comes out is the game's own logic rather than three's.
 *
 *   node tools/alloc.mjs [frames] [cars]
 *
 * **It exists to rule something out, and it does.** Stutter in a browser game reads as garbage
 * collection whether or not it is, and the way to find out is to measure the allocation rate rather
 * than to read the code looking for object literals. A full city — 110 cars, every signal, the fare
 * clocks — allocates about **60 bytes a frame**, which is 4 KiB a second and something like one
 * young-generation scavenge an hour. Whatever a hitch is here, it is not this. When a frame-time
 * problem is reported, run this first: a number in this range means look at the GPU side, and
 * `tools/links.mjs` is the next thing to reach for.
 *
 * The one thing to know reading the output: a row is *self* size, so a hot leaf like `Math.cos`
 * boxing a double can outrank the whole traffic model, and V8's sampler is statistical — anything
 * under a few bytes a frame is noise between runs.
 */
import { Session } from 'node:inspector/promises';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createPolice } from '../src/sim/police.js';
import { createFareSystem } from '../src/game/fares.js';
import { cityFor } from './autoplay.mjs';

const FRAMES = Number(process.argv[2] ?? 6000);
const STEP = 1 / 60;
const CARS = Number(process.argv[3] ?? 110);

cityFor(71624);
const scene = new THREE.Scene();
const traffic = createTraffic(makeRng(71624 + 44), scene, CARS);
const fares = createFareSystem(makeRng(71624 + 55), scene);
const police = createPolice(makeRng(71624 + 66), scene);
traffic.warmup(60);

const step = () => {
  police.update(STEP);
  traffic.update(STEP);
  fares.update(STEP, traffic.taxi);
};

// Warm the JIT so the sample is steady-state rather than first-run.
for (let i = 0; i < 600; i++) step();

const session = new Session();
session.connect();
await session.post('HeapProfiler.startSampling', { samplingInterval: 2048 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < FRAMES; i++) step();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const { profile } = await session.post('HeapProfiler.stopSampling');
session.disconnect();

// Roll the sampled call tree up to one row per (function, file:line).
const rows = new Map();
let total = 0;
const walk = (node) => {
  const f = node.callFrame;
  const self = (node.selfSize ?? 0);
  if (self) {
    const file = (f.url || '?').replace(/^.*\/sim-taxi\//, '');
    const key = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`;
    rows.set(key, (rows.get(key) ?? 0) + self);
    total += self;
  }
  for (const c of node.children ?? []) walk(c);
};
walk(profile.head);

const sorted = [...rows].sort((a, b) => b[1] - a[1]);
console.log(`${CARS} cars · ${FRAMES} frames · ${ms.toFixed(0)}ms (${(ms / FRAMES).toFixed(3)}ms/frame)`);
console.log(`sampled allocation: ${(total / 1024).toFixed(0)} KiB total · `
  + `${(total / FRAMES).toFixed(0)} B/frame · ${(total / FRAMES * 60 / 1024).toFixed(0)} KiB/s at 60fps`);
console.log('');
for (const [key, bytes] of sorted.slice(0, 30)) {
  console.log(`${String(Math.round(bytes / FRAMES)).padStart(7)} B/frame  ${(bytes / total * 100).toFixed(1).padStart(5)}%  ${key}`);
}
