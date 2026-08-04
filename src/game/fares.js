import { GRID, HALF_ROAD, lineCoord } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createPassengerPin, createDestinationPin } from '../geometry/marker.js';
import { createPerson } from '../geometry/person.js';
import { createTimerRing } from './timerring.js';
import { createRiderMeter } from '../geometry/ridermeter.js';
import { urgencyLevel, URGENCY_SEGMENTS } from './urgency.js';
import { distanceTier } from './triptier.js';
import { PALETTE } from '../palette.js';

// The fare loop: a passenger waits at an intersection under a meter saying how long they'll wait
// and how far they're going, the taxi collects them, a drop-off pin appears, the taxi delivers.
// Any fare's timer running out ends the run.
//
// Each fare is its own little state machine (`waiting → riding → gone`) carrying its own clock,
// pins and ring, and up to MAX_FARES of them run at once.

// One flat deadline for the entire fare — spawned to delivered — and it does NOT restart when
// the rider gets in. Collecting them quickly is what buys the time to deliver them, which is the
// whole tension of the game. Trips average ~17s one-way, so 60s for both legs plus reaction time
// is tight but fair.
export const FARE_SECONDS = 60;

/**
 * Fare price = FARE_BASE + FARE_PER_BLOCK × Manhattan distance in blocks between the pickup and
 * drop-off intersections. Real taxis charge a flag drop plus a per-mile meter, and a flat rate
 * made every rider worth the same regardless of the effort — a corner-to-corner haul paid the same
 * as a one-block hop right next door. The base survives the tiniest trip (a 1-block ride still
 * pays enough to be worth taking), and the per-block slope makes the choice of *which* fare to
 * grab into an economic decision as well as a timing one.
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
 * Three fares, never four.
 *
 * The taxi has one seat, so any extra fare is someone *waiting* — a clock draining on the kerb
 * while you decide who to grab. Two waiting riders is where the game turns into a prioritisation
 * puzzle: you can't take both, and the wrong pick loses one of the two clocks. Three waiting was
 * tried and the board stops being readable at play zoom before it stops being solvable.
 */
export const MAX_FARES = 3;

/**
 * Deliveries before the board is allowed to hold two fares (SECOND) and three (THIRD).
 *
 * The first fare has to be allowed to teach the loop — spawn, tap, collect, tap, deliver — with
 * nothing else on screen. Someone learning which pin means what while extra clocks burn learns
 * neither. THIRD_FARE_AFTER staggers the ramp on top of that: two clocks is where the game turns
 * into a prioritisation puzzle, and adding a third on top before the player has settled into that
 * shape collapses the survival curve — measured median 2/25 with no ramp against 3/25 with one.
 */
export const SECOND_FARE_AFTER = 1;
export const THIRD_FARE_AFTER = 3;

// Cadence and placement of every fare beyond the first.
//
// SPAWN_MIN_GAP is the one that turns the game into a prioritisation puzzle rather than a burst
// event: after the tutorial delivery the board refills toward MAX_FARES one rider at a time, so
// two clocks land staggered by a few seconds. Their kerbside times drain out of phase and the
// player has to keep picking which one to serve. Spawning them all in the same frame gives one
// hard moment and then a quiet board, which is the wrong shape.
//
// RANGE / RADIUS / DELAY / MIN_CLOCK still shape the classic "second fare while carrying"
// hand-off: when someone is aboard and closing on their drop-off, the new rider appears near that
// drop-off so the pickup is a short hop. Their 60s has to cover the tail of the current delivery
// and a fresh pickup drive; charging them for a whole drop-off leg is ruinous (measured 7-fare
// median → 3 at 1.5s reaction). When that shape doesn't apply — the third rider on the kerb, or a
// refill while the taxi is on its way to a pickup — the spawn is still biased, but around the
// taxi's current intersection instead. A rider dropped in the far corner of the map has a 60s
// clock the taxi cannot possibly reach in time, which turns "prioritise" into "roll the dice".
const SPAWN_MIN_GAP = 15;            // seconds between successive spawns on a non-empty board
const SECOND_FARE_DELAY = 5;         // seconds aboard before the near-the-drop-off bias applies
const SECOND_FARE_RANGE = 45;        // world units from the taxi to its drop-off
const SECOND_FARE_RADIUS = 3;        // blocks from that drop-off they may spawn within
const SECOND_FARE_MIN_CLOCK = 18;    // seconds the current fare must still have

// Live-tweakable from the debug panel. FARE_SECONDS stays the documented default so the headless
// tools keep a fixed baseline.
let fareSeconds = FARE_SECONDS;
export const setFareSeconds = (s) => { fareSeconds = s; };
export const getFareSeconds = () => fareSeconds;

const ARRIVE_RADIUS = 7;       // how close the taxi must get to count as arrived

// How long the rider takes to run from the kerb and hop into the taxi after pickup fires.
//
// The pickup *event* still fires the instant the taxi is inside ARRIVE_RADIUS — game logic, HUD
// and the timer transfer all start immediately. This only defers the moment the rider marker
// physically hides, so a run-and-jump animation gets to play across it. Tuned against the timer
// transfer's 0.65s so the ring lands on the taxi a beat before the rider disappears into it.
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
 * The meshes one fare needs. Built once per slot and reused for every fare that occupies it —
 * a fare is cheap bookkeeping, but a person, two pins, a shaft and a ring are not something to
 * rebuild every twenty seconds.
 */
function createSlot(scene, index) {
  const passenger = createPassengerPin(createPerson);
  const destination = createDestinationPin();
  // One clock for the whole fare, in two bodies: the meter's urgency bar while the rider is on the
  // kerb, then this ring once they're aboard. It does not restart at the hand-off.
  const timer = createTimerRing(scene);

  // Urgency and trip distance, floating over the waiting rider. Hangs off the marker's standing group
  // so it follows the same kerb placement — but it keeps its own `visible` flag, which is what
  // stops it reappearing over the delivered rider when beginExit un-hides the passenger group at
  // the far end of the trip.
  //
  // This is also what used to be a shaft of light: at play zoom the meter is a bright ~67 x 27px
  // block over the rider's head, which marks them at range better than the shaft did *and* says
  // something while doing it.
  const meter = createRiderMeter();
  passenger.postGroup.add(meter.group);

  // Stamped on the roots so a click can be traced back to the fare that owns what was hit. The
  // picker already walks up parents looking for `pickable`; this rides along the same walk.
  passenger.group.userData.fareSlot = index;
  destination.group.userData.fareSlot = index;

  passenger.group.visible = false;
  destination.group.visible = false;
  scene.add(passenger.group);
  scene.add(destination.group);

  return { index, passenger, destination, timer, meter };
}

export function createFareSystem(rng, scene) {
  const state = {
    // Active fares, newest last. At most MAX_FARES, and up to MAX_FARES - 1 of them can be
    // waiting on the kerb at once — the whole prioritisation puzzle.
    fares: [],
    elapsed: 0,
    money: 0,
    delivered: 0,
    // Time of the most recent spawn, so refills stagger by SPAWN_MIN_GAP instead of bursting.
    // -Infinity so the very first spawn is unrestricted.
    lastSpawnAt: -Infinity,
    gameOver: false,
    failTitle: 'Game Over',
    failReason: null,
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
    pin.group.visible = true;
  };

  /**
   * Pick an intersection that isn't the taxi's next one, and isn't already spoken for.
   *
   * `near` biases the draw to within SECOND_FARE_RADIUS blocks of another junction — either the
   * current drop-off or the taxi's own intersection, see `spawnBias`. Drop-offs are always drawn
   * unbiased: the whole point of showing a trip's length up front is that they differ.
   */
  function pickIntersection(taxiCar, near = null) {
    // Every junction already spoken for, which is now both ends of every live fare: a waiting
    // rider's drop-off pin is on the map from the moment they appear, so dropping a second rider
    // (or a second drop-off) on top of it would put two markers on one kerb corner.
    const avoid = [{ i: taxiCar.i, j: taxiCar.j }];
    for (const f of state.fares) {
      avoid.push(f.target);
      if (f.dropoff) avoid.push(f.dropoff);
    }
    const free = (i, j) => !avoid.some((a) => a.i === i && a.j === j);

    if (near) {
      const options = [];
      const lo = (v) => Math.max(0, v - SECOND_FARE_RADIUS);
      const hi = (v) => Math.min(GRID, v + SECOND_FARE_RADIUS);
      for (let i = lo(near.i); i <= hi(near.i); i++) {
        for (let j = lo(near.j); j <= hi(near.j); j++) if (free(i, j)) options.push({ i, j });
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

  let lastColorIndex = -1;

  /**
   * A colour no other live fare is wearing, and not the one the previous fare had either.
   *
   * "Different from the last one" was enough while colour was assigned at pickup and only the
   * carried fare ever had one. Now every fare on the board is coloured from the moment it spawns —
   * that colour is what pairs a rider with their drop-off pin across the map — so two fares sharing
   * one would point the player at the wrong junction. Five colours against MAX_FARES = 3 means the
   * walk below always finds a free one, and it still costs exactly one draw so the stream stays
   * predictable.
   */
  function nextFareColor() {
    const palette = PALETTE.fareColors;
    const taken = new Set(state.fares.map((f) => f.color).filter(Boolean));
    let index = rng.int(0, palette.length - 1);
    for (let step = 0; step < palette.length; step++) {
      const candidate = (index + step) % palette.length;
      if (candidate === lastColorIndex || taken.has(palette[candidate])) continue;
      index = candidate;
      break;
    }
    lastColorIndex = index;
    return palette[index];
  }

  const carrying = () => state.fares.find((f) => f.stage === 'riding') ?? null;
  // With more than one rider on the kerb the "waiting fare" the game means is the one about to
  // time out — that is who a perfect player takes next.
  const waiting = () => state.fares
    .filter((f) => f.stage === 'waiting')
    .reduce((best, f) => (best === null || f.timeLeft < best.timeLeft ? f : best), null);
  // Every waiting fare, for the HUD stack that surfaces one chip per rider on the kerb.
  const waitingAll = () => state.fares.filter((f) => f.stage === 'waiting');

  /** The fare the player is currently working: whichever one the taxi was last sent at. */
  const focus = () => state.fares.find((f) => f.directed) ?? carrying() ?? waiting() ?? null;

  function spawnFare(taxiCar, near = null) {
    const slot = slots.find((s) => !state.fares.some((f) => f.slot === s)
      && !exits.some((e) => e.slot === s));
    if (!slot) return null;

    const spot = pickIntersection(taxiCar, near);
    const fare = {
      slot,
      stage: 'waiting',
      target: spot,
      // Where they were picked up. `target` moves to the drop-off at `beginRide`, so without a
      // separate copy the trip distance (and its fare) can't be measured later.
      pickup: spot,
      // Where they are going, known from the moment they appear. `target` is what the taxi is
      // being sent at right now; `dropoff` is the far end of the trip, and it stays put across
      // the hand-off at pickup.
      dropoff: null,
      blocks: 0,
      limit: fareSeconds,
      timeLeft: fareSeconds,
      // Arrival only resolves once the player has actually sent the taxi at this fare. Without
      // it, a taxi cruising on random turns wanders into the pin on its own — measured at 11 of
      // 40 seeds — and picks up or delivers a fare the player never directed it to.
      directed: false,
      color: null,
      ridingFor: 0,
      value: 0,
    };
    state.fares.push(fare);

    // Destination first, colour second — the draw order is load-bearing. Both come off the same
    // stream, so swapping them reshuffles every intersection a seed produces and the headless
    // baselines stop describing the same run.
    //
    // The trip is *decided* here even though its far end stays hidden until pickup: the meter's
    // distance bar needs the length, and the price is fixed from it. What the player gets up front
    // is how far, not where. The unbiased draw is deliberate — the *pickup* is biased toward where
    // the taxi can reach (see spawnBias), but a drop-off next door to every other drop-off would
    // flatten the trip lengths the distance bar exists to tell apart.
    fare.dropoff = pickIntersection(taxiCar);
    fare.color = nextFareColor();
    fare.blocks = blockDistance(spot, fare.dropoff);
    // Priced by the trip's block distance, fixed here because both endpoints are already known. A
    // hidden meter that ticked while driving would punish traffic and reward Loco Mode for the
    // wrong reasons.
    fare.value = priceFor(spot, fare.dropoff);

    place(slot.passenger, spot.i, spot.j);
    // Slot reuse: the previous rider on this slot may have left the figure shrunk and tumbled at
    // the end of their board() pose. Reset so the new waiter starts clean on this frame — wave()
    // would fix it on the next tick, but there is one frame between spawn and first wave.
    slot.passenger.standing?.rest?.();

    // Where they're going stays theirs until they're in the car. The meter says how far, which is
    // the whole of the "is this worth taking?" decision; a pin on the far kerb as well turned the
    // board into three riders and three destinations to read at once.
    slot.destination.group.visible = false;
    // Full urgency and the trip's tier. The clock has not started draining yet this frame, so the
    // bar opens at 4/4 by construction rather than by rounding.
    slot.meter.show(URGENCY_SEGMENTS, distanceTier(fare.blocks));

    // No ring on the kerb: while the rider waits their clock is the meter's urgency bar. The ring
    // is placed and launched at pickup, from this same corner, so the hand-off still reads as the
    // clock leaving the rider and chasing the taxi.
    return fare;
  }

  /**
   * How much time this fare has left, 1 (just spawned) down to 0.
   *
   * Every rider drains at the same rate today — one flat `fareSeconds` for all of them — so this is
   * just the clock. It exists as its own function because that is the seam: a patience mechanic
   * where some riders are pricklier than others changes what goes in here, and nothing downstream
   * of it. The meter, the ring and the finder chips already speak in levels, not seconds.
   */
  const urgencyOf = (fare) => Math.max(0, Math.min(1, fare.timeLeft / fare.limit));

  function beginRide(fare) {
    // Remember where the pickup happened before we overwrite `target` with the drop-off. The
    // boarding animation needs the kerb corner as its origin so the figure can run from it.
    fare.boardingFrom = cornerFor(fare.target.i, fare.target.j);
    fare.boarding = 0;

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
    place(fare.slot.destination, fare.dropoff.i, fare.dropoff.j);
    fare.slot.destination.setColor(fare.color);
    // The meter has done its job the moment the choice is made. Both its questions are answered:
    // this rider is taken, and where they're going is now the pin the taxi is driving at.
    fare.slot.meter.hide();
    // The rider is aboard, so the deadline is the car's problem now. The ring picks the clock up
    // from the kerb the meter was standing over and chases the taxi with it, drawing over the city
    // so the timer never gets lost behind a building.
    fare.slot.timer.placeAt(fare.boardingFrom.x, fare.boardingFrom.z);
    fare.slot.timer.beginTransfer();
  }

  function clear(fare) {
    fare.slot.passenger.group.visible = false;
    fare.slot.destination.group.visible = false;
    fare.slot.meter.hide();
    fare.slot.timer.hide();
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
    // Already hidden at pickup, but the passenger group it hangs off is being un-hidden right
    // here — belt and braces so a delivered rider never walks away still wearing a meter.
    slot.meter.hide();
    slot.timer.hide();
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
   * An empty board always refills — the ordinary one-fare loop. Beyond that, refills are gated
   * on the tutorial delivery (SECOND_FARE_AFTER), on the board having room, and on
   * SPAWN_MIN_GAP since the last spawn so the extra clocks arrive staggered rather than in a
   * single burst.
   */
  function shouldRefill() {
    if (state.fares.length >= MAX_FARES) return false;
    if (state.fares.length === 0) return true;
    if (state.fares.length === 1 && state.delivered < SECOND_FARE_AFTER) return false;
    if (state.fares.length === 2 && state.delivered < THIRD_FARE_AFTER) return false;
    return state.elapsed - state.lastSpawnAt >= SPAWN_MIN_GAP;
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
    // board refills at once; further slots open one at a time, staggered by SPAWN_MIN_GAP, so the
    // extra clocks arrive out of phase and the board turns into a prioritisation puzzle instead
    // of a single hard moment followed by a lull.
    if (shouldRefill()) {
      const spawned = spawnFare(taxiCar, spawnBias(taxiCar));
      if (spawned) {
        state.lastSpawnAt = state.elapsed;
        emit('spawned', spawned);
      }
    }

    state.elapsed += dt;

    for (const fare of live) {
      const { passenger, destination, timer, meter } = fare.slot;

      // Wave the waiting rider. Driven off sim time so it stays deterministic for screenshots.
      if (fare.stage === 'waiting' && passenger.standing) passenger.standing.wave(state.elapsed);
      // Bounce the drop-off pin, so the thing you are being asked to drive to is the thing moving.
      if (fare.stage === 'riding') {
        destination.update(dt);
        fare.ridingFor += dt;
        // Boarding animation: the marker stays visible for BOARD_SECONDS after pickup while the
        // figure runs across the kerb and hops into the taxi. `boardingFrom` was captured at the
        // pickup instant; the delta to the taxi's *current* position is re-read every frame so a
        // slight drift while the car settles into `parked` still lands the rider on the car.
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

      fare.timeLeft -= dt;

      // One clock, two bodies. On the kerb it's the meter's urgency bar; once the rider is aboard
      // it's the ring following the taxi. The hand-off happens at pickup and the seconds never
      // reset across it — see beginRide.
      if (fare.stage === 'waiting') {
        meter.setUrgency(urgencyLevel(urgencyOf(fare)));
      } else {
        // The taxi rides on the road, not the kerb.
        timer.update(dt, { x: taxiCar.x, z: taxiCar.z, y: 0.09 },
          urgencyOf(fare), fare.timeLeft);
      }

      if (fare.timeLeft <= 0) {
        state.gameOver = true;
        state.failReason = fare.stage === 'waiting'
          ? 'A passenger gave up waiting.'
          : 'A fare was not delivered in time.';
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
        // Priced at spawn by the trip's block distance, so longer hauls pay more — and the block
        // count over the rider's head was that same number, so the player already knew what this
        // was worth when they chose it. The clock still supplies the *time* pressure; the meter is
        // what makes "which fare should I grab?" an economic decision rather than a coin flip.
        state.money += fare.value;
        state.delivered += 1;
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
   */
  function markDirected(fare = focus()) {
    if (!fare || !state.fares.includes(fare)) return false;
    if (fare.stage === 'waiting' && carrying()) return false;
    fare.directed = true;
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
   * to "Game Over") so a bust can read "Busted" while a wreck reads plainly. Idempotent: a second
   * call after game-over is already set is a no-op.
   */
  function crash(reason = 'Wrecked in a collision.', title = 'Game Over') {
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
    crash,
    pickables,
    fareFor,
    markDirected,
    carrying,
    waiting,
    waitingAll,
    focus,
    slots,
    intersectionCentre,
  };
}
