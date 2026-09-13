import * as THREE from 'three';
import { propMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { createBargeMesh, createSailboatMesh, BARGE_LEN, SAIL_LEN, BEAM } from '../geometry/boat.js';
import {
  waterEdges, waterHeightAt, bridgeSpan, drawbridgeLine, BARGE_AIR, SAIL_AIR,
} from '../city/river.js';
import { OPEN_SECONDS } from './drawbridge.js';
import { createWake } from './wake.js';
import { SLAB_X, EDGE_FADE } from '../city/ground.js';

// Traffic on the river, and the thing that asks the drawbridge to lift.
//
// **Two kinds, and the difference between them is a number rather than a decision.** A barge clears
// every span in the city and never asks for anything; a sailboat's rig does not clear the flat one,
// so it has to. That is the whole mechanism — the bridge is not on a timer with boats added for
// decoration, it opens because something that cannot fit is coming.
//
// The tall one was a tug until it was a sailboat, and the swap was about *reading* the mechanism
// rather than about the mechanism itself: the air draught is unchanged at 2.4 and cannot go up
// (see the ceiling note in geometry/boat.js), but a gaff mainsail spends it on thirty times the
// silhouette a mast did. Nothing in this file moved for it except the hull length.
//
// Run seed, not city seed, for the reason the flyover and the police runs are: which span lifts is
// a fact about the map and has to stay learnable, but *when* is the situation.

/** How far off each end of the map a boat is spawned and retired. Out past the fade skirt. */
const OFF_MAP = () => SLAB_X / 2 + 26;

// --- Coming and going -------------------------------------------------------
//
// **A boat past the coast is a boat in the sky.** The island's asphalt dissolves over `EDGE_FADE`
// and the river dissolves with it, but a hull is opaque geometry: a barge outside the coastline
// sits on nothing, in front of nothing, perfectly sharp — which reads as a model floating in space
// rather than as a boat coming in from off the map, and it is the first thing the eye goes to on a
// wide shot.
//
// So a boat fades on the same band the ground under it does: solid at the coast, gone by the time
// the asphalt is. Nothing here needs to know where the water's own alpha gets to, because the two
// are the same ramp measured from the same line.
const FADE_FROM = () => SLAB_X / 2;
const fadeAt = (x) => {
  const out = Math.abs(x) - FADE_FROM();
  if (out <= 0) return 1;
  const t = Math.min(1, out / EDGE_FADE);
  return 1 - t * t * (3 - 2 * t);      // the smoothstep `asphaltFade` and the water both use
};

// --- The wake ---------------------------------------------------------------
//
// The foam behind a hull is the only thing that says a boat is *moving* — at 2.6 units per second
// against a car's 8.5, a barge on a still river reads as scenery that happens to be in a different
// place each time you look at it.
//
// It is a particle pool now rather than a triangle welded to the stern, and the module next door
// (`game/wake.js`) carries the argument for why. The two things this file still owns are that a
// wake is spent per unit **travelled** — which is what makes a boat held at `holdOff` lay none —
// and that the foam is laid into the world rather than parented to the boat, so it stays on the
// water the hull is pulling away from.

// Speeds, in world units per second. Cars cruise at 8.5, and a boat that kept up with the traffic
// would read as a jet ski — what sells it is being the slowest thing in the frame. At 3.4 the
// sailboat takes about 45 seconds to cross the map, which is most of a fare.
const BARGE_SPEED = 2.6;
const SAIL_SPEED = 3.4;

// Seconds between sailboats.
//
// **Stretched with the lift.** The cycle went from about twelve seconds to about twenty-four, and
// left at the old spacing that put a route shut for 27% of the run — which stops being an event and
// starts being the map. At 90-150 the span is open four fifths of the time and a three-minute
// session still sees one or two lifts, which is what this is for.
const SAIL_WAIT = [90, 150];
// ...and between barges, which cost nothing and are just weather on the water.
const BARGE_WAIT = [16, 34];

// How far short of the span the sailboat asks for the lift.
//
// **Derived from the bridge's own timing rather than copied from it.** The two are one decision:
// the span needs `OPEN_SECONDS` to get its arms down and its leaf up with an empty deck, and a boat
// covering that distance in less than that arrives at something still grinding upward. Halving the
// lift speed without moving this number is precisely how that happens, which is why it is an import.
//
// The slack on top is four seconds, so the boat reaches an opening that is already open and the
// player sees the bridge react to it rather than the other way round. It is a *distance* for the
// reason the roadworks hop is paced by distance: the answer has to be the same whatever else is
// going on.
const ASK_SLACK = 4;
const ASK_AHEAD = (OPEN_SECONDS + ASK_SLACK) * SAIL_SPEED;
// ...and how far past it before the boat lets go. Its stern has to be clear of the leaf's swing.
const RELEASE_PAST = SAIL_LEN + 4;

// How far off the middle of the channel a boat runs, and how much of that is left to chance.
//
// Exported because the ceiling on them is a *clearance* and belongs in the probe: see `laneZ` in
// `createBoats` for both bounds and why the sailboat is the one that pays.
export const BOAT_LANE = BEAM / 2 + 0.3;
export const LANE_WANDER = 0.2;

// How much water the waiting boat keeps between its bow and the edge of the deck.
//
// **The boat waits, not the bridge.** `clearing` has no timeout — it holds until the deck is empty,
// taxi included — so a lift can take arbitrarily long, and a boat that sailed on regardless would
// pass through a closed span.
//
// **Measured from the bow to the deck's edge, not from the hull's middle to the bridge's.** It used
// to be a flat nine units centre-to-centre, which was a hull length of clearance for a 4.4-unit tug
// and is 1.1 for a 6.4-unit sailboat under a span on an arterial line — the leaf comes down onto the
// widest deck in the city and there are two units of variation in how wide that is. Stated as the
// gap that actually has to exist and turned into a stopping distance where the span is known
// (`holdOff` in `createBoats`), so neither a longer hull nor a wider road can quietly eat it.
const BOW_GAP = 2.2;

export function createBoats(scene, rng, drawbridge) {
  const edges = waterEdges();
  if (!edges) return null;

  const group = new THREE.Group();
  group.name = 'boats';
  scene.add(group);

  const drawLine = drawbridgeLine();
  const drawSpan = drawLine === null ? null : bridgeSpan(drawLine);

  const midZ = (edges.z0 + edges.z1) / 2;

  // Where the sailboat stops if the leaf is not up yet — `BOW_GAP` of water ahead of its bow, and
  // the bow is half a hull ahead of the position the sim actually moves. `outer` rather than `half`,
  // because what a leaf comes down onto is the deck plus its footway, and on an arterial line that
  // is 6.73 rather than 5.4.
  const holdOff = (drawSpan ? drawSpan.outer : 0) + BOW_GAP + SAIL_LEN / 2;

  // The foam, on a stream of its own.
  //
  // **One draw off the boats' rng and no more.** A wake spends a dozen randoms a second, so sharing
  // this generator would make which lane the next barge is given a function of how much foam the
  // last one happened to lay — the coupling the two-seed rule exists to prevent, in its most
  // literal form. Seeded from a single draw taken here at construction instead, so the boats' own
  // stream advances by exactly one whatever the river does afterwards.
  const wake = createWake(group, makeRng(rng.int(0, 0x7fffffff)), edges, fadeAt);

  /**
   * Which side of the channel a boat runs on, keyed to which way it is going.
   *
   * The first cut drew a direction and a lateral position as two independent randoms, which put an
   * up-river and a down-river boat in the same water about four times in five — reported, fairly,
   * as "they are about to collide".
   *
   * The offset is bounded from both ends and neither bound is a matter of taste:
   *
   * - **Floor.** Two hulls passing must not touch, so the separation `2 * BOAT_LANE` has to clear
   *   `BEAM`. At 1.4 they pass with 0.6 of water between them, and 0.2 at the worst of the wander.
   * - **Ceiling, and this is the one that is easy to get backwards.** Every bridge here carries a
   *   road running along Z across a river running along X, so the arch humps *across the channel*:
   *   `deckHeightAt` is a function of z alone and it **crests on the centreline**. Clearance is
   *   `1.65 + 1.1 * cos^2(pi * dz / span)` — best in the middle, falling off both ways — so pushing
   *   a boat outboard spends the very clearance the arch exists to provide. A design that put the
   *   **sailboat** on the outside would be exactly wrong.
   *
   * The old free-for-all was already over that ceiling: `wander` reached 2.4 where `SAIL_AIR` needs
   * `|dz| <= 2.29`, so about one tall boat in twenty drove its rig through the soffit of a fixed
   * span, silently — the clearance check in the probe compares against the crest and never looked at
   * the boat's z. At 1.4 ± 0.2 the worst case is 2.52 against a 2.4 rig on the narrow channel, which
   * is thinner than it sounds and is asserted rather than trusted. It is also why redrawing the tug
   * as a sailboat bought no height: 0.12 is the whole of the headroom, so the boat had to get more
   * *visible* rather than taller.
   *
   * Port to port, as it happens: heading +x a boat's starboard side is +z, so `dir` *is* the sign.
   */
  const laneZ = (dir) => midZ + dir * (BOAT_LANE + rng.jitter(LANE_WANDER));

  const boats = [];
  const state = {
    bargeIn: rng.range(BARGE_WAIT[0], BARGE_WAIT[1]) * 0.4,
    sailIn: rng.range(SAIL_WAIT[0], SAIL_WAIT[1]) * 0.5,
    sails: 0,
    barges: 0,
  };

  function launch(kind) {
    const geo = kind === 'sail' ? createSailboatMesh(rng) : createBargeMesh(rng);
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Per-boat material, so each can carry its own opacity as it comes in and goes out.
    mesh.material.transparent = true;
    // The hull is modelled bow-toward +Z; a boat running -X turns to face it.
    const dir = rng.chance(0.5) ? 1 : -1;
    mesh.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    const off = OFF_MAP();
    const boat = {
      kind,
      mesh,
      dir,
      x: dir > 0 ? -off : off,
      z: laneZ(dir),
      speed: kind === 'sail' ? SAIL_SPEED : BARGE_SPEED,
      asked: false,
      len: kind === 'sail' ? SAIL_LEN : BARGE_LEN,
    };
    mesh.position.set(boat.x, waterHeightAt(boat.x), boat.z);
    group.add(mesh);
    boats.push(boat);
    if (kind === 'sail') state.sails += 1; else state.barges += 1;
    return boat;
  }

  /** Where along the channel the lifting span is, or null on a city without one. */
  const spanX = () => (drawSpan ? drawSpan.cx : null);

  function update(dt) {
    state.bargeIn -= dt;
    state.sailIn -= dt;
    if (state.bargeIn <= 0) {
      launch('barge');
      state.bargeIn = rng.range(BARGE_WAIT[0], BARGE_WAIT[1]);
    }
    // One sailboat at a time. Two would queue at a bridge that only opens for the first, and a
    // boat waiting in the channel is a whole behaviour this does not have.
    if (state.sailIn <= 0 && !boats.some((b) => b.kind === 'sail')) {
      launch('sail');
      state.sailIn = rng.range(SAIL_WAIT[0], SAIL_WAIT[1]);
    }

    const gate = spanX();
    const off = OFF_MAP();

    for (let k = boats.length - 1; k >= 0; k--) {
      const boat = boats[k];
      const before = boat.x;
      boat.x += boat.dir * boat.speed * dt;
      boat.mesh.position.x = boat.x;
      // Ride the surface, which is not flat any more: the channel shoals up to meet the ground
      // through each mouth (`waterHeightAt`), and a hull pinned to `WATER_Y` would sail into the
      // shallows with the river closing over it.
      boat.mesh.position.y = waterHeightAt(boat.x);

      if (boat.kind === 'sail' && gate !== null && drawbridge) {
        // Measured along the direction of travel, so both ends of the river behave the same.
        const toGate = (gate - boat.x) * boat.dir;
        if (!boat.asked && toGate <= ASK_AHEAD && toGate > 0) {
          boat.asked = true;
          drawbridge.request();
        }
        // Hold station short of a span that is not open yet. Clamped rather than decelerated: at
        // 3.4 u/s a boat is barely moving on screen anyway, and a stopping curve would be a second
        // motion model for something the player sees twice a session.
        //
        // **`toGate > 0` is load-bearing.** Without it the clamp goes on applying after the boat
        // is through — `toGate` is negative by then, still under `holdOff` — so the moment the leaf
        // started back down it teleported the boat to the near side of the bridge and held it
        // there. One boat in 260 seconds instead of three, and the one was going round in circles.
        if (boat.asked && toGate > 0 && toGate <= holdOff && drawbridge.state.lift < 0.98) {
          boat.x = gate - boat.dir * holdOff;
          boat.mesh.position.x = boat.x;
        }
        // Through, and far enough past that the leaf can come down behind it.
        if (boat.asked && toGate < -RELEASE_PAST) drawbridge.release();
      }

      // Fade with the ground under it. The foam behind it fades on the same band, but per mote and
      // at the x it was *laid* at rather than at the boat's — it does not travel with the hull, so
      // it cannot inherit the hull's opacity either.
      boat.mesh.material.opacity = fadeAt(boat.x);

      // Foam is spent per unit of river covered, so a boat clamped at `holdOff` in front of a leaf
      // that has not come up spends nothing and lies there with the water flat behind it. That used
      // to be a `moved / would-have-moved` term multiplied into the wake's opacity; keyed to
      // distance it is not a special case any more, it is just what the emitter does.
      wake.follow(boat, Math.abs(boat.x - before));

      if (Math.abs(boat.x) > off) {
        // A sailboat retired without ever getting through — it can only happen if the bridge never
        // cleared — still has to let go, or the span stays shut for the rest of the run.
        if (boat.kind === 'sail' && boat.asked && drawbridge) drawbridge.release();
        group.remove(boat.mesh);
        boat.mesh.geometry.dispose();
        // Its foam is **not** retired with it. The motes are in the world, not on the hull, so they
        // go on lying where they were laid and dying of old age — which out here is past the coast
        // fade, where their own `dim` has already taken them to nothing.
        boats.splice(k, 1);
      }
    }

    wake.update(dt);
  }

  return {
    group,
    boats,
    state,
    wake,
    update,
    /**
     * Shot mode ticks the world once and freezes it, so anything that opens at zero is stuck on its
     * first frame. Nothing here is scaled up from nothing, but a river with no boats on it is the
     * screenshot equivalent — so a shot gets one of each, placed rather than waited for.
     *
     * The wake is the same problem one layer down and it now needs saying out loud: a pool that
     * fills over a couple of seconds of travel is empty on the frame a shot renders, so each boat
     * is handed a finished trail by `prime` rather than left to lay one. Without it every
     * screenshot of the river has boats standing on flat water — which is what the `wake` shot
     * exists to catch, and exactly how the old triangle's winding bug read.
     */
    settle() {
      if (boats.length) return;
      const gate = spanX() ?? 0;
      // Both forced up-river, so the lane has to be re-drawn to match: `launch` picked a side from
      // the direction it drew, and overriding the direction afterwards without moving the boat
      // would put a screenshot's boats on the wrong side of a river the game runs correctly.
      const barge = launch('barge');
      barge.dir = 1;
      barge.mesh.rotation.y = Math.PI / 2;
      barge.x = gate - 26;
      barge.z = laneZ(barge.dir);
      barge.mesh.position.set(barge.x, waterHeightAt(barge.x), barge.z);
      const sailboat = launch('sail');
      sailboat.dir = 1;
      sailboat.mesh.rotation.y = Math.PI / 2;
      sailboat.x = gate - 2;
      sailboat.z = laneZ(sailboat.dir);
      sailboat.mesh.position.set(sailboat.x, waterHeightAt(sailboat.x), sailboat.z);
      // After both are in their final place, not inside `launch` — a trail laid at the spawn point
      // and then teleported with the hull would be twenty-six units up-river of the boat it belongs
      // to, which is a wake in a screenshot of open water.
      for (const boat of boats) wake.prime(boat);
    },
  };
}

export { BARGE_AIR, SAIL_AIR };
