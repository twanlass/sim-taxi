import { GRID, HALF_ROAD, lineCoord } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createPassengerPin, createDestinationPin } from '../geometry/marker.js';
import { createPerson } from '../geometry/person.js';
import { createFareMarker } from './faremarker.js';
import { urgencyLevel, URGENCY_SEGMENTS } from './urgency.js';
import { popEnvelope, popHighlight, POP_TIME, POP_SCALE_RIDER } from './selectpop.js';
import { chainSeconds, planOrigin } from './route.js';
import * as difficulty from './difficulty.js';

// The fare loop: a passenger waits at an intersection under a diamond coloured by how long they'll
// keep waiting, the taxi collects them, a drop-off ring appears, the taxi delivers. Any fare's timer
// running out ends the run.
//
// Each fare is its own little state machine (`waiting → riding → gone`) carrying its own clock, its
// rider, its drop-off and the one marker that travels between them; up to MAX_FARES run at once.

// One deadline for the entire fare — spawned to delivered — and it does NOT restart when the
// rider gets in. Collecting them quickly is what buys the time to deliver them, which is the whole
// tension of the game.
//
// **It is budgeted from the work, not flat.** A rider's clock is
// `difficulty.fareLimit(estimated driving seconds, deliveries)`, computed once at spawn — so a
// corner-to-corner haul and a hop next door are the same *difficulty* rather than the same number
// of seconds, and the ramp tightens the margin over the run. See `budgetFor` below.
//
// A flat 60s was what shipped before, and the reason it went is worth keeping: it made trip length
// the dominant source of difficulty and none of it was under anyone's control. `tools/soak.mjs`
// named it as its own biggest noise source — "one corner-to-corner fare eats 40s against a 17s
// average, and on some seeds even a perfect player loses the very first fare". Every fairness rule
// in this file used to exist to paper over that: extras were held near the current drop-off
// because a flat clock could not pay for a distant one.
//
// FARE_SECONDS survives as the debug panel's manual override and as the value a pinned clock falls
// back to. Setting it (from the ⚙️ panel, or `setFareSeconds`) takes the budget out of the loop
// entirely, which is what you want when you are tuning something else and need the clock to hold
// still.
export const FARE_SECONDS = 60;

/**
 * Fare price = FARE_BASE + FARE_PER_BLOCK × Manhattan distance in blocks between the pickup and
 * drop-off intersections. Real taxis charge a flag drop plus a per-mile meter, and a flat rate
 * made every rider worth the same regardless of the effort — a corner-to-corner haul paid the same
 * as a one-block hop right next door. The base survives the tiniest trip (a 1-block ride still
 * pays enough to be worth taking), and the per-block slope pays a long haul for the clock it eats.
 *
 * The player no longer sees the length before choosing: the distance bar that used to advertise it
 * went with the meter, so the kerb offers a clock and a place, and what the trip turns out to be
 * worth is settled on delivery.
 *
 * Calibrated so a median-length trip (~5 blocks) pays $20 — the old flat rate — which keeps the
 * soak suite's earnings roughly where they were. Range: $8 (1 block) → $35 (10 blocks, the
 * diameter of the grid).
 */
export const FARE_BASE = 5;
export const FARE_PER_BLOCK = 3;

/** Blocks between two intersections. */
export const blockDistance = (a, b) => Math.abs(a.i - b.i) + Math.abs(a.j - b.j);

/** What a trip from `pickup` to `dropoff` is worth. */
export const priceFor = (pickup, dropoff) =>
  FARE_BASE + FARE_PER_BLOCK * blockDistance(pickup, dropoff);

/**
 * The size of the mesh pool, and so the hard ceiling on the board.
 *
 * How many of these are actually *allowed* at any moment is `difficulty.maxFares(delivered)`,
 * which climbs 1 → 2 → 3 → 4 over the run. This constant is only the pool: one slot's worth of
 * meshes (a person, two pins, a marker) and one rider-finder chip are built per unit at startup,
 * so it has to cover the ramp's ceiling and there is no reason for it to exceed it.
 *
 * The taxi has one seat, so every fare beyond the first is someone *waiting* — a clock draining on
 * the kerb while you decide who to grab. Two waiting riders is where the game turns into a
 * prioritisation puzzle: you can't take both, and the wrong pick loses one of the two clocks.
 *
 * **Three waiting is readable, which it once was not.** This constant was 3 with a comment saying
 * three waiting riders "stops being readable at play zoom before it stops being solvable". That
 * judgement was made against the old meter — a bright ~67 × 27px slab over each rider's head — and
 * it did not survive the diamond that replaced it at ~29px: `?shot=11` renders a full four-fare
 * board and the four markers sit well apart, each a distinct hue with a matching disc on the road.
 * The finding is worth more than the inheritance, so the board goes to four.
 */
export const MAX_FARES = 4;

// --- VIP pickups ---------------------------------------------------------------
//
// A rare, cash-rich rider layered on top of the ordinary board: a fixed-purple diamond (see
// faremarker.js) instead of the usual urgency scale, a clock cut down from the ordinary budget,
// and — the one rule that makes it pure upside — missing one never ends the run. It only costs
// the bonus.
//
// The payout is the ordinary distance price times the player's current *VIP streak*: how many
// VIPs have been delivered back to back. Stamped at spawn like every other price on the board
// (see spawnFare) — the diamond's fixed purple should say what this one is worth the moment it
// appears, not leave it to be found out on delivery. The streak is what makes stacking VIPs worth
// the risk, and missing one resets it to zero: the whole tension is that one late drop-off gives
// it all back.
const VIP_MIN_DELIVERED = 1;      // never on the tutorial fare — nothing to distinguish it against yet
const VIP_COOLDOWN = 55;          // seconds between opportunities, so a VIP stays a rare event
const VIP_CHANCE = 0.16;          // chance a qualifying spawn actually becomes one

// The clock is a fraction of the run's own slack rather than a flat number, so a VIP tightens
// along the same ramp as everything else — just harder. Never below VIP_MIN_SLACK: `tools/
// probe.mjs` asserts every fare's clock covers its own work, and a VIP is meant to be urgent, not
// unwinnable.
const VIP_SLACK_FACTOR = 0.7;
const VIP_MIN_SLACK = 1.05;
const VIP_CLOCK_FLOOR = 10;

// Cadence and placement of every fare beyond the first.
//
// The spawn gap is what turns the game into a prioritisation puzzle rather than a burst event:
// after the tutorial delivery the board refills one rider at a time, so clocks land staggered by
// a few seconds. They drain out of phase and the player has to keep picking which one to serve.
// Spawning them all in the same frame gives one hard moment and then a quiet board, which is the
// wrong shape. It is `difficulty.spawnGap(delivered)` now — 15s down to 7s over the ramp — because
// tightening the stagger applies pressure without putting another pin on the map.
//
// RANGE / DELAY / MIN_CLOCK still shape the classic "second fare while carrying" hand-off: when
// someone is aboard and closing on their drop-off, the new rider appears near that drop-off so the
// pickup is a short hop.
//
// **The radius used to be a fairness patch and is now a difficulty knob.** Under a flat 60s clock
// an extra rider had to land near the current drop-off, because their clock had to cover the tail
// of that delivery plus a fresh pickup drive and charging them for a whole drop-off leg was
// ruinous — measured 7-fare median → 3 at 1.5s reaction. Budgeted clocks pay for the distance
// explicitly (see `budgetFor`), so the radius is free to open from 3 blocks to the whole map as
// the run goes on: `difficulty.spawnRadius(delivered)`.
const SECOND_FARE_DELAY = 5;         // seconds aboard before the near-the-drop-off bias applies
const SECOND_FARE_RANGE = 45;        // world units from the taxi to its drop-off
const SECOND_FARE_MIN_CLOCK = 18;    // seconds the current fare must still have

// The very first fare of the run gets a hard cap, independent of difficulty.spawnRadius: a
// tutorial-only guarantee that the rider a brand-new player is asked to find is never more than a
// short walk from where their taxi opened. Left as its own constant rather than folded into the
// ramp because it isn't a difficulty knob — it exists once, before the ramp has moved at all, and
// tightening or loosening the ramp's own start (`spawnRadiusStart`) must not change what the very
// first rider promises.
const FIRST_FARE_MAX_BLOCKS = 3;

// A manual override on the budgeted clock, for the ⚙️ panel and the tools.
//
// Null means "budget it" — the shipped behaviour. A number pins every rider to that many seconds
// flat, which is the old model, and is what you want while tuning something the clock would
// otherwise move under you.
let fareSecondsOverride = null;
export const setFareSeconds = (s) => { fareSecondsOverride = s === null ? null : Number(s); };
export const getFareSeconds = () => fareSecondsOverride ?? FARE_SECONDS;
export const isFareClockPinned = () => fareSecondsOverride !== null;

// How close the taxi's centre must get to the target *junction centre* to count as arrived.
//
// It has to cover a taxi held at that junction's red light, which is the one place the car can
// stop and stay stopped short of the pin. The hold line puts the car's centre at
// HALF_ROAD + STOP_SETBACK = 7.4 back along its lane, and the lane itself is LANE = 2 off the
// centreline, so a taxi waiting at the target's line sits hypot(7.4, 2) = 7.67 out — measured
// worst case 7.69 over 548 held-at-the-target samples in the headless sim. At 7 that was
// 0.4 too far: the car parked on the corner, right beside the pin, with the drop refusing to
// resolve until the light turned green. 9 clears it with margin.
//
// Not larger. Queued a car back from the line is another 5.3 (MIN_GAP), which is past half the
// 20-unit block pitch — resolving there would pop the rider out mid-block with the pin still a
// visible distance away, which reads as the drop landing in the wrong place.
export const ARRIVE_RADIUS = 9;

// How long the rider takes to run from the kerb and hop into the taxi after pickup fires.
//
// The pickup *event* still fires the instant the taxi is inside ARRIVE_RADIUS — game logic, HUD
// and the marker's flight to the taxi all start immediately. This only defers the moment the rider
// figure physically hides, so a run-and-jump animation gets to play across it. Tuned against that
// flight's 0.65s so the clock lands on the taxi a beat before the rider disappears into it.
const BOARD_SECONDS = 0.9;

// How long the delivered rider is visible for after they leave the cab. Longer than BOARD_SECONDS
// because the animation carries an extra beat — a fade after the run — so a departing rider is
// on-screen while the earnings pop is still travelling to the counter.
const EXIT_SECONDS = 1.4;

const NO_EVENTS = Object.freeze([]);

/**
 * Pin position for an intersection: on the pavement corner rather than in the carriageway, so it
 * never sits under a vehicle. Corners are flipped at the grid edge where there is no block.
 */
export function cornerFor(i, j) {
  // Right on the kerb, on the corner that faces the camera.
  //
  // Two separate things were hiding the rider. The old inset of +2.2 put it *inside* a building
  // (they start 0.85 into the block). And the camera looks down the +X+Z diagonal, so the block
  // on the +X+Z side of a junction is between the viewer and anything standing on it — the rider
  // has to go on the -X-Z kerb, flipping only at the grid edge where there is no block.
  const inset = HALF_ROAD + 0.5;
  const sx = i === 0 ? 1 : -1;
  const sz = j === 0 ? 1 : -1;
  return { x: lineCoord(i) + sx * inset, z: lineCoord(j) + sz * inset };
}

export const intersectionCentre = (i, j) => ({ x: lineCoord(i), z: lineCoord(j) });

/**
 * Which block a corner pin at intersection (i, j) actually stands on, mirroring the sx/sz flip in
 * `cornerFor`. Only i (or j) === 0 flips its corner inward, onto the same block that i (or j) === 1
 * already claims — every other line maps to a block of its own. That aliasing is invisible in
 * `pickIntersection`'s plain (i, j) equality check: two intersections a block apart by
 * `blockDistance` can still park their pins on the same physical block near the map's origin edge.
 */
function blockFor(i, j) {
  return { bi: i === 0 ? 0 : i - 1, bj: j === 0 ? 0 : j - 1 };
}

const onSameBlock = (a, b) => {
  const ba = blockFor(a.i, a.j);
  const bb = blockFor(b.i, b.j);
  return ba.bi === bb.bi && ba.bj === bb.bj;
};

/**
 * The meshes one fare needs. Built once per slot and reused for every fare that occupies it —
 * a fare is cheap bookkeeping, but a person, two pins, a shaft and a ring are not something to
 * rebuild every twenty seconds.
 */
function createSlot(scene, index) {
  const passenger = createPassengerPin(createPerson);
  const destination = createDestinationPin();

  // One clock for the whole fare, in one body: the diamond waits over the rider's head and flies to
  // the taxi when they get in. It does not restart at the hand-off, and neither does the marker.
  //
  // Scene-level rather than hung off the rider's kerb group — it has to leave that corner — so
  // hiding it is its own call rather than something the passenger group's visibility does for it.
  //
  // The bounce is staggered by slot so two fares live at once don't pulse in lockstep. A fixed
  // offset rather than a random one, because sim time drives it and shots have to reproduce.
  const marker = createFareMarker(scene, index * 0.31);

  // Stamped on the roots so a click can be traced back to the fare that owns what was hit. The
  // picker already walks up parents looking for `pickable`; this rides along the same walk.
  passenger.group.userData.fareSlot = index;
  destination.group.userData.fareSlot = index;

  passenger.group.visible = false;
  destination.group.visible = false;
  scene.add(passenger.group);
  scene.add(destination.group);

  return { index, passenger, destination, marker };
}

export function createFareSystem(rng, scene) {
  const state = {
    // Active fares, newest last. At most MAX_FARES, and up to MAX_FARES - 1 of them can be
    // waiting on the kerb at once — the whole prioritisation puzzle.
    fares: [],
    elapsed: 0,
    money: 0,
    delivered: 0,
    // Consecutive VIPs delivered without missing one. Stamped into a VIP's own price at spawn
    // (see spawnFare) and reset to 0 the instant one is missed.
    vipStreak: 0,
    // Time of the most recent spawn, so refills stagger by difficulty.spawnGap() rather than
    // bursting.
    // -Infinity so the very first spawn is unrestricted.
    lastSpawnAt: -Infinity,
    gameOver: false,
    failTitle: 'Too Slow!',
    failReason: null,
    // Holds every fare's countdown where it stands — the opening tutorial sets it while it is
    // talking (see game/tutorial.js). Only the *clock* stops: fares still spawn, riders still
    // wave, diamonds still bob, and the city behind the bubble carries on. A player being told how
    // to pick someone up must not be spending the clock they are about to need on it — and that
    // clock is budgeted from their trip's own driving (see `budgetFor`), so it is margin sized for
    // the road, not a flat sixty seconds with slack to spare.
    //
    // `state.elapsed` deliberately keeps running: it drives the spawn stagger and the marker
    // animations, neither of which is the player's to pay for.
    paused: false,
  };

  const slots = Array.from({ length: MAX_FARES }, (_, index) => createSlot(scene, index));

  // Delivered riders that are still animating out of the taxi. Kept separate from `state.fares` so
  // an exit-in-progress does not gate the next spawn — the puzzle is over the moment a fare is
  // delivered, and the animation is only skin. Each entry pins the slot it uses until it clears,
  // so a new fare cannot land on the same slot while its previous rider is still running away.
  const exits = [];

  // The marker root sits on the junction so intersection-space arithmetic elsewhere still works;
  // the standing pin (and, on the destination, the ring around it) shifts out to the pavement
  // corner as a single unit, so the pole and its ring read as one object.
  const place = (pin, i, j) => {
    const centre = intersectionCentre(i, j);
    const corner = cornerFor(i, j);
    pin.group.position.set(centre.x, 0.12, centre.z);
    pin.postGroup.position.set(corner.x - centre.x, KERB_H, corner.z - centre.z);
    // The select pop rides on this group (see the update tick), so a slot handed to a new rider —
    // or to a delivered one climbing out — has to start it back at rest rather than inherit
    // whatever frame of the last pop it was left on.
    pin.postGroup.scale.setScalar(1);
    pin.group.visible = true;
  };

  /**
   * Pick an intersection that isn't the taxi's next one, and isn't already spoken for.
   *
   * `near` biases the draw to within difficulty.spawnRadius() blocks of another junction — either the
   * current drop-off or the taxi's own intersection, see `spawnBias`. Drop-offs are always drawn
   * unbiased: the whole point of showing a trip's length up front is that they differ.
   *
   * `maxBlocks`, when given, additionally caps the draw to real Manhattan block distance from
   * `near` — the box `radius` builds is per-axis, so its corners sit up to `2 × radius` blocks out
   * on the diagonal. That slack is fine for an ordinary extra, but the very first fare (see
   * `spawnFare`) wants a hard cap the box alone can't promise, especially now that the taxi itself
   * starts downtown, where `radius` can span the whole map.
   *
   * `avoidBlockOf`, when given, additionally rules out any candidate whose corner pin would land
   * on the same physical block as that intersection's own corner pin (see `blockFor`) — used to
   * keep a fare's drop-off off the same block as its own pickup, which plain (i, j) inequality
   * doesn't catch near the map's origin edge.
   */
  function pickIntersection(taxiCar, near = null, maxBlocks = null, avoidBlockOf = null) {
    // Every junction already spoken for, which is now both ends of every live fare: a waiting
    // rider's drop-off pin is on the map from the moment they appear, so dropping a second rider
    // (or a second drop-off) on top of it would put two markers on one kerb corner.
    const avoid = [{ i: taxiCar.i, j: taxiCar.j }];
    for (const f of state.fares) {
      avoid.push(f.target);
      if (f.dropoff) avoid.push(f.dropoff);
    }
    const free = (i, j) => !avoid.some((a) => a.i === i && a.j === j)
      && (!avoidBlockOf || !onSameBlock({ i, j }, avoidBlockOf));

    if (near) {
      const options = [];
      const radius = difficulty.spawnRadius(state.delivered);
      const lo = (v) => Math.max(0, v - radius);
      const hi = (v) => Math.min(GRID, v + radius);
      for (let i = lo(near.i); i <= hi(near.i); i++) {
        for (let j = lo(near.j); j <= hi(near.j); j++) {
          if (!free(i, j)) continue;
          if (maxBlocks !== null && blockDistance({ i, j }, near) > maxBlocks) continue;
          options.push({ i, j });
        }
      }
      if (options.length) return options[rng.int(0, options.length - 1)];
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      const i = rng.int(0, GRID);
      const j = rng.int(0, GRID);
      if (free(i, j)) return { i, j };
    }
    return { i: 0, j: 0 };
  }

  /**
   * Junctions the *next* drop-off should prefer, if either is still free. Set once per run by
   * main.js when a construction zone goes up (see `roadwork.onPlaced`), and consumed by the very
   * next fare drawn — hence one-shot.
   *
   * The taxi cannot be steered, so meeting the zone has to be arranged rather than hoped for. The
   * router discount in route.js does most of it; this closes the gap by giving the player one trip
   * whose far end is a junction the closed street runs into, so the cheap lane is on the way rather
   * than merely nearby.
   *
   * Exactly one fare is nudged and only its *destination* moves — the pickup, the clock and the
   * price are all drawn as usual — so the economy is untouched. It cannot cascade either: a hint
   * that finds nothing free is dropped rather than retried.
   */
  let dropoffHint = null;

  /**
   * Take the hint if one of its junctions is a legal drop-off for a fare picked up at `spot`, and
   * clear it either way. Returns null when there is nothing usable, which puts the caller back on
   * the ordinary unbiased draw.
   *
   * "Legal" is the same pair of rules `pickIntersection` applies: not already spoken for by another
   * fare or by the taxi's own next junction, and not on the same physical block as the pickup.
   */
  function takeDropoffHint(taxiCar, spot) {
    const hint = dropoffHint;
    dropoffHint = null;
    if (!hint) return null;

    const avoid = [{ i: taxiCar.i, j: taxiCar.j }];
    for (const f of state.fares) {
      avoid.push(f.target);
      if (f.dropoff) avoid.push(f.dropoff);
    }
    // On the map first. `pickIntersection` draws its own candidates from `rng.int(0, GRID)` and so
    // can never produce an off-grid one; a hint arrives from outside and can. Without this a bad
    // hint is honoured rather than declined, and the rider's pin is staked off the edge of the
    // city — tools/probe.mjs caught exactly that.
    const onMap = (at) => at.i >= 0 && at.i <= GRID && at.j >= 0 && at.j <= GRID;
    const usable = hint.filter((at) => onMap(at)
      && !avoid.some((a) => a.i === at.i && a.j === at.j)
      && !onSameBlock(at, spot));
    if (!usable.length) return null;
    // Whichever end is further from the pickup, so the trip runs the length of the closed street
    // rather than clipping its nearer corner.
    return usable.reduce((best, at) => (blockDistance(at, spot) > blockDistance(best, spot) ? at : best));
  }

  const carrying = () => state.fares.find((f) => f.stage === 'riding') ?? null;
  // With more than one rider on the kerb the "waiting fare" the game means is the one about to
  // time out — that is who a perfect player takes next.
  //
  // Ranked by *fraction* of clock left, not by seconds. Now that clocks are budgeted, the two are
  // different questions: a rider with 30s left on a 90s haul is in more trouble than one with 25s
  // left on a 30s hop, and the second is the one you can still save. Fraction is also what the
  // diamond and the finder chip already show (`urgencyOf` → `urgencyLevel`), so ranking by
  // seconds would have the perfect player and the player's own eyes disagree about who is next.
  const waiting = () => state.fares
    .filter((f) => f.stage === 'waiting')
    .reduce((best, f) => (best === null || urgencyOf(f) < urgencyOf(best) ? f : best), null);
  // Every waiting fare, for the HUD stack that surfaces one chip per rider on the kerb.
  const waitingAll = () => state.fares.filter((f) => f.stage === 'waiting');

  /**
   * Every intersection the fare loop currently has a claim on: each rider's kerb corner and, for
   * the one aboard, where they are going.
   *
   * game/roadwork.js asks so it never closes a street a rider is standing in — the taxi can drive
   * through a closure, but a pickup happening inside a construction site reads as a bug even
   * though nothing about it actually breaks.
   */
  const occupiedSpots = () => state.fares.flatMap(
    (f) => (f.dropoff ? [f.target, f.dropoff] : [f.target]),
  );

  /** The fare the player is currently working: whichever one the taxi was last sent at. */
  const focus = () => state.fares.find((f) => f.directed) ?? carrying() ?? waiting() ?? null;

  /**
   * How many seconds this rider gets: the driving their trip actually costs, times the run's
   * current slack.
   *
   * The chain is what the taxi is *forced* to do before it can finish this fare — and that is
   * only ever the rider already aboard. You cannot take a kerbside fare while carrying one
   * (`markDirected` refuses), and the drop-off dispatches itself, so a carried rider is a
   * commitment the new arrival has to wait behind whether the player likes it or not. This is the
   * cost `SECOND_FARE_RANGE` and friends used to dodge by placing extras near the current
   * drop-off; budgeting it is what lets the placement rules relax.
   *
   * **Other waiting riders are deliberately not in the chain.** Budgeting a third rider as though
   * they will be served after the second would hand them a clock long enough to make waiting
   * safe, and "you can't take both, and the wrong pick loses one of the two clocks" is the entire
   * game.
   *
   * **That was measured and it was wrong.** Budgeting each rider as if they were next made every
   * board of two waiters a countdown rather than a choice: one of them was always on a clock no
   * play could meet, and because any expiry ends the run outright, the run ended. It capped a
   * perfect player at a median of 3–5 fares no matter which other knob was turned — the survival
   * curve was flat against the spawn gap, the board steps and the slack alike, because none of
   * them was the thing killing it (`tools/difficulty-sweep.mjs`, presets `gap` and `board`).
   *
   * So the queue is the *whole* queue: everything the taxi must clear before it can reach this
   * rider, in the order a competent player would clear it — the fare aboard first, then every
   * waiting rider by urgency, then this one. What that buys is a board where serving in the right
   * order works and serving in the wrong order does not. The puzzle survives; it is an ordering
   * puzzle now rather than a lottery, and the ramp squeezes how far from the right order you can
   * stray before the margin runs out.
   *
   * Computed once, at spawn, and never revisited. A clock that grew because the board got busier
   * would be incoherent — and it would mean the player could earn time by dithering. It also
   * means the newest rider always holds the longest clock, so the board reads oldest-first, which
   * is the order it wants to be served in.
   */
  // Never while one is already live on the board, and gated by its own cooldown/chance on top of
  // that — a VIP has to stay a rare thing to be a special one.
  let lastVipAt = -Infinity;
  function wantsVip() {
    if (state.delivered < VIP_MIN_DELIVERED) return false;
    if (state.fares.some((f) => f.vip)) return false;
    if (state.elapsed - lastVipAt < VIP_COOLDOWN) return false;
    return rng.chance(VIP_CHANCE);
  }

  /** A VIP's clock: tight, but still guaranteed to cover the driving it pays for. */
  function vipLimitFor(work) {
    const slackMul = Math.max(VIP_MIN_SLACK, difficulty.slack(state.delivered) * VIP_SLACK_FACTOR);
    return Math.max(VIP_CLOCK_FLOOR, Math.round(work * slackMul));
  }

  function budgetFor(taxiCar, pickup, dropoff, vip = false) {
    const stops = [];
    // The rider aboard is a commitment: you cannot take a kerbside fare while carrying one
    // (`markDirected` refuses) and the drop-off dispatches itself.
    const riding = carrying();
    if (riding) stops.push(riding.dropoff);
    // Then everyone already on the kerb, most urgent first — the same order `waiting()` hands
    // them to the player, and the only order one taxi can work in.
    // `limit > 0` skips the rider currently being budgeted: `spawnFare` pushes them onto the
    // board before their trip is decided, and a fare cannot queue behind itself.
    const ahead = state.fares
      .filter((f) => f.stage === 'waiting' && f.limit > 0)
      .sort((a, b) => urgencyOf(a) - urgencyOf(b));
    for (const f of ahead) stops.push(f.pickup, f.dropoff);
    stops.push(pickup, dropoff);

    // `main.js` rerolls any city where `findRoute` fails a pair, so null is the unreachable case
    // rather than a real one. Falling back to the old flat clock keeps an unroutable fare
    // playable instead of handing it a zero.
    const work = chainSeconds(planOrigin(taxiCar), stops) ?? FARE_SECONDS;
    // A pinned clock takes the budget out of the loop entirely — see `setFareSeconds`. The work
    // is still measured, so the tools can report the slack a pinned run happens to be playing at.
    const limit = isFareClockPinned()
      ? getFareSeconds()
      : vip ? vipLimitFor(work) : difficulty.fareLimit(work, state.delivered);
    return { work, limit };
  }

  function spawnFare(taxiCar, near = null, vip = false) {
    const slot = slots.find((s) => !state.fares.some((f) => f.slot === s)
      && !exits.some((e) => e.slot === s));
    if (!slot) return null;

    // `lastSpawnAt` only holds -Infinity before the run's very first spawn — see its init above.
    // That is the one spawn this cap applies to; every later empty-board refill is an ordinary one
    // and gets the ramp's own radius.
    const isFirstEver = state.lastSpawnAt === -Infinity;
    const spot = pickIntersection(taxiCar, near, isFirstEver ? FIRST_FARE_MAX_BLOCKS : null);
    const fare = {
      slot,
      stage: 'waiting',
      vip,
      target: spot,
      // Where they were picked up. `target` moves to the drop-off at `beginRide`, so without a
      // separate copy the trip distance (and its fare) can't be measured later.
      pickup: spot,
      // Where they are going, known from the moment they appear. `target` is what the taxi is
      // being sent at right now; `dropoff` is the far end of the trip, and it stays put across
      // the hand-off at pickup.
      dropoff: null,
      blocks: 0,
      // Both filled in below, once the drop-off is drawn — the clock is budgeted from the trip,
      // so it cannot be known until the trip is.
      limit: 0,
      timeLeft: 0,
      // Estimated seconds of driving this fare was priced against, kept for the tools: the ratio
      // of it to `limit` is the slack the fare actually shipped with, and `tools/soak.mjs` reads
      // it to check the ramp is tightening.
      work: 0,
      // Arrival only resolves once the player has actually sent the taxi at this fare. Without
      // it, a taxi cruising on random turns wanders into the pin on its own — measured at 11 of
      // 40 seeds — and picks up or delivers a fare the player never directed it to.
      directed: false,
      // The select pop on the figure: `popPending` is a tap waiting to be stamped, `popAt` the sim
      // time it was stamped at, undefined once the pop has run out. The crystal over their head
      // runs its own half of the same pop. See `markDirected`.
      popPending: false,
      popAt: undefined,
      ridingFor: 0,
      value: 0,
    };
    state.fares.push(fare);

    // The trip is *decided* here even though its far end stays hidden until pickup: the price is
    // fixed from its length, so both ends have to be known now. What the player gets up front is
    // the clock, and nothing about where. The unbiased draw is deliberate — the *pickup* is biased
    // toward where the taxi can reach (see spawnBias), but a drop-off next door to every other
    // drop-off would flatten the trip lengths the fares are priced off. `spot` is also passed as
    // the block-avoid point, so the drop-off can't land on the same physical block as the pickup
    // even when the two intersections aren't identical — see `blockFor`.
    //
    // `takeDropoffHint` is the one exception, and it is deliberately narrow: at most one fare per
    // run has its far end aimed at a construction zone, and it falls straight back to the draw
    // below when neither end qualifies.
    fare.dropoff = takeDropoffHint(taxiCar, spot) ?? pickIntersection(taxiCar, null, null, spot);
    fare.blocks = blockDistance(spot, fare.dropoff);
    // Priced by the trip's block distance, fixed here because both endpoints are already known. A
    // hidden meter that ticked while driving would punish traffic and reward Loco Mode for the
    // wrong reasons.
    //
    // The shift multiplier is stamped in at the same moment and for the same reason: the price is
    // a fact about the trip settled when the trip is, so a rider who appeared during Rush Hour is
    // worth Rush Hour money whenever they happen to get delivered.
    //
    // A VIP's own multiplier stacks on top: the current streak plus one, for the delivery that
    // would extend it. Stamped now rather than read at delivery, same as everything else priced
    // here — the marker's fixed purple has to say what this trip is worth the moment it appears.
    fare.vipMultiplier = vip ? state.vipStreak + 1 : 1;
    fare.value = Math.round(priceFor(spot, fare.dropoff)
      * difficulty.payoutMultiplier(state.delivered)
      * fare.vipMultiplier);

    // The clock, last: it is budgeted from the trip that was just decided, plus whatever the taxi
    // is already committed to finishing. Both ends of the trip are now known, which is the
    // earliest this number can exist.
    const budget = budgetFor(taxiCar, spot, fare.dropoff, vip);
    fare.work = budget.work;
    fare.limit = budget.limit;
    fare.timeLeft = budget.limit;

    place(slot.passenger, spot.i, spot.j);
    // Slot reuse: the previous rider on this slot may have left the figure shrunk and tumbled at
    // the end of their board() pose. Reset so the new waiter starts clean on this frame — wave()
    // would fix it on the next tick, but there is one frame between spawn and first wave.
    slot.passenger.standing?.rest?.();

    // Where they're going stays theirs until they're in the car — a pin on the far kerb as well
    // turned the board into three riders and three destinations to read at once.
    slot.destination.group.visible = false;
    // Full urgency: the clock has not started draining yet this frame, so the diamond opens on the
    // top level by construction rather than by rounding. Placed on the same kerb corner the figure
    // stands on, which is where it will launch from at pickup.
    const corner = cornerFor(spot.i, spot.j);
    slot.marker.showAt(URGENCY_SEGMENTS, corner.x, corner.z, vip);

    return fare;
  }

  /**
   * How much time this fare has left, 1 (just spawned) down to 0.
   *
   * Every rider drains at the same rate today — one flat `fareSeconds` for all of them — so this is
   * just the clock. It exists as its own function because that is the seam: a patience mechanic
   * where some riders are pricklier than others changes what goes in here, and nothing downstream
   * of it. The diamond, the ring and the finder chips already speak in levels, not seconds.
   */
  const urgencyOf = (fare) => Math.max(0, Math.min(1, fare.timeLeft / fare.limit));

  function beginRide(fare) {
    // Remember where the pickup happened before we overwrite `target` with the drop-off. The
    // boarding animation needs the kerb corner as its origin so the figure can run from it.
    fare.boardingFrom = cornerFor(fare.target.i, fare.target.j);
    fare.boarding = 0;
    // A rider standing next to the taxi when they were tapped can be collected mid-pop — the pop is
    // 0.4s and the drive is usually seconds, but not always. The waiting branch that drives the
    // swell stops running here, so land the figure back at full size before it starts running.
    fare.popAt = undefined;
    fare.popPending = false;
    fare.slot.passenger.postGroup.scale.setScalar(1);
    fare.slot.passenger.standing?.highlight?.(0);

    fare.stage = 'riding';
    // Both ends were drawn at spawn; the pickup is done, so the drop-off becomes the thing the
    // taxi is being sent at.
    fare.target = fare.dropoff;
    fare.directed = false;
    fare.ridingFor = 0;
    // Deliberately does not touch limit or timeLeft: the clock started when the rider appeared
    // and keeps running straight through the pickup.
    //
    // The rider stays *visible* here — the pickup event fires this frame, but they still need to
    // run to the taxi and hop in. board() in the update tick drives that and hides the marker
    // when the animation ends.
    // The drop-off is revealed now, at the junction drawn when this fare spawned. It never moves —
    // it was always going to be here, the player just could not see it yet.
    // No retint: the pin is Loco Mode's yellow at build time and stays there. It is an instruction
    // from the frame it appears, because the taxi is dispatched at it on this same frame — it spent
    // a spell opening in a resting teal for the stretch where the taxi parked waiting to be told,
    // and there is no such stretch any more. No per-fare hue either: one rider is aboard at a time,
    // so there is only ever one drop-off on the board and nothing to tell it apart from. The fare's
    // own colour lives on the taxi's roof sign now.
    place(fare.slot.destination, fare.dropoff.i, fare.dropoff.j);
    // The rider is aboard, so the deadline is the car's problem now — and the marker goes with
    // them, off the kerb corner it has been waiting on and across to the roof. Nothing is created
    // or destroyed at the hand-off, which is the point: it is the same clock, visibly moving.
    fare.slot.marker.beginTransfer();
  }

  function clear(fare) {
    fare.slot.passenger.group.visible = false;
    fare.slot.destination.group.visible = false;
    fare.slot.marker.hide();
    const at = state.fares.indexOf(fare);
    if (at !== -1) state.fares.splice(at, 1);
  }

  /**
   * Start the "rider gets out and walks to the sidewalk" animation.
   *
   * The passenger figure was hidden the moment they finished the boarding animation on pickup —
   * this un-hides it, drops it onto the taxi's current position, and hands the slot to `exits`
   * where its own tick will drive it home. The fare has already been removed from `state.fares`
   * by the caller, so the slot is free to be reused as soon as the animation completes.
   */
  function beginExit(slot, target, taxiCar) {
    place(slot.passenger, target.i, target.j);
    slot.passenger.standing?.rest?.();
    slot.passenger.group.visible = true;
    slot.destination.group.visible = false;
    // The clock stops here: the marker has ridden all the way in on the taxi, and the figure it
    // is about to hand back to the pavement has no deadline left.
    slot.marker.hide();
    exits.push({
      slot,
      target,
      // Captured now rather than looked up each frame — the taxi is about to drive off, and the
      // rider needs to land where the drop-off happened, not where the taxi currently is.
      exitFrom: { x: taxiCar.x, z: taxiCar.z },
      elapsed: 0,
    });
  }

  function updateExits(dt) {
    for (let i = exits.length - 1; i >= 0; i--) {
      const e = exits[i];
      e.elapsed += dt;
      const t = Math.min(1, e.elapsed / EXIT_SECONDS);
      const kerb = cornerFor(e.target.i, e.target.j);
      const dx = e.exitFrom.x - kerb.x;
      const dz = e.exitFrom.z - kerb.z;
      e.slot.passenger.standing?.exit?.(t, dx, dz);
      if (t >= 1) {
        e.slot.passenger.group.visible = false;
        e.slot.passenger.standing?.rest?.();
        exits.splice(i, 1);
      }
    }
  }

  const distanceToTarget = (fare, taxiCar) => {
    const c = intersectionCentre(fare.target.i, fare.target.j);
    return Math.hypot(taxiCar.x - c.x, taxiCar.z - c.z);
  };

  /**
   * Should the board be topped up this frame?
   *
   * An empty board always refills — the ordinary one-fare loop. Beyond that, refills are gated on
   * the board having room *for this point in the run* (`difficulty.maxFares`, which is what holds
   * the first fare alone until the loop has been taught) and on `difficulty.spawnGap` since the
   * last spawn, so the extra clocks arrive staggered rather than in a single burst.
   *
   * Both gates tighten as the run goes on, and MAX_FARES caps the first because the mesh pool is
   * only built once.
   */
  function shouldRefill() {
    // An empty board always refills, whatever the curve says — the ordinary one-fare loop, and the
    // only spawn that ignores the stagger.
    if (state.fares.length === 0) return true;
    if (state.fares.length >= Math.min(MAX_FARES, difficulty.maxFares(state.delivered))) return false;
    return state.elapsed - state.lastSpawnAt >= difficulty.spawnGap(state.delivered);
  }

  /**
   * Where to bias the next spawn. Extras only land where the taxi will actually be — otherwise a
   * rider spawned in the far corner has a 60-second clock the taxi cannot possibly reach in time,
   * which turns "prioritise" into "roll the dice".
   *
   *   Someone aboard and closing on their drop-off → bias near that drop-off (the classic
   *   two-fare hand-off, and the same fairness tax the original game paid).
   *   Otherwise → bias near the taxi's next intersection so extras are at least reachable, using
   *   the same block radius so the two paths read alike.
   */
  function spawnBias(taxiCar) {
    const riding = state.fares.find((f) => f.stage === 'riding');
    if (riding
      && riding.ridingFor >= SECOND_FARE_DELAY
      && distanceToTarget(riding, taxiCar) <= SECOND_FARE_RANGE
      && riding.timeLeft > SECOND_FARE_MIN_CLOCK) {
      return riding.target;
    }
    // Around wherever the taxi is heading — the intersection it's about to reach, not the one it
    // just left, so a spawn one step ahead is still a real hop away.
    return { i: taxiCar.i, j: taxiCar.j };
  }

  /**
   * Advances every fare's clock and resolves arrivals. Returns the events that happened this
   * frame — `{type, fare}`, with type one of 'spawned' | 'pickup' | 'delivered' | 'failed' — which
   * the caller uses to drive HUD feedback. Usually empty, and more than one can land together
   * (delivering the last fare frees the board and spawns the next in the same frame).
   */
  function update(dt, taxiCar) {
    if (state.gameOver) return NO_EVENTS;

    let events = null;
    const emit = (type, fare) => { (events ??= []).push({ type, fare }); };

    // Snapshot before refilling, for two reasons: resolving an arrival splices the fare out from
    // under the loop, and a fare spawned *this* frame must not also be ticked in it.
    const live = [...state.fares];

    // Refill the board at the top of the frame rather than the bottom, so a fare delivered last
    // frame has visibly cleared its ring before its slot gets handed to the next one. An empty
    // board refills at once; further slots open one at a time, staggered by difficulty.spawnGap(), so the
    // extra clocks arrive out of phase and the board turns into a prioritisation puzzle instead
    // of a single hard moment followed by a lull.
    if (shouldRefill()) {
      const vip = wantsVip();
      const spawned = spawnFare(taxiCar, spawnBias(taxiCar), vip);
      if (spawned) {
        state.lastSpawnAt = state.elapsed;
        if (spawned.vip) lastVipAt = state.elapsed;
        emit('spawned', spawned);
      }
    }

    state.elapsed += dt;

    for (const fare of live) {
      const { passenger, marker } = fare.slot;

      // Wave the waiting rider. Driven off sim time so it stays deterministic for screenshots.
      if (fare.stage === 'waiting' && passenger.standing) {
        passenger.standing.wave(state.elapsed);
        // ...and swell them if the player has just picked them (see `markDirected`).
        //
        // On `postGroup` rather than on the figure's own group for two reasons. `wave` writes
        // `group.scale` every frame, so a pop there would be overwritten by whichever of the two
        // ran last. And postGroup's origin is the kerb corner at pavement height — which is where
        // the rider's feet are — so the swell grows them out of the ground instead of out of their
        // own waist, and they never sink through the pavement at the undershoot.
        if (fare.popPending) {
          fare.popAt = state.elapsed;
          fare.popPending = false;
        }
        let pop = 0;
        let glow = 0;
        if (fare.popAt !== undefined) {
          const since = state.elapsed - fare.popAt;
          // On the clock, not on the value: the envelope passes through 0 before its undershoot.
          if (since >= POP_TIME) fare.popAt = undefined;
          else {
            pop = popEnvelope(since);
            glow = popHighlight(since);
          }
        }
        passenger.postGroup.scale.setScalar(1 + pop * POP_SCALE_RIDER);
        // Both written every frame, so the frame a pop retires is the one that puts the figure back.
        passenger.standing.highlight(glow);
      }
      // The drop-off is a ring on the road and holds still — nothing to tick but the beam circling
      // its rim. It used to bounce a floating head, on the grounds that the thing you are being
      // driven at should be the thing moving; the head is gone and the ring's own motion carries
      // that now, at ground level.
      if (fare.stage === 'riding') {
        fare.slot.destination.ring.update(state.elapsed);
        fare.ridingFor += dt;
        // Boarding animation: the marker stays visible for BOARD_SECONDS after pickup while the
        // figure runs across the kerb and hops into the taxi. `boardingFrom` was captured at the
        // pickup instant; the delta to the taxi's *current* position is re-read every frame, which
        // is what lets the figure catch a car that is still moving — and it always is, since the
        // pickup fires with the taxi mid-junction and it now drives straight on to the drop-off.
        if (fare.boarding !== undefined && passenger.standing?.board) {
          fare.boarding += dt;
          const t = Math.min(1, fare.boarding / BOARD_SECONDS);
          const kerb = fare.boardingFrom;
          passenger.standing.board(t, taxiCar.x - kerb.x, taxiCar.z - kerb.z);
          if (t >= 1) {
            passenger.group.visible = false;
            fare.boarding = undefined;
          }
        }
      }

      if (!state.paused) fare.timeLeft -= dt;

      // One clock, one body, wherever the fare currently is. The seconds never reset across the
      // hand-off and neither does the marker — see beginRide.
      //
      // The same fraction read twice: as a level, which is the colour and steps in quarters, and
      // as a fill, which is the liquid in the crystal and moves every frame.
      const left = urgencyOf(fare);
      marker.setUrgency(urgencyLevel(left));
      marker.setFill(left);
      if (fare.stage === 'waiting') {
        // No target: it holds the kerb corner it was shown on.
        marker.update(state.elapsed, null, fare.timeLeft);
      } else {
        marker.update(state.elapsed, taxiCar, fare.timeLeft);
      }

      if (fare.timeLeft <= 0) {
        // The one place a fare's clock running out does not end the run. A VIP is pure upside —
        // missing one costs the bonus and the streak, never the game — so it just clears off the
        // board like a delivery would, and the rest of the frame carries on.
        if (fare.vip) {
          state.vipStreak = 0;
          clear(fare);
          emit('vip-missed', fare);
          continue;
        }
        state.gameOver = true;
        state.failReason = "Patience wasn't your fare's strong suit.";
        for (const other of [...state.fares]) clear(other);
        for (const e of exits) {
          e.slot.passenger.group.visible = false;
          e.slot.passenger.standing?.rest?.();
        }
        exits.length = 0;
        emit('failed', fare);
        return events;
      }

      // Proximity resolves the arrival, but only for a taxi the player actually sent here. No
      // extra confirmation tap is needed on arrival — the tap that set the route is the intent.
      if (!fare.directed || distanceToTarget(fare, taxiCar) >= ARRIVE_RADIUS) continue;

      if (fare.stage === 'waiting') {
        beginRide(fare);
        emit('pickup', fare);
      } else {
        // Priced at spawn by the trip's block distance, so longer hauls pay more. The player does
        // not see the length before choosing — what the kerb offers is a clock, and the payout is
        // the trip's own business — so "which fare should I grab?" is a timing decision.
        state.money += fare.value;
        state.delivered += 1;
        // Extends the streak the next VIP's price is stamped with — see spawnFare. A miss resets
        // it; a delivery is the only way it grows.
        if (fare.vip) state.vipStreak += 1;
        // Pull the fare out of the puzzle immediately — the board is free to refill — while
        // handing the slot's passenger figure over to the exit animation. The next spawner
        // will skip this slot until the animation is done, so nothing lands on top of it.
        const at = state.fares.indexOf(fare);
        if (at !== -1) state.fares.splice(at, 1);
        beginExit(fare.slot, fare.target, taxiCar);
        emit('delivered', fare);
      }
    }

    updateExits(dt);
    return events ?? NO_EVENTS;
  }

  /**
   * Called when the player has routed the taxi at a fare. Refused for a rider on the kerb while
   * someone is already aboard: there is one seat, and a route that could never resolve into a
   * pickup is worse than no route at all.
   *
   * There is one taxi, so at most one fare can be `directed` at a time. Tapping a second waiting
   * rider before the taxi reaches the first re-routes the car — `routeTo` already overwrites
   * `car.route` — but without this, the first rider's `directed` flag survived the switch, and
   * `update()`'s arrival check only reads `directed` and proximity. If the new route happened to
   * pass within `ARRIVE_RADIUS` of the abandoned rider's corner, that fare resolved a pickup too:
   * two riders aboard at once, sharing the taxi's one seat. Clearing every other fare's flag here
   * is what keeps "whichever one the taxi was last sent at" (see `focus`) true of `directed` as
   * well as of the route.
   *
   * `pop` is the tap acknowledgement below, and shot mode turns it off: a staged dispatch is not a
   * gesture, and a still that happened to freeze a rider mid-swell would show them a few percent
   * large for a reason nothing in the frame explains.
   */
  function markDirected(fare = focus(), { pop = true } = {}) {
    if (!fare || !state.fares.includes(fare)) return false;
    if (fare.stage === 'waiting' && carrying()) return false;
    for (const other of state.fares) {
      if (other === fare || !other.directed) continue;
      other.directed = false;
    }
    fare.directed = true;
    // Acknowledge the tap: the rider and the crystal over their head swell and settle back
    // together (game/selectpop.js). Here rather than at the two call sites in main.js — a tap on
    // the pin and a tap on the rider-finder chip are the same instruction, and both land here only
    // once the route has actually been planned, so the pop never fires for a selection that was
    // refused.
    //
    // Waiting fares only. The drop-off is a disc on the road with nobody standing on it and its
    // crystal is over the taxi by then; the taxi dispatches itself there on the pickup frame, so
    // there is usually no tap to acknowledge in the first place.
    if (pop && fare.stage === 'waiting') {
      // Flagged rather than stamped, and stamped in the update tick — the same deferral the marker
      // makes for the same reason (see faremarker.js). It is also what keeps the two halves in
      // phase: both take their zero from the *same* `state.elapsed`, so the figure and the crystal
      // are on one curve rather than one frame apart.
      //
      // On the fare rather than on the slot: the figure is what pops, but the slot outlives this
      // rider and a pop is about this one selection.
      fare.popPending = true;
      fare.slot.marker.pop();
    }
    // Nothing else on the marker reflects this. The diamond's outline used to ink over heavier
    // for whichever waiting rider the car was on its way to, and it was pushed from here as well as
    // reconciled per frame so it landed on the same frame as the route band. The band is now the
    // whole of that answer — see geometry/diamond.js, RIM_SCALE.
    return true;
  }

  /** Objects the picker may hit — every live fare's one visible marker. */
  function pickables() {
    return state.fares.map((f) => (f.stage === 'waiting' ? f.slot.passenger : f.slot.destination).group);
  }

  /**
   * End the run outside the ordinary fare loop — the collision and police-bust paths both use
   * this. Clears every live fare so the pins/rings vanish under the run-end banner rather than
   * being frozen on-screen next to the frozen taxi. `title` overrides the banner heading (defaults
   * to "Wrecked!") so a bust can read "Busted!" while a collision reads plainly. Idempotent: a
   * second call after game-over is already set is a no-op.
   */
  function crash(reason = "That's coming out of your paycheck.", title = 'Wrecked!') {
    if (state.gameOver) return;
    state.gameOver = true;
    state.failTitle = title;
    state.failReason = reason;
    for (const other of [...state.fares]) clear(other);
    // An exit animation in progress freezes with the rest of the world under the run-end banner.
    for (const e of exits) {
      e.slot.passenger.group.visible = false;
      e.slot.passenger.standing?.rest?.();
    }
    exits.length = 0;
  }

  /** Which fare owns a picked object, walking up from the hit the way the picker does. */
  function fareFor(object) {
    for (let node = object; node; node = node.parent) {
      const slot = node.userData?.fareSlot;
      if (slot !== undefined) return state.fares.find((f) => f.slot.index === slot) ?? null;
    }
    return null;
  }

  return {
    state,
    update,
    /** Freeze/unfreeze every fare's countdown. See `paused` on the state above. */
    setPaused: (paused) => { state.paused = paused; },
    crash,
    pickables,
    fareFor,
    markDirected,
    carrying,
    waiting,
    waitingAll,
    occupiedSpots,
    focus,
    slots,
    intersectionCentre,
    /** Aim the next drop-off at one of `spots`, if either is free. See `dropoffHint`. */
    aimNextDropoff: (spots) => { dropoffHint = spots?.length ? spots : null; },
  };
}
