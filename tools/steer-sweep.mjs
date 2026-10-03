// The chase-steering prototype (game/steer.js), measured on the patrol's own staged chase.
//
// The same staging as the escape table in game/patrol.js (tools/probe.mjs, "staged patrol chase"):
// a patrol a few seconds into town, the taxi placed 8-18 units off it, spotted on the pill, then
// driven for up to 45s. What changes per row is how the taxi is driven and whether the cop needs a
// line of sight:
//
//   base    the probe's driver: a route to the far corner, boost for the first `tank` seconds
//   los     the same driver, against a cop that loses you out of sight (`?steer=los`)
// Every row past `base` has line of sight on; `flick`, `uturn` and `drift` each add one input to it.
//
//   flick   + at every junction, take the exit that gets furthest from the cop, preferring a
//             corner while it can see you (`?steer=flick,los`)
//   uturn   + turn round in the road when the cop is in front, inside a block and a half (`uturn`)
//   drift   + hold the brake through every real turn and let go on the exit (`drift`)
//   all     the lot
//
// It is a bot, so read the rows as "what the mechanic can buy a player who uses it well", not as
// what a player will get. Usage: node tools/steer-sweep.mjs [seeds=16]

import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, placeCar, isLaneClosed } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createPolice } from '../src/sim/police.js';
import { createPatrol } from '../src/game/patrol.js';
import { createSteer, parseSteerFlags } from '../src/game/steer.js';
import { findRoute, planOrigin } from '../src/game/route.js';
import { setCityOccluders, clearCityOccluders, groundLineClear } from '../src/game/sightline.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { GRID_I, GRID_J, legalExits, nextIntersection, lineX, lineZ } from '../src/city/grid.js';

const SEEDS = Number(process.argv[2] ?? 16);
const BASE = 4242;
const CARS = 7;
const DT = 1 / 60;

const driveOn = (taxi) => {
  if (taxi.route?.length) return;
  const target = { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
  const route = findRoute(planOrigin(taxi), target);
  if (route?.length) { taxi.route = route; taxi.routeConsumed = false; }
};

function outcome(s, tank, mode) {
  const flags = parseSteerFlags(`?steer=${mode === 'base' ? 'none' : mode === 'all' ? 'all' : `${mode},los`}`);
  const blocks = createLayout(makeRng(s));
  if (flags.los) {
    setCityOccluders(createBuildings(makeRng(s + 22), blocks).mesh, createProps(makeRng(s + 33), blocks).mesh);
  } else {
    clearCityOccluders();
  }
  const scene = new THREE.Scene();
  const traffic = createTraffic(makeRng(s + 44), scene, CARS);
  const police = createPolice(scene);
  const taxi = traffic.taxi;
  let result = null;
  const patrol = createPatrol({
    rng: makeRng(s + 66), police, traffic, taxi,
    onCaught: () => { result = 'caught'; taxi.crashed = true; },
    onLost: () => { result = 'lost'; },
    lineOfSight: flags.los ? (cop) => groundLineClear(cop.x, cop.z, taxi.x, taxi.z) : null,
  });
  const steer = createSteer({ flags, taxi, project: () => ({ x: 0, y: 0 }), chasing: () => true });
  patrol.state.cooldown = 0;
  let onPatrol = 0;
  for (let step = 0; step < 60 * 90 && onPatrol < 60 * 3; step++) {
    traffic.update(DT);
    patrol.update(DT);
    police.update(DT);
    if (patrol.state.phase === 'patrol') onPatrol += 1;
  }
  if (patrol.state.phase !== 'patrol') return null;
  const net = cityNetwork();
  const cp = police.group.position;
  let spot = null;
  for (const lane of net.lanes) {
    if (lane.degenerate || isLaneClosed(lane.id) || lane.length < 6) continue;
    for (let back = 4; back < lane.length - 1 && !spot; back += 1) {
      const at = lane.path.at(lane.length - back);
      const r = Math.hypot(at.x - cp.x, at.z - cp.z);
      if (r < 8 || r > 18) continue;
      if (traffic.cars.some((c) => c !== taxi && Math.hypot(c.x - at.x, c.z - at.z) < 7)) continue;
      const to = net.nodeById.get(lane.to);
      spot = { d: net.dirOfLane(lane), i: to.gi, j: to.gj, back };
    }
    if (spot) break;
  }
  if (!spot || !placeCar(taxi, spot.d, spot.i, spot.j, spot.back)) return null;
  taxi.route = [];
  const at0 = taxi.lane.path.at(taxi.s);
  taxi.x = at0.x;
  taxi.z = at0.z;
  patrol.update(DT, { boosting: true });
  if (patrol.state.phase !== 'chase') return null;

  let decidedAt = null;
  let t = 0;
  for (; t < 45 && !result; t += DT) {
    const cop = patrol.state.cop;
    if (!cop) break;
    // The flick bot: once per junction, the exit that lands furthest from the cop — a corner
    // preferred while it can see the taxi, since that is what breaks the line.
    if (flags.flick) {
      const from = planOrigin(taxi);
      const key = `${from.i},${from.j},${from.d}`;
      if (key !== decidedAt && taxi.state === 'drive') {
        decidedAt = key;
        const seen = patrol.state.sees;
        let best = null;
        for (const d of legalExits(from.d, from.i, from.j)) {
          const n = nextIntersection(d, from.i, from.j);
          let score = Math.hypot(lineX(n.i) - cop.x, lineZ(n.j) - cop.z);
          if (seen && d !== from.d) score += 12;
          if (!best || score > best.score) best = { d, score };
        }
        if (best) steer.request({ d: best.d });
      }
    }
    // The U-turn bot: the cop is in front, coming this way, inside two blocks.
    if (flags.uturn && taxi.state === 'drive' && !taxi.uturn) {
      const hx = Math.sin(taxi.yaw);
      const hz = Math.cos(taxi.yaw);
      const dx = cop.x - taxi.x;
      const dz = cop.z - taxi.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 30 && (dx * hx + dz * hz) / dist > 0.6 && steer.state.uturnFor <= 0) {
        steer.request({ rel: 'back' });
      }
    }
    driveOn(taxi);
    const turning = taxi.state === 'turn' && taxi.dOut !== taxi.d;
    const steered = steer.update(DT, { brakeHeld: flags.drift && turning });
    taxi.boost = t < tank || steered.turbo;
    taxi.braking = steered.braking;
    traffic.update(DT);
    patrol.update(DT, { boosting: t < tank });
    police.update(DT);
  }
  // CHASE_MAX (40s) calls the chase off as "lost" — a stalemate, not an escape. Counted apart.
  if (result === 'lost' && t >= 39.9) result = 'timeout';
  return {
    how: result ?? 'none', t, bySight: patrol.state.lostBySight,
    flicks: steer.state.flicks, uturns: steer.state.uturns, drifts: steer.state.drifts,
  };
}

const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
const MODES = ['base', 'los', 'flick', 'uturn', 'drift', 'all'];
const TANKS = [0, 5, 15];
console.log(`${SEEDS} seeds per cell; chases the staging could not spot are dropped (lost / caught / 40s stalemate, median seconds to lose it)\n`);
console.log(`| mode   | ${TANKS.map((k) => `${k}s boost`.padEnd(26)).join(' | ')} | steering used (15s row) |`);
console.log(`|--------|${TANKS.map(() => '-'.repeat(28)).join('|')}|-------------------------|`);
for (const mode of MODES) {
  const cells = [];
  let used = '';
  for (const tank of TANKS) {
    const runs = [];
    for (let k = 0; k < SEEDS; k++) {
      const r = outcome(BASE + k, tank, mode);
      if (r) runs.push(r);
    }
    const lost = runs.filter((r) => r.how === 'lost');
    const caught = runs.filter((r) => r.how === 'caught').length;
    const stale = runs.filter((r) => r.how === 'timeout').length;
    const sight = runs.reduce((a, r) => a + r.bySight, 0);
    const lostT = median(lost.map((r) => r.t));
    cells.push(`${lost.length}/${runs.length} lost${sight ? ` (${sight} by sight)` : ''}, ${caught} caught${stale ? `, ${stale} timed out` : ''}${lost.length ? `, ${lostT.toFixed(1)}s` : ''}`.padEnd(26));
    if (tank === 15) {
      const sum = (key) => runs.reduce((a, r) => a + r[key], 0);
      used = `${sum('flicks')} flicks · ${sum('uturns')} U · ${sum('drifts')} drifts`;
    }
  }
  console.log(`| ${mode.padEnd(6)} | ${cells.join(' | ')} | ${used.padEnd(23)} |`);
}
