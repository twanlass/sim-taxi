import * as THREE from 'three';
import { propMaterial, unlitMaterial } from '../util/geo.js';
import { createBargeMesh, createTugMesh, BARGE_LEN, TUG_LEN, BEAM } from '../geometry/boat.js';
import {
  waterEdges, waterHeightAt, bridgeSpan, drawbridgeLine, BARGE_AIR, TUG_AIR,
} from '../city/river.js';
import { OPEN_SECONDS } from './drawbridge.js';
import { SLAB_X, EDGE_FADE } from '../city/ground.js';
import { PALETTE } from '../palette.js';

// Traffic on the river, and the thing that asks the drawbridge to lift.
//
// **Two kinds, and the difference between them is a number rather than a decision.** A barge clears
// every span in the city and never asks for anything; a tug's mast does not clear the flat one, so
// it has to. That is the whole mechanism — the bridge is not on a timer with boats added for
// decoration, it opens because something that cannot fit is coming.
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
// A flat triangle trailing each hull, widening astern. It is the only thing that says a boat is
// *moving* — at 2.6 units per second against a car's 8.5, a barge on a still river reads as
// scenery that happens to be in a different place each time you look at it.
//
// Drawn as one triangle rather than a strip of quads, and lying on the water rather than standing
// in it: at play zoom a wake is four pixels across at the stern and the shape is the whole of the
// information. It sits `WAKE_LIFT` above the surface for the reason every painted mark in this city
// sits above the road it is on — two coplanar surfaces is a shimmer, not a touch.
const WAKE_LIFT = 0.012;
const WAKE_LEN = 5.2;
const WAKE_SPREAD = 1.45;

// Speeds, in world units per second. Cars cruise at 8.5, and a boat that kept up with the traffic
// would read as a jet ski — what sells it is being the slowest thing in the frame. At 3.4 a tug
// takes about 45 seconds to cross the map, which is most of a fare.
const BARGE_SPEED = 2.6;
const TUG_SPEED = 3.4;

// Seconds between tugs.
//
// **Stretched with the lift.** The cycle went from about twelve seconds to about twenty-four, and
// left at the old spacing that put a route shut for 27% of the run — which stops being an event and
// starts being the map. At 90-150 the span is open four fifths of the time and a three-minute
// session still sees one or two lifts, which is what this is for.
const TUG_WAIT = [90, 150];
// ...and between barges, which cost nothing and are just weather on the water.
const BARGE_WAIT = [16, 34];

// How far short of the span a tug asks for the lift.
//
// **Derived from the bridge's own timing rather than copied from it.** The two are one decision:
// the span needs `OPEN_SECONDS` to get its arms down and its leaf up with an empty deck, and a tug
// covering that distance in less than that arrives at something still grinding upward. Halving the
// lift speed without moving this number is precisely how that happens, which is why it is an import.
//
// The slack on top is four seconds, so the tug reaches an opening that is already open and the
// player sees the bridge react to the boat rather than the other way round. It is a *distance* for
// the reason the roadworks hop is paced by distance: the answer has to be the same whatever else is
// going on.
const ASK_SLACK = 4;
const ASK_AHEAD = (OPEN_SECONDS + ASK_SLACK) * TUG_SPEED;
// ...and how far past it before the tug lets go. Its stern has to be clear of the leaf's swing.
const RELEASE_PAST = TUG_LEN + 4;

// How far off the middle of the channel a boat runs, and how much of that is left to chance.
//
// Exported because the ceiling on them is a *clearance* and belongs in the probe: see `laneZ` in
// `createBoats` for both bounds and why the tug is the one that pays.
export const BOAT_LANE = BEAM / 2 + 0.3;
export const LANE_WANDER = 0.2;

// Where a tug stops if the leaf is not up yet.
//
// **The boat waits, not the bridge.** `clearing` has no timeout — it holds until the deck is empty,
// taxi included — so a lift can take arbitrarily long, and a tug that sailed on regardless would
// pass through a closed span. Nine units is a hull length clear of the abutment: near enough that
// it reads as a boat nosing up to a bridge and waiting, far enough that the leaf coming down would
// not land on it.
const HOLD_OFF = 9;

export function createBoats(scene, rng, drawbridge) {
  const edges = waterEdges();
  if (!edges) return null;

  const group = new THREE.Group();
  group.name = 'boats';
  scene.add(group);

  const drawLine = drawbridgeLine();
  const drawSpan = drawLine === null ? null : bridgeSpan(drawLine);

  const midZ = (edges.z0 + edges.z1) / 2;

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
   *   *tug* on the outside would be exactly wrong.
   *
   * The old free-for-all was already over that ceiling: `wander` reached 2.4 where `TUG_AIR` needs
   * `|dz| <= 2.29`, so about one tug in twenty drove its mast through the soffit of a fixed span,
   * silently — the clearance check in the probe compares against the crest and never looked at the
   * boat's z. At 1.4 ± 0.2 the worst case is 2.52 against a 2.4 mast on the narrow channel, which
   * is thinner than it sounds and is asserted rather than trusted.
   *
   * Port to port, as it happens: heading +x a boat's starboard side is +z, so `dir` *is* the sign.
   */
  const laneZ = (dir) => midZ + dir * (BOAT_LANE + rng.jitter(LANE_WANDER));

  const boats = [];
  const state = {
    bargeIn: rng.range(BARGE_WAIT[0], BARGE_WAIT[1]) * 0.4,
    tugIn: rng.range(TUG_WAIT[0], TUG_WAIT[1]) * 0.5,
    tugs: 0,
    barges: 0,
  };

  /**
   * The wake, in the boat's own local frame: a triangle from the stern, widening astern.
   *
   * Its own mesh rather than part of the hull, because the two want opposite materials — the hull
   * is lit and the wake is foam, which is bright at every hour and takes no shadow. Unlit is also
   * what lets it fade with the hull without the fade reading as the water changing colour.
   */
  function wakeMesh(len) {
    const stern = -len / 2;
    const geo = new THREE.BufferGeometry();
    // Wound to face up. Taken the other way round it lies under the water it is drawn on.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, WAKE_LIFT, stern,
      -WAKE_SPREAD, WAKE_LIFT, stern - WAKE_LEN,
      WAKE_SPREAD, WAKE_LIFT, stern - WAKE_LEN,
      -0.5, WAKE_LIFT, stern,
      WAKE_SPREAD, WAKE_LIFT, stern - WAKE_LEN,
      0.5, WAKE_LIFT, stern,
    ]), 3));
    geo.computeVertexNormals();
    // Through `unlitMaterial`, which is the house rule for anything `MeshBasicMaterial` and turns
    // the haze off with it — a wake is foam, and foam has no business reporting a colour between
    // its own and the sky's just because it is at the far end of the map.
    const mat = unlitMaterial({
      color: new THREE.Color(PALETTE.wake),
      transparent: true,
      opacity: 0.5,
      // Foam on water has no business hiding what is drawn behind it, and the water it lies on is
      // itself a transparent surface at `renderOrder` -2 — so this has to sort after it and write
      // nothing, or the two fight over a millimetre.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    return mesh;
  }

  function launch(kind) {
    const geo = kind === 'tug' ? createTugMesh(rng) : createBargeMesh(rng);
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
      speed: kind === 'tug' ? TUG_SPEED : BARGE_SPEED,
      asked: false,
      len: kind === 'tug' ? TUG_LEN : BARGE_LEN,
    };
    mesh.position.set(boat.x, waterHeightAt(boat.x), boat.z);
    const wake = wakeMesh(boat.len);
    mesh.add(wake);
    boat.wake = wake;
    group.add(mesh);
    boats.push(boat);
    if (kind === 'tug') state.tugs += 1; else state.barges += 1;
    return boat;
  }

  /** Where along the channel the lifting span is, or null on a city without one. */
  const spanX = () => (drawSpan ? drawSpan.cx : null);

  function update(dt) {
    state.bargeIn -= dt;
    state.tugIn -= dt;
    if (state.bargeIn <= 0) {
      launch('barge');
      state.bargeIn = rng.range(BARGE_WAIT[0], BARGE_WAIT[1]);
    }
    // One tug at a time. Two would queue at a bridge that only opens for the first, and a boat
    // waiting in the channel is a whole behaviour this does not have.
    if (state.tugIn <= 0 && !boats.some((b) => b.kind === 'tug')) {
      launch('tug');
      state.tugIn = rng.range(TUG_WAIT[0], TUG_WAIT[1]);
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

      if (boat.kind === 'tug' && gate !== null && drawbridge) {
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
        // **`toGate > 0` is load-bearing.** Without it the clamp goes on applying after the tug is
        // through — `toGate` is negative by then, still under `HOLD_OFF` — so the moment the leaf
        // started back down it teleported the boat to the near side of the bridge and held it
        // there. One tug in 260 seconds instead of three, and the one was going round in circles.
        if (boat.asked && toGate > 0 && toGate <= HOLD_OFF && drawbridge.state.lift < 0.98) {
          boat.x = gate - boat.dir * HOLD_OFF;
          boat.mesh.position.x = boat.x;
        }
        // Through, and far enough past that the leaf can come down behind it.
        if (boat.asked && toGate < -RELEASE_PAST) drawbridge.release();
      }

      // Fade with the ground under it, and take the wake down with it. The wake also thins out
      // when the boat is not actually moving — a tug holding station short of a raised leaf with a
      // full wake behind it is a boat doing a wheelspin.
      const alpha = fadeAt(boat.x);
      boat.mesh.material.opacity = alpha;
      const moved = Math.abs(boat.x - before) / Math.max(1e-6, boat.speed * dt);
      boat.wake.material.opacity = 0.5 * alpha * Math.min(1, moved);

      if (Math.abs(boat.x) > off) {
        // A tug retired without ever getting through — it can only happen if the bridge never
        // cleared — still has to let go, or the span stays shut for the rest of the run.
        if (boat.kind === 'tug' && boat.asked && drawbridge) drawbridge.release();
        group.remove(boat.mesh);
        boat.mesh.geometry.dispose();
        boat.wake.geometry.dispose();
        boat.wake.material.dispose();
        boats.splice(k, 1);
      }
    }
  }

  return {
    group,
    boats,
    state,
    update,
    /**
     * Shot mode ticks the world once and freezes it, so anything that opens at zero is stuck on its
     * first frame. Nothing here is scaled up from nothing, but a river with no boats on it is the
     * screenshot equivalent — so a shot gets one of each, placed rather than waited for.
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
      const tug = launch('tug');
      tug.dir = 1;
      tug.mesh.rotation.y = Math.PI / 2;
      tug.x = gate - 2;
      tug.z = laneZ(tug.dir);
      tug.mesh.position.set(tug.x, waterHeightAt(tug.x), tug.z);
    },
  };
}

export { BARGE_AIR, TUG_AIR };
