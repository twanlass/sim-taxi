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

/** Flat rate per delivered fare. */
export const FARE_VALUE = 20;

/**
 * Two fares, never three.
 *
 * The taxi has one seat, so a second fare can only ever be someone *waiting* — a clock draining
 * on the kerb while you finish the job you're on. That is the whole added difficulty, and it
 * doesn't compound: a third would just be a second clock you equally cannot do anything about,
 * and the board would stop being readable at play zoom long before it stopped being solvable.
 */
export const MAX_FARES = 2;

/**
 * Deliveries before the second slot opens.
 *
 * The first fare has to be allowed to teach the loop — spawn, tap, collect, tap, deliver — with
 * nothing else on screen. Someone learning which pin means what while a second clock burns learns
 * neither.
 */
export const SECOND_FARE_AFTER = 1;

// When the second rider appears, and where.
//
// The stagger is the point of the whole feature. Spawning both at once gives two clocks running in
// lockstep — one hard moment, then an empty board. Landing the second one partway through a
// drop-off route means their clock is already part-spent by the time you are free to take them:
// you inherit a fare mid-emergency rather than starting one fresh.
//
// But the second rider pays a tax no first rider ever pays. Their 60s has to cover the rest of the
// current delivery *and* a full pickup drive, before their own trip even starts. Charging them for
// a whole drop-off leg is ruinous — median run over 40 seeds at a 1.5s reaction, `tools/soak.mjs
// 40 1.5 40`, went 7 fares to 3. So two things bound the tax:
//
//   RANGE  — they appear only once the taxi is closing on its drop-off, so the wait they inherit
//            is the tail of a delivery rather than all of one. 45 units is a bit over two blocks.
//   RADIUS — and they appear near that drop-off, never on the far corner of the map, so the
//            hand-off between the two fares is a short hop.
//
// Those two put it back at a median of 5 against the one-fare baseline of 7 — about a third
// shorter, and still a game about how well you drive rather than which junction the spawner picked.
//
// DELAY keeps them off the kerb for the first seconds of a ride, so a pickup and a spawn are never
// the same event. MIN_CLOCK stops a rider flashing into existence a few seconds before an
// unrelated timer ends the run, which reads as the game taunting you.
const SECOND_FARE_DELAY = 5;         // seconds aboard before a second rider may appear
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
    // Active fares, newest last. At most MAX_FARES, and — because a second one only ever spawns
    // behind a rider who is already aboard — never two waiting at the same time.
    fares: [],
    elapsed: 0,
    money: 0,
    delivered: 0,
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
   * `near` biases the draw to within SECOND_FARE_RADIUS blocks of another junction, and is only
   * ever used for the staggered second rider — see the note on that constant. The unbiased path is
   * left exactly as it was, draw for draw, so a seed still produces the same one-fare run.
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
  const waiting = () => state.fares.find((f) => f.stage === 'waiting') ?? null;

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
      limit: fareSeconds,
      timeLeft: fareSeconds,
      // Arrival only resolves once the player has actually sent the taxi at this fare. Without
      // it, a taxi cruising on random turns wanders into the pin on its own — measured at 11 of
      // 40 seeds — and picks up or delivers a fare the player never directed it to.
      directed: false,
      color: null,
      ridingFor: 0,
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
   * Should a second rider appear this frame?
   *
   * Only behind a fare that is already aboard and a few seconds into its drop-off route, which is
   * what staggers the two clocks apart. Everything else — the very first fare, and the replacement
   * after a delivery clears the board — falls through the "nothing running" case above it.
   */
  function shouldStagger(taxiCar) {
    if (state.delivered < SECOND_FARE_AFTER) return false;
    if (state.fares.length !== 1) return false;
    const [only] = state.fares;
    return only.stage === 'riding'
      && only.ridingFor >= SECOND_FARE_DELAY
      && distanceToTarget(only, taxiCar) <= SECOND_FARE_RANGE
      && only.timeLeft > SECOND_FARE_MIN_CLOCK;
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
    // board refills at once — that is the ordinary one-fare loop — but the second slot only ever
    // opens mid-drop-off.
    if (state.fares.length === 0) {
      const spawned = spawnFare(taxiCar);
      if (spawned) emit('spawned', spawned);
    } else if (shouldStagger(taxiCar)) {
      // Near the drop-off the taxi is already driving at, not anywhere on the map.
      const spawned = spawnFare(taxiCar, state.fares[0].target);
      if (spawned) emit('spawned', spawned);
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
      timer.update(dt, anchor, Math.max(0, fare.timeLeft / fare.limit));

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
        // Flat fare. The clock already supplies the pressure; paying more for a fast delivery
        // would double-count it and make an unlucky long fare feel like a penalty.
        state.money += FARE_VALUE;
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
