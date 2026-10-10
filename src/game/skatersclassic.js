import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import {
  SKATE_TOP_Y, LIP_H, TRANS_RUN, TRANS_R, RAIL_H, RAIL_HALF, surfaceAt,
} from '../city/skatepark.js';

// `?skater=classic`: the first cut of the skatepark's riders, kept for comparison — the default is
// game/skaters.js. One or two people going back and forth between
// the quarter pipes, each in a lane of their own — the rail's or the funbox's.
//
// Scenery on the hoopers' terms: no collisions, nothing the fare loop knows about, and a run seed
// rather than the city's — where the park is is the map, who is riding it is the situation.
//
// **It is a pendulum, pumped.** A rider is a point on the lane's surface (`surfaceAt`) with a
// signed speed along it, and gravity does the rest: down one transition, across the flat, up the
// other, slowing as it climbs. The only energy put in is on entering the flat, where the speed is
// *set* for the trick at the far end — a kickturn below the lip, or an air above it — which is the
// pump a real rider makes at the bottom of a ramp. Solving for the peak rather than for a speed
// means a rider always tops out where the trick was meant to happen, whatever the feature in their
// lane does to them on the way.
//
// **The orientation is a frame, not three angles.** The board lies on the surface's tangent, and
// every turn a rider makes — a kickturn at the top of a transition, the 180 in an air — is a spin
// about the board's *normal*. At the lip that normal points out of a 72° wall, and spinning about
// it is exactly what brings an air back down the ramp nose-first. Written as yaw-pitch-roll it
// would be three angles fighting each other; written as a basis it is one line (`orient`).

const SECOND_RIDER = 0.75;

/** Gravity, a little under the hoopers' 16: an air should hang long enough to see the spin in. */
const G = 13;
/** How long a kickturn's 180 takes, and a turn on the deck before dropping back in. */
const KICK_TIME = 0.32;
const DECK_TURN = 0.7;
/** Above the lip on an air, and how far short of it a kickturn turns. */
const AIR_PEAK = [0.55, 1.25];
const KICK_SHORT = [0.15, 0.45];
/** The share of passes that go up for an air, and the share of rail-lane passes that grind it. */
const AIR_CHANCE = 0.4;
const GRIND_CHANCE = 0.6;
/** Passes between rests on the deck, and the rest itself. */
const PASSES = [5, 10];
const REST = [1.6, 4.0];
/** How far a rider rolls back from the lip onto the deck before stepping off. */
const DECK_IN = 0.5;
/** The hop onto and off the rail: how far out from its end it starts, and how high it peaks. */
const HOP_RUN = 0.9;
const HOP_LIFT = 0.32;
/** The trucks' axles over the board's origin — what sits on the rail in a 50-50. */
const AXLE_Y = 0.07;
/** A board is a chord on a curved transition: its ends would sink this far into the ramp. */
const SAG = 0.2;
const BOARD_LEN = 1.9;
const DECK_TOP = 0.255;

const TAU = Math.PI * 2;
const ease = (t) => t * t * (3 - 2 * t);

/**
 * @param park  the plan from city/skatepark.js, or null — a quiet no-op, as the hoopers are.
 */
export function createClassicSkaters(scene, rng, park) {
  const group = new THREE.Group();
  group.name = 'skaters';
  if (!park) return { group, riders: [], entryObjects: [], update: () => {} };
  scene.add(group);

  const looks = [
    { body: PALETTE.skaterA, legs: PALETTE.skaterPants, hair: '#2E2520' },
    { body: PALETTE.skaterB, legs: PALETTE.skaterPants, hair: '#6B4A33' },
  ];
  const boardGeometry = buildBoard();
  const boardMaterial = propMaterial();

  const count = rng.chance(SECOND_RIDER) ? 2 : 1;
  // A lone rider takes the funbox lane: on a park seen from this camera the rail is the thing that
  // reads least, and a rider is what makes a lane read at all.
  const lanes = count === 2 ? park.lanes : park.lanes.filter((l) => l.feature === 'box');

  const riders = lanes.map((lane, i) => {
    const person = createPerson({ ...looks[i], pickable: null });
    const holder = new THREE.Group();
    const board = new THREE.Mesh(boardGeometry, boardMaterial);
    board.castShadow = true;
    holder.add(board);
    const stance = new THREE.Group();
    stance.position.y = DECK_TOP;
    stance.add(person.group);
    holder.add(stance);
    group.add(holder);

    const side = i === 0 ? 1 : -1;
    const rider = {
      lane, person, holder, side,
      u: side * (park.lipU + DECK_IN), s: 0,
      // Facing inward, ready to drop in: forward along −side.
      psi: side > 0 ? Math.PI : 0,
      turnTo: null,
      mode: 'deck',
      t: 0,
      wait: rng.range(0.3, REST[1]),
      turned: true,
      air: null,
      trick: null,
      grind: false,
      passes: rng.int(PASSES[0], PASSES[1]),
      sway: rng.next() * TAU,
      y: LIP_H,
      grab: 0,
    };
    return rider;
  });

  // --- The frame ---------------------------------------------------------------

  const U = new THREE.Vector3(park.U.x, 0, park.U.z);
  const Y = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const across = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const face = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  /**
   * The holder's rotation for a board on a slope of `a` radians (rising along +u) spun `psi` about
   * its normal. The figure stands sideways, so the *board* is its X axis and it faces along
   * board × normal.
   */
  function orient(rider, a) {
    tangent.copy(U).multiplyScalar(Math.cos(a)).addScaledVector(Y, Math.sin(a));
    normal.copy(U).multiplyScalar(-Math.sin(a)).addScaledVector(Y, Math.cos(a));
    across.crossVectors(normal, tangent);
    fwd.copy(tangent).multiplyScalar(Math.cos(rider.psi)).addScaledVector(across, Math.sin(rider.psi));
    face.crossVectors(fwd, normal);
    basis.makeBasis(fwd, normal, face);
    rider.holder.quaternion.setFromRotationMatrix(basis);
  }

  // --- Choosing what happens at the far end ---------------------------------------

  /** On entering the flat: set the speed for whatever the rider is about to do at the far end. */
  function pump(rider) {
    rider.passes -= 1;
    let peak;
    if (rider.passes <= 0) {
      rider.trick = 'rest';
      peak = LIP_H + 0.12;
    } else if (rng.chance(AIR_CHANCE)) {
      rider.trick = 'air';
      peak = LIP_H + rng.range(AIR_PEAK[0], AIR_PEAK[1]);
    } else {
      rider.trick = 'kick';
      peak = LIP_H - rng.range(KICK_SHORT[0], KICK_SHORT[1]);
    }
    rider.grind = rider.lane.feature === 'rail' && rng.chance(GRIND_CHANCE);
    rider.s = Math.sign(rider.s) * Math.sqrt(2 * G * peak);
  }

  /** Keep the rider facing the way they are rolling, turning through a 180 about the normal. */
  function face180(rider, dt, time) {
    const want = rider.s >= 0 ? 0 : 1;
    const have = Math.round(rider.psi / Math.PI) & 1;
    if (rider.turnTo === null && want !== have && Math.abs(rider.s) > 1e-3) {
      rider.turnTo = (Math.round(rider.psi / Math.PI) + 1) * Math.PI;
    }
    if (rider.turnTo !== null) {
      rider.psi = Math.min(rider.turnTo, rider.psi + (Math.PI / time) * dt);
      if (rider.psi >= rider.turnTo - 1e-9) {
        rider.psi = rider.turnTo % TAU;
        rider.turnTo = null;
      }
    }
  }

  // --- Stepping ----------------------------------------------------------------

  function step(rider, dt) {
    rider.t += dt;
    rider.sway += dt * 1.7;
    const feature = rider.lane.feature;

    if (rider.mode === 'deck') {
      // Rolled back off the lip: slow to a stop, stand, turn round, drop back in.
      const out = rider.side;
      if (rider.s !== 0) {
        const slowed = Math.max(0, Math.abs(rider.s) - 5 * dt);
        rider.s = Math.sign(rider.s) * slowed;
        rider.u += rider.s * dt;
        const stop = park.lipU + DECK_IN;
        if (rider.u * out > stop) {
          rider.u = out * stop;
          rider.s = 0;
        }
        return;
      }
      if (!rider.turned) {
        // Feet back on the board facing in, a casual 180 on the spot.
        rider.turnTo ??= (Math.round(rider.psi / Math.PI) + 1) * Math.PI;
        rider.psi = Math.min(rider.turnTo, rider.psi + (Math.PI / DECK_TURN) * dt);
        if (rider.psi >= rider.turnTo - 1e-9) {
          rider.psi = rider.turnTo % TAU;
          rider.turnTo = null;
          rider.turned = true;
        }
        return;
      }
      rider.wait -= dt;
      if (rider.wait > 0) return;
      // Drop in: a nudge toward the lip, and gravity has it from there.
      rider.mode = 'ride';
      rider.s = -out * 1.2;
      rider.passes = rng.int(PASSES[0], PASSES[1]);
      rider.trick = null;
      return;
    }

    if (rider.mode === 'air') {
      const air = rider.air;
      air.t = Math.min(air.T, air.t + dt);
      const k = air.t / air.T;
      rider.y = LIP_H + air.vy * air.t - 0.5 * G * air.t * air.t;
      rider.psi = air.psi0 + Math.PI * ease(k);
      rider.grab = Math.sin(Math.PI * Math.min(1, k * 1.15));
      if (air.t >= air.T) {
        // Back in on the lip, nose first, at the speed it left with.
        rider.mode = 'ride';
        rider.psi = (air.psi0 + Math.PI) % TAU;
        rider.u = air.side * (park.lipU - 1e-3);
        rider.s = -air.side * air.vy;
        rider.y = LIP_H;
        rider.grab = 0;
        rider.trick = null;
      }
      return;
    }

    // Riding: along the surface under gravity.
    const was = Math.abs(rider.u);
    const { slope } = surfaceAt(park, feature, rider.u);
    const a = Math.atan(slope);
    rider.u += rider.s * Math.cos(a) * dt;
    rider.s -= G * Math.sin(a) * dt;
    const now = Math.abs(rider.u);

    // Into the flat, heading for the far end: the pump.
    if (now < park.transU && was >= park.transU) pump(rider);

    // At the lip, heading out.
    const end = Math.sign(rider.u) || 1;
    if (now >= park.lipU && rider.s * end > 0) {
      if (rider.trick === 'air') {
        rider.mode = 'air';
        rider.u = end * park.lipU;
        rider.air = { side: end, vy: Math.abs(rider.s), T: 2 * Math.abs(rider.s) / G, t: 0, psi0: rider.psi };
        rider.turnTo = null;
        return;
      }
      if (rider.trick === 'rest') {
        rider.mode = 'deck';
        rider.u = end * park.lipU;
        rider.side = end;
        rider.turned = false;
        rider.wait = rng.range(REST[0], REST[1]);
        rider.trick = null;
        return;
      }
      // Anything else that reaches the lip was meant to turn below it; send it back.
      rider.u = end * park.lipU;
      rider.s = -rider.s;
    }
    face180(rider, dt, KICK_TIME);
  }

  // --- Posing ----------------------------------------------------------------

  function railLift(rider) {
    if (!rider.grind) return 0;
    const x = Math.abs(rider.u) - RAIL_HALF;
    const top = RAIL_H - AXLE_Y;
    if (x <= 0) return top;
    if (x >= HOP_RUN) return 0;
    const k = x / HOP_RUN;
    return top * (1 - k) + HOP_LIFT * Math.sin(Math.PI * k);
  }

  function pose(rider) {
    const feature = rider.lane.feature;
    let h;
    let a;
    let lift = 0;
    let sag = 0;
    if (rider.mode === 'air') {
      h = rider.y;
      a = rider.air.side * TRANS_TOP_ANGLE;
      sag = SAG;
    } else {
      const surf = surfaceAt(park, feature, rider.u);
      h = surf.h;
      a = Math.atan(surf.slope);
      if (feature === 'rail') lift = railLift(rider);
      // The board's ends sink into a concave ramp unless the board is lifted off its middle by the
      // sagitta — all of it once the whole board is on the curve, none while it is on the floor.
      const into = Math.abs(rider.u) - park.transU;
      sag = SAG * Math.min(1, Math.max(0, (into + BOARD_LEN / 2) / BOARD_LEN));
      if (rider.mode === 'deck' || Math.abs(rider.u) > park.lipU + 1e-3) sag = 0;
    }
    orient(rider, a);
    const at = park.toWorld(rider.u, rider.lane.v);
    rider.holder.position.set(at.x, SKATE_TOP_Y + h + lift, at.z).addScaledVector(normal, sag);

    // Knees soft on the flat, deeper as the transition loads them, deeper still on a grind.
    const load = Math.min(1, Math.abs(Math.sin(a)) * 1.3);
    const grinding = lift > RAIL_H - AXLE_Y - 1e-6;
    const drop = 0.12 + 0.22 * load + (grinding ? 0.12 : 0);
    const sway = rider.mode === 'deck' ? 0.15 * Math.sin(rider.sway) : Math.sin(rider.sway * 2.3) * (grinding ? 0.9 : 0.35);
    rider.person.skate(rider.mode === 'deck' ? 0.04 : drop, rider.grab, sway);
  }

  function update(dt) {
    // Short steps: the transition near the lip is a 72° wall, and a long frame would step a rider
    // straight through the top of it.
    const steps = Math.min(32, Math.ceil(dt / (1 / 240)));
    const h = dt / Math.max(1, steps);
    for (let n = 0; n < steps; n++) for (const rider of riders) step(rider, h);
    for (const rider of riders) pose(rider);
  }

  // A few seconds in before anyone looks — shot mode ticks once and freezes, and a screenshot of a
  // skatepark should have someone on the ramp rather than everyone standing on the decks.
  update(0);
  for (let k = 0; k < 60 * 3; k++) update(1 / 60);

  const entryObjects = riders.map((rider) => ({
    object: rider.holder, x: park.x, z: park.z, rand: hash01(park.x, park.z),
  }));

  return { group, riders, entryObjects, park, update };
}

/** The lip's angle off the floor, as the ramp is built (TRANS_RUN over TRANS_R). */
const TRANS_TOP_ANGLE = Math.asin(TRANS_RUN / TRANS_R);

/** A skateboard along +X: deck with kicked nose and tail, two trucks, four wheels. */
function buildBoard() {
  const parts = [];
  const box = (w, h, d, x, y, z, col, roll = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (roll) geo.rotateZ(roll);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };
  const deck = PALETTE.skateDeck;
  box(1.5, 0.07, 0.52, 0, 0.22, 0, deck);
  for (const s of [-1, 1]) {
    box(0.26, 0.07, 0.5, s * 0.86, 0.255, 0, deck, s * 0.38);
    box(0.12, 0.07, 0.4, s * 0.55, 0.155, 0, PALETTE.skateTruck);
    for (const z of [-0.2, 0.2]) box(0.14, 0.14, 0.1, s * 0.55, 0.07, z, PALETTE.skateWheel);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}
