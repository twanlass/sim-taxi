import * as THREE from 'three';
import { GRID, HALF_ROAD, lineCoord } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createPassengerPin, createDestinationPin } from '../geometry/marker.js';
import { createPerson } from '../geometry/person.js';
import { createTimerRing, fareStageColour } from './timerring.js';
import { createLightShaft } from '../geometry/lightshaft.js';
import { findRoute, planOrigin } from './route.js';
import { PALETTE } from '../palette.js';

// The fare loop: a passenger waits at an intersection, the taxi collects them, a destination
// appears, the taxi delivers. Either timer running out ends the run.

// One flat deadline for the entire fare — spawned to delivered — and it does NOT restart when
// the rider gets in. Collecting them quickly is what buys the time to deliver them, which is the
// whole tension of the game. Trips average ~17s one-way, so 24s for both legs is deliberately
// punishing: this is a score-attack clock, not a comfortable one.
export const FARE_SECONDS = 60;

/** Flat rate per delivered fare. */
export const FARE_VALUE = 20;

// Live-tweakable from the debug panel. FARE_SECONDS stays the documented default so the headless
// tools keep a fixed baseline.
let fareSeconds = FARE_SECONDS;
export const setFareSeconds = (s) => { fareSeconds = s; };
export const getFareSeconds = () => fareSeconds;

const ARRIVE_RADIUS = 7;       // how close the taxi must get to count as arrived

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

export function createFareSystem(rng, scene) {
  const state = {
    stage: 'idle',        // idle | waiting | riding
    target: null,         // {i, j} the taxi currently needs to reach
    timeLeft: 0,
    limit: 0,
    // Arrival only resolves once the player has actually sent the taxi at the target. Without
    // this, a taxi cruising on random turns wanders into the pin on its own — measured at 11 of
    // 40 seeds — and picks up or delivers a fare the player never directed it to.
    directed: false,
    elapsed: 0,
    fareColor: null,      // assigned at pickup; shared by the taxi and the destination pin
    money: 0,
    delivered: 0,
    gameOver: false,
    failReason: null,
  };

  const passenger = createPassengerPin(createPerson);
  const destination = createDestinationPin();
  // One clock for the whole fare. It waits with the rider, then rides with the taxi.
  const timer = createTimerRing(scene);

  // Stands over the waiting rider. Lives on the marker's standing group, so it follows the same
  // kerb placement and hides with the rider automatically.
  const shaft = createLightShaft();
  passenger.postGroup.add(shaft.mesh);
  passenger.group.visible = false;
  destination.group.visible = false;
  scene.add(passenger.group);
  scene.add(destination.group);

  // The marker group sits on the junction (its ring is the "drive here" cue); only the standing
  // pin is pushed out to the pavement corner so it doesn't hover over the carriageway.
  const place = (pin, i, j) => {
    const centre = intersectionCentre(i, j);
    const corner = cornerFor(i, j);
    pin.group.position.set(centre.x, 0.12, centre.z);
    pin.postGroup.position.set(corner.x - centre.x, KERB_H, corner.z - centre.z);
    pin.group.visible = true;
  };

  /** Pick an intersection that isn't the one the taxi is already about to reach. */
  function pickIntersection(avoid = []) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const i = rng.int(0, GRID);
      const j = rng.int(0, GRID);
      if (avoid.some((a) => a.i === i && a.j === j)) continue;
      return { i, j };
    }
    return { i: 0, j: 0 };
  }

  function spawnPassenger(taxiCar) {
    const spot = pickIntersection([{ i: taxiCar.i, j: taxiCar.j }]);
    state.stage = 'waiting';
    state.target = spot;
    state.directed = false;
    state.limit = fareSeconds;
    state.timeLeft = fareSeconds;
    place(passenger, spot.i, spot.j);
    destination.group.visible = false;
    // Under the rider, not at the junction centre — the clock belongs to the person.
    const kerb = cornerFor(spot.i, spot.j);
    timer.placeAt(kerb.x, kerb.z);
    return spot;
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

  function beginRide(taxiCar) {
    const spot = pickIntersection([{ i: taxiCar.i, j: taxiCar.j }, state.target]);
    state.fareColor = nextFareColor();
    destination.setColor(state.fareColor);
    state.stage = 'riding';
    state.target = spot;
    state.directed = false;
    // Deliberately does not touch limit or timeLeft: the clock started when the rider appeared
    // and keeps running straight through the pickup.
    passenger.group.visible = false;
    place(destination, spot.i, spot.j);
    // The rider is aboard, so the deadline is the car's problem now — send the clock after it,
    // and let it draw over the city so the taxi never loses its timer behind a building.
    timer.beginTransfer();
    return spot;
  }

  const distanceToTarget = (taxiCar) => {
    if (!state.target) return Infinity;
    const c = intersectionCentre(state.target.i, state.target.j);
    return Math.hypot(taxiCar.x - c.x, taxiCar.z - c.z);
  };

  /**
   * Advances timers and resolves arrivals. Returns an event name when something happened, which
   * the caller uses to drive HUD feedback.
   */
  function update(dt, taxiCar) {
    if (state.gameOver) return null;

    if (state.stage === 'idle') {
      spawnPassenger(taxiCar);
      return 'spawned';
    }

    // Wave the waiting rider. Driven off sim time so it stays deterministic for screenshots.
    if (state.stage === 'waiting' && passenger.standing) passenger.standing.wave(state.elapsed);
    state.elapsed += dt;

    state.timeLeft -= dt;
    const fraction = Math.max(0, state.timeLeft / state.limit);

    // Waiting: the clock sits on the rider's junction. Riding: it follows the taxi.
    // Beacon tracks the same stage colour as the ring, so urgency reads from across the map.

    const anchor = state.stage === 'waiting'
      ? { ...cornerFor(state.target.i, state.target.j), y: KERB_H + 0.05 }
      : { x: taxiCar.x, z: taxiCar.z, y: 0.09 };   // the taxi rides on the road, not the kerb
    timer.update(dt, anchor, fraction);

    if (state.timeLeft <= 0) {
      state.gameOver = true;
      state.failReason = state.stage === 'waiting'
        ? 'A passenger gave up waiting.'
        : 'A fare was not delivered in time.';
      passenger.group.visible = false;
      destination.group.visible = false;
      timer.hide();
      return 'failed';
    }

    // Proximity resolves the arrival, but only for a taxi the player actually sent here. No
    // extra confirmation tap is needed on arrival — the tap that set the route is the intent.
    if (state.directed && distanceToTarget(taxiCar) < ARRIVE_RADIUS) {
      if (state.stage === 'waiting') {
        beginRide(taxiCar);
        return 'pickup';
      }
      // Flat fare. The clock already supplies the pressure; paying more for a fast delivery
      // would double-count it and make an unlucky long fare feel like a penalty.
      state.money += FARE_VALUE;
      state.delivered += 1;
      destination.group.visible = false;
      timer.hide();
      state.stage = 'idle';
      state.target = null;
      state.fareColor = null;
      return 'delivered';
    }

    return null;
  }

  /** Called when the player has routed the taxi at the current target. */
  function markDirected() {
    state.directed = true;
  }

  /** Objects the picker may hit for the current stage. */
  function pickables() {
    if (state.stage === 'waiting') return [passenger.group];
    if (state.stage === 'riding') return [destination.group];
    return [];
  }

  return { state, update, pickables, markDirected, passenger, destination, timer, intersectionCentre };
}
