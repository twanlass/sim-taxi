/**
 * How often does the player actually meet the construction zone, and what does it cost?
 *
 * The vignette had a problem the rest of the game didn't: the player could not steer. They tapped a
 * fare and the taxi routed itself, so "drive down the closed street" was not something they could
 * choose to do — either the router sent them or they never saw the thing. The first build shipped
 * with no pull at all and the zone was, in practice, scenery.
 *
 * **The premise expired.** The player steers now (docs/gameplay.md#steering), so the router does not
 * decide where the taxi goes and knob 1 below cannot pull it anywhere; what it still does is move
 * the fare's *clock*, since `estimateSeconds` bills the route the router would have taken. Knob 2
 * survives intact and is now the whole mechanism. The percentages this tool prints were measured
 * against the routed taxi and have not been re-measured against a driven one.
 *
 * Two knobs answer it, and this tool is what fits the first:
 *
 *   1. `EDGE_COST.roadwork` in game/route.js — the closed lanes are priced below an ordinary side
 *      street, so a route that can pass through them does.
 *   2. `fares.aimNextDropoff` — one fare per run has its drop-off aimed at a junction the closed
 *      street runs into, so there is a trip going that way to be pulled.
 *
 * Both are measured here, because they interact: a discount with nothing headed that way is a
 * tie-break on routes that were never near the zone, and an aimed drop-off with no discount still
 * lets the router pick either of the two ways into the junction.
 *
 *   node tools/roadwork-pull.mjs [weights] [runs] [seconds]
 *   node tools/roadwork-pull.mjs 1.00,0.62,0.45,0.20 12 180
 *
 * Reported per weight: the share of runs that entered a closed lane at least once, and the mean
 * planned route length in legs. The second is the cost of the first — a weight low enough to drag
 * routes across town would buy its hit rate by making every unrelated trip longer, which the
 * player pays for and never sees a reason for. What is wanted is the knee.
 *
 * **Not part of `npm run check`.** This measures a distribution, not an invariant: the honest
 * assertion ("most players meet it") is a percentage with real variance, and a suite that gates on
 * one goes red for reasons nobody can act on. The invariants it produced — that the discount is a
 * discount, and that a route from next door goes through — are in tools/probe.mjs instead.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, setClosedLanes } from '../src/sim/traffic.js';
import { createFareSystem } from '../src/game/fares.js';
import { createRoadwork } from '../src/game/roadwork.js';
import { findRoute, planOrigin, laneCost, setRoadworkLanes } from '../src/game/route.js';
import { cityFor } from './autoplay.mjs';

const WEIGHTS = (process.argv[2] ?? '1.00,0.90,0.62,0.45,0.20').split(',').map(Number);
const RUNS = Number(process.argv[3] ?? 12);
const SECONDS = Number(process.argv[4] ?? 240);

const STEP = 1 / 60;
const CARS = 24;
const REACTION = 1.5;
const SEED_STRIDE = 613;
const CITY_STRIDE = 7919;
const FIRST_SEED = 71624;

/**
 * One run: a perfect player, a zone on the game's own schedule, and the question of whether the
 * two ever meet.
 *
 * Placement is left to `roadwork.update` rather than forced at t=0. Forcing it was the first
 * version and it flattered every weight — a zone standing from the first frame gets the whole run
 * to be found, where the real one appears 40–75s in and has maybe three minutes. The measured
 * window has to be the one the player actually gets, so the run is 240s and the zone shows up when
 * it shows up.
 *
 * `hint` is the drop-off aim, switchable because the two mechanisms have to be told apart: a
 * discount can only pull a route that was already heading somewhere useful.
 */
function run(runSeed, citySeed, weight, hint) {
  cityFor(citySeed);
  setClosedLanes([]);
  setRoadworkLanes([]);

  const traffic = createTraffic(makeRng(runSeed + 44), new THREE.Scene(), CARS);
  const fares = createFareSystem(makeRng(runSeed + 55), new THREE.Scene());
  const roadwork = createRoadwork(makeRng(runSeed + 177), new THREE.Scene(), null);
  const taxi = traffic.taxi;
  traffic.warmup(10);

  // The weight under test, in place of the shipped one. Passed to findRoute rather than pushed
  // through setRoadworkLanes so the sweep can try values the game does not hold — same trick
  // tools/router-sweep.mjs uses to compare hierarchy tunings.
  let closed = new Set();
  const cost = (lane) => (closed.has(lane.id) ? weight : laneCost(lane));

  roadwork.onPlaced(({ ends }) => {
    closed = new Set(roadwork.closedLaneIds);
    if (hint) fares.aimNextDropoff(ends);
  });

  let pending = null;
  let reactIn = 0;

  let elapsed = 0;
  let placed = false;
  let entered = false;
  let legs = 0;
  let routes = 0;

  const nextJob = () => fares.carrying() ?? fares.waiting();

  while (elapsed < SECONDS && !fares.state.gameOver) {
    traffic.update(STEP);
    const events = fares.update(STEP, taxi);
    elapsed += STEP;

    roadwork.update(STEP, taxi, traffic.cars, fares.occupiedSpots());
    if (closed.size) {
      placed = true;
      if (closed.has(taxi.lane?.id)) entered = true;
    }

    for (const { type } of events) if (type === 'delivered') taxi.route = [];

    const job = nextJob();
    if (events.length && job && job !== pending && !job.directed) {
      pending = job;
      reactIn = job.stage === 'riding' ? 0 : REACTION;
      taxi.route = [];
    }

    // Lifted from tools/autoplay.mjs, down to `routeConsumed` and `markDirected` — a route handed
    // over without those two is a route the taxi never drives, which is how this tool first
    // reported a hit rate of zero for every weight.
    //
    // Nulling `pending` here is also what makes the leg count meaningful: one plan per job, which
    // is what the game does. The player taps a rider and the taxi is routed once.
    if (pending) {
      reactIn -= STEP;
      if (reactIn <= 0) {
        const route = findRoute(planOrigin(taxi), pending.target, cost);
        if (route) {
          legs += route.length;
          routes += 1;
          taxi.route = route;
          taxi.routeConsumed = false;
          fares.markDirected(pending);
        }
        pending = null;
      }
    }
  }

  return {
    placed, entered, meanLegs: routes ? legs / routes : 0, delivered: fares.state.delivered,
  };
}

console.log(`${RUNS} runs x ${SECONDS}s, zone on the game's own schedule\n`);
for (const hint of [false, true]) {
  console.log(`  drop-off aimed at the zone: ${hint ? 'yes' : 'no'}`);
  console.log('    weight   zone stood up   entered it   mean legs   delivered');
  for (const weight of WEIGHTS) {
    const results = Array.from({ length: RUNS }, (_, k) => run(
      FIRST_SEED + k * SEED_STRIDE, FIRST_SEED + k * CITY_STRIDE, weight, hint,
    ));
    const placed = results.filter((r) => r.placed);
    const n = placed.length || 1;
    const entered = placed.filter((r) => r.entered).length;
    const meanLegs = placed.reduce((a, r) => a + r.meanLegs, 0) / n;
    const delivered = placed.reduce((a, r) => a + r.delivered, 0) / n;
    console.log(`    ${weight.toFixed(2)}${String(placed.length).padStart(12)}/${RUNS}`
      + `${String(entered).padStart(11)}/${placed.length}`
      + `${String(Math.round(entered / n * 100)).padStart(5)}%`
      + `${meanLegs.toFixed(2).padStart(10)}${delivered.toFixed(1).padStart(12)}`);
  }
  console.log('');
}
