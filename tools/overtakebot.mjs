/**
 * A bot throwing the overtake combo at every car the taxi catches, in ambient traffic, so the
 * gesture's cost and the timing's cost can be told apart.
 *
 *   node tools/overtakebot.mjs [--cities 12] [--secs 60]
 *
 * The taxi cruises on the dice with Loco held. Each time a car comes within OVERTAKE_ARM_RANGE
 * (an "encounter") the bot waits its reaction time, lifts the pill for its lift time, and presses
 * again. Each encounter ends one of four ways: passed, rammed, gone (the car turned off), or
 * lapsed. Run against a grid of reaction × lift, so a row that fails at every lift is timing and a
 * column that fails at every reaction is the gesture.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createCollisions, TAXI_HP } from '../src/sim/collisions.js';
import { createOvertakeCombo, OVERTAKE_ARM_RANGE } from '../src/game/overtake.js';
import { BOOST_COOLDOWN } from '../src/game/boost.js';
import { cityFor } from './autoplay.mjs';

const arg = (name, dflt) => {
  const k = process.argv.indexOf(`--${name}`);
  return k > 0 ? Number(process.argv[k + 1]) : dflt;
};
const CITIES = arg('cities', 12);
const SECS = arg('secs', 60);
const CARS = 12;
const STEP = 1 / 60;

/** One bot over one city. `react` and `lift` in seconds; `react: null` never throws the combo. */
function run(seed, { react, lift, grace }) {
  cityFor(seed);
  const traffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), CARS);
  traffic.warmup(5);
  const taxi = traffic.taxi;
  taxi.hp = TAXI_HP;
  const combo = createOvertakeCombo({ taxi, grace });
  const collisions = createCollisions(traffic.cars, taxi);
  const tally = { passed: 0, rammed: 0, gone: 0, lapsed: 0, rammedBeforeLift: 0 };
  let enc = null;     // { t, lifted, pressed, overtakes }
  let held = true;
  let sinceRelease = Infinity;
  let bumped = false;
  collisions.onBump(() => { bumped = true; });

  const close = (how) => { tally[how] += 1; enc = null; held = true; };
  for (let f = 0; f < SECS / STEP; f++) {
    const gap = taxi.passGap ?? Infinity;
    if (!enc && gap < OVERTAKE_ARM_RANGE && !taxi.passing && taxi.state === 'drive') {
      enc = { t: 0, overtakes: taxi.overtakes, far: 0 };
    }
    if (enc) {
      enc.t += STEP;
      if (react !== null && enc.t >= react && enc.t < react + lift) held = false;
      else held = true;
    }
    sinceRelease = held ? (sinceRelease === Infinity ? Infinity : sinceRelease) : 0;
    if (!held) sinceRelease = 0; else if (sinceRelease !== Infinity) sinceRelease += STEP;
    taxi.boost = held || sinceRelease < BOOST_COOLDOWN;
    taxi.boostEasing = !held;
    combo.update(STEP, { held, brakeHeld: false });
    bumped = false;
    traffic.update(STEP);
    collisions.update(STEP);
    taxi.hp = TAXI_HP;
    if (taxi.crashed) break;
    if (!enc) continue;
    if (taxi.overtakes > enc.overtakes) close('passed');
    // A bump with the car the encounter is about — not cross traffic in a junction, which a
    // taxi on Loco runs into whatever the combo does.
    else if (bumped && gap < 8) {
      if (react !== null && enc.t < react + lift) tally.rammedBeforeLift += 1;
      close('rammed');
    } else {
      enc.far = (taxi.passGap ?? Infinity) > OVERTAKE_ARM_RANGE + 5 ? enc.far + STEP : 0;
      if (enc.far > 0.5) close('gone');
      else if (enc.t > 6) close('lapsed');
    }
  }
  return tally;
}

const sum = (rows) => rows.reduce((a, r) => {
  for (const k in r) a[k] = (a[k] ?? 0) + r[k];
  return a;
}, {});

const GRACES = (process.argv.find((a) => a.startsWith('--grace=')) ?? '--grace=0').slice(8)
  .split(',').map(Number);
const grid = [];
for (const grace of GRACES) {
  for (const react of [null, 0.35, 0.6, 0.9]) {
    for (const lift of react === null ? [0] : [0.12, 0.3]) {
      const t = sum(Array.from({ length: CITIES }, (_, k) => run(9100 + k * 37, { react, lift, grace })));
      const decided = t.passed + t.rammed + t.lapsed;
      grid.push({
        grace, react: react ?? 'never', lift,
        passed: `${t.passed}/${decided} (${Math.round((100 * t.passed) / decided)}%)`,
        rammed: t.rammed, 'rammed before the re-press': t.rammedBeforeLift, lapsed: t.lapsed, gone: t.gone,
      });
    }
  }
}
console.table(grid);
