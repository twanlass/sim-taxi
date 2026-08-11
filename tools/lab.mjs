/**
 * Headless checks for the passing lab — see docs/lab.md.
 *
 * The lab exists to be *looked at*, which makes it exactly the kind of thing that quietly stops
 * working: nothing else imports `src/lab/`, so a change to the road network, to `placeCar`, or to
 * the overtake's own gates could leave the page loading a road the taxi never passes anything on
 * and nobody would find out until they opened it.
 *
 * So this asserts the two things the page is for. First that the world is what it claims — one
 * straight road, no signals anywhere on it. Then that the scenario resolves: a taxi staged behind
 * a cruising leader with the button held actually pulls out into the oncoming lane, gets past, and
 * comes back, without clipping the car it went round.
 *
 *   node tools/lab.mjs
 */

import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { setCityNetwork } from '../src/city/roadnet.js';
import { createTraffic, placeCar, SPEED, laysPassRubber } from '../src/sim/traffic.js';
import { createCollisions } from '../src/sim/collisions.js';
import { DIR, dirSign, PITCH, HALF_ROAD, LANE } from '../src/city/grid.js';
import { labNetwork, labRoadLength, labNodeX, labTreeBlocks, LAB_BLOCKS } from '../src/lab/labroad.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const net = setCityNetwork(labNetwork(LAB_BLOCKS));

// --- The world --------------------------------------------------------------

check('road is one straight chain',
  net.nodes.length === LAB_BLOCKS + 1 && net.edges.length === LAB_BLOCKS
  && net.chains.length === 1,
  `${net.nodes.length} junctions, ${net.edges.length} roads, ${net.chains.length} chain`);

const signalised = net.nodes.filter((n) => n.signal).length;
check('no traffic lights anywhere', signalised === 0, `${signalised} signalised junctions`);

check('road is the length it says it is',
  Math.abs(labNodeX(LAB_BLOCKS) - labNodeX(0) - labRoadLength()) < 1e-9,
  `${labRoadLength()} units`);

// Both carriageways exist, on the right-hand side of their own travel direction, at the same lane
// offset the city uses. A lab whose lanes sat somewhere else would be measuring a different road.
const east = net.laneByGrid(DIR.PX, 3);
const west = net.laneByGrid(DIR.NX, 3);
check('two-way, right-hand traffic, city lane offset',
  Math.abs(east.path.at(0).z - LANE) < 1e-9 && Math.abs(west.path.at(0).z + LANE) < 1e-9,
  `eastbound z=${east.path.at(0).z}, westbound z=${west.path.at(0).z}`);

// Every interior junction is a straight-through crossing and nothing else, which is what keeps
// the overdrive band reachable: a real turn clamps to `cruise` and sheds the whole band.
const exits = net.lanes.filter((l) => !l.degenerate).flatMap((l) => l.exits);
const hands = new Set(exits.map((id) => net.turnById.get(id).hand));
check('every junction movement is straight on',
  hands.size === 1 && hands.has('straight'), [...hands].join(', '));

check('junction geometry matches the city',
  Math.abs(east.length - (PITCH - 8)) < 1e-9
  && Math.abs(net.turnById.get(east.exits[0]).length - 8) < 1e-9,
  `${east.length}-unit lanes, ${net.turnById.get(east.exits[0]).length}-unit junctions`);

check('verge tree strips flank the road', (() => {
  const strips = labTreeBlocks(LAB_BLOCKS);
  return strips.length === LAB_BLOCKS * 2
    && strips.every((s) => s.type === 'park' && s.bounds.z1 > s.bounds.z0)
    && strips.some((s) => s.bounds.cz > 0) && strips.some((s) => s.bounds.cz < 0);
})());

// --- The scenario -----------------------------------------------------------
//
// The same staging `lab/passing.js` does, with the same helper, driven at a fixed step.

/** Put `car` on the carriageway running `d`, at world x. Mirrors `placeAtX` in the lab. */
function placeAtX(car, d, x) {
  const block = Math.min(LAB_BLOCKS - 1,
    Math.max(0, Math.floor((x - labNodeX(0)) / PITCH)));
  const from = labNodeX(block) + HALF_ROAD;
  const to = labNodeX(block + 1) - HALF_ROAD;
  const at = Math.min(to, Math.max(from, x));
  const junction = dirSign(d) > 0 ? block + 1 : block;
  const lane = net.laneByGrid(d, junction);
  if (!lane) return false;
  return placeCar(car, d, junction, 0, lane.length - (dirSign(d) > 0 ? at - from : to - at));
}

const STEP = 1 / 60;

/**
 * One staged approach: taxi at `start` units into the road, one leader `gap` ahead of it, button
 * held for the whole run. Returns what the taxi managed and how close it came.
 */
function approach(gap, start) {
  const scene = new THREE.Scene();
  const traffic = createTraffic(makeRng(4242), scene, 2, 2, 0);
  const taxi = traffic.taxi;
  const leader = traffic.cars.find((c) => !c.isTaxi);
  const collisions = createCollisions(traffic.cars, taxi);
  let wrecked = false;
  collisions.onImpact(() => { wrecked = true; });

  placeAtX(taxi, DIR.PX, labNodeX(0) + start);
  placeAtX(leader, DIR.PX, labNodeX(0) + start + gap);
  taxi.v = SPEED;
  leader.v = SPEED;

  const out = {
    wrecked: false, passed: false, top: 0, maxLateral: 0, minApproach: Infinity,
    passedAt: null, tuckedAt: null, stationary: 0,
    // How the manoeuvre is *shaped*, not just whether it completed.
    bankHigh: 0, bankLow: 0,        // the roll rocks both ways per change; these are its extremes
    rubber: 0,                      // units of road laid with the wheels lit up
    changing: 0,                    // units of road spent actually moving sideways
    slopeJump: 0,                   // biggest one-frame jump in the crab angle
    stalled: 0,                     // frames displaced from the lane but not moving sideways
  };
  for (let n = 0; n < 60 * 30; n++) {
    taxi.boost = true;                          // the button, held
    taxi.boostEasing = false;
    // The road's only exit, handed back as a route — see `docs/lab.md`. Without it `room` in
    // traffic.js is false and the overtake is never offered at all.
    while (taxi.route.length < 3) taxi.route.push(taxi.d);

    const wasSlope = taxi.passSlope;
    const wasTravelled = taxi.travelled;

    traffic.update(STEP);
    collisions.update();

    const ds = taxi.travelled - wasTravelled;
    out.bankHigh = Math.max(out.bankHigh, taxi.passBank);
    out.bankLow = Math.min(out.bankLow, taxi.passBank);
    if (laysPassRubber(taxi)) out.rubber += ds;
    if (Math.abs(taxi.passSlope) > 0.001) out.changing += ds;
    out.slopeJump = Math.max(out.slopeJump, Math.abs(taxi.passSlope - wasSlope));
    // Displaced from the lane, boosting, and going nowhere sideways: the taxi parked half way
    // across the road. Excludes the settled state out in the borrowed lane, which is `pass === 1`.
    if (taxi.pass > 0.05 && taxi.pass < 0.95 && Math.abs(taxi.passSlope) < 0.001) out.stalled += 1;

    out.top = Math.max(out.top, taxi.v);
    out.maxLateral = Math.max(out.maxLateral, Math.abs(taxi.z - LANE));
    if (wrecked) { out.wrecked = true; break; }
    if (!leader.crashed) {
      out.minApproach = Math.min(out.minApproach,
        Math.hypot(taxi.x - leader.x, taxi.z - leader.z));
      if (out.passedAt === null && taxi.x > leader.x + 4) {
        out.passedAt = n * STEP;
        out.passed = true;
      }
    }
    if (out.passedAt !== null && out.tuckedAt === null && taxi.pass < 0.02) {
      out.tuckedAt = n * STEP;
    }
    if (taxi.v < 0.5) out.stationary += 1;
    if (taxi.x > labNodeX(LAB_BLOCKS) - 16) break;
  }
  return out;
}

const one = approach(22, 12);

check('the taxi reaches the overdrive band on the straight', one.top > SPEED * 2.2,
  `${one.top.toFixed(1)} u/s`);
// A pass is a full lane change into the oncoming lane — 2·LANE of offset. Anything less means
// the taxi merely weaved, which is what the mode does when it is *not* going round anything.
check('it commits the whole lane', one.maxLateral > 2 * LANE - 0.6,
  `${one.maxLateral.toFixed(2)} units off its lane centre`);
check('it gets past the car in front', one.passed,
  one.passed ? `at ${one.passedAt.toFixed(1)}s` : 'never drew level');
check('and tucks back in', one.tuckedAt !== null,
  one.tuckedAt === null ? 'still out at the end of the road' : `at ${one.tuckedAt.toFixed(1)}s`);
// `sim/collisions.js` puts the summed envelope at 2.31 units, so that is the bar: at or under it
// the pass is a wreck rather than an overtake.
check('without clipping it', !one.wrecked && one.minApproach > 2.31,
  `closest approach ${one.minApproach.toFixed(2)} units against a 2.31 envelope`);
check('and nothing stops it', one.stationary === 0, `${one.stationary} stationary frames`);

// --- The shape of the manoeuvre ---------------------------------------------

// The lane change used to freeze for the whole 8 units of every junction it crossed, and since
// every pass spans a junction by construction, most passes stopped dead half way across the road —
// the taxi sat on the centreline, which docs/traffic.md calls the worst place on it, and then
// resumed. That hole in the middle of the ramp was most of what read as "angular". Nothing may
// leave the taxi displaced and not moving.
check('the lane change never stalls half way across', one.stalled === 0,
  `${one.stalled} frames displaced but going nowhere sideways`);
// Smoothstep's whole job: the crab angle eases in and out instead of stepping. The old linear ramp
// put the *entire* peak slope on the frame the pass began — 0.571, a 30° flick between two frames
// — and took it all off again in one frame at the other end. What is left is frame quantisation
// and nothing else: the eased slope starts at zero, so the first frame can only reach
// `e'(v·dt / PASS_FADE) · PASS_LATERAL / PASS_FADE`, which at the overdrive top and 60fps is 0.18.
// The bar sits between the two so it still fails if anyone straightens the ramp back out.
check('and eases into the crab angle rather than snapping to it', one.slopeJump < 0.3,
  `biggest one-frame change in crab angle ${one.slopeJump.toFixed(3)} (a linear ramp jumps 0.571)`);
// The bank rocks *both* ways per change — thrown out of the lane one way, settling into it the
// other — which is what the curvature of the eased offset gives for free and what a constant-slope
// translation could not express at all.
check('the body banks over and back', one.bankHigh > 0.25 && one.bankLow < -0.25,
  `roll ran ${one.bankLow.toFixed(2)} to ${one.bankHigh.toFixed(2)} of full lean`);
// And leaves rubber over the meat of both changes rather than a token stamp at each end.
check('and lays rubber across both lane changes', one.rubber > one.changing * 0.5,
  `${one.rubber.toFixed(1)} of ${one.changing.toFixed(1)} units of lane-change road marked`);

// --- Does it pass *reliably*? -----------------------------------------------
//
// The single scenario above says the manoeuvre works; this says it works whatever the road hands
// it. Both axes matter and the second is the one that caught a real bug: `start` slides the whole
// scenario along the road, which changes where the junctions fall relative to the pass, and the
// junction is where the taxi used to drive into the back of the car in front.
//
// What this was measuring before that bug was fixed: **117 passes, 43 rear-ends** out of 160 — a
// crash better than one approach in four, every one of them with `pass` still 0.00 because the
// taxi never got as far as pulling out. Two changes in `sim/traffic.js` took it to 148/12: a
// leader crossing a junction *in a straight line* is passable (it is not turning across anything),
// and a car crossing a junction no longer accelerates into the boot of the car in front of it.
//
// The bar is set below what is measured but well above what the bug allowed, because the residual
// is real risk rather than slack: Loco Mode is meant to be dangerous, and docs/traffic.md prices
// the oncoming lane at about one wreck in ten passes. What must not come back is the *quarter*.
//
// The gap axis stops at 34 because that is where the lab's 200-unit road stops being able to
// finish the job, not where the taxi does: from a 36-unit opening gap the taxi is still only a
// unit past its leader when the tarmac runs out. Checked by re-running those exact settings on a
// 320-unit road, where every one of them completes with the taxi 80–106 units clear. A bound that
// is a property of the *lab* rather than of the manoeuvre, and worth spelling out so it isn't read
// as one.
let passes = 0;
let wrecks = 0;
let stuck = 0;
let stalls = 0;
let runs = 0;
for (let gap = 10; gap <= 34; gap += 2) {
  for (let start = 6; start <= 24; start += 2) {
    const r = approach(gap, start);
    runs += 1;
    stalls += r.stalled;
    if (r.wrecked) wrecks += 1;
    else if (r.passed) passes += 1;
    else stuck += 1;
  }
}
const rate = (n) => `${((n / runs) * 100).toFixed(0)}%`;
check('it gets past the car in front nearly every time',
  passes / runs >= 0.85, `${passes}/${runs} passed (${rate(passes)})`);
check('and rear-ends it rarely',
  wrecks / runs <= 0.12, `${wrecks}/${runs} wrecked (${rate(wrecks)})`);
// The failure mode the first fix has to avoid: braking so early behind a fleeing leader that the
// taxi never closes to PASS_TRIGGER and the overtake stops being offered. It is not a crash, so
// the two counters above would both look healthy while the mode quietly did nothing.
check('and never just sits behind it', stuck === 0,
  `${stuck}/${runs} never got past and never hit it`);
// The junction freeze again, across every starting position rather than one. It is worth the
// second asking because `start` is precisely the axis that decides where the junctions fall
// relative to the lane change, and the freeze only showed on the ones that lined up.
check('and never parks half way across the road', stalls === 0,
  `${stalls} frames displaced but going nowhere sideways, over ${runs} runs`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
