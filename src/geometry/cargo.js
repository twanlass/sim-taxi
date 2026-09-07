import * as THREE from 'three';
import { createParcel, PARCEL_CENTRE_Y, PARCEL_DECK_SCALE } from './parcel.js';
import { createFoodOrder, FOOD_CENTRE_Y } from './food.js';

// What a courier job is carrying: a taped cardboard box (geometry/parcel.js) or a food order
// (geometry/food.js). One rig that can be either, because one *slot* has to be either — the kerb
// marker, the flying copy and the HUD chip are each built once and reused for the whole run
// (game/parcels.js), and a load that changes kind every twenty seconds cannot be a mesh built at
// construction.
//
// **Both are built and one is shown.** The alternative — dispose the geometry and build the other
// kind on each spawn — is a merge and a few dozen primitives every time the board turns over, to
// save two small meshes sitting invisible in a group, and it puts a `dispose` on a path where
// forgetting one leaks silently. Three skips an invisible mesh before it reaches a draw call, and
// the shadow and AO passes skip it too.
//
// **The two kinds share an envelope, and that is what makes this a switch rather than a fork.**
// Three separate things measure a load without asking which kind it is — the HUD chip's frustum, the
// point a pickup hands the chip, and the size the outbound flight opens at — and all three read the
// numbers below. geometry/food.js is built to the box's height and half-diagonal for exactly this
// reason, and `tools/probe.mjs` asserts the two meshes against each other rather than trusting it.

/** The kinds a courier job can be carrying, in the order nothing depends on. */
export const CARGO_KINDS = ['parcel', 'food'];

/**
 * Half a load's standing height — the point a picture of one is centred on, whichever kind it is.
 *
 * The box's own, because the box defined the envelope and the order was built into it. Named for the
 * *cargo* rather than for the parcel at the three call sites that use it: what they are asking is
 * "where is the middle of the thing the taxi is carrying", and answering that with a constant whose
 * name says `PARCEL` is what would make a second kind look like it needed a second number.
 */
export const CARGO_CENTRE_Y = PARCEL_CENTRE_Y;

/** What a load is drawn at when it is scaled down to the size the car handles one at. */
export const CARGO_DECK_SCALE = PARCEL_DECK_SCALE;

/** Sanity, at import time: the two kinds have to agree about where their middle is. */
if (Math.abs(FOOD_CENTRE_Y - PARCEL_CENTRE_Y) > 1e-6) {
  throw new Error('cargo: the food order and the parcel disagree about the envelope');
}

/**
 * One load, either kind. `group` carries the pose; the two meshes hang inside it.
 *
 * The idle **lives here rather than in either geometry module**, and that is not tidiness: a box and
 * a bag turning at two rates would be two answers to "this is a thing to pick up", and the rate is
 * the whole of what that motion says. See `idle` below.
 *
 * @param pickable  the `userData.pickable` kind for both meshes, or null for a load that is scenery.
 *                  Every load in the game passes null — a package is reached through its marker's own
 *                  hit box — but the option is kept for the reason the two geometry modules keep it.
 */
export function createCargo({ pickable = null } = {}) {
  const group = new THREE.Group();
  group.name = 'cargo';

  const rigs = {
    parcel: createParcel({ pickable }),
    food: createFoodOrder({ pickable }),
  };
  for (const rig of Object.values(rigs)) group.add(rig.group);

  let kind = CARGO_KINDS[0];

  /**
   * Show one kind and hide the other. Silent on an unknown kind rather than throwing: the only thing
   * upstream of this is a random draw and a `?cargo=` pin, and a still frame that photographed the
   * wrong box is a better failure than a run that ends on a typo in a query string.
   */
  function setKind(next) {
    if (!(next in rigs)) return;
    kind = next;
    for (const [name, rig] of Object.entries(rigs)) rig.group.visible = name === kind;
  }

  /**
   * Waiting on the corner: a slow spin and a gentle bob.
   *
   * The rider's answer to "come and get me" is a raised, waving arm. A load has no arm, so the motion
   * carries the whole of it — a slow turn is the universal "this is a thing to pick up", and it is
   * deliberately slower than the rider's wave: a courier job is not impatient, it has no clock. The
   * turn also brings each kind's own signature past the camera in turn: the box's tape strip and
   * label, the order's straw.
   *
   * On the **outer** group rather than on the mesh that happens to be showing, so that the yaw a
   * pickup hands to the HUD (game/parcels.js reads `group.rotation.y`) is one number wherever the
   * load is in its life, and a kind switched mid-spin does not land the new mesh square.
   *
   * `t` is sim time, never an accumulated dt — a frozen shot has to render the same frame every time.
   */
  function idle(t) {
    group.rotation.y = t * 0.55;
    group.position.y = Math.sin(t * 1.6) * 0.07;
  }

  /** Both kinds, not just the one showing: an opacity left on a hidden mesh is a fade that arrives late. */
  function setOpacity(a) {
    for (const rig of Object.values(rigs)) rig.setOpacity(a);
  }

  /** Back to an untouched load, of whatever kind is up. Slot reuse: the last one left a pose behind. */
  function rest() {
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    group.visible = true;
    for (const rig of Object.values(rigs)) rig.rest();
    setKind(kind);
  }

  rest();
  return {
    group,
    idle,
    setOpacity,
    rest,
    setKind,
    get kind() { return kind; },
    /** The mesh that is actually showing — what a check reads a material or a bounding box off. */
    get mesh() { return rigs[kind].mesh; },
    /** Both of them, for a check that wants to compare the two kinds against each other. */
    rigs,
  };
}
