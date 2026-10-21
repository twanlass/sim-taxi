/**
 * Films the burnout launch for its New Move card (game/burnoutclip.js): the shipped taxi on the
 * passing lab's straight road (src/lab/labroad.js), driven by the shipped traffic model, Loco Mode
 * (game/boost.js) and the burnout (game/burnout.js), with the pedals pressed on the card's own
 * timeline. Recorded sixty times a second into src/game/burnoutreel-<width>.js, which the card
 * plays back on a street in the player's city.
 *
 * Why a recording, and why it is checked: tools/uturnreel.mjs, which this follows.
 *
 *   node tools/burnoutreel.mjs           # check the committed reel against a fresh take
 *   node tools/burnoutreel.mjs --write   # film it and write src/game/burnoutreel-<width>.js
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { setCityNetwork, cityNetwork } from '../src/city/roadnet.js';
import { createTraffic, placeCar, SPEED } from '../src/sim/traffic.js';
import { createBoost } from '../src/game/boost.js';
import { createBurnout, BURNOUT_SKID_TIME } from '../src/game/burnout.js';
import { DIR, PITCH, HALF_ROAD, STREETS_KEY } from '../src/city/grid.js';
import { labNetwork, labNodeX, LAB_BLOCKS } from '../src/lab/labroad.js';
import { BRAKE_ON, LOCO_ON, CLIP_LOOP } from '../src/game/burnoutclip.js';

const OUT = new URL(`../src/game/burnoutreel-${STREETS_KEY}.js`, import.meta.url);
const STEP = 1 / 60;
// main.js's own: the brake marks the road above this speed, and the stamp spacing in `layRubber`.
const BRAKE_SKID_V = 2.5;
const STAMP_EVERY = 0.42;

setCityNetwork(labNetwork(LAB_BLOCKS));

/** One take, with the taxi starting `start` units along the eastbound carriageway. */
function film(start) {
  const traffic = createTraffic(makeRng(4242), new THREE.Scene(), 1, 1, 0);
  const taxi = traffic.taxi;
  const boost = createBoost();
  boost.topUp(1);
  for (let n = 0; n < 600; n++) boost.update(STEP);
  const burnout = createBurnout({ taxi, unlocked: () => true });

  const block = Math.floor(start / PITCH);
  const from = labNodeX(block) + HALF_ROAD;
  const at = Math.min(labNodeX(block + 1) - HALF_ROAD, labNodeX(0) + start);
  const lane = cityNetwork().laneByGrid(DIR.PX, block + 1);
  placeCar(taxi, DIR.PX, block + 1, 0, lane.length - (at - from));
  taxi.v = SPEED;

  const g = traffic.taxiGroup;
  let brakeHeld = false;
  let launchSkidT = 0;
  let lastStamp = 0;
  let launched = null;
  let stopX = null;
  const frames = [];
  const rubber = [];
  const bursts = [];
  const stamp = (kind) => { rubber.push([frames.length, taxi.x, taxi.z, taxi.yaw, kind]); };
  const crossed = (t, mark) => t <= mark && t + STEP > mark;

  for (let n = 0; n * STEP < CLIP_LOOP - 1e-9; n++) {
    const t = n * STEP;
    if (crossed(t, BRAKE_ON)) {
      brakeHeld = true;
      boost.release();
      if (taxi.v > BRAKE_SKID_V) stamp(2);
    }
    if (crossed(t, LOCO_ON)) {
      // holdLocoMode: the burnout reads the brake before the press lets go of it.
      const launch = burnout.press();
      brakeHeld = false;
      if (boost.press()) {
        taxi.wheelieT = 0;
        bursts.push([frames.length, taxi.x, taxi.z, taxi.yaw]);
        stamp(1);
        if (launch !== null) { launched = frames.length; launchSkidT = BURNOUT_SKID_TIME; }
      } else if (launch !== null) burnout.cancel();
    }

    boost.update(STEP);
    burnout.update(STEP, { brakeHeld });
    taxi.boost = boost.isEngaged();
    taxi.boostEasing = boost.isCoolingDown();
    taxi.braking = brakeHeld;
    while (taxi.route.length < 3) taxi.route.push(taxi.d);
    traffic.update(STEP);
    if (brakeHeld && taxi.v === 0 && stopX == null) stopX = taxi.x;

    if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - STEP);
    const skidding = taxi.braking && taxi.v > BRAKE_SKID_V;
    const launching = taxi.boost && launchSkidT > 0;
    if (!skidding && !launching) lastStamp = taxi.travelled;
    else if (taxi.travelled - lastStamp >= STAMP_EVERY) { lastStamp = taxi.travelled; stamp(skidding ? 2 : 1); }

    frames.push([
      g.position.x, g.position.z, g.position.y,
      g.rotation.x, g.rotation.y, g.rotation.z,
      taxi.wheelAngle, taxi.brakeLevel, boost.isActive() ? 1 : 0,
    ]);
  }
  return { frames, rubber, bursts, launched, stopX, crashed: taxi.crashed, launches: burnout.state.launches };
}

// Where to start: the take that stops the car nearest the middle of a block, so the standstill and
// the launch are both clear of the junctions.
let best = null;
for (let start = 20; start < 60; start += 0.25) {
  const take = film(start);
  if (take.crashed || take.launched == null || take.stopX == null) continue;
  const intoBlock = ((take.stopX - labNodeX(0)) % PITCH + PITCH) % PITCH;
  const off = Math.abs(intoBlock - PITCH * 0.3);
  if (!best || off < best.off) best = { start, off, take };
}
if (!best) { console.error('burnoutreel: no take launched'); process.exit(1); }

const r = (v) => Math.round(v * 1000) / 1000;
const along0 = best.take.frames[0][0];
const unwrap = (prev, yaw) => yaw + Math.round((prev - yaw) / (2 * Math.PI)) * 2 * Math.PI;
let yawWas = 0;
const reel = {
  step: STEP,
  frames: best.take.frames.map((f) => {
    yawWas = unwrap(yawWas, f[4]);
    return [f[0] - along0, f[1], f[2], f[3], yawWas, ...f.slice(5)].map(r);
  }),
  rubber: best.take.rubber.map((s) => [s[0], s[1] - along0, s[2], unwrap(0, s[3]), s[4]].map(r)),
  bursts: best.take.bursts.map((s) => [s[0], s[1] - along0, s[2], unwrap(0, s[3])].map(r)),
};
const source = `// Generated by tools/burnoutreel.mjs — do not edit; run \`node tools/burnoutreel.mjs --write\`.
//
// The burnout launch as the shipped traffic model drives it — a stop on the brake, held, then Loco
// Mode off it (game/burnout.js) — filmed on the passing lab's straight road with the pedals pressed
// on the New Move card's timeline (game/burnoutclip.js). One row per frame at 60Hz: [along,
// lateral, y, roll, yaw, pitch, wheel, brake, flame], as game/uturnreel-<width>.js. \`rubber\` is
// [frame, along, lateral, yaw, kind] per skid stamp; \`bursts\` [frame, along, lateral, yaw] per bark
// out of the pipe.
export const REEL = ${JSON.stringify(reel)};
`;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, source);
  console.log(`wrote ${reel.frames.length} frames, ${reel.rubber.length} stamps (start ${best.start})`);
  process.exit(0);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
let committed = '';
try { committed = fs.readFileSync(OUT, 'utf8'); } catch { /* missing: fails below */ }
check('the committed reel is the shipped burnout', committed === source,
  committed === source ? '' : 'the sim has changed under it; run node tools/burnoutreel.mjs --write');
check('it stops on the brake before the launch', best.take.stopX != null);
check('and the pill launches it', best.take.launches === 1 && best.take.launched === Math.round(LOCO_ON / STEP),
  `frame ${best.take.launched}`);
// The point of the move, measured: the same take with an ordinary press off the same stop.
const launchFrame = Math.round(LOCO_ON / STEP);
const quarter = Math.round(0.25 / STEP);
const gone = reel.frames[launchFrame + quarter][0] - reel.frames[launchFrame][0];
check('it is off the line harder than a plain press would be', gone > 2.6, `${gone.toFixed(2)} units in 0.25s`);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
