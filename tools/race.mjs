/**
 * The street race, raced headless: how often does the taxi beat the rival, and by how much?
 *
 *   node tools/race.mjs [races] [chase]
 *
 * For each race: a fresh city and situation, the rival summoned and accepted on the spot, the taxi
 * routed to the start and lined up exactly as main.js does it, and then three players drive the same
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
    onEvent: (type) => { if (type === 'go') went = true; },
  });
  if (CHASE !== null) race.setRivalChase(CHASE);
  if (!race.summon()) return { result: 'no-spot' };

  const boost = createBoost(undefined, player.tank);
  const collisions = createCollisions(traffic.cars, taxi);
  taxi.hp = TAXI_HP;
  let wrecked = false;
  collisions.onImpact(() => { wrecked = true; });

  let t = 0;
  while (t < 240 && !wrecked) {
    if (race.state.phase === 'offer') race.accept();
    if (went && player.tank > 0 && boost.fraction() > 0 && !boost.state.held) boost.press();
    if (went && boost.fraction() <= 0 && boost.state.held) boost.release();
    boost.update(STEP);
    taxi.boost = went && boost.isEngaged();
    traffic.update(STEP);
    collisions.update(STEP);
    race.update(STEP);
    t += STEP;
    if (race.state.phase === 'leaving' || race.state.phase === 'waiting') break;
  }
  const s = race.state;
  if (wrecked) return { result: 'wreck' };
  if (!s.races) return { result: `stuck in ${s.phase}` };
  return { result: s.lastResult, taxi: s.taxiTime, rival: s.rivalTime };
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
  for (let k = 0; k < RACES; k++) {
    const r = race(7 + k * 13, player);
    tally[r.result] = (tally[r.result] ?? 0) + 1;
    if (process.env.RACE_DEBUG && !['won', 'lost'].includes(r.result)) console.log(`    seed ${7 + k * 13}: ${r.result}`);
    if (r.result === 'won') won.push(r.taxi);
    if (r.result === 'lost') lost.push(r.rival);
  }
  const rate = ((tally.won ?? 0) / RACES * 100).toFixed(0);
  console.log(`  ${player.name.padEnd(28)} win ${rate}%  `
    + `${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}  `
    + `· taxi home in ${median(won).toFixed(1)}s when it wins · rival in ${median(lost).toFixed(1)}s when it does`);
}
