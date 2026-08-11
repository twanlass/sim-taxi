/**
 * One auto-played run, shared by `soak.mjs` and `difficulty-sweep.mjs`.
 *
 * Simulates a perfect *router*: sends the taxi at a fare the instant one appears or changes hands,
 * with a configurable reaction delay, and lets it drive the whole planned route. A real player is
 * strictly slower than this, so a run length here is the *ceiling* — how long the game can be
 * survived, not how long it usually is.
 *
 * That ceiling got further away from the floor when the game moved to
 * [swipe steering](../docs/gameplay.md#steering). This harness is no longer even approximately the
 * person playing: it takes the optimal route at every junction where they take whichever one they
 * managed to swipe for in time. What it still measures honestly is the *ramp* — the clocks are
 * budgeted from exactly this router, so a change that makes them tighter shows up here — and that
 * is what soak.mjs gates on. Read the absolute numbers as a bound, not as a difficulty.
 *
 * It lives in its own module because two tools now drive it and a copied harness is a harness that
 * drifts: the sweep's job is to compare tunings against the soak's number, which only means
 * anything if both are playing the same game. `tools/taxi.mjs` importing `ARRIVE_RADIUS` from
 * `fares.js` rather than keeping its own copy is the same rule.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { createPolice } from '../src/sim/police.js';
import { createFareSystem } from '../src/game/fares.js';
import { findRoute, planOrigin } from '../src/game/route.js';
import { isCityConnected } from '../src/city/grid.js';

// Pinned, and deliberately *not* `difficulty.carCount()`: the density ramp is pushed into the sim
// by main.js, and letting it move here would mean every fare number below was also measuring a
// traffic change. Density gets measured on its own, against `tools/signals.mjs`.
//
// 7 rather than the game's opening 12 is inherited from the tools this harness was factored out
// of, and every baseline in the suite is quoted against it — the fare numbers are comparable to
// each other and to the build before this one, which is what they are for. They are a slightly
// emptier city than the one that ships.
export const CARS = 7;

const STEP = 1 / 60;

/**
 * The city a run is played on, rerolled until it is actually drivable.
 *
 * `main.js` does this before the meshers ever run, because random park closures can strand part of
 * the map and the fare loop depends on `findRoute` never returning null. A sweep over cities has to
 * do it too, or one unlucky seed reports as a broken build.
 */
export function cityFor(seed) {
  for (let attempt = 0; attempt < 40; attempt++) {
    createLayout(makeRng(seed + attempt));
    if (isCityConnected()) return seed + attempt;
  }
  throw new Error(`no drivable city near seed ${seed}`);
}

/**
 * One full run: its own city, and its own situation on it.
 *
 * @param runSeed   the situation — car spawns, fare spawns, police timing
 * @param citySeed  the map
 * @param opts      {fares} deliveries to stop at, {reaction} seconds before the "player" reacts
 */
export function play(runSeed, citySeed, { fares: FARES = 40, reaction: REACTION = 1.5 } = {}) {
  cityFor(citySeed);
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
  // One row per delivered fare: what the clock was worth, what the driving was estimated to cost,
  // and how much of the clock was left at the drop-off. This is the read on whether the ramp is
  // ramping — if late fares still land with half their budget unspent, slack(d) is too loose.
  const budgets = [];

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
      if (type === 'delivered') {
        // `index` is which delivery this was, so the rows can be bucketed along the ramp.
        budgets.push({
          index: fares.state.delivered,
          limit: fare.limit,
          work: fare.work,
          spent: 1 - fare.timeLeft / fare.limit,
        });
        taxi.route = [];
      }
    }

    // Re-aim whenever the job changes hands — a pickup swaps the target to a drop-off, a delivery
    // hands the taxi over to whoever was left waiting on the kerb.
    const job = nextJob();
    if (events.length && job && job !== pending && !job.directed) {
      pending = job;
      // The drop-off leg costs the player nothing here: the harness routes on at the drop-off on
      // the pickup frame, so the only reaction a run pays for is on the
      // kerbside legs — deciding which rider to grab, which is the decision the game is about.
      reactIn = job.stage === 'riding' ? 0 : REACTION;
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
    budgets,
  };
}

// --- Small shared statistics --------------------------------------------------
// Both callers report distributions rather than a single number, because what is being tuned is
// the *shape* of the survival curve and a median hides both of its ends.

/** Value at a percentile of an already-sorted array. */
export const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
