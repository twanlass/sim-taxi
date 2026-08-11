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
import { createTraffic, placeCar, SPEED } from '../src/sim/traffic.js';
import { DIR, dirSign, PITCH, LANE } from '../src/city/grid.js';
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
// The same staging `lab/passing.js` does, with the same helper shape, driven at a fixed step.

const scene = new THREE.Scene();
const traffic = createTraffic(makeRng(4242), scene, 2, 2, 0);
const [taxi, leader] = [traffic.taxi, traffic.cars.find((c) => !c.isTaxi)];

/** Put `car` `dist` units into the carriageway running `d`. Mirrors `placeAlong` in the lab. */
function placeAlong(car, d, dist) {
  const step = dirSign(d);
  let i = step > 0 ? 1 : LAB_BLOCKS - 1;
  let left = dist;
  for (let guard = 0; guard <= LAB_BLOCKS; guard++) {
    const lane = net.laneByGrid(d, i);
    if (!lane) return false;
    if (left <= lane.length) return placeCar(car, d, i, 0, lane.length - left);
    left -= lane.length;
    const turn = lane.exits.length ? net.turnById.get(lane.exits[0]) : null;
    if (!turn) return placeCar(car, d, i, 0, 0);
    left = Math.max(0, left - turn.length);
    i += step;
  }
  return false;
}

const GAP = 22;
placeAlong(taxi, DIR.PX, 12);
placeAlong(leader, DIR.PX, 12 + GAP);
taxi.v = SPEED;
leader.v = SPEED;

let maxLateral = 0;         // how far the taxi got from its own lane centre
let minApproach = Infinity; // closest it came to the car it went round
let passedAt = null;        // sim time it drew level with the leader
let tuckedAt = null;        // and got back into lane after
let stationary = 0;

const STEP = 1 / 60;
for (let n = 0; n < 60 * 16; n++) {
  taxi.boost = true;                          // the button, held
  taxi.boostEasing = false;
  while (taxi.route.length < 3) taxi.route.push(taxi.d);

  traffic.update(STEP);

  maxLateral = Math.max(maxLateral, Math.abs(taxi.z - LANE));
  if (!leader.crashed) {
    minApproach = Math.min(minApproach, Math.hypot(taxi.x - leader.x, taxi.z - leader.z));
    if (passedAt === null && taxi.x > leader.x) passedAt = n * STEP;
  }
  if (passedAt !== null && tuckedAt === null && taxi.pass < 0.02 && taxi.x > leader.x + 6) {
    tuckedAt = n * STEP;
  }
  if (taxi.v < 0.5) stationary += 1;
  if (taxi.x > labNodeX(LAB_BLOCKS) - 16) break;
}

check('the taxi reaches the overdrive band on the straight', taxi.v > SPEED * 2.2,
  `${taxi.v.toFixed(1)} u/s`);
// A pass is a full lane change into the oncoming lane — 2·LANE of offset. Anything less means
// the taxi merely weaved, which is what the mode does when it is *not* going round anything.
check('it commits the whole lane', maxLateral > 2 * LANE - 0.6,
  `${maxLateral.toFixed(2)} units off its lane centre`);
check('it gets past the car in front', passedAt !== null,
  passedAt === null ? 'never drew level' : `at ${passedAt.toFixed(1)}s`);
check('and tucks back in', tuckedAt !== null,
  tuckedAt === null ? 'still out at the end of the road' : `at ${tuckedAt.toFixed(1)}s`);
// `sim/collisions.js` puts the summed envelope at 2.31 units, so that is the bar: at or under it
// the pass is a wreck rather than an overtake. Swept across the whole `gap` slider (8 to 70 in ten
// steps) the closest approach runs 2.97 to 4.06 — snugger than the 3.70 the probe measures in the
// city, because a lab taxi is at the overdrive top when it pulls out and is therefore further into
// its lane change when it draws level. Still clear, and clear at every setting.
check('without clipping it', minApproach > 2.31 && !taxi.crashed && !leader.crashed,
  `closest approach ${minApproach.toFixed(2)} units against a 2.31 envelope`);
check('and nothing stops it', stationary === 0, `${stationary} stationary frames`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
