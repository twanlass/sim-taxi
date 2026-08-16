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
 * Drives the taxi to random intersections, records (blocks, turns, lights) against the arrival
 * time it actually took, then least-squares fits
 *
 *   seconds = SEC_PER_BLOCK * blocks + SEC_PER_TURN * turns + SEC_PER_LIGHT * lights
 *
 * and reports the fit alongside how the *currently shipped* constants score on the same data. Fit
 * through the origin deliberately: a zero-block trip is a taxi already at the pin, and an
 * intercept would charge it for arriving.
 *
 * `lights` is how many signalised junctions the route crosses, and it only became worth a term of
 * its own once the arterials lost their signals — before that it was "blocks, give or take one"
 * and had nothing left to explain. See the constants in route.js.
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
  findRoute, planOrigin, allIntersections, countTurns, countLights,
  SEC_PER_BLOCK, SEC_PER_TURN, SEC_PER_LIGHT,
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

/** One city's worth of samples: {blocks, turns, lights, seconds} per completed trip. */
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
    const lights = countLights(route, from);
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

    if (arrived) out.push({ blocks, turns, lights, seconds: elapsed });
    else missed += 1;
  }

  return { out, missed };
}

/** The predictors, in the order the fit and the shipped constants both use. */
const TERMS = ['blocks', 'turns', 'lights'];

/**
 * Least squares for `seconds = a*blocks + b*turns + c*lights`, no intercept.
 *
 * Normal equations solved by Gauss-Jordan rather than with a matrix library — this is a 3x3 and
 * the project carries no linear-algebra dependency. It was a hand-solved 2x2 until the arterials
 * lost their signals and "lights crossed" stopped being a synonym for "blocks driven"; see the
 * constants in route.js for why the third term had nothing to explain before that.
 */
function fit(rows) {
  const n = TERMS.length;
  const m = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const r of rows) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) m[a][b] += r[TERMS[a]] * r[TERMS[b]];
      m[a][n] += r[TERMS[a]] * r.seconds;
    }
  }
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-9) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return TERMS.map((_, i) => m[i][n] / m[i][i]);
}

/** How a given set of coefficients scores: mean absolute error, mean signed error, worst miss. */
function grade(rows, coef) {
  let abs = 0, signed = 0, worst = 0;
  for (const r of rows) {
    const err = TERMS.reduce((sum, term, i) => sum + coef[i] * r[term], 0) - r.seconds;
    abs += Math.abs(err);
    signed += err;
    worst = Math.max(worst, Math.abs(err));
  }
  return { mae: abs / rows.length, bias: signed / rows.length, worst };
}

const label = (coef) => `SEC_PER_BLOCK ${coef[0].toFixed(2)}  SEC_PER_TURN ${coef[1].toFixed(2)}`
  + `  SEC_PER_LIGHT ${coef[2].toFixed(2)}`;
const score = (g) => `MAE ${g.mae.toFixed(2)}s  bias ${g.bias >= 0 ? '+' : ''}${g.bias.toFixed(2)}s`
  + `  worst ${g.worst.toFixed(1)}s`;

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
const meanOf = (term) => rows.reduce((a, r) => a + r[term], 0) / rows.length;

console.log(`${rows.length} trips over ${CITIES} cities (${missed} timed out)`);
console.log(`  mean ${meanOf('blocks').toFixed(2)} blocks, ${meanOf('turns').toFixed(2)} turns, `
  + `${meanOf('lights').toFixed(2)} lights, `
  + `${(seconds.reduce((a, b) => a + b, 0) / seconds.length).toFixed(1)}s `
  + `(median ${seconds[seconds.length >> 1].toFixed(1)}s, worst ${seconds[seconds.length - 1].toFixed(1)}s)`);

const shippedCoef = [SEC_PER_BLOCK, SEC_PER_TURN, SEC_PER_LIGHT];
const shipped = grade(rows, shippedCoef);
console.log(`shipped  ${label(shippedCoef)}  ->  ${score(shipped)}`);

const best = fit(rows);
if (best) console.log(`fitted   ${label(best)}  ->  ${score(grade(rows, best))}`);

// Informational, like tools/signals.mjs: this reports the estimator's error so the constants can
// be set from it. It fails only when the shipped estimator has drifted far enough that the fare
// budgets built on it are meaningless — a bias worth more than a block of driving, or an average
// miss worth more than two.
const ok = Math.abs(shipped.bias) <= SEC_PER_BLOCK && shipped.mae <= 2 * SEC_PER_BLOCK;
console.log(ok ? 'PASS' : 'FAIL — refit the SEC_PER_* constants from the numbers above');
process.exit(ok ? 0 : 1);
