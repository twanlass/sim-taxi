/**
 * Auto-play soak.
 *
 * Simulates a perfect player: routes the taxi the instant a fare appears or changes hands, with a
 * configurable reaction delay. A real player is strictly slower than this, so the run length here
 * is the ceiling — how long the game *can* be survived, not how long it usually is.
 *
 * The airport prototype taught the lesson behind this file: three builds passed a short probe and
 * then froze at t=900. A snapshot cannot distinguish a working system from a slowly dying one.
 *
 *   node tools/soak.mjs [fares] [reaction] [runs] [firstSeed]
 *
 * **Runs, plural, is the point.** A single run is dominated by trip-length luck — one
 * corner-to-corner fare eats 40s against a 17s average — and on some seeds even a perfect player
 * loses the very first fare. Tuning difficulty against one seed is tuning against noise; it is how
 * a 30% harder game once read as a 75% harder one. The suite reports the median of a fixed sweep.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { createPolice } from '../src/sim/police.js';
import { createFareSystem } from '../src/game/fares.js';
import { findRoute, planOrigin } from '../src/game/route.js';

// Matches the game's default so these numbers describe the game as played, not a denser city.
const CARS = 7;

const FARES = Number(process.argv[2] ?? 40);
const REACTION = Number(process.argv[3] ?? 1.5);   // seconds before the "player" reacts
const RUNS = Number(process.argv[4] ?? 9);
const FIRST_SEED = Number(process.argv[5] ?? 71624);
const STEP = 1 / 60;

// Spread rather than consecutive: adjacent seeds through this RNG produce visibly similar first
// fares, and a sweep of near-duplicates measures one situation nine times.
const SEED_STRIDE = 613;

createLayout(makeRng(71624));   // the city is fixed; only the situation varies per run

/** One full run. Returns what the run is worth measuring by. */
function play(runSeed) {
  const traffic = createTraffic(makeRng(runSeed + 44), new THREE.Scene(), CARS);
  const fares = createFareSystem(makeRng(runSeed + 55), new THREE.Scene());
  const police = createPolice(makeRng(runSeed + 66), new THREE.Scene());
  const taxi = traffic.taxi;
  traffic.warmup(10);

  let pending = null;      // fare awaiting our reaction
  let reactIn = 0;
  let elapsed = 0;
  let routeFailures = 0;
  const margins = [];      // seconds left when each leg completed

  // With more than one rider on the board the "perfect player" needs a policy, not just a reflex:
  // finish the rider you are carrying, then go straight to whichever waiting rider is closest to
  // timing out. `fares.waiting()` already returns the most-urgent waiter — deferring to it here is
  // the strategy, and the only order one taxi can serve them in.
  const nextJob = () => fares.carrying() ?? fares.waiting();

  while (fares.state.delivered < FARES && !fares.state.gameOver && elapsed < 4000) {
    police.update(STEP);
    traffic.update(STEP);
    const events = fares.update(STEP, taxi);
    elapsed += STEP;

    for (const { type, fare } of events) {
      if (type === 'pickup' || type === 'delivered') margins.push(fare.timeLeft);
      if (type === 'delivered') taxi.route = [];
    }

    // Re-aim whenever the job changes hands — a pickup swaps the target to a drop-off, a delivery
    // hands the taxi over to whoever was left waiting on the kerb.
    const job = nextJob();
    if (events.length && job && job !== pending && !job.directed) {
      pending = job;
      reactIn = REACTION;
      taxi.route = [];
    }

    if (pending) {
      reactIn -= STEP;
      if (reactIn <= 0) {
        const route = findRoute(planOrigin(taxi), pending.target);
        if (route === null) routeFailures += 1;
        else { taxi.route = route; taxi.routeConsumed = false; fares.markDirected(pending); }
        pending = null;
      }
    }
  }

  return {
    seed: runSeed,
    delivered: fares.state.delivered,
    money: fares.state.money,
    elapsed,
    routeFailures,
    violations: traffic.stats.violations,
    worstMargin: margins.length ? Math.min(...margins) : 0,
    failReason: fares.state.failReason,
  };
}

const runs = Array.from({ length: RUNS }, (_, k) => play(FIRST_SEED + k * SEED_STRIDE));

const delivered = runs.map((r) => r.delivered).sort((a, b) => a - b);
const median = delivered[delivered.length >> 1];
const mean = delivered.reduce((a, b) => a + b, 0) / runs.length;
const routeFailures = runs.reduce((a, r) => a + r.routeFailures, 0);
const violations = runs.reduce((a, r) => a + r.violations, 0);
const worstMargin = Math.min(...runs.map((r) => r.worstMargin));

for (const r of runs) {
  console.log(`  seed ${r.seed}: ${String(r.delivered).padStart(2)} fares, $${r.money}`
    + `, ${r.elapsed.toFixed(0)}s${r.failReason ? ` — ${r.failReason}` : ''}`);
}

// A perfect player is *meant* to fail eventually: one flat clock covering both legs makes this a
// score-attack, so this is a difficulty gauge, not a fairness gate. The hard failures are the ones
// that mean something is broken rather than hard — a city that cannot be driven, or a median run
// so short the loop never gets going.
console.log(`delivered ${median}/${FARES} median over ${RUNS} runs `
  + `(mean ${mean.toFixed(1)}, best ${delivered[delivered.length - 1]}, worst ${delivered[0]})`);
console.log(`tightest deadline margin across all runs: ${worstMargin.toFixed(1)}s`);
console.log(`route failures ${routeFailures} | red-light violations ${violations}`);
console.log(`a perfect player (${REACTION}s reaction) survives a median of ${median} fares`);

const ok = median >= 2 && routeFailures === 0 && violations === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
