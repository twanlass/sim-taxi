/**
 * Which way does the overtake combo go, and what happens next — counted by the situation it was
 * thrown in.
 *
 *   node tools/overtakecases.mjs [--cities 24] [--secs 60]
 *
 * The same bot as tools/overtakebot.mjs (cruise on the dice with Loco held, throw the combo 0.35s
 * after catching a car with a 0.12s lift), but instead of scoring the gesture it snapshots every
 * pull-out: the side the taxi went (the oncoming lane or the kerb), what the car in front was doing,
 * the road it happened on, and how the pass ended. A table per case is what docs/traffic.md's
 * "which side" numbers come from.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, STOP_SETBACK, setPeek } from '../src/sim/traffic.js';
import { createCollisions, TAXI_HP } from '../src/sim/collisions.js';
import { createOvertakeCombo, OVERTAKE_ARM_RANGE } from '../src/game/overtake.js';
import { BOOST_COOLDOWN } from '../src/game/boost.js';
import {
  LANE, isXAxis, dirSign, opposite, laneOffsetFor, lineX, lineZ, riverBanks,
} from '../src/city/grid.js';
import { cityFor } from './autoplay.mjs';

const arg = (name, dflt) => {
  const k = process.argv.indexOf(`--${name}`);
  return k > 0 ? Number(process.argv[k + 1]) : dflt;
};
const CITIES = arg('cities', 24);
const SECS = arg('secs', 60);
const CARS = 12;
const STEP = 1 / 60;
// `--classic` measures the first build of the peek (`?peek=classic`).
setPeek(process.argv.includes('--classic') ? 'classic' : null);
const REACT = 0.35;
const LIFT = 0.12;

/** Is anything coming the other way within `range` ahead, on the line the taxi is on? */
function oncomingWithin(cars, taxi, range) {
  const xAxis = isXAxis(taxi.d);
  const sign = dirSign(taxi.d);
  const back = opposite(taxi.d);
  for (const c of cars) {
    if (c === taxi || c.crashed || c.d !== back) continue;
    if (xAxis ? c.j !== taxi.j : c.i !== taxi.i) continue;
    const ahead = ((xAxis ? c.x - taxi.x : c.z - taxi.z) * sign);
    if (ahead > 0 && ahead < range) return true;
  }
  return false;
}

function onBridge(taxi) {
  const banks = riverBanks();
  return Boolean(banks) && taxi.z > banks.z0 - 4 && taxi.z < banks.z1 + 4 && !isXAxis(taxi.d);
}

function run(seed, rows) {
  cityFor(seed);
  const traffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), CARS);
  traffic.warmup(5);
  const taxi = traffic.taxi;
  taxi.hp = TAXI_HP;
  const combo = createOvertakeCombo({ taxi });
  const collisions = createCollisions(traffic.cars, taxi);
  let bumpedWith = null;
  collisions.onBump((e) => { bumpedWith = e?.other ?? e?.car ?? true; });
  let enc = null;
  let held = true;
  let sinceRelease = Infinity;
  let live = null;     // the pass under way: its row, and its target

  for (let f = 0; f < SECS / STEP; f++) {
    const gap = taxi.passGap ?? Infinity;
    if (!enc && gap < OVERTAKE_ARM_RANGE && !taxi.passing && taxi.state === 'drive') {
      enc = { t: 0, overtakes: taxi.overtakes };
    }
    if (enc) {
      enc.t += STEP;
      held = !(enc.t >= REACT && enc.t < REACT + LIFT);
    }
    if (!held) sinceRelease = 0; else if (sinceRelease !== Infinity) sinceRelease += STEP;
    taxi.boost = held || sinceRelease < BOOST_COOLDOWN;
    taxi.boostEasing = !held;
    combo.update(STEP, { held, brakeHeld: false });
    bumpedWith = null;
    const before = taxi.overtakes;
    traffic.update(STEP);
    collisions.update(STEP);
    taxi.hp = TAXI_HP;
    if (taxi.crashed) break;

    if (taxi.overtakes > before) {
      const l = taxi.passTarget;
      const toLine = l && l.state === 'drive' ? l.lane.length - STOP_SETBACK - l.s : null;
      live = {
        target: l,
        row: {
          side: taxi.dodgeLateral < 0 ? 'kerb' : 'oncoming',
          signal: l?.signalHand ?? 'none',
          leaderState: l ? (l.state === 'turn' ? `turn:${l.turn?.hand}` : 'drive') : 'none',
          leaderStopped: l ? l.v < 0.5 : false,
          toLine,
          truck: Boolean(l?.isTruck),
          inBox: taxi.state === 'turn',
          arterial: laneOffsetFor(taxi.d, taxi.i, taxi.j) > LANE + 0.1,
          bridge: onBridge(taxi),
          oncoming: oncomingWithin(traffic.cars, taxi, 30),
          gap: Number.isFinite(gap) ? gap : null,
          leaderWent: null,
          bump: null,
          kerbRoad: 0,
          leaderLatAtLevel: null,
        },
      };
      rows.push(live.row);
    }
    if (live) {
      const t = live.target;
      if (t && t.state === 'turn' && live.row.leaderWent === null) { live.row.leaderWent = t.turn?.hand ?? '?'; if (process.env.DBG && live.row.side==='kerb') console.log('went', t.turn?.hand, 'sig', t.signalHand, 'scatter', t.scatter?.toFixed?.(2), 'target', taxi.passTarget===t, 'dl', taxi.dodgeLateral, 'pass', taxi.pass.toFixed(2), 'route', t.route?.length, 'police', t.police); }
      if (bumpedWith && !live.row.bump) {
        live.row.bump = bumpedWith === t ? 'the car passed' : 'something else';
      }
      // Road ridden with the wheels over the kerb face (1.15 off the lane centre, see PULLOVER_LATERAL).
      if (taxi.passOffset < -1.15) live.row.kerbRoad += taxi.v * STEP;
      // How far out of the taxi's lane the car being passed was, the frame the taxi drew level.
      if (t && live.row.leaderLatAtLevel === null) {
        const xAxis = isXAxis(taxi.d);
        const ahead = (xAxis ? t.x - taxi.x : t.z - taxi.z) * dirSign(taxi.d);
        if (ahead < 3.4) {
          const end = taxi.lane.path.at(taxi.lane.length);
          live.row.leaderLatAtLevel = Math.abs(xAxis ? t.z - end.z : t.x - end.x);
        }
      }
      if (!taxi.passing && !(taxi.pass > 0)) live = null;
    }
    if (enc && (taxi.overtakes > enc.overtakes || enc.t > 6)) { enc = null; held = true; }
  }
}

const rows = [];
for (let k = 0; k < CITIES; k++) run(9100 + k * 37, rows);

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const group = (label, pick) => {
  const g = rows.filter(pick);
  const kerb = g.filter((r) => r.side === 'kerb').length;
  const bumps = g.filter((r) => r.bump).length;
  return { case: label, passes: g.length, kerb: `${kerb} (${pct(kerb, g.length)})`, bumped: pct(bumps, g.length) };
};
console.log(`${rows.length} pull-outs over ${CITIES} cities × ${SECS}s`);
console.table([
  group('all', () => true),
  group('leader signalling left', (r) => r.signal === 'left'),
  group('  ...still rolling', (r) => r.signal === 'left' && !r.leaderStopped),
  group('  ...stopped at its line', (r) => r.signal === 'left' && r.leaderStopped),
  group('leader signalling right', (r) => r.signal === 'right'),
  group('leader no signal', (r) => r.signal === 'none'),
  group('leader already turning left', (r) => r.leaderState === 'turn:left'),
  group('leader is a truck', (r) => r.truck),
  group('thrown in the junction box', (r) => r.inBox),
  group('on an arterial', (r) => r.arterial),
  group('on/near a bridge', (r) => r.bridge),
  group('oncoming car within 30', (r) => r.oncoming),
]);
const kerbRows = rows.filter((r) => r.side === 'kerb');
console.log('kerb peeks: where the leader went', Object.fromEntries(
  ['left', 'straight', 'right', null].map((h) => [h ?? 'never', kerbRows.filter((r) => r.leaderWent === h).length]),
));
console.log('kerb peeks: gap at pull-out', kerbRows.map((r) => r.gap?.toFixed(1)).join(' '));
console.log('kerb peeks: leader to its line', kerbRows.map((r) => r.toLine?.toFixed(1) ?? 'box').join(' '));
console.log('kerb peeks: road on the pavement', kerbRows.map((r) => r.kerbRoad.toFixed(0)).join(' '));
console.log('kerb peeks: leader off the taxi lane when level', kerbRows.map((r) => r.leaderLatAtLevel?.toFixed(1) ?? '-').join(' '));
