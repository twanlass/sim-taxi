/**
 * Films the U-turn for the New Move card (game/uturnclip.js): the shipped taxi, on the passing lab's
 * straight road (src/lab/labroad.js), driven by the shipped traffic model, Loco Mode
 * (game/boost.js) and bootleg (game/bootleg.js) with the pedals pressed on the card's own timeline.
 * What it records is what the renderer is handed — the taxi group's transform, the wheel lock, the
 * brake lamp, the flame and the rubber — sixty times a second, into src/game/uturnreel.js, which
 * the card plays back on a street in the player's city.
 *
 * Why a recording and not the sim itself. The card opens with the world frozen, and the traffic
 * model keeps state at module scope (the priority junction a boosting taxi claims, the closed lanes,
 * the grip), so a second, private traffic instance running in the page would write over the real
 * one's. A first version faked the move with a hand-written timeline instead, and it read as fake —
 * faster than the game's spin, and rocking where the game's car does not (Tyler, 2026-10-04).
 *
 * So the reel is checked rather than trusted: `npm run check` films it again and fails if it no
 * longer matches the file, which is what keeps it the game's U-turn after the sim is retuned.
 *
 *   node tools/uturnreel.mjs           # check the committed reel against a fresh take
 *   node tools/uturnreel.mjs --write   # film it and write src/game/uturnreel.js
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { setCityNetwork, cityNetwork } from '../src/city/roadnet.js';
import { createTraffic, placeCar, SPEED } from '../src/sim/traffic.js';
import { createBoost } from '../src/game/boost.js';
import { createBootleg } from '../src/game/bootleg.js';
import { DIR, PITCH, HALF_ROAD } from '../src/city/grid.js';
import { labNetwork, labNodeX, LAB_BLOCKS } from '../src/lab/labroad.js';
import { BOOST_ON, BOOST_OFF, TAP_1, TAP_2, TAP_LEN, CLIP_LOOP } from '../src/game/uturnclip.js';

const OUT = new URL('../src/game/uturnreel.js', import.meta.url);
const STEP = 1 / 60;
// main.js's own: the brake marks the road above this speed, and a launch breaks traction for this
// long (BRAKE_SKID_V, LAUNCH_SKID_TIME, and the 0.42 stamp spacing in `layRubber`).
const BRAKE_SKID_V = 2.5;
const LAUNCH_SKID_TIME = 0.5;
const STAMP_EVERY = 0.42;

setCityNetwork(labNetwork(LAB_BLOCKS));

/** One take, with the taxi starting `start` units along the eastbound carriageway. */
function film(start) {
  const traffic = createTraffic(makeRng(4242), new THREE.Scene(), 1, 1, 0);
  const taxi = traffic.taxi;
  const boost = createBoost();
  const bootleg = createBootleg({ taxi });
  // A full tank, so the hold is never cut short by fuel.
  boost.topUp(1);
  for (let n = 0; n < 600; n++) boost.update(STEP);

  // `placeAtX` in the lab: onto the block's lane, clamped off the junctions.
  const block = Math.floor(start / PITCH);
  const from = labNodeX(block) + HALF_ROAD;
  const at = Math.min(labNodeX(block + 1) - HALF_ROAD, Math.max(from, labNodeX(0) + start));
  const lane = cityNetwork().laneByGrid(DIR.PX, block + 1);
  placeCar(taxi, DIR.PX, block + 1, 0, lane.length - (at - from));
  taxi.v = SPEED;

  const g = traffic.taxiGroup;
  let brakeHeld = false;
  let launchSkidT = 0;
  let lastStamp = 0;
  let spunAt = null;
  const frames = [];
  const rubber = [];
  const stamp = (kind) => { rubber.push([frames.length, taxi.x, taxi.z, taxi.yaw, kind]); };

  const tapBrake = () => {
    // holdBrake in main.js: the press, the combo test with Loco Mode as it stood, the release.
    brakeHeld = true;
    const engaged = boost.isEngaged();
    if (bootleg.brakeTap({ engaged })) { boost.release(); if (spunAt == null) spunAt = frames.length; return; }
    boost.release();
    if (taxi.v > BRAKE_SKID_V) stamp(2);
  };
  const crossed = (t, at) => t <= at && t + STEP > at;

  for (let n = 0; n * STEP < CLIP_LOOP - 1e-9; n++) {
    const t = n * STEP;
    // The pedals, between frames as the input events are.
    if (crossed(t, BOOST_ON)) {
      brakeHeld = false;
      if (boost.press()) { taxi.wheelieT = 0; stamp(1); launchSkidT = LAUNCH_SKID_TIME; }
    }
    if (crossed(t, BOOST_OFF)) boost.release();
    if (crossed(t, TAP_1) || crossed(t, TAP_2)) tapBrake();
    if (crossed(t, TAP_1 + TAP_LEN) || crossed(t, TAP_2 + TAP_LEN)) brakeHeld = false;
    if (bootleg.state.spins && spunAt == null) spunAt = frames.length;

    // The frame loop's order: the tank, the flags, the bootleg's brake, then the sim.
    boost.update(STEP);
    taxi.boost = boost.isEngaged();
    taxi.boostEasing = boost.isCoolingDown();
    taxi.braking = bootleg.update(STEP, { brakeHeld });
    // The lab's one exit, handed back as a route (see docs/lab.md); a spin empties it.
    while (taxi.route.length < 3) taxi.route.push(taxi.d);
    traffic.update(STEP);

    // layRubber, minus the corners and the overtake, which a straight road never asks for.
    if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - STEP);
    const skidding = (taxi.braking && taxi.v > BRAKE_SKID_V) || taxi.uturn?.kind === 'spin';
    const launching = taxi.boost && launchSkidT > 0;
    if (!skidding && !launching) lastStamp = taxi.travelled;
    else if (taxi.travelled - lastStamp >= STAMP_EVERY) { lastStamp = taxi.travelled; stamp(skidding ? 2 : 1); }

    frames.push([
      g.position.x, g.position.z, g.position.y,
      g.rotation.x, g.rotation.y, g.rotation.z,
      taxi.wheelAngle, taxi.brakeLevel, boost.isActive() ? 1 : 0,
    ]);
  }
  return { frames, rubber, spunAt, crashed: taxi.crashed, refused: bootleg.state.refused };
}

// Where to start: the take whose second tap spins the car on the frame it lands — not buffered
// through a junction, which a player does not see as their tap — and lands it nearest the middle
// of the far lane's block, so the spin is clear of both crossings.
let best = null;
for (let start = 30; start < 70; start += 0.25) {
  const take = film(start);
  if (take.crashed || take.refused || take.spunAt == null) continue;
  const late = take.spunAt - Math.round(TAP_2 / STEP);
  if (late > 1) continue;
  const landed = take.frames[Math.min(take.frames.length - 1, take.spunAt + Math.round(0.45 / STEP))];
  const worldX = landed[0] + labNodeX(0) + start;
  const intoBlock = ((worldX - labNodeX(0)) % PITCH + PITCH) % PITCH;
  const off = Math.abs(intoBlock - PITCH / 2);
  if (!best || off < best.off) best = { start, off, take };
}
if (!best) { console.error('uturnreel: no take spun on the tap'); process.exit(1); }

// Along measured from where the car is on the first frame, and the yaw unwrapped — the sim keeps
// it in ±π, which jumps by a whole turn half way through the spin and would interpolate the long way
// round.
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
};
const source = `// Generated by tools/uturnreel.mjs — do not edit; run \`node tools/uturnreel.mjs --write\`.
//
// The U-turn as the shipped traffic model drives it, filmed on the passing lab's straight road with
// the pedals pressed on the New Move card's timeline (game/uturnclip.js). One row per frame at 60Hz:
// [along, lateral, y, roll, yaw, pitch, wheel, brake, flame] — the taxi group's transform, along
// measured from the first frame and lateral from the road's centreline (+ is the driver's right),
// yaw from due east and unwrapped, the front-wheel lock, the brake lamp and whether the Loco Mode flame is lit. \`rubber\` is
// [frame, along, lateral, yaw, kind] per skid stamp: 1 the rear pair, 2 all four.
export const REEL = ${JSON.stringify(reel)};
`;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, source);
  console.log(`wrote ${reel.frames.length} frames, ${reel.rubber.length} stamps (start ${best.start})`);
  process.exit(0);
}

// The check: the committed reel is this take.
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
let committed = '';
try { committed = fs.readFileSync(OUT, 'utf8'); } catch { /* missing: fails below */ }
check('the committed reel is the shipped U-turn', committed === source,
  committed === source ? '' : 'the sim has changed under it; run node tools/uturnreel.mjs --write');
const yaw0 = reel.frames[0][4];
const yaw1 = reel.frames[reel.frames.length - 1][4];
check('it turns the car round', Math.abs(Math.abs(yaw1 - yaw0) - Math.PI) < 0.05,
  `${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
check('from its own lane to the far one',
  reel.frames[0][1] > 0 && reel.frames[reel.frames.length - 1][1] < 0);
check('and spins on the second tap', best.take.spunAt - Math.round(TAP_2 / STEP) <= 1,
  `frame ${best.take.spunAt}`);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
