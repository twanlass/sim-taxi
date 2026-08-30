import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { cityNetwork } from '../city/roadnet.js';
import { bridgeSpan, drawbridgeLine, WATER_Y, RAIL_W } from '../city/river.js';
import { DIR } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createBridge, abutmentParts } from '../geometry/bridge.js';
import { setClosedLanes, policeRoad } from '../sim/traffic.js';
import { setBlockedLanes } from './route.js';
import { sinkShadowCaster } from './scene.js';

// The one span that lifts.
//
// **It is the only thing in this game that changes the road network while the player is driving
// it.** A park district closes a road before the run starts and a roadworks zone only ever makes
// one cheaper; this takes a route that was valid ten seconds ago and stops it existing, with a
// clock running in the back seat. That is the whole point of it, and it is also why every part of
// this module is more careful than a piece of scenery would need to be.
//
// Which span lifts is `planRiver`'s draw, and it is always an interior one — the ring road is what
// everything else in this game escapes onto, and a lift that closed it would take the way round
// away at the same moment it takes the way through.
//
// **The leaf is deliberately not in the city's entrance wave**, and it is worth saying why rather
// than leaving it to look like an oversight. `createCityEntry` grows its meshes in a vertex shader
// that scales every vertex about an anchor stamped into the geometry in *world* coordinates, and a
// world coordinate in a rotating object's local space is not a coordinate — the same reason the
// burger on its pole had to become an `objects` entry. This span is road rather than building, so
// it belongs with the ground either way: the city rises out of a river that is already there,
// bridges and all.

// --- The lift ---------------------------------------------------------------
//
// **70 degrees, and the ceiling is what the leaf hides rather than what a bascule does.** A real one
// opens to about 80; at this camera anything of height `h` hides `1.54h` of ground behind it, and a
// leaf spanning the channel is ~10.7 units long, so its raised tip stands 10.0 units up at 70
// degrees and casts a 15-unit blind spot over the far bank. Past that it starts hiding the road
// beyond, and a marker the player cannot find is exactly what `cornerSeen` exists to prevent —
// except that this one comes and goes, so no static filter can catch it. It is a landmark event
// lasting a dozen seconds, and this is as tall as it gets to stay one.
const LIFT_ANGLE = THREE.MathUtils.degToRad(70);

// **Twice as slow as this shipped at, and the first numbers were the mistake.** 3.4s to raise a
// hundred-odd tonnes of deck is not a bascule, it is a boom gate: the leaf snapped up faster than
// the eye tracks it, which made the one genuinely mechanical thing in the city read as a UI state
// change. Machinery is heavy and the whole point of this is that the player watches it.
//
// The cycle is now ~24 seconds end to end against ~12. That is deliberately a long time to close a
// route for — it is the event, and a route that reopens before you have finished going round is not
// one you had to plan against.
const LIFT_SECONDS = 6.8;
const LOWER_SECONDS = 6.0;    // gravity is on its side going down, and the beat wants to end sooner

// The barriers across each approach, and the beat they take. Down before anything moves, up only
// once the leaf is home — and back up on the same curve, which is the half this originally missed.
const BARRIER_SECONDS = 2.2;
const BARRIER_DROP = THREE.MathUtils.degToRad(88);
const BARRIER_R = 0.16;
const BARRIER_POST_H = 1.5;
// How far back from the abutment the barrier stands. Clear of the deck itself, so a car stopped at
// it is on the road rather than on the bridge, and clear of the footway so it does not fence the
// pavement off with the carriageway.
const BARRIER_SETBACK = 1.6;

/**
 * A backstop, not a hold. Whatever asked for the lift is what puts it down again — `release()` —
 * and this only exists so that a caller which forgets can never shut a route for the rest of the
 * run.
 *
 * **It has to be longer than the thing it is backing up, or it becomes the thing.** A tug asks 30
 * units out and lets go `TUG_LEN + 4` past the span, which at 3.4 u/s is 11.3 seconds of request —
 * about 6.8 of it after the leaf is fully up, and more when the deck took a while to clear. At 4.5
 * this fired first and started lowering the leaf onto a boat that was still four seconds short of
 * it, which looked exactly like the bridge closing early because that is what it was.
 */
const HOLD_SECONDS = 20;

/**
 * The cycle.
 *
 *   open -> closing -> clearing -> lifting -> up -> lowering -> open
 *
 * `clearing` is what makes this safe, and it has **no timeout**. The barriers are already down and
 * the lanes already shut, so nothing new can get onto the deck; what is on it drives off, and only
 * then does the leaf move. If the deck will not clear — a car queued behind a red at the far
 * junction, or a player sitting on the crest with the brake held — the boat waits. A lift that
 * fired anyway would be the one event in this game that can throw a car into the river, and "it
 * hardly ever happens" is not a property worth having.
 */
const PHASES = ['open', 'closing', 'clearing', 'lifting', 'up', 'lowering', 'raising'];

/**
 * The phases in which nothing may cross.
 *
 * `raising` is not one of them, and that is the point of it existing. The deck is down and the road
 * is a road again; the gates are still on their way up, and traffic starts moving under them
 * exactly as it does at a level crossing. Reopening only once the arms were vertical would hold the
 * span shut for two seconds after there was anything to hold it shut for.
 */
const SHUT = new Set(['closing', 'clearing', 'lifting', 'up', 'lowering']);

export function createDrawbridge(scene, rng, { replan = null, onLand = null } = {}) {
  const line = drawbridgeLine();
  if (line === null) return null;
  const span = bridgeSpan(line);
  if (!span) return null;

  const net = cityNetwork();
  // Both directions of the crossing. `laneByGrid` names a lane by the junction it runs *to*, so the
  // northbound one arrives at the far side of the row and the southbound one at the near side.
  const laneIds = [
    net.laneByGrid(DIR.PZ, line, span.row + 1)?.id,
    net.laneByGrid(DIR.NZ, line, span.row)?.id,
  ].filter(Boolean);
  if (laneIds.length !== 2) return null;

  const group = new THREE.Group();
  group.name = 'drawbridge';

  // --- The deck, in two pieces of one profile.
  //
  // The hinge sits on the near bank, so the leaf covers the whole channel and rises away from the
  // camera: this view looks down the -x-z diagonal, so a leaf hinged at the *far* bank would come
  // up between the player and the water it is opening, and hide the boat it opened for.
  const hingeU = 0;
  const length = span.z1 - span.z0;

  const leafGeo = createBridge(span, rng, { range: [hingeU, 1], abutments: false, pivotZ: 0 });
  const leaf = new THREE.Mesh(leafGeo, propMaterial());
  leaf.castShadow = true;
  leaf.receiveShadow = true;
  // Same shell as a fixed span — flat rather than arched, and it self-shadowed just the same, in a
  // band down the carriageway. See `sinkShadowCaster` (game/scene.js).
  sinkShadowCaster(leaf);
  leaf.name = 'drawbridge-leaf';

  // The pivot carries the leaf; the leaf's own geometry is built with its hinge on the origin.
  const pivot = new THREE.Group();
  pivot.position.set(span.cx, 0, span.z0);
  pivot.add(leaf);
  group.add(pivot);

  // The abutments and the machinery house stay where they are, whatever the leaf is doing.
  const staticParts = [];
  const trimCol = jitterColor(PALETTE.bridgeTrim, rng, { l: 0.02 });
  const houseCol = jitterColor(PALETTE.riverWall, rng, { l: 0.02 });
  // The abutments straight from the bridge kit rather than through a hair-thin `range`, which would
  // hand back a fan of degenerate triangles rather than the two blocks that were wanted.
  for (const end of [0, 1]) {
    for (const part of abutmentParts(span, rng, end)) {
      part.translate(span.cx, 0, span.z0);
      staticParts.push(part);
    }
  }

  // The counterweight house on the hinge bank: the thing a bascule needs, and the thing that says
  // *this* span is the one that moves before it has ever moved. One either side of the deck, clear
  // of the leaf's swing.
  for (const sign of [-1, 1]) {
    const house = new THREE.BoxGeometry(1.6, 2.6, 2.2);
    house.translate(span.cx + sign * (span.outer + 0.8), 1.3, span.z0 - 0.4);
    staticParts.push(bakeColor(house, houseCol));
    const cap = new THREE.BoxGeometry(1.9, 0.24, 2.5);
    cap.translate(span.cx + sign * (span.outer + 0.8), 2.6 + 0.12, span.z0 - 0.4);
    staticParts.push(bakeColor(cap, trimCol));
  }

  const shell = new THREE.Mesh(mergeGeometries(staticParts, false), propMaterial());
  staticParts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'drawbridge-shell';
  group.add(shell);

  // --- The barriers, one across each approach.
  const barriers = [];
  for (const end of [0, 1]) {
    const z = end === 0 ? span.z0 - BARRIER_SETBACK : span.z1 + BARRIER_SETBACK;
    const arm = new THREE.Group();
    arm.position.set(span.cx - span.half, BARRIER_POST_H * 0.72, z);
    // Across the whole carriageway rather than one lane of it. A barrier that covered only the
    // approach would be the truthful thing and the unreadable one: at play zoom the road is 62px
    // and half of it is a dash.
    const len = span.half * 2 * 0.92;
    const bar = new THREE.BoxGeometry(len, BARRIER_R * 2, BARRIER_R * 2);
    bar.translate(len / 2, 0, 0);
    const barMesh = new THREE.Mesh(
      bakeColor(bar, jitterColor(PALETTE.barrier, rng, { l: 0.02 })), propMaterial(),
    );
    barMesh.castShadow = true;
    arm.add(barMesh);
    // Raised is out of the way: the arm stands vertical and drops to horizontal across the road.
    arm.rotation.z = BARRIER_DROP;
    group.add(arm);

    const post = new THREE.BoxGeometry(0.28, BARRIER_POST_H, 0.28);
    post.translate(span.cx - span.half, BARRIER_POST_H / 2, z);
    const postMesh = new THREE.Mesh(bakeColor(post, trimCol), propMaterial());
    postMesh.castShadow = true;
    group.add(postMesh);

    barriers.push(arm);
  }

  scene.add(group);

  const state = {
    phase: 'open',
    t: 0,
    lift: 0,        // 0 down, 1 fully raised
    barrier: 0,     // 0 up (out of the way), 1 down across the road
    requested: false,
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  /** Is the police corridor currently running down the road this span carries? */
  function sirenOnLine() {
    const siren = policeRoad();
    return Boolean(siren) && siren.axis === 'z' && siren.line === line;
  }

  /** Is anything at all standing on either lane of the span? The taxi counts. */
  function deckClear(cars) {
    const ids = new Set(laneIds);
    return !cars.some((car) => ids.has(car.lane?.id) || ids.has(car.turn?.outLane));
  }

  function publish() {
    // Shut to ambient traffic and impassable to the router the moment the barriers start down —
    // not when the leaf starts to move. The gap between the two is `clearing`, and its whole job is
    // to empty a deck that nothing new can enter.
    const shut = SHUT.has(state.phase);
    setClosedLanes(shut ? laneIds : [], 'drawbridge');
    setBlockedLanes(shut ? laneIds : []);
  }

  function enter(phase) {
    state.phase = phase;
    state.t = 0;
    publish();
    // Re-plan on the way in, not on the way out. A taxi whose route crosses this span has to be
    // given a new one while it still has road to turn off on.
    if (phase === 'closing') replan?.();
  }

  function pose() {
    leaf.rotation.x = -state.lift * LIFT_ANGLE;
    for (const arm of barriers) arm.rotation.z = BARRIER_DROP * (1 - state.barrier);
  }

  function update(dt, cars = []) {
    state.t += dt;
    switch (state.phase) {
      case 'open':
        state.barrier = 0;
        // Not while a siren is running down this line. The corridor holds every light on its road
        // green and the cruiser neither queues nor brakes, so dropping a barrier in front of one is
        // the one closure it cannot answer — the same courtesy `roadwork.js` extends when it
        // declines to dig up a road a run is already on. A corridor crosses the map in about eight
        // seconds, so this costs the boat a beat at most.
        if (state.requested && !sirenOnLine()) enter('closing');
        break;
      case 'closing':
        state.barrier = Math.min(1, state.t / BARRIER_SECONDS);
        if (state.t >= BARRIER_SECONDS) enter('clearing');
        break;
      case 'clearing':
        state.barrier = 1;
        if (deckClear(cars)) enter('lifting');
        break;
      case 'lifting':
        state.lift = smooth(Math.min(1, state.t / LIFT_SECONDS));
        if (state.t >= LIFT_SECONDS) enter('up');
        break;
      case 'up':
        state.lift = 1;
        // Down as soon as whatever asked for the lift says it is through, and after `HOLD_SECONDS`
        // regardless — nothing may leave a route shut indefinitely because it forgot to `release`.
        if (!state.requested || state.t >= HOLD_SECONDS) {
          state.requested = false;
          enter('lowering');
        }
        break;
      case 'lowering':
        state.lift = 1 - smooth(Math.min(1, state.t / LOWER_SECONDS));
        if (state.t >= LOWER_SECONDS) {
          state.lift = 0;
          enter('raising');
          // The leaf is home. A hundred tonnes of deck meeting its abutment is the one moment in
          // the cycle with an impact in it, and it was landing in silence — `onLand` is what puts a
          // puff of dust at each end of it (main.js hands it `dust.burst`).
          onLand?.([
            { x: span.cx, z: span.z0 },
            { x: span.cx, z: span.z1 },
          ]);
        }
        break;
      case 'raising':
        // **The gates come back up on their own curve.** They used to snap: `open` set `barrier = 0`
        // on the frame it was entered, so after a full slow lower the arms jumped from flat across
        // the road to vertical in one frame — which at this camera reads as them vanishing and
        // popping back rather than as a gate rising.
        state.barrier = Math.max(0, 1 - state.t / BARRIER_SECONDS);
        if (state.t >= BARRIER_SECONDS) enter('open');
        break;
      default:
        break;
    }
    pose();
  }

  publish();
  pose();

  return {
    group,
    leaf,
    state,
    line,
    span,
    laneIds,
    /** Ask for the leaf. Idempotent while a cycle is already running. */
    request() { state.requested = true; },
    /** The boat is through; come back down. */
    release() { state.requested = false; },
    /** True while nothing may cross — the router's answer, not the leaf's angle. */
    get closed() { return SHUT.has(state.phase); },
    update,
    /** Shot mode ticks the world once and freezes it. See `settle` in game/fares.js. */
    settle() { pose(); },
    dispose() {
      setClosedLanes([], 'drawbridge');
      setBlockedLanes([]);
    },
  };
}

/**
 * How long from `request()` to a fully raised leaf, with an empty deck.
 *
 * Exported so `game/boats.js` can work out how far out a tug has to ask rather than carrying a
 * number copied from here — the two are one decision, and halving the lift speed without moving the
 * asking distance is exactly how a tug ends up nosing into a bridge that is still grinding upward.
 */
export const OPEN_SECONDS = BARRIER_SECONDS + LIFT_SECONDS;

export { PHASES, LIFT_ANGLE, WATER_Y, KERB_H, RAIL_W };
