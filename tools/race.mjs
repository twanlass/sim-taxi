/**
 * The street race, raced headless: how often does the taxi beat the rival, and by how much?
 *
 *   node tools/race.mjs [races] [chase]
 *
 * For each race: a fresh city and situation, the racer summoned and tapped on the spot, the two
 * put side by side exactly as the game's cut does, and then each player drives the same
 * race from the same frame — one who never touches Loco Mode, one holding it from the green on
 * the tank the race guarantees (`TANK_FLOOR`), and one holding it on a full tank. Each holds the
 * pedal until the tank runs dry and does nothing to avoid a hit, so its wreck rate is the
 * pessimistic end and its pace the optimistic one — the same player `tools/autoplay.mjs` is.
 *
 * `chase` overrides RIVAL_CHASE for a sweep. Informational: it reports, it does not gate.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { findRoute, findRouteOnto, planOrigin } from '../src/game/route.js';
import { createBoost } from '../src/game/boost.js';
import { createCollisions, TAXI_HP } from '../src/sim/collisions.js';
import { createRace, TANK_FLOOR, COUNTDOWN } from '../src/game/race.js';
import { cityFor, CARS } from './autoplay.mjs';

const RACES = Number(process.argv[2] ?? 24);
const CHASE = process.argv[3] != null ? Number(process.argv[3]) : null;
const STEP = 1 / 60;
const PLAYERS = [
  { name: 'no loco', tank: 0 },
  { name: 'loco, 1/4 tank', tank: 0.25 },
  { name: 'loco, 1/3 tank (the floor)', tank: TANK_FLOOR },
  { name: 'loco, full tank', tank: 1 },
];

function race(seed, player) {
  cityFor(1000 + seed);
  const traffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), CARS);
  const taxi = traffic.taxi;
  traffic.warmup(10);
  const routeTo = (target) => {
    const from = planOrigin(taxi);
    const route = target.onto != null ? findRouteOnto(from, target, target.onto) : findRoute(from, target);
    if (!route) return false;
    taxi.route = route;
    taxi.routeConsumed = false;
    taxi.pendingTarget = target;
    taxi.parked = false;
    return true;
  };
  let went = false;
  const race = createRace({
    rng: makeRng(seed + 911), scene: new THREE.Scene(), traffic, routeTo,
    onEvent: (type) => {
      if (type === 'go') went = true;
      // No camera here to go and look at the finish: count straight in.
      if (type === 'lined-up') race.countIn();
      // Nor a wipe for the finale's cut to the loser: land it on the spot.
      if (type === 'arrival-cut') race.stageArrival();
      if (process.env.RACE_DEBUG && ['arrival', 'skid', 'decided'].includes(type)) { const c = race.state.car; const t = traffic.taxi; const fx = Math.cos(t.yaw), fz = -Math.sin(t.yaw);
        const along = (c.x - t.x) * fx + (c.z - t.z) * fz; const across = (c.x - t.x) * Math.sin(t.yaw) + (c.z - t.z) * Math.cos(t.yaw);
        console.log(`      ${type} ${race.state.winner} t=${race.state.stepT.toFixed(2)} along ${along.toFixed(2)} across ${across.toFixed(2)} v ${c.v.toFixed(1)}/${t.v.toFixed(1)} s ${c.s.toFixed(2)}/${race.state.arrival?.stopS.toFixed(2)} lane ${c.lane?.id === race.state.arrival?.lane.id} ${c.state}`); }
    },
  });
  // No wipe here either: land the start the moment it is tapped.
  const tapped = () => race.accept() && race.stage();
  if (CHASE !== null) race.setRivalChase(CHASE);
  if (!race.summon() || !tapped()) return { result: 'no-spot' };

  const boost = createBoost(undefined, player.tank);
  const collisions = createCollisions(traffic.cars, taxi);
  taxi.hp = TAXI_HP;
  let wrecked = false;
  collisions.onImpact(() => { wrecked = true; });

  // The drag start (`dragStart`): how close the two get while the racer is out in the oncoming
  // lane, and which side of the taxi it comes back in on.
  const rival = race.state.car;
  let closest = Infinity;
  let rejoined = null;
  let t = 0;
  while (t < 240 && !wrecked) {
    if (went && player.tank > 0 && boost.fraction() > 0 && !boost.state.held) boost.press();
    if (went && boost.fraction() <= 0 && boost.state.held) boost.release();
    boost.update(STEP);
    taxi.boost = went && boost.isEngaged();
    // main.js's pedal, which the finale's skid and the winner pulling up both go through.
    taxi.braking = race.brakesTaxi();
    traffic.update(STEP);
    collisions.update(STEP);
    race.update(STEP);
    if (went && rival && !rival.crashed) {
      closest = Math.min(closest, Math.hypot(rival.x - taxi.x, rival.z - taxi.z));
      if (!rejoined && !rival.dragStart) {
        const ahead = (rival.x - taxi.x) * Math.cos(taxi.yaw) - (rival.z - taxi.z) * Math.sin(taxi.yaw);
        rejoined = { ahead: ahead > 0, at: t };
      }
    }
    t += STEP;
    // Done once it is settled: the racer stays in town afterwards (back to 'offer'), and a taxi left
    // holding Loco Mode with no route to drive would wreck itself and score the race as a wreck.
    if (went && !race.holdsBoard()) break;
  }
  const s = race.state;
  if (wrecked) return { result: 'wreck', closest };
  if (!s.races) return { result: `stuck in ${s.phase}` };
  return { result: s.lastResult, taxi: s.taxiTime, rival: s.rivalTime, closest, rejoined };
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log(`${RACES} races${CHASE !== null ? `, rival chase ${CHASE}` : ''} (countdown ${COUNTDOWN}s)`);
for (const player of PLAYERS) {
  const tally = {};
  const won = [];
  const lost = [];
  const closest = [];
  let ahead = 0;
  let behind = 0;
  for (let k = 0; k < RACES; k++) {
    const r = race(7 + k * 13, player);
    tally[r.result] = (tally[r.result] ?? 0) + 1;
    if (process.env.RACE_DEBUG && !['won', 'lost'].includes(r.result)) console.log(`    seed ${7 + k * 13}: ${r.result}`);
    if (Number.isFinite(r.closest)) closest.push(r.closest);
    if (r.rejoined) { if (r.rejoined.ahead) ahead += 1; else behind += 1; }
    if (r.result === 'won') won.push(r.taxi);
    if (r.result === 'lost') lost.push(r.rival);
  }
  const rate = ((tally.won ?? 0) / RACES * 100).toFixed(0);
  console.log(`  ${player.name.padEnd(28)} win ${rate}%  `
    + `${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}  `
    + `· taxi home in ${median(won).toFixed(1)}s when it wins · rival in ${median(lost).toFixed(1)}s when it does`);
  console.log(`  ${''.padEnd(28)} drag: racer cut in ahead ${ahead} · behind ${behind} · `
    + `closest ${Math.min(...closest).toFixed(2)} (median ${median(closest).toFixed(2)})`);
}
