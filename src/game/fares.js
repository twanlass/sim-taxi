import { GRID, HALF_ROAD, lineCoord } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createPassengerPin, createDestinationPin } from '../geometry/marker.js';
import { createPerson } from '../geometry/person.js';
import { createTimerRing } from './timerring.js';
import { createLightShaft } from '../geometry/lightshaft.js';
import { PALETTE } from '../palette.js';

// The fare loop: a passenger waits at an intersection, the taxi collects them, a destination
// appears, the taxi delivers. Any fare's timer running out ends the run.
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
const blockDistance = (a, b) => Math.abs(a.i - b.i) + Math.abs(a.j - b.j);

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
  // One clock for the whole fare. It waits with the rider, then rides with the taxi.
  const timer = createTimerRing(scene);

  // Stands over the waiting rider. Lives on the marker's standing group, so it follows the same
  // kerb placement and hides with the rider automatically.
  passenger.postGroup.add(createLightShaft().mesh);

  // Stamped on the roots so a click can be traced back to the fare that owns what was hit. The
  // picker already walks up parents looking for `pickable`; this rides along the same walk.
  passenger.group.userData.fareSlot = index;
  destination.group.userData.fareSlot = index;

  passenger.group.visible = false;
  destination.group.visible = false;
  scene.add(passenger.group);
  scene.add(destination.group);

  return { index, passenger, destination, timer };
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
    failReason: null,
  };

  const slots = Array.from({ length: MAX_FARES }, (_, index) => createSlot(scene, index));

  // The marker group sits on the junction (its ring is the "drive here" cue); only the standing
  // pin is pushed out to the pavement corner so it doesn't hover over the carriageway.
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
   * current drop-off or the taxi's own intersection, see `spawnBias`. The unbiased path is left
   * exactly as it was, draw for draw, so a seed still produces the same one-fare run.
   */
  function pickIntersection(taxiCar, near = null) {
    const avoid = [{ i: taxiCar.i, j: taxiCar.j }, ...state.fares.map((f) => f.target)];
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

  /** A different colour from the previous fare, so consecutive rides never look identical. */
  function nextFareColor() {
    const palette = PALETTE.fareColors;
    let index = rng.int(0, palette.length - 1);
    if (index === lastColorIndex) index = (index + 1) % palette.length;
    lastColorIndex = index;
    return palette[index];
  }

  const carrying = () => state.fares.find((f) => f.stage === 'riding') ?? null;
  // With more than one rider on the kerb the "waiting fare" the game means is the one about to
  // time out — that is who the finder button should surface and who a perfect player takes next.
  const waiting = () => state.fares
    .filter((f) => f.stage === 'waiting')
    .reduce((best, f) => (best === null || f.timeLeft < best.timeLeft ? f : best), null);

  /** The fare the player is currently working: whichever one the taxi was last sent at. */
  const focus = () => state.fares.find((f) => f.directed) ?? carrying() ?? waiting() ?? null;

  function spawnFare(taxiCar, near = null) {
    const slot = slots.find((s) => !state.fares.some((f) => f.slot === s));
    if (!slot) return null;

    const spot = pickIntersection(taxiCar, near);
    const fare = {
      slot,
      stage: 'waiting',
      target: spot,
      // Where they were picked up. `target` moves to the drop-off at `beginRide`, so without a
      // separate copy the trip distance (and its fare) can't be measured later.
      pickup: spot,
      limit: fareSeconds,
      timeLeft: fareSeconds,
      // Arrival only resolves once the player has actually sent the taxi at this fare. Without
      // it, a taxi cruising on random turns wanders into the pin on its own — measured at 11 of
      // 40 seeds — and picks up or delivers a fare the player never directed it to.
      directed: false,
      color: null,
      ridingFor: 0,
      // Priced at pickup, once both endpoints are known. See `priceFor`.
      value: 0,
    };
    state.fares.push(fare);

    place(slot.passenger, spot.i, spot.j);
    slot.destination.group.visible = false;
    // Under the rider, not at the junction centre — the clock belongs to the person.
    const kerb = cornerFor(spot.i, spot.j);
    slot.timer.placeAt(kerb.x, kerb.z);
    return fare;
  }

  function beginRide(fare, taxiCar) {
    // Destination first, colour second — the draw order is load-bearing. Both come off the same
    // stream, so swapping them reshuffles every intersection a seed produces and the headless
    // baselines stop describing the same run.
    const spot = pickIntersection(taxiCar);
    fare.color = nextFareColor();
    fare.slot.destination.setColor(fare.color);
    fare.stage = 'riding';
    fare.target = spot;
    fare.directed = false;
    fare.ridingFor = 0;
    // The trip's price is fixed the moment both endpoints are known. A hidden meter that ticks
    // while driving would punish traffic and reward Loco Mode for the wrong reasons.
    fare.value = priceFor(fare.pickup, spot);
    // Deliberately does not touch limit or timeLeft: the clock started when the rider appeared
    // and keeps running straight through the pickup.
    fare.slot.passenger.group.visible = false;
    place(fare.slot.destination, fare.target.i, fare.target.j);
    // The rider is aboard, so the deadline is the car's problem now — send the clock after it,
    // and let it draw over the city so the taxi never loses its timer behind a building.
    fare.slot.timer.beginTransfer();
  }

  function clear(fare) {
    fare.slot.passenger.group.visible = false;
    fare.slot.destination.group.visible = false;
    fare.slot.timer.hide();
    const at = state.fares.indexOf(fare);
    if (at !== -1) state.fares.splice(at, 1);
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
      const { passenger, destination, timer } = fare.slot;

      // Wave the waiting rider. Driven off sim time so it stays deterministic for screenshots.
      if (fare.stage === 'waiting' && passenger.standing) passenger.standing.wave(state.elapsed);
      // Bounce the drop-off pin, so the thing you are being asked to drive to is the thing moving.
      if (fare.stage === 'riding') { destination.update(dt); fare.ridingFor += dt; }

      fare.timeLeft -= dt;

      // Waiting: the clock sits on the rider's junction. Riding: it follows the taxi.
      const anchor = fare.stage === 'waiting'
        ? { ...cornerFor(fare.target.i, fare.target.j), y: KERB_H + 0.05 }
        : { x: taxiCar.x, z: taxiCar.z, y: 0.09 };   // the taxi rides on the road, not the kerb
      timer.update(dt, anchor, Math.max(0, fare.timeLeft / fare.limit), fare.timeLeft);

      if (fare.timeLeft <= 0) {
        state.gameOver = true;
        state.failReason = fare.stage === 'waiting'
          ? 'A passenger gave up waiting.'
          : 'A fare was not delivered in time.';
        for (const other of [...state.fares]) clear(other);
        emit('failed', fare);
        return events;
      }

      // Proximity resolves the arrival, but only for a taxi the player actually sent here. No
      // extra confirmation tap is needed on arrival — the tap that set the route is the intent.
      if (!fare.directed || distanceToTarget(fare, taxiCar) >= ARRIVE_RADIUS) continue;

      if (fare.stage === 'waiting') {
        beginRide(fare, taxiCar);
        emit('pickup', fare);
      } else {
        // Priced at pickup by the trip's block distance, so longer hauls pay more. The clock
        // still supplies the *time* pressure; the meter is what makes "which fare should I
        // grab?" an economic decision rather than a coin flip.
        state.money += fare.value;
        state.delivered += 1;
        clear(fare);
        emit('delivered', fare);
      }
    }

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

  /** Objects the picker may hit — every live fare's current marker. */
  function pickables() {
    return state.fares.map((f) => (f.stage === 'waiting' ? f.slot.passenger : f.slot.destination).group);
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
    pickables,
    fareFor,
    markDirected,
    carrying,
    waiting,
    focus,
    slots,
    intersectionCentre,
  };
}
