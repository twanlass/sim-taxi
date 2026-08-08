/**
 * Fits and grades the trip-time estimator in `src/game/route.js`.
 *
 * A fare's deadline is now budgeted from `estimateSeconds()`, so that function's error is a
 * difficulty knob whether or not anyone tuned it. If it is biased low, every clock is tight and
 * the game reads as unfair; if it is noisy, `slack(d)` spends itself absorbing the noise and the
 * ramp never bites. Neither failure looks like anything from the outside — the game is just
 * harder or easier than the curve says — which is exactly the sort of thing that has to be
 * measured rather than eyeballed.
 *
 *   node tools/eta.mjs [tripsPerCity] [cities]
 *
 * Drives the taxi to random intersections, records (blocks, turns) against the arrival time it
 * actually took, then least-squares fits
 *
 *   seconds = SEC_PER_BLOCK * blocks + SEC_PER_TURN * turns
 *
 * and reports the fit alongside how the *currently shipped* constants score on the same data. Fit
 * through the origin deliberately: a zero-block trip is a taxi already at the pin, and an
 * intercept would charge it for arriving.
 *
 * Cities, plural, for the same reason soak.mjs sweeps them: one city's arterial layout and signal
 * offsets shift trip times enough that a single-city fit is a fit to that city.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { isCityConnected } from '../src/city/grid.js';
import {
  findRoute, planOrigin, allIntersections, countTurns,
  SEC_PER_BLOCK, SEC_PER_TURN,
} from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';

// Matches the game's default so these numbers describe the game as played, not a denser city.
const CARS = 7;
const TRIPS = Number(process.argv[2] ?? 100);
const CITIES = Number(process.argv[3] ?? 6);
const FIRST_CITY = 71624;
const CITY_STRIDE = 7919;
const STEP = 1 / 60;
const TIMEOUT = 120;

/** The city a run is played on, rerolled until it is actually drivable — as `main.js` does. */
function cityFor(seed) {
  for (let attempt = 0; attempt < 40; attempt++) {
    createLayout(makeRng(seed + attempt));
    if (isCityConnected()) return seed + attempt;
  }
  throw new Error(`no drivable city near seed ${seed}`);
}

/** One city's worth of samples: {blocks, turns, seconds} per completed trip. */
function sample(citySeed) {
  cityFor(citySeed);
  const rng = makeRng(citySeed + 9001);
  const traffic = createTraffic(makeRng(citySeed + 44), new THREE.Scene(), CARS);
  const taxi = traffic.taxi;
  traffic.warmup(10);

  const ints = allIntersections();
  const out = [];
  let missed = 0;

  for (let n = 0; n < TRIPS; n++) {
    const target = ints[rng.int(0, ints.length - 1)];
    const from = planOrigin(taxi);
    const route = findRoute(from, target);
    if (route === null || route.length === 0) continue;

    const blocks = route.length;
    const turns = countTurns(route, from.d);
    const centre = intersectionCentre(target.i, target.j);
    taxi.route = route;
    taxi.routeConsumed = false;

    let elapsed = 0;
    let arrived = false;
    while (elapsed < TIMEOUT) {
      traffic.update(STEP);
      elapsed += STEP;
      if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { arrived = true; break; }
    }
    taxi.route = [];

    if (arrived) out.push({ blocks, turns, seconds: elapsed });
    else missed += 1;
  }

  return { out, missed };
}

/**
 * Least squares for `seconds = a*blocks + b*turns`, no intercept.
 *
 * Two normal equations, solved by hand rather than with a matrix library — this is a 2x2 and the
 * project carries no linear-algebra dependency.
 */
function fit(rows) {
  let bb = 0, bt = 0, tt = 0, bs = 0, ts = 0;
  for (const r of rows) {
    bb += r.blocks * r.blocks;
    bt += r.blocks * r.turns;
    tt += r.turns * r.turns;
    bs += r.blocks * r.seconds;
    ts += r.turns * r.seconds;
  }
  const det = bb * tt - bt * bt;
  if (Math.abs(det) < 1e-9) return null;
  return { a: (bs * tt - ts * bt) / det, b: (bb * ts - bt * bs) / det };
}

/** How a given (a, b) scores: mean absolute error, mean signed error, and the worst miss. */
function grade(rows, a, b) {
  let abs = 0, signed = 0, worst = 0;
  for (const r of rows) {
    const err = a * r.blocks + b * r.turns - r.seconds;
    abs += Math.abs(err);
    signed += err;
    worst = Math.max(worst, Math.abs(err));
  }
  return { mae: abs / rows.length, bias: signed / rows.length, worst };
}

const rows = [];
let missed = 0;
for (let k = 0; k < CITIES; k++) {
  const r = sample(FIRST_CITY + k * CITY_STRIDE);
  rows.push(...r.out);
  missed += r.missed;
}

if (rows.length < 20) {
  console.log(`only ${rows.length} usable trips — nothing to fit`);
  process.exit(1);
}

const seconds = rows.map((r) => r.seconds).sort((x, y) => x - y);
const blocks = rows.reduce((a, r) => a + r.blocks, 0) / rows.length;
const turns = rows.reduce((a, r) => a + r.turns, 0) / rows.length;

console.log(`${rows.length} trips over ${CITIES} cities (${missed} timed out)`);
console.log(`  mean ${blocks.toFixed(2)} blocks, ${turns.toFixed(2)} turns, `
  + `${(seconds.reduce((a, b) => a + b, 0) / seconds.length).toFixed(1)}s `
  + `(median ${seconds[seconds.length >> 1].toFixed(1)}s, worst ${seconds[seconds.length - 1].toFixed(1)}s)`);

const shipped = grade(rows, SEC_PER_BLOCK, SEC_PER_TURN);
console.log(`shipped  SEC_PER_BLOCK ${SEC_PER_BLOCK.toFixed(2)}  SEC_PER_TURN ${SEC_PER_TURN.toFixed(2)}`
  + `  ->  MAE ${shipped.mae.toFixed(2)}s  bias ${shipped.bias >= 0 ? '+' : ''}${shipped.bias.toFixed(2)}s`
  + `  worst ${shipped.worst.toFixed(1)}s`);

const best = fit(rows);
if (best) {
  const g = grade(rows, best.a, best.b);
  console.log(`fitted   SEC_PER_BLOCK ${best.a.toFixed(2)}  SEC_PER_TURN ${best.b.toFixed(2)}`
    + `  ->  MAE ${g.mae.toFixed(2)}s  bias ${g.bias >= 0 ? '+' : ''}${g.bias.toFixed(2)}s`
    + `  worst ${g.worst.toFixed(1)}s`);
}

// Informational, like tools/signals.mjs: this reports the estimator's error so the constants can
// be set from it. It fails only when the shipped estimator has drifted far enough that the fare
// budgets built on it are meaningless — a bias worth more than a block of driving, or an average
// miss worth more than two.
const ok = Math.abs(shipped.bias) <= SEC_PER_BLOCK && shipped.mae <= 2 * SEC_PER_BLOCK;
console.log(ok ? 'PASS' : 'FAIL — refit SEC_PER_BLOCK / SEC_PER_TURN from the numbers above');
process.exit(ok ? 0 : 1);
