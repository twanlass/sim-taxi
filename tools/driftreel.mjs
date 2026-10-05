/**
 * Films the drift for its New Move card (game/driftclip.js): the shipped taxi driven by the shipped
 * traffic model and Loco Mode (game/boost.js) into a left turn off a side street, with the pedals
 * pressed on the card's own timeline — Loco, a tap of the brake just before the corner, Loco again
 * mid-slide (`driftTaxi` / `kickDrift` in sim/traffic.js, and holdBrake / holdLocoMode in main.js).
 * What it records is what the renderer is handed — the taxi group's transform, the wheel lock, the
 * brake lamp, the flame and the rubber — sixty times a second, into src/game/driftreel.js, which
 * the card plays back on a matching corner of the player's city.
 *
 * Why a recording and not the sim, and why it is checked: tools/uturnreel.mjs, which this follows.
 * The difference is the road. A drift needs a corner, so the take is not on the passing lab's
 * straight but on a grid of side streets with the lights taken out (a red would stop the take), and
 * the reel is written in the corner's own frame — along the approach from the junction's centre and
 * across it, + to the driver's right — so the card can lay it on any junction whose turn is the same
 * shape. That shape is written down with it (`turn`) and the card's corner picker matches on it.
 *
 *   node tools/driftreel.mjs           # check the committed reel against a fresh take
 *   node tools/driftreel.mjs --write   # film it and write src/game/driftreel.js
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { setCityNetwork, cityNetwork, roadNetFromGrid } from '../src/city/roadnet.js';
import { createTraffic, placeCar, SPEED, DRIFT_MIN_V } from '../src/sim/traffic.js';
import { driftTaxi, kickDrift } from '../src/sim/traffic.js';
import { createBoost } from '../src/game/boost.js';
import { createBootleg } from '../src/game/bootleg.js';
import { DIR } from '../src/city/grid.js';
import {
  BOOST_ON, TAP, TAP_LEN, KICK_ON, CLIP_LOOP,
} from '../src/game/driftclip.js';

const OUT = new URL('../src/game/driftreel.js', import.meta.url);
const STEP = 1 / 60;
// main.js's own (BRAKE_SKID_V, LAUNCH_SKID_TIME, the 0.42 stamp spacing in `layRubber`).
const BRAKE_SKID_V = 2.5;
const LAUNCH_SKID_TIME = 0.5;
const STAMP_EVERY = 0.42;

// A city of side streets and nothing else: no arterials, no parks, no river, and no lights. The
// corner is (2, 5) — the taxi comes in eastbound along line 5 from the ring and turns left, north,
// up line 2, which leaves it five blocks of straight to come out of the corner on.
const net = setCityNetwork(roadNetFromGrid({}));
for (const node of net.nodes) { node.signal = null; node.uncontrolled = true; }
const CORNER = { i: 2, j: 5 };
const node = net.nodeByGrid(CORNER.i, CORNER.j);
const inLane = net.laneByGrid(DIR.PX, CORNER.i, CORNER.j);
const outLane = net.laneOutByGrid(DIR.NZ, CORNER.i, CORNER.j);
const turn = inLane.exits.map((id) => net.turnById.get(id)).find((t) => t.outLane === outLane.id);
if (inLane.klass !== 'side' || outLane.klass !== 'side' || turn?.hand !== 'left') {
  console.error('driftreel: the corner is not a side-street left turn');
  process.exit(1);
}

/** One take, with the taxi starting `back` units short of the corner's junction. */
function film(back) {
  const traffic = createTraffic(makeRng(4242), new THREE.Scene(), 1, 1, 0);
  const taxi = traffic.taxi;
  const boost = createBoost();
  const bootleg = createBootleg({ taxi });
  boost.topUp(1);
  for (let n = 0; n < 600; n++) boost.update(STEP);
  if (!placeCar(taxi, DIR.PX, CORNER.i, CORNER.j, back)) return null;
  taxi.v = SPEED;

  const g = traffic.taxiGroup;
  let brakeHeld = false;
  let driftHoldOff = false;
  let launchSkidT = 0;
  let lastStamp = 0;
  let driftedAt = null;
  let kickedAt = null;
  let turnedAt = null;
  const frames = [];
  const rubber = [];
  const bursts = [];
  const stamp = (kind) => { rubber.push([frames.length, taxi.x, taxi.z, taxi.yaw, kind]); };
  const burst = () => { bursts.push([frames.length, taxi.x, taxi.z, taxi.yaw]); };

  const pressLoco = () => {
    // holdLocoMode: the brake comes up, the kick is asked for, the pill goes down.
    brakeHeld = false;
    kickDrift(taxi);
    if (boost.press()) { taxi.wheelieT = 0; burst(); stamp(1); launchSkidT = LAUNCH_SKID_TIME; }
  };
  const tapBrake = () => {
    // holdBrake's drift branch: Loco Mode, at speed, a turn just ahead.
    brakeHeld = true;
    if (boost.isEngaged() && driftTaxi(taxi) === null) {
      bootleg.reset();
      driftHoldOff = true;
      boost.release();
      stamp(2);
      driftedAt = frames.length;
      return;
    }
    boost.release();
  };
  const crossed = (t, at) => t <= at && t + STEP > at;

  let drifts = 0;
  let routed = null;
  for (let n = 0; n * STEP < CLIP_LOOP - 1e-9; n++) {
    const t = n * STEP;
    if (crossed(t, BOOST_ON)) pressLoco();
    if (crossed(t, TAP)) tapBrake();
    if (crossed(t, TAP + TAP_LEN)) brakeHeld = false;
    if (crossed(t, KICK_ON)) pressLoco();

    boost.update(STEP);
    taxi.boost = boost.isEngaged();
    taxi.boostEasing = boost.isCoolingDown();
    const bootlegBrake = bootleg.update(STEP, { brakeHeld });
    if (!brakeHeld) driftHoldOff = false;
    const drifting = taxi.drift && taxi.drift.phase !== 'carry';
    taxi.braking = bootlegBrake && !driftHoldOff && !drifting;
    // Straight on to the corner, round it, then straight on up line 2 — handed over once per lane,
    // as the router would, rather than re-planned every frame.
    if (taxi.lane.id !== routed) {
      routed = taxi.lane.id;
      const ahead = taxi.d === DIR.PX ? CORNER.i - net.nodeById.get(taxi.lane.to).gi : 0;
      if (taxi.d === DIR.PX) taxi.route = [...Array(Math.max(0, ahead)).fill(DIR.PX), DIR.NZ, DIR.NZ, DIR.NZ];
    }
    while (taxi.route.length < 3) taxi.route.push(DIR.NZ);
    traffic.update(STEP);
    // The landed kick: main.js's `driftsPaid` — the bark out of the pipe.
    if (turnedAt == null && taxi.state === 'turn' && taxi.dOut !== taxi.d) turnedAt = frames.length;
    if (taxi.drifts > drifts) { drifts = taxi.drifts; kickedAt = frames.length; burst(); }

    // layRubber: the corner, the launch, and the drift's four wheels.
    if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - STEP);
    const cornering = taxi.boost && taxi.state === 'turn' && taxi.dOut !== taxi.d
      && Math.min(taxi.turnT, 1) * taxi.turnLen > taxi.leadIn;
    const launching = taxi.boost && launchSkidT > 0;
    const skidding = (taxi.braking && taxi.v > BRAKE_SKID_V) || (taxi.drift && taxi.drift.phase !== 'carry');
    if (!cornering && !launching && !skidding) lastStamp = taxi.travelled;
    else if (taxi.travelled - lastStamp >= STAMP_EVERY) { lastStamp = taxi.travelled; stamp(skidding ? 2 : 1); }

    // The flame: 0 out, 1 lit, 2 the kick's twin plume.
    const flame = !boost.isActive() ? 0 : taxi.drift?.phase === 'carry' ? 2 : 1;
    frames.push([
      g.position.x, g.position.z, g.position.y,
      g.rotation.x, g.rotation.y, g.rotation.z,
      taxi.wheelAngle, taxi.brakeLevel, flame,
    ]);
  }
  return {
    frames, rubber, bursts, driftedAt, kickedAt, turnedAt, crashed: taxi.crashed,
    onExit: taxi.lane.id === outLane.id || net.dirOfLane(taxi.lane) === DIR.NZ,
  };
}

// Where to start: the take whose tap starts a drift on the frame it lands, whose kick lands, and
// whose tap comes TAP_LEAD before the car starts into the corner. The game takes the tap up to
// ~0.6s out, but a slide that runs a long way in a straight line before the turn reads as the tap
// doing something else; this close, the press and the corner are one thing. The pill goes back
// down mid-arc (KICK_ON), and is held to the end of the loop: let go, the brake lamps come on as
// the car eases off the boost, which would be a brake the pedal row never pressed.
const TAP_LEAD = 0.2;
let best = null;
for (let back = 14; back < 60; back += 0.25) {
  const take = film(back);
  if (!take || take.crashed || take.driftedAt == null || take.kickedAt == null || !take.onExit) continue;
  if (take.turnedAt == null || take.turnedAt < take.driftedAt) continue;
  const off = Math.abs((take.turnedAt - take.driftedAt) * STEP - TAP_LEAD);
  if (!best || off < best.off) best = { back, off, take };
}
if (!best) { console.error('driftreel: no take drifted on the tap'); process.exit(1); }

// The corner's frame: origin the junction's centre, along the approach (east), lateral to its
// right (+z). The sim keeps yaw in ±π; it is unwrapped so the turn interpolates the short way.
const r = (v) => Math.round(v * 1000) / 1000;
const unwrap = (prev, yaw) => yaw + Math.round((prev - yaw) / (2 * Math.PI)) * 2 * Math.PI;
const local = (x, z) => [x - node.x, z - node.z];
let yawWas = 0;
const p = (u) => local(turn.path.at(u * turn.length).x, turn.path.at(u * turn.length).z).map(r);
const reel = {
  step: STEP,
  hand: turn.hand,
  // The turn's shape, entry, middle and exit, in the corner's frame: what a city corner has to match.
  turn: [...p(0), ...p(0.5), ...p(1)],
  frames: best.take.frames.map((f) => {
    yawWas = unwrap(yawWas, f[4]);
    return [...local(f[0], f[1]), f[2], f[3], yawWas, ...f.slice(5)].map(r);
  }),
  rubber: best.take.rubber.map((s) => [s[0], ...local(s[1], s[2]), unwrap(0, s[3]), s[4]].map(r)),
  bursts: best.take.bursts.map((s) => [s[0], ...local(s[1], s[2]), unwrap(0, s[3])].map(r)),
};
const source = `// Generated by tools/driftreel.mjs — do not edit; run \`node tools/driftreel.mjs --write\`.
//
// The drift as the shipped traffic model drives it — Loco, a tap of the brake just before a left
// turn, Loco again mid-slide — filmed on a grid of side streets with the pedals pressed on the New
// Move card's timeline (game/driftclip.js). In the corner's own frame: along the approach from the
// junction's centre, lateral across it (+ is the driver's right). One row per frame at 60Hz:
// [along, lateral, y, roll, yaw, pitch, wheel, brake, flame] — the taxi group's transform, yaw from
// the approach's heading and unwrapped, the front-wheel lock, the brake lamp and the flame (0 out,
// 1 lit, 2 the kick's twin plume). \`rubber\` is [frame, along, lateral, yaw, kind] per skid stamp
// (1 the rear pair, 2 all four); \`bursts\` [frame, along, lateral, yaw] per bark out of the pipe.
// \`turn\` is the corner's shape — its entry, middle and exit — which a city corner must match.
export const REEL = ${JSON.stringify(reel)};
`;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, source);
  console.log(`wrote ${reel.frames.length} frames, ${reel.rubber.length} stamps (start ${best.back} back)`);
  process.exit(0);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
let committed = '';
try { committed = fs.readFileSync(OUT, 'utf8'); } catch { /* missing: fails below */ }
check('the committed reel is the shipped drift', committed === source,
  committed === source ? '' : 'the sim has changed under it; run node tools/driftreel.mjs --write');
const yaw0 = reel.frames[0][4];
const yaw1 = reel.frames[reel.frames.length - 1][4];
// Within the swing's last rock: the drift is still settling as the loop fades.
check('it turns the car left', Math.abs(yaw1 - yaw0 - Math.PI / 2) < 0.15, `${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
check('drifts on the tap', best.take.driftedAt - Math.round(TAP / STEP) <= 1, `frame ${best.take.driftedAt}`);
const n = Math.round(TAP / STEP);
const v = (reel.frames[n][0] - reel.frames[n - 1][0]) / STEP;
check('at drifting speed', v >= DRIFT_MIN_V, `${v.toFixed(1)} u/s at the tap`);
check('and kicks out of it', reel.frames.some((f) => f[8] === 2), `kick at frame ${best.take.kickedAt}`);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
