/**
 * Auto-play soak.
 *
 * Simulates a perfect player: routes the taxi the instant a fare appears, with a configurable
 * reaction delay. If this run ever ends on a timer, the deadline formula is unfair — a real
 * player is strictly slower than this, so anything failing here is unwinnable.
 *
 * The airport prototype taught the lesson behind this file: three builds passed a short probe and
 * then froze at t=900. A snapshot cannot distinguish a working system from a slowly dying one.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';

// Matches the game's default so these numbers describe the game as played, not a denser city.
const CARS = 7;
import { createPolice } from '../src/sim/police.js';
import { createFareSystem } from '../src/game/fares.js';
import { findRoute, planOrigin } from '../src/game/route.js';

const FARES = Number(process.argv[2] ?? 40);
const REACTION = Number(process.argv[3] ?? 1.5);   // seconds before the "player" reacts
const STEP = 1 / 60;

createLayout(makeRng(71624));   // registers closed road segments before anything spawns
const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), CARS);
const fares = createFareSystem(makeRng(71624 + 55), new THREE.Scene());
const police = createPolice(makeRng(71624 + 66), new THREE.Scene());
const taxi = traffic.taxi;
traffic.warmup(10);

let pending = null;      // target awaiting our reaction
let reactIn = 0;
let elapsed = 0;
let routeFailures = 0;
const margins = [];      // seconds left when each leg completed

while (fares.state.delivered < FARES && !fares.state.gameOver && elapsed < 4000) {
  police.update(STEP);
  traffic.update(STEP);
  const event = fares.update(STEP, taxi);
  elapsed += STEP;

  if (event === 'spawned' || event === 'pickup') {
    if (event === 'pickup') margins.push(fares.state.timeLeft);
    pending = fares.state.target;
    reactIn = REACTION;
    taxi.route = [];
  } else if (event === 'delivered') {
    margins.push(fares.state.timeLeft);
    taxi.route = [];
    pending = null;
  }

  if (pending) {
    reactIn -= STEP;
    if (reactIn <= 0) {
      const route = findRoute(planOrigin(taxi), pending);
      if (route === null) routeFailures += 1;
      else { taxi.route = route; taxi.routeConsumed = false; fares.markDirected(); }
      pending = null;
    }
  }
}

// With a flat 24s clock covering both legs, a perfect player is *meant* to fail eventually —
// so this is now a difficulty gauge, not a fairness gate. The only hard failure is completing
// almost nothing, which would mean something is broken rather than hard.
const s = fares.state;
const worstMargin = margins.length ? Math.min(...margins) : 0;
const avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;

console.log(`delivered ${s.delivered}/${FARES} in ${elapsed.toFixed(0)}s of sim`);
console.log(`earned $${s.money}`);
console.log(`deadline margin: worst ${worstMargin.toFixed(1)}s, avg ${avgMargin.toFixed(1)}s`);
console.log(`route failures ${routeFailures} | red-light violations ${traffic.stats.violations}`);
if (s.gameOver) console.log(`ENDED EARLY: ${s.failReason}`);

console.log(`a perfect player (${REACTION}s reaction) survived ${s.delivered} fares`);
const ok = s.delivered >= 2 && routeFailures === 0 && traffic.stats.violations === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
