/**
 * One auto-played run, shared by `soak.mjs` and `difficulty-sweep.mjs`.
 *
 * Simulates a perfect player: routes the taxi the instant a fare appears or changes hands, with a
 * configurable reaction delay. A real player is strictly slower than this, so a run length here is
 * the *ceiling* — how long the game can be survived, not how long it usually is.
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
import { createBuildings } from '../src/city/buildings.js';
import { createPolice } from '../src/sim/police.js';
import { createPatrol } from '../src/game/patrol.js';
import { createFareSystem } from '../src/game/fares.js';
import { createRobbery } from '../src/game/robbery.js';
import { findRoute, planOrigin, chainSeconds } from '../src/game/route.js';
import { createBoost, BOOST_FARE_REWARD } from '../src/game/boost.js';
import { createCollisions, TAXI_HP } from '../src/sim/collisions.js';
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

// How fast the loco player reckons it can drive when it has to, as a fraction of the cruise
// estimate `estimateSeconds` budgets from — what it uses to decide whether a rider is still within
// reach. Held to the ground on both sides: a player holding Loco Mode at every chance measured 0.41
// over the runs it survived, and wrecked on two runs in three; boosting only when behind, the same
// player measures 0.91–0.98 because it lets go as soon as the clock allows. 0.8 is a pace it can
// hold through a whole trip without needing the luck the first number did, and it is the floor
// `VIP_MIN_PACE` and `paceEnd` are kept above.
export const LOCO_PACE_SELF = 0.8;

// Seconds of cushion either player wants on a rider before taking them: the estimator's measured
// error is 4.35s (route.js), and a rider who runs out in the back seat ends the run.
const PICK_MARGIN = 4;

// Seconds of cushion the loco player wants over the cruise estimate before it lets go of the pedal.
const LOCO_MARGIN = 3;

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
    acceptedLayout = createLayout(makeRng(seed + attempt));
    acceptedSeed = seed + attempt;
    if (isCityConnected()) return acceptedSeed;
  }
  throw new Error(`no drivable city near seed ${seed}`);
}

// The blocks and the seed `cityFor` last accepted.
//
// Held here rather than returned because `cityFor`'s return value is the accepted *seed* and two
// callers outside this file read it as such. What needs the blocks is `createBuildings`, and it
// needs the ones the road network was actually installed from: `createLayout` is not a pure
// function — it bakes the network and installs it as *the* city's — so calling it a second time to
// get the same blocks back would silently replace the network every car in the sim is driving on.
// That trap has cost this project eight red checks once already.
let acceptedLayout = null;
let acceptedSeed = null;

/**
 * One full run: its own city, and its own situation on it.
 *
 * @param runSeed   the situation — car spawns, fare spawns, police timing
 * @param citySeed  the map
 * @param opts      {fares} deliveries to stop at, {reaction} seconds before the "player" reacts,
 *                  {robbery} whether the bank robbery layer runs (default on — it is in the game,
 *                  so it is in the number this harness reports). `false` is for measuring what it
 *                  costs, which is the only reason the switch exists.
 */
export function play(runSeed, citySeed,
  {
    fares: FARES = 40, reaction: REACTION = 1.5, robbery: ROBBERY = true, loco: LOCO = false,
  } = {}) {
  cityFor(citySeed);
  const traffic = createTraffic(makeRng(runSeed + 44), new THREE.Scene(), CARS);
  const fares = createFareSystem(makeRng(runSeed + 55), new THREE.Scene());
  const police = createPolice(new THREE.Scene());
  const taxi = traffic.taxi;
  // The patrol, which this player never boosts in front of — so it is only ever traffic to it, and
  // a chase it cannot start is one this harness does not measure (see the Loco Mode caveat in
  // docs/gameplay.md). `robbery` is declared below; the closure only runs once it exists.
  const patrol = createPatrol({
    rng: makeRng(runSeed + 66), police, traffic, taxi,
    blocked: () => Boolean(robbery?.state.active) || traffic.policeCars.some((cop) => !cop.patrol),
  });
  traffic.warmup(10);

  // The bank robbery (game/robbery.js). It is here rather than left out because it is **not** a
  // cosmetic layer: an event that takes the seat for a cross-town getaway spends the clock of every
  // rider standing on a kerb while it runs, which is a difficulty change whether or not anybody
  // tuned it as one. A harness that skipped it would report the survival curve of a game nobody
  // plays.
  //
  // The city's buildings have to be meshed for it, which is the one thing this harness did not
  // previously need — the bank is a lot, and which lot is a fact about the tower generator's own
  // draw. It costs about 30ms a run against runs that take seconds.
  //
  // `null` on a city with nowhere to put a bank, exactly as in main.js.
  const city = ROBBERY ? createBuildings(makeRng(acceptedSeed + 22), acceptedLayout) : null;
  let robbed = 0;

  let pending = null;      // fare awaiting our reaction
  let reactIn = 0;
  let elapsed = 0;
  let routeFailures = 0;
  const margins = [];      // seconds left when each leg completed
  // One row per delivered fare: what the clock was worth, what the driving was estimated to cost,
  // and how much of the clock was left at the drop-off. This is the read on whether the ramp is
  // ramping — if late fares still land with half their budget unspent, pace(d) is too loose.
  const budgets = [];

  // With more than one rider on the board the "perfect player" needs a policy, not just a reflex:
  // finish the rider you are carrying, then go straight to whichever waiting rider is closest to
  // timing out. `fares.waiting()` already returns the most-urgent waiter — deferring to it here is
  // the strategy, and the only order one taxi can serve them in.
  //
  // **Closest to timing out among the ones it can still make.** Every clock is budgeted as if its
  // rider were served next (see `budgetFor` in fares.js), and the board offers riders faster than one
  // taxi can serve them late in the ramp — so some of them are going to be let go, and a player who
  // goes for a rider whose clock is already short of the drive is not playing well, it is picking up
  // a fare that will run out in the back seat and end the run. `PACE_SELF` is how fast this player
  // actually drives against the estimator: about 1.0 at cruise, measured lower with Loco Mode.
  const PACE_SELF = LOCO ? LOCO_PACE_SELF : 1;
  const feasible = (f) => {
    const est = chainSeconds(planOrigin(taxi), [f.target, f.dropoff]);
    return est !== null && est * PACE_SELF + REACTION + PICK_MARGIN < f.timeLeft;
  };
  const nextJob = () => {
    const riding = fares.carrying();
    if (riding) return riding;
    let best = null;
    for (const f of fares.waitingAll()) {
      if (best && f.timeLeft / f.limit >= best.timeLeft / best.limit) continue;
      if (feasible(f)) best = f;
    }
    return best;
  };

  // Loco Mode, driven the way a player behind on the clock drives it: held while the job in hand
  // would not make it at cruise, let go once it would. Holding it everywhere was tried first and it
  // measured nothing useful — that player wrecks on two runs in three, so its survival curve is a
  // curve of collisions. Boosting is what arms sim/collisions.js, so it runs for this player and not for
  // the cruising one — off boost a contact is a free shove — and the run ends on the wreck exactly
  // as main.js ends it. This player does nothing to *avoid* a hit, so its wreck rate is the
  // pessimistic end and its pace the optimistic one.
  const boost = LOCO ? createBoost() : null;
  const collisions = LOCO ? createCollisions(traffic.cars, taxi) : null;
  let wrecked = false;
  let behind = false;
  if (collisions) {
    taxi.hp = TAXI_HP;
    collisions.onImpact(() => { wrecked = true; fares.crash(); });
  }
  let strikes = 0;
  const choices = [];

  // The robbery layer, wired the way main.js wires it: the trigger fires off where the taxi happens
  // to be, and the robber's getaway dispatches itself on the frame they get in. A perfect player
  // drives it because it is in the seat and `nextJob` returns whoever is carrying — the route is
  // planned here rather than through `pending` because there is no reaction to pay for, exactly as
  // for any other drop-off.
  const robbery = city?.bank
    ? createRobbery({
      site: city.bank,
      taxi,
      fares,
      traffic,
      onBoard: (fare) => {
        robbed += 1;
        const route = findRoute(planOrigin(taxi), fare.target);
        if (route === null) routeFailures += 1;
        else { taxi.route = route; taxi.routeConsumed = false; }
        pending = null;
      },
    })
    : null;

  while (fares.state.delivered < FARES && !fares.state.gameOver && elapsed < 4000) {
    if (boost) {
      // Re-judged four times a second, off the same estimator the clocks are budgeted from.
      if (Math.floor(elapsed * 4) !== Math.floor((elapsed - STEP) * 4)) {
        const job = fares.directed();
        const stops = job ? (job.stage === 'riding' ? [job.target] : [job.target, job.dropoff]) : [];
        const left = stops.length ? chainSeconds(planOrigin(taxi), stops) : null;
        behind = left !== null && taxi.route.length > 0 && left + LOCO_MARGIN > job.timeLeft;
      }
      if (behind && !boost.state.held) boost.press();
      if (!behind && boost.state.held) boost.release();
      boost.update(STEP);
      taxi.boost = boost.isEngaged();
    }
    traffic.update(STEP);
    collisions?.update(STEP);
    patrol.update(STEP);
    police.update(STEP);
    // Before the fare loop, same as main.js — a robber who gets in on this frame is on the board
    // before `fares.update` snapshots it.
    robbery?.update(STEP);
    const events = fares.update(STEP, taxi);
    elapsed += STEP;

    for (const { type, fare } of events) {
      if (type === 'pickup' || type === 'delivered') margins.push(fare.timeLeft);
      if (type === 'missed' || type === 'vip-missed') {
        if (type === 'missed') strikes += 1;
        if (fare.directed || fare.stage === 'riding') taxi.route = [];
        if (pending === fare) pending = null;
      }
      if (type === 'delivered') boost?.topUp(fare.vip || fare.robber ? 1 - boost.fraction() : BOOST_FARE_REWARD);
      // A getaway checkpoint moved the robber's target on; the game re-dispatches itself, so the
      // perfect player does too, with no reaction to pay.
      if (type === 'checkpoint') {
        const route = findRoute(planOrigin(taxi), fare.target);
        if (route === null) routeFailures += 1;
        else { taxi.route = route; taxi.routeConsumed = false; }
      }
      if (type === 'delivered') {
        // `index` is which delivery this was, so the rows can be bucketed along the ramp.
        budgets.push({
          index: fares.state.delivered,
          limit: fare.limit,
          work: fare.work,
          spent: 1 - fare.timeLeft / fare.limit,
          // Seconds the trip actually took against the estimate it was budgeted from — the pace this
          // player drives at. A VIP or a robber is budgeted off a different factor, so only ordinary
          // fares are worth reading this off.
          pace: fare.vip || fare.robber ? null : (fare.limit - fare.timeLeft) / fare.work,
        });
        taxi.route = [];
      }
    }

    // Re-aim whenever the job changes hands — a pickup swaps the target to a drop-off, a delivery
    // hands the taxi over to whoever was left waiting on the kerb.
    // Re-chosen every quarter second as well as on every event: a rider the player has not gone for
    // yet can drop out of reach just by waiting, and a fresh one can turn up that is.
    const tick = Math.floor(elapsed * 4) !== Math.floor((elapsed - STEP) * 4);
    const job = (events.length || tick) && !fares.directed() ? nextJob() : null;
    if (job && job !== pending && !job.directed) {
      // How many riders were on the kerb when this one was chosen — the read on whether the board
      // is offering a choice at all. Counted once per kerbside pick.
      if (job.stage === 'waiting') choices.push(fares.waitingAll().length);
      pending = job;
      // The drop-off leg costs the player nothing: the game routes the taxi there itself on the
      // pickup frame (main.js:dispatchToDropoff), so the only reaction a run pays for is on the
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
    /** How many bank robberies happened during the run. See game/robbery.js. */
    robbed,
    routeFailures,
    violations: traffic.stats.violations,
    worstMargin: margins.length ? Math.min(...margins) : 0,
    failReason: fares.state.failReason,
    strikes,
    wrecked,
    choices,
    budgets,
  };
}

// --- Small shared statistics --------------------------------------------------
// Both callers report distributions rather than a single number, because what is being tuned is
// the *shape* of the survival curve and a median hides both of its ends.

/** Value at a percentile of an already-sorted array. */
export const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
