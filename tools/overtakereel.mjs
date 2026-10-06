/**
 * Films the overtake for its New Move card (game/overtakeclip.js): the shipped taxi behind a car on
 * the passing lab's straight road (src/lab/labroad.js), driven by the shipped traffic model, Loco
 * Mode (game/boost.js) and the overtake combo (game/overtake.js), with the pill pressed, blipped and
 * pressed again on the card's own timeline. Both cars are recorded — the taxi as the renderer is
 * handed it, the car being passed by where it is — sixty times a second, into
 * src/game/overtakereel.js, which the card plays back on a street in the player's city.
 *
 * Why a recording, and why it is checked: tools/uturnreel.mjs, which this follows.
 *
 *   node tools/overtakereel.mjs           # check the committed reel against a fresh take
 *   node tools/overtakereel.mjs --write   # film it and write src/game/overtakereel.js
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { setCityNetwork, cityNetwork } from '../src/city/roadnet.js';
import { createTraffic, placeCar, SPEED } from '../src/sim/traffic.js';
import { createCollisions, TAXI_HP } from '../src/sim/collisions.js';
import { createBoost } from '../src/game/boost.js';
import { createOvertakeCombo } from '../src/game/overtake.js';
import { DIR, PITCH, HALF_ROAD } from '../src/city/grid.js';
import { labNetwork, labNodeX, LAB_BLOCKS } from '../src/lab/labroad.js';
import { PRE_ROLL, BLIP_OFF, BLIP_ON, CLIP_LOOP } from '../src/game/overtakeclip.js';

const OUT = new URL('../src/game/overtakereel.js', import.meta.url);
const STEP = 1 / 60;
// main.js's own: a launch breaks traction for this long, and the stamp spacing in `layRubber`.
const LAUNCH_SKID_TIME = 0.5;
const STAMP_EVERY = 0.42;

setCityNetwork(labNetwork(LAB_BLOCKS));

/** `placeAtX` in the lab: onto the block's eastbound lane at x, clamped off the junctions. */
function placeAt(car, x) {
  const block = Math.floor((x - labNodeX(0)) / PITCH);
  const from = labNodeX(block) + HALF_ROAD;
  const at = Math.min(labNodeX(block + 1) - HALF_ROAD, Math.max(from, x));
  const lane = cityNetwork().laneByGrid(DIR.PX, block + 1);
  placeCar(car, DIR.PX, block + 1, 0, lane.length - (at - from));
  car.v = SPEED;
  car.route = [];
}

/** One take: the taxi at `start` units along the road, the car `gap` units in front of it. */
function film(start, gap) {
  const traffic = createTraffic(makeRng(4242), new THREE.Scene(), 2, 2, 0);
  const [taxi, lead] = traffic.cars;
  const x0 = labNodeX(0) + start;
  placeAt(taxi, x0);
  placeAt(lead, x0 + gap);
  taxi.hp = TAXI_HP;
  const collisions = createCollisions(traffic.cars, taxi);
  let bumps = 0;
  collisions.onBump(() => { bumps += 1; });
  const boost = createBoost();
  boost.topUp(1);
  for (let n = 0; n < 600; n++) boost.update(STEP);
  const combo = createOvertakeCombo({ taxi });

  const g = traffic.taxiGroup;
  let launchSkidT = 0;
  let lastStamp = 0;
  let pulledOut = null;
  let peak = 0;
  const frames = [];
  const lane = [];
  const rubber = [];
  const bursts = [];
  const stamp = (kind) => { rubber.push([frames.length, taxi.x, taxi.z, taxi.yaw, kind]); };
  // A launch fires the bark and the wheelie — `kickLocoMode` — and the blip's re-press is a
  // fresh press out of the cooldown, so it does too. The pre-roll's own is off camera.
  const press = () => {
    if (boost.press()) {
      taxi.wheelieT = 0;
      launchSkidT = LAUNCH_SKID_TIME;
      if (frames.length) { bursts.push([frames.length, taxi.x, taxi.z, taxi.yaw]); stamp(1); }
    }
  };
  // Counted in whole frames: `n * STEP - PRE_ROLL` lands a hair either side of a timeline mark, and a
  // `t <= at < t + STEP` test then skips it outright.
  const pre = Math.round(PRE_ROLL / STEP);
  const at = (t) => pre + Math.round(t / STEP);

  // The pre-roll: Loco Mode down and up to speed, unrecorded.
  for (let n = 0; n < pre + Math.round(CLIP_LOOP / STEP); n++) {
    const rolling = n >= pre;
    if (n === 0 || n === at(BLIP_ON)) press();
    if (n === at(BLIP_OFF)) boost.release();

    boost.update(STEP);
    taxi.boost = boost.isEngaged();
    taxi.boostEasing = boost.isCoolingDown();
    combo.update(STEP, { held: boost.isActive() });
    // The lab's one exit, handed back as a route (see docs/lab.md).
    while (taxi.route.length < 3) taxi.route.push(taxi.d);
    while (lead.route.length < 3) lead.route.push(lead.d);
    traffic.update(STEP);
    collisions.update(STEP);
    if (taxi.passing && pulledOut == null) pulledOut = rolling ? frames.length : -1;
    peak = Math.max(peak, taxi.pass);

    // layRubber: the launch and the overtake's own two faint dots.
    if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - STEP);
    const launching = taxi.boost && launchSkidT > 0;
    if (!launching) lastStamp = taxi.travelled;
    else if (taxi.travelled - lastStamp >= STAMP_EVERY) { lastStamp = taxi.travelled; if (rolling) stamp(1); }

    if (!rolling) continue;
    frames.push([
      g.position.x, g.position.z, g.position.y,
      g.rotation.x, g.rotation.y, g.rotation.z,
      taxi.wheelAngle, taxi.brakeLevel, boost.isActive() ? 1 : 0,
    ]);
    lane.push([lead.x, lead.z, lead.yaw, lead.brakeLevel ?? 0]);
  }
  const back = taxi.pass < 0.02;
  const ahead = taxi.x - lead.x;
  return { arms: combo.state.arms, frames, lane, rubber, bursts, bumps, pulledOut, peak, back, ahead, crashed: taxi.crashed };
}

// The take: no contact, the pull-out on the blip's heels, all the way out and back in again by the
// end of the loop, and finishing a couple of car lengths past the car — clearly by, without the
// taxi running so far up the road that the frame has to shrink both cars to hold it.
const AHEAD = 6;
let best = null;
for (let start = 10; start < 60; start += 2) {
  for (let gap = 8; gap <= 30; gap += 0.5) {
    const take = film(start, gap);
    if (take.crashed || take.bumps || take.pulledOut == null || take.pulledOut < 0) continue;
    if (take.peak < 0.99 || !take.back) continue;
    if ((take.pulledOut - Math.round(BLIP_ON / STEP)) * STEP > 0.4) continue;
    const off = Math.abs(take.ahead - AHEAD);
    if (!best || off < best.off) best = { start, gap, off, score: take.ahead, take };
  }
}
if (!best) { if (process.env.DBG) for (const gap of [26, 30, 36, 42]) { const k = film(30, gap); console.log(gap, k.arms, k.bumps, k.pulledOut, k.peak.toFixed(2), k.back, k.ahead.toFixed(1)); } console.error("overtakereel: no take passed cleanly"); process.exit(1); }

const r = (v) => Math.round(v * 1000) / 1000;
const along0 = best.take.frames[0][0];
const unwrap = (prev, yaw) => yaw + Math.round((prev - yaw) / (2 * Math.PI)) * 2 * Math.PI;
let yawWas = 0;
let leadYawWas = 0;
const reel = {
  step: STEP,
  frames: best.take.frames.map((f) => {
    yawWas = unwrap(yawWas, f[4]);
    return [f[0] - along0, f[1], f[2], f[3], yawWas, ...f.slice(5)].map(r);
  }),
  lead: best.take.lane.map((f) => {
    leadYawWas = unwrap(leadYawWas, f[2]);
    return [f[0] - along0, f[1], leadYawWas, f[3]].map(r);
  }),
  rubber: best.take.rubber.map((s) => [s[0], s[1] - along0, s[2], unwrap(0, s[3]), s[4]].map(r)),
  bursts: best.take.bursts.map((s) => [s[0], s[1] - along0, s[2], unwrap(0, s[3])].map(r)),
};
const source = `// Generated by tools/overtakereel.mjs — do not edit; run \`node tools/overtakereel.mjs --write\`.
//
// The overtake as the shipped traffic model drives it — Loco Mode behind a slower car, a blip off
// the pill and back on (game/overtake.js), and round it — filmed on the passing lab's straight road
// with the pedals pressed on the New Move card's timeline (game/overtakeclip.js). One row per frame
// at 60Hz: [along, lateral, y, roll, yaw, pitch, wheel, brake, flame] — the taxi group's transform,
// along measured from the taxi's first frame and lateral from the road's centreline (+ is the
// driver's right), yaw from due east and unwrapped, the front-wheel lock, the brake lamp and whether
// the Loco Mode flame is lit. \`lead\` is the car being passed, one row per frame:
// [along, lateral, yaw, brake]. \`rubber\` is [frame, along, lateral, yaw, kind] per skid stamp;
// \`bursts\` [frame, along, lateral, yaw] per bark out of the pipe.
export const REEL = ${JSON.stringify(reel)};
`;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, source);
  console.log(`wrote ${reel.frames.length} frames (start ${best.start}, gap ${best.gap}, ${best.score.toFixed(1)} ahead)`);
  process.exit(0);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
let committed = '';
try { committed = fs.readFileSync(OUT, 'utf8'); } catch { /* missing: fails below */ }
check('the committed reel is the shipped overtake', committed === source,
  committed === source ? '' : 'the sim has changed under it; run node tools/overtakereel.mjs --write');
check('it pulls out on the blip', (best.take.pulledOut - Math.round(BLIP_ON / STEP)) * STEP <= 0.4,
  `frame ${best.take.pulledOut}`);
check('goes all the way out and back without touching the car',
  best.take.peak >= 0.99 && best.take.back && best.take.bumps === 0);
check('and ends up in front of it', best.score > 4, `${best.score.toFixed(1)} units ahead`);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
