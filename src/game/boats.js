import * as THREE from 'three';
import { propMaterial, vehiclePaintOn } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import {
  createBargeMesh, createTugMesh, BARGE_LEN, TUG_LEN, BARGE_BEAM, TUG_BEAM,
} from '../geometry/boat.js';
import {
  waterEdges, waterHeightAt, bridgeSpan, bridgeLines, drawbridgeLine, BARGE_AIR, TUG_AIR, coastFor,
} from '../city/river.js';
import { createGullFlock, MOVE_SECONDS, MOVE_REACH, LIFT_RAMP } from './gulls.js';
import { OPEN_SECONDS } from './drawbridge.js';
import { createWake } from './wake.js';
import { EDGE_FADE } from '../city/ground.js';

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
// Per side, since the harbor moved the east coast out (`coastFor`, city/river.js): `sign` is the
// end of the map the boat is at.
const OFF_MAP = (sign = -1) => coastFor(sign) + 26;

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
const fadeAt = (x) => {
  const out = Math.abs(x) - coastFor(x);
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
// wake is spent per unit **travelled** — which is what makes a tug held at `HOLD_OFF` lay none —
// and that the foam is laid into the world rather than parented to the boat, so it stays on the
// water the hull is pulling away from.

// Speeds, in world units per second. Cars cruise at 8.5, and a boat that kept up with the traffic
// would read as a jet ski — what sells it is being the slowest thing in the frame. At 3.4 a tug
// takes about 45 seconds to cross the map, which is most of a fare.
const BARGE_SPEED = 2.6;
const TUG_SPEED = 3.4;

// Seconds between tugs, which is seconds between lifts.
//
// **About one every 45 seconds** (Tyler, 2026-10-19: "I rarely see it ... I kind of expect it once
// every 30 seconds or once every 45"). It was 90-150, and that was the *wait*, not the spacing: a tug
// could only set off onto an empty river, so it also waited out every barge and its own trip across
// the map, and the lift came round once every **179 s** (median over 30 seeds, 141-225), the first
// one 2:16 into a run. Ten minutes of play saw three. Now tugs and barges share the river in single
// file (`FOLLOW_GAP`), so this is what the player gets: 45 s apart, give or take.
//
// The cost is the road. A lift keeps the span shut for 24 s, so at this spacing the middle crossing
// is shut about half the time rather than an eighth — it is a hazard you plan round, not an event
// you are lucky to catch.
const TUG_WAIT = [30, 50];
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

// The least water between one boat's stern and the next one's bow.
//
// **The river is single file and every boat keeps station on the one ahead.** It used to be kept
// apart by the launch schedule alone — a tug only onto an empty river, no barge while a tug was out
// — because a tug is the faster hull and the only one that stops. That held two boats apart and cost
// the drawbridge two thirds of its lifts: a tug due behind a barge waited ~70 s for it to leave the
// map. With a following rule the schedule only has to space launches; a tug that catches a barge
// slows to it, and a barge arriving at a tug held short of the leaf waits behind it.
const FOLLOW_GAP = 5;
// ...and how far the last boat out must be from the spawn before another follows it.
const LAUNCH_GAP = 30;

// How far off the middle of the channel a boat runs, and how much of that is left to chance.
//
// **Zero: the river is single file.** Boats used to keep to a lane each side so an up-river and a
// down-river hull could pass, which capped the beam at under half the water — and a barge that
// narrow read as a toy next to the cars on the bridges. The barge filled three quarters of the
// channel for a while; the trash barge that replaced it is back to half (4.2), and two of those
// still do not fit side by side on the narrow build (8.4 against 7.87) — so the passing problem
// stays with the launch schedule (`riverDir` below) rather than going back to lanes. Running down the middle is also the best the arches can offer a
// mast: they crest on the centreline.
//
// Exported because the ceiling on them is a *clearance* and belongs in the probe.
export const BOAT_LANE = 0;
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

  // Every span over the water, as an x interval — what a gull changing altitude must not be under.
  const spans = bridgeLines().map(bridgeSpan).filter(Boolean)
    .map((s) => [s.cx - s.outer, s.cx + s.outer]);
  /**
   * May a barge's gulls take off or land? Only if no span is over the hull, or will be over it
   * before a move that starts now has finished — the hull's swept interval over `MOVE_SECONDS`,
   * padded by how far past its ends a bird mid-move can be. See game/gulls.js for why this is the
   * whole of the bridge problem.
   */
  const gullsClear = (boat) => {
    const half = boat.len / 2 + MOVE_REACH;
    const ahead = boat.x + boat.dir * boat.speed * MOVE_SECONDS;
    const lo = Math.min(boat.x, ahead) - half;
    const hi = Math.max(boat.x, ahead) + half;
    return spans.every(([a, b]) => hi < a || lo > b);
  };
  /**
   * How far up toward its bridge height a gull at hull-frame `z` must fly: 1 anywhere within a
   * unit of a span's footprint (a wing's reach, padded), easing to 0 `LIFT_RAMP` beyond it.
   */
  const gullLift = (boat) => (z) => {
    const wx = boat.x + boat.dir * z;
    let d = Infinity;
    for (const [a, b] of spans) d = Math.min(d, Math.max(0, a - wx, wx - b));
    const t = Math.min(1, Math.max(0, (d - 1) / LIFT_RAMP));
    return 1 - t * t * (3 - 2 * t);
  };

  // The foam, on a stream of its own.
  //
  // **One draw off the boats' rng and no more.** A wake spends a dozen randoms a second, so sharing
  // this generator would make which lane the next barge is given a function of how much foam the
  // last one happened to lay — the coupling the two-seed rule exists to prevent, in its most
  // literal form. Seeded from a single draw taken here at construction instead, so the boats' own
  // stream advances by exactly one whatever the river does afterwards.
  const wake = createWake(group, makeRng(rng.int(0, 0x7fffffff)), edges, fadeAt);

  /**
   * Where across the channel a boat runs: down the middle, give or take `LANE_WANDER`.
   *
   * There used to be a lane each way, port to port, and the two bounds on it — a floor so passing
   * hulls do not touch, a ceiling so the tug's mast clears the arch off-centre — are the reason the
   * boats were so narrow. Single file has neither: nothing passes, and the centreline is where the
   * arch is highest.
   */
  const laneZ = (dir) => midZ + dir * BOAT_LANE + rng.jitter(LANE_WANDER);

  const boats = [];
  const state = {
    bargeIn: rng.range(BARGE_WAIT[0], BARGE_WAIT[1]) * 0.4,
    tugIn: rng.range(TUG_WAIT[0], TUG_WAIT[1]) * 0.5,
    tugs: 0,
    barges: 0,
    wanting: false,
  };

  /**
   * Single file, so two rules keep hulls apart:
   *
   * - **Everything on the river goes the same way.** A new boat takes the direction of whatever is
   *   already out there; only an empty river gets a fresh draw. Nothing ever meets head-on.
   * - **Every boat keeps `FOLLOW_GAP` behind the one ahead** (`update`), so a tug (3.4) cannot run
   *   down a barge (2.6), and a barge cannot sail into a tug holding station at a shut leaf.
   *
   * The schedule only spaces launches (`LAUNCH_GAP`), and a tug that comes due is never held back
   * for a barge: it is the lift.
   */
  const riverDir = () => (boats.length ? boats[0].dir : null);
  /** Room at the spawn for another boat: the last one out is `LAUNCH_GAP` clear of it. */
  const roomToLaunch = () => boats.every((b) => {
    const fromSpawn = (b.x - (b.dir > 0 ? -OFF_MAP(-1) : OFF_MAP(1))) * b.dir;
    return fromSpawn - b.len / 2 >= LAUNCH_GAP;
  });

  function launch(kind) {
    const geo = kind === 'tug' ? createTugMesh(rng) : createBargeMesh(rng);
    // On the cars' paint, with the heap, the rust and the canvas tagged matte (geometry/boat.js);
    // `?vehiclepaint=classic` puts the hull back on the plain prop material.
    const mesh = new THREE.Mesh(geo, vehiclePaintOn() ? propMaterial({ gloss: { geometry: geo } }) : propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Per-boat material, so each can carry its own opacity as it comes in and goes out.
    mesh.material.transparent = true;
    // The hull is modelled bow-toward +Z; a boat running -X turns to face it.
    const drawn = rng.chance(0.5) ? 1 : -1;
    const dir = riverDir() ?? drawn;
    mesh.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    const boat = {
      kind,
      mesh,
      dir,
      x: dir > 0 ? -OFF_MAP(-1) : OFF_MAP(1),
      z: laneZ(dir),
      speed: kind === 'tug' ? TUG_SPEED : BARGE_SPEED,
      asked: false,
      len: kind === 'tug' ? TUG_LEN : BARGE_LEN,
      beam: kind === 'tug' ? TUG_BEAM : BARGE_BEAM,
    };
    mesh.position.set(boat.x, waterHeightAt(boat.x), boat.z);
    // The wheelhouse's windows are a mesh of their own, on the cars' gloss material (geometry/boat.js
    // says why).
    // Per-boat for the same reason as the hull's: it fades with the boat.
    if (geo.userData.house) {
      const houseGeo = geo.userData.house;
      boat.house = new THREE.Mesh(houseGeo, propMaterial({ gloss: { geometry: houseGeo } }));
      boat.house.material.transparent = true;
      boat.house.castShadow = true;
      boat.house.receiveShadow = true;
      mesh.add(boat.house);
    }
    // The barge's gulls ride in its frame and wear its material, so they fade with it.
    if (kind === 'barge') {
      // On a stream of their own, seeded from one draw, for the wake's reason: they spend randoms
      // every time one lands, and the schedule must not depend on how often that was.
      boat.gulls = createGullFlock(makeRng(rng.int(0, 0x7fffffff)), geo.userData.perches, mesh.material);
      boat.gullLift = gullLift(boat);
      mesh.add(boat.gulls.group);
    }
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
    // A boat that comes due with no room at the spawn is not dropped, it waits for the room. A tug
    // goes first, and a barge waits while one is due, or barges arriving every 16-34 s would keep
    // the spawn busy and push the lifts back.
    if (state.tugIn <= 0 && roomToLaunch()) {
      launch('tug');
      state.tugIn = rng.range(TUG_WAIT[0], TUG_WAIT[1]);
    }
    if (state.bargeIn <= 0 && state.tugIn > 0 && roomToLaunch()) {
      launch('barge');
      state.bargeIn = rng.range(BARGE_WAIT[0], BARGE_WAIT[1]);
    }

    const gate = spanX();
    // Moved front to back, so each boat is clamped against where the one ahead has *got to* this
    // frame. Sorted rather than taken in launch order, because a staged shot (`settle`) puts a tug
    // ahead of a barge launched before it.
    const order = boats.slice().sort((a, b) => (b.x - a.x) * b.dir);
    for (let k = 0; k < order.length; k++) {
      const boat = order[k];
      boat.before = boat.x;
      boat.x += boat.dir * boat.speed * dt;
      if (boat.kind === 'tug' && gate !== null && drawbridge) {
        const toGate = (gate - boat.x) * boat.dir;
        if (!boat.asked && toGate <= ASK_AHEAD && toGate > 0) boat.asked = true;
        // Hold station short of a span that is not open yet. Clamped rather than decelerated: at
        // 3.4 u/s a boat is barely moving on screen anyway, and a stopping curve would be a second
        // motion model for something the player sees every 45 seconds.
        //
        // **`toGate > 0` is load-bearing.** Without it the clamp goes on applying after the tug is
        // through — `toGate` is negative by then, still under `HOLD_OFF` — so the moment the leaf
        // started back down it teleported the boat to the near side of the bridge and held it
        // there. One tug in 260 seconds instead of three, and the one was going round in circles.
        if (boat.asked && toGate > 0 && toGate <= HOLD_OFF && drawbridge.state.lift < 0.98) {
          boat.x = gate - boat.dir * HOLD_OFF;
        }
      }
      const ahead = order[k - 1];
      if (ahead) {
        const limit = ahead.x - boat.dir * (ahead.len / 2 + FOLLOW_GAP + boat.len / 2);
        if ((boat.x - limit) * boat.dir > 0) boat.x = limit;
      }
    }

    // **The lift is held while any tug still wants it**, not toggled by each one. Two tugs can be
    // on the river at once now, and with one flag per bridge the first one's `release` cancelled
    // the second's `request` — which left the second asked, holding at `HOLD_OFF`, under a leaf that
    // came down and never went back up. Asked every frame rather than once, for the same reason the
    // other way: `HOLD_SECONDS` drops the leaf on a tug that is still waiting, and it has to be able
    // to ask again.
    if (gate !== null && drawbridge) {
      const wanting = boats.some((b) => b.kind === 'tug' && b.asked
        && (gate - b.x) * b.dir >= -RELEASE_PAST && Math.abs(b.x) <= OFF_MAP(b.x));
      if (wanting) drawbridge.request();
      else if (state.wanting) drawbridge.release();
      state.wanting = wanting;
    }

    for (let k = boats.length - 1; k >= 0; k--) {
      const boat = boats[k];
      const before = boat.before ?? boat.x;
      boat.mesh.position.x = boat.x;
      // Ride the surface, which is not flat any more: the channel shoals up to meet the ground
      // through each mouth (`waterHeightAt`), and a hull pinned to `WATER_Y` would sail into the
      // shallows with the river closing over it.
      boat.mesh.position.y = waterHeightAt(boat.x);

      // Fade with the ground under it. The foam behind it fades on the same band, but per mote and
      // at the x it was *laid* at rather than at the boat's — it does not travel with the hull, so
      // it cannot inherit the hull's opacity either.
      boat.mesh.material.opacity = fadeAt(boat.x);
      if (boat.house) boat.house.material.opacity = boat.mesh.material.opacity;
      if (boat.gulls) boat.gulls.update(dt, gullsClear(boat), boat.gullLift);

      // Foam is spent per unit of river covered, so a tug clamped at `HOLD_OFF` in front of a leaf
      // that has not come up spends nothing and lies there with the water flat behind it. That used
      // to be a `moved / would-have-moved` term multiplied into the wake's opacity; keyed to
      // distance it is not a special case any more, it is just what the emitter does.
      wake.follow(boat, Math.abs(boat.x - before));

      if (Math.abs(boat.x) > OFF_MAP(boat.x)) {
        // A tug retired without ever getting through lets go by leaving `wanting` above.
        group.remove(boat.mesh);
        boat.mesh.geometry.dispose();
        if (boat.house) {
          boat.house.geometry.dispose();
          boat.house.material.dispose();
        }
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
    gullsClear,
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
      // Far enough astern of the sailboat that it cannot run into it while a drawbridge shot steps
      // the cycle forward. The barge does not stop, the sailboat holds at `HOLD_OFF`, and a staged
      // shot puts both on the river at once, which the schedule never does — 26 units back, with a
      // 16-unit hull, the barge sailed straight through the waiting sailboat by the time the leaf
      // was up. 13 seconds of staging is 34 units of barge, so from 60 back its bow stopped 6 short
      // of the sailboat's stern — and 8.5 short now the hull is 11.
      barge.x = gate - 60;
      barge.z = laneZ(barge.dir);
      barge.mesh.position.set(barge.x, waterHeightAt(barge.x), barge.z);
      const tug = launch('tug');
      tug.dir = 1;
      tug.mesh.rotation.y = Math.PI / 2;
      tug.x = gate - 2;
      tug.z = laneZ(tug.dir);
      tug.mesh.position.set(tug.x, waterHeightAt(tug.x), tug.z);
      // After both are in their final place, not inside `launch` — a trail laid at the spawn point
      // and then teleported with the hull would be sixty units up-river of the boat it belongs
      // to, which is a wake in a screenshot of open water.
      for (const boat of boats) wake.prime(boat);
    },
  };
}

export { BARGE_AIR, TUG_AIR };
