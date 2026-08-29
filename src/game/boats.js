import * as THREE from 'three';
import { propMaterial } from '../util/geo.js';
import { createBargeMesh, createTugMesh, BARGE_LEN, TUG_LEN } from '../geometry/boat.js';
import {
  waterEdges, WATER_Y, bridgeSpan, drawbridgeLine, BARGE_AIR, TUG_AIR,
} from '../city/river.js';
import { SLAB_X } from '../city/ground.js';

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

// Speeds, in world units per second. Cars cruise at 8.5, and a boat that kept up with the traffic
// would read as a jet ski — what sells it is being the slowest thing in the frame. At 3.4 a tug
// takes about 45 seconds to cross the map, which is most of a fare.
const BARGE_SPEED = 2.6;
const TUG_SPEED = 3.4;

// Seconds between tugs. A lift plus the run up to it is a ~12-second event and the whole point is
// that it is an event, so this is deliberately long: a three-minute session sees one or two.
const TUG_WAIT = [55, 95];
// ...and between barges, which cost nothing and are just weather on the water.
const BARGE_WAIT = [16, 34];

// How far short of the span a tug asks for the lift.
//
// **It is a distance, not a clock**, for the reason the roadworks hop is paced by distance: the
// answer has to be the same whatever else is happening. The bridge needs `BARRIER_SECONDS` to drop
// its arms plus however long the deck takes to clear plus `LIFT_SECONDS` to raise the leaf — call
// it five seconds with an empty deck, which at tug speed is 17 units. 30 leaves the tug most of
// four seconds of slack, so it arrives at an opening that is already open rather than at one still
// grinding upward, and the player sees the bridge react to the boat rather than the other way
// round.
const ASK_AHEAD = 30;
// ...and how far past it before the tug lets go. Its stern has to be clear of the leaf's swing.
const RELEASE_PAST = TUG_LEN + 4;

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
  // How far off the middle a boat may sit. The channel is 9-ish units wide and a hull is 2.2, so
  // there is room for a boat to be somewhere in it rather than always down the centreline — but
  // not so much that one grazes a wall.
  const wander = Math.max(0, (edges.z1 - edges.z0) / 2 - 2.2);

  const boats = [];
  const state = {
    bargeIn: rng.range(BARGE_WAIT[0], BARGE_WAIT[1]) * 0.4,
    tugIn: rng.range(TUG_WAIT[0], TUG_WAIT[1]) * 0.5,
    tugs: 0,
    barges: 0,
  };

  function launch(kind) {
    const geo = kind === 'tug' ? createTugMesh(rng) : createBargeMesh(rng);
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The hull is modelled bow-toward +Z; a boat running -X turns to face it.
    const dir = rng.chance(0.5) ? 1 : -1;
    mesh.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    const off = OFF_MAP();
    const boat = {
      kind,
      mesh,
      dir,
      x: dir > 0 ? -off : off,
      z: midZ + rng.jitter(wander),
      speed: kind === 'tug' ? TUG_SPEED : BARGE_SPEED,
      asked: false,
      len: kind === 'tug' ? TUG_LEN : BARGE_LEN,
    };
    mesh.position.set(boat.x, WATER_Y, boat.z);
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
      boat.x += boat.dir * boat.speed * dt;
      boat.mesh.position.x = boat.x;

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

      if (Math.abs(boat.x) > off) {
        // A tug retired without ever getting through — it can only happen if the bridge never
        // cleared — still has to let go, or the span stays shut for the rest of the run.
        if (boat.kind === 'tug' && boat.asked && drawbridge) drawbridge.release();
        group.remove(boat.mesh);
        boat.mesh.geometry.dispose();
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
      const barge = launch('barge');
      barge.dir = 1;
      barge.mesh.rotation.y = Math.PI / 2;
      barge.x = gate - 26;
      barge.mesh.position.x = barge.x;
      const tug = launch('tug');
      tug.dir = 1;
      tug.mesh.rotation.y = Math.PI / 2;
      tug.x = gate - 2;
      tug.mesh.position.x = tug.x;
    },
  };
}

export { BARGE_AIR, TUG_AIR };
