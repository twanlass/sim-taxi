import * as THREE from 'three';
import { LANE, ROAD_W } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import { markOccluder, unmarkOccluder } from './ssao.js';
import {
  coneGeometry, barricadeParts, spoilParts, mergeAll, splinterGeometry,
  CONE_REST_Y, SPLINTER_REST_Y,
} from '../geometry/roadworks.js';
import { launchHop, setClosedLanes, policeRoad } from '../sim/traffic.js';
import { setRoadworkLanes } from './route.js';

// A street closed for roadworks: a striped trestle across each end, a scatter of cones, a heap of
// spoil beside the hole it came out of, and two workers standing over it.
//
// **Ambient traffic routes around it; the taxi has never heard of it.** The closure is two lane
// ids handed to `setClosedLanes` in sim/traffic.js, where they zero the weight of any turn that
// would enter them. The taxi's turn comes from its route, which is planned over the untouched road
// network, so it drives straight in — and since nothing else is in there, the closed street is the
// emptiest road in the city. That is the whole reward: no cash, no boost, just a fast lane and a
// ramp at the end of it.
//
// Scheduling is modelled on game/flyover.js and is deliberately **off the difficulty curve**, for
// the same reason the flyover is: nothing about this is pressure. One zone per run, one cooldown,
// and then it stays where it is. `place()` is public so shot mode and tools/probe.mjs can stage
// one rather than wait forty seconds for it.

const FIRST_WAIT = [40, 75];   // seconds. A three-to-four minute session sees exactly one.
const RETRY_WAIT = 5;          // nothing qualified right now — the city moves, ask again shortly
const FADE_IN = 1.1;
const RISE = 1.1;              // how far under the road the zone starts, so it grows out of it

// Packing up. Once the taxi has been through, the zone sinks back the way it came and the street
// reopens — a wrecked site sitting there for the rest of the run is a stale prop, and the second
// drive through an already-smashed barricade is a no-op that reads as broken.
//
// `LEAVE_DWELL` is measured from the taxi being *clear* **and the crew being gone**, not from the
// smash: the trestle takes TRESTLE_FLIGHT to finish cartwheeling, the cones and the splinters a
// little longer to settle, and the two workers longer still to get off the road. Fading during any
// of that swallows the payoff — and in the crew's case it swallowed the beat entirely. At overdrive
// the taxi crosses a 12-unit block in half a second, so the old rule started the zone's fade at
// about t = 1.35s against a run that ends at 1.15s and a fade that ends at 1.65s: the workers spent
// the back half of their sprint dissolving, which reads as them vanishing *instead of* escaping.
const LEAVE_DWELL = 0.8;
const FADE_OUT = 1.4;
const SINK = 1.1;              // matches RISE, so it leaves the way it arrived
const WORKER_HOLD = 0.45;      // a beat at the kerb, turned round, before they go
const WORKER_FADE = 0.5;       // ...and then they vanish, well ahead of the site itself

// How far the taxi has to be for a zone to appear. Same number and same honest caveat as
// traffic.js's SPAWN_CLEARANCE: on a desktop the whole city is in frame at once, so this cannot
// pretend to be off-camera — what it buys is that the zone is never *near* the car the player is
// watching. The rise-and-fade is what covers the desktop case.
const PLACE_CLEARANCE = 45;

// How far along a closed lane its trestle stands. Far enough that the ramp leaning against it
// clears the junction box behind: the ramp runs RAMP_RUN back from this line, so the toe lands at
// BARRIER_S - RAMP_RUN and that has to stay positive. At 1.7 against the old 3.2-unit ramp it was
// -1.5 — the toe sat in the middle of a live intersection, which is the other half of why the thing
// read as a plate lying near the corner rather than as a ramp up to a barricade.
export const BARRIER_S = 2.1;
const CONES = 12;
const WORKERS = 2;

// Two rows, one either side, this far off the road centreline. Set against the car rather than by
// eye: the taxi drives a lane centre at LANE (2.0) and is CAR_W/2 = 0.85 wide, so its flank sweeps
// to 2.85. At 2.6 the near row is squarely in the way and goes flying, and the far row survives to
// be seen — which is what makes the drive through read as damage rather than as a clean corridor.
export const CONE_ROW = 2.6;
const CONE_SPAN = [0.22, 0.78];   // along the segment, kept between the two barricades
const CONE_JITTER_SIDE = 0.12;    // placed by a crew, not stamped by a machine
const CONE_JITTER_ALONG = 0.15;

const SMASH_SCATTER = 7;       // cones this close to a smashed trestle go with it
const KNOCK_R = 1.7;           // and any cone the taxi drives over, anywhere in the zone
const KNOCK_V = 2;             // ...as long as it is actually moving

const CONE_GRAVITY = 26;
const CONE_SETTLE = 0.3;       // fraction of a cone's flight spent easing into its resting pose

// A cone caught by a trestle going over is thrown harder than one the taxi merely clipped: the
// blast is the event, the cone is only reporting it. 1.5 rather than a bigger number because the
// throw is *also* scaled by the taxi's speed, and the two multiply — see `knock`.
const SMASH_POWER = 1.5;
// ...which is why there is a ceiling on the vertical. At the overdrive top the speed term alone is
// 2.15, so 7.6 · 2.15 · 1.5 would launch a cone at 24 m/s: an apex of eleven units, most of a
// second of hang time, and a cone that leaves frame entirely on a close shot. 13 tops out at 3.25
// units — about a car length of air, high enough to read as flipped and low enough to stay in the
// picture with the thing that flipped it.
const CONE_VY_MAX = 13;

const TRESTLE_FLIGHT = 0.85;   // seconds a knocked trestle spends cartwheeling
const TRESTLE_THROW = 4.6;     // and how far downfield it lands

// Splintered plank off a trestle that has just been hit. Thrown from the plank line rather than
// from the road, in a forward fan: a trestle does not disintegrate evenly in all directions, it
// comes apart along the axis of whatever went through it.
const CHIPS = 16;              // per trestle, and only one trestle is ever hit at a time
const CHIP_GRAVITY = 30;       // heavier than a cone. Wood this size drops, it does not float down
const CHIP_SETTLE = 0.35;      // fraction of the flight spent easing flat onto the road
const CHIP_PLANK_Y = 0.95;     // roughly the height of the upper plank, where the chips come off

const FLEE_R = 15;             // a worker starts running when the taxi is this close
const FLEE_DUR = 1.15;
const KERB_OUT = ROAD_W / 2 + 1.4;   // where they run to, measured off the road centreline

const UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A local frame on a lane: **+X across the road to the right of travel, +Y up, +Z the direction of
 * travel**, with the origin on the tarmac at the lane centre.
 *
 * `makeBasis(r, up, f)` is right-handed here — `r · (up × f)` works out to `fx² + fz²` = 1 — which
 * matters because a left-handed basis would mirror every stripe on the barricade and put the ramp
 * on the wrong side of the road.
 */
function laneFrame(lane, s) {
  const p = lane.path.at(s);
  const t = lane.path.tangentAt(s);
  const f = new THREE.Vector3(t.x, 0, t.z).normalize();
  const r = new THREE.Vector3(f.z, 0, -f.x);
  const m = new THREE.Matrix4().makeBasis(r, UP, f);
  m.setPosition(p.x, 0, p.z);
  return { matrix: m, forward: f, right: r, x: p.x, z: p.z };
}

export function createRoadwork(rng, scene, camera = null) {
  const group = new THREE.Group();
  group.name = 'roadwork';
  scene.add(group);
  group.visible = false;

  const smashListeners = [];
  const landListeners = [];
  const placeListeners = [];
  const clearListeners = [];
  const emit = (list, event) => { for (const cb of list) cb(event); };

  /** The two junctions a closed segment runs between, in grid coordinates. */
  function endJunctions(edge) {
    const net = cityNetwork();
    return [edge.a, edge.b]
      .map((id) => net.nodeById.get(id))
      .filter(Boolean)
      .map((node) => ({ i: node.gi, j: node.gj }));
  }

  const state = {
    phase: 'waiting',                                   // waiting | fading | live | leaving | gone
    cooldown: rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    fade: 0,
    alpha: 0,                                           // what the zone's materials are actually on
    smashed: false,                                     // the taxi has been through at least one
    leaveAt: null,                                      // when to start packing up, once it is clear
    t: 0,                                               // seconds since the zone was placed
    airborne: false,
    lastLaneId: null,                                   // where the taxi was last frame, so a
    lastS: 0,                                           // barricade can test a crossing, not a side
    edge: null,
    closedLaneIds: [],
    occluded: false,
  };

  // Every material the zone owns, collected once at build. Walking `group` for them each frame
  // would be the same list and a traversal; the set is fixed for the zone's lifetime.
  const materials = [];
  const workers = [];
  const barriers = [];
  const cones = [];
  const chips = [];

  let coneMesh = null;
  let chipMesh = null;
  const dummy = new THREE.Object3D();
  const qTumble = new THREE.Quaternion();
  const qRest = new THREE.Quaternion();
  const restEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const spinAxis = new THREE.Vector3();

  // --- Choosing a street ------------------------------------------------------

  /**
   * Would closing `ids` leave some approach to `node` with nowhere to go?
   *
   * Asked exactly rather than by a corner heuristic: what strands a car is not the shape of the
   * junction but a single inbound lane whose every onward lane is closed. Because U-turns are
   * illegal, such a car can never leave — it would hold at the line forever with its whole lane
   * queued behind it. The zero-weight fallback in traffic.js means it drives on regardless, but a
   * car visibly driving through a barricade is the one thing this must never produce.
   */
  function strands(node, ids) {
    for (const lane of node.inbound) {
      if (lane.degenerate) continue;
      if (!lane.onward.some((out) => !ids.has(out.id))) return true;
    }
    return false;
  }

  /** True if any car is on, or turning onto, either lane of `edge`. */
  function occupied(edge, cars) {
    const ids = new Set(edge.lanes.map((l) => l.id));
    return cars.some((car) => ids.has(car.lane?.id) || ids.has(car.turn?.outLane));
  }

  function eligible(edge, taxi, cars, busy) {
    // Side streets only. An arterial is the one interior road with no lights on it at all, and
    // half-closing it takes the city's fast lane away; the ring is the road everything escapes onto.
    if (edge.klass !== 'side') return false;
    if (edge.lanes.length !== 2) return false;
    if (edge.lanes.some((l) => l.degenerate)) return false;

    const net = cityNetwork();
    const ids = new Set(edge.lanes.map((l) => l.id));
    const a = net.nodeById.get(edge.a);
    const b = net.nodeById.get(edge.b);
    if (!a || !b) return false;
    if (strands(a, ids) || strands(b, ids)) return false;

    // Not on the road a siren is currently running down. sim/police.js checks the closure before
    // it picks a corridor and again at every chase turn, so the only way a cruiser can end up
    // driving through a hole is if the hole opens underneath a run already in progress — and this
    // is the end of that hole to close. A live corridor is one road out of twelve for a few
    // seconds at a time, so it costs the placement almost nothing.
    const siren = policeRoad();
    if (siren && (siren.axis === 'x'
      ? a.gj === siren.line && b.gj === siren.line
      : a.gi === siren.line && b.gi === siren.line)) return false;

    // A rider standing on a kerb corner at either end would be picked up from inside the zone.
    if (busy.some((spot) => (spot.i === a.gi && spot.j === a.gj)
      || (spot.i === b.gi && spot.j === b.gj))) return false;

    if (occupied(edge, cars)) return false;

    const mid = edge.curve.at(edge.curve.length / 2);
    return Math.hypot(mid.x - taxi.x, mid.z - taxi.z) >= PLACE_CLEARANCE;
  }

  /**
   * Is the middle of this segment outside the frame right now?
   *
   * Only a *preference* — on a desktop the whole city is in shot and this finds nothing, which is
   * why the zone rises out of the road rather than simply appearing. Same projection recipe as
   * game/dropoffindicator.js, in clip space rather than pixels because nothing here needs pixels.
   */
  function offScreen(edge) {
    if (!camera) return false;
    const mid = edge.curve.at(edge.curve.length / 2);
    const v = new THREE.Vector3(mid.x, 0.1, mid.z).project(camera);
    return Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
  }

  // --- Building it ------------------------------------------------------------

  /**
   * A point on the **road centreline** `u` of the way along the segment, plus `side` units
   * across it, and the lateral unit vector that came with it.
   *
   * Measured along a *lane* rather than along `edge.curve`, and this is not a detail: an edge runs
   * node centre to node centre, so its first and last four units are inside the junction boxes at
   * either end. Cones strung along it were being laid out across two live intersections, where
   * cross traffic drove over them and the taxi collected them on its way past. A lane is already
   * trimmed to the tarmac between the two.
   *
   * The lane sits `LANE` to the right of the centreline, so `side` is offset by that to end up
   * measured from the middle of the road, which is where a road's furniture is naturally placed.
   */
  function roadPoint(edge, u, side) {
    const lane = edge.lanes[0];
    const at = lane.path.at(u * lane.length);
    const tan = lane.path.tangentAt(u * lane.length);
    const rx = tan.z;
    const rz = -tan.x;
    const o = side - LANE;
    return { x: at.x + rx * o, z: at.z + rz * o, rx, rz, u };
  }

  function buildStatic(edge) {
    const parts = [];
    const ramps = [];

    for (const lane of edge.lanes) {
      const frame = laneFrame(lane, BARRIER_S);
      const { trestle, ramp } = barricadeParts({ width: ROAD_W - 0.4, centreX: -LANE });

      // The trestle gets a group of its own so it can be thrown. Its geometry stays in the local
      // frame and the group carries the placement, which is what lets the flight below be written
      // in "across / up / downfield" rather than in world axes.
      const holder = new THREE.Group();
      holder.applyMatrix4(frame.matrix);
      const mesh = new THREE.Mesh(mergeAll(trestle), propMaterial());
      mesh.castShadow = true;
      holder.add(mesh);
      group.add(holder);
      materials.push(mesh.material);
      barriers.push({
        mesh, laneId: lane.id, s: BARRIER_S, hit: false, hitAt: 0,
        throwX: rng.jitter(0.8), twist: rng.range(-0.9, 0.9),
        x: frame.x, z: frame.z,
        // Kept so the splinters can be thrown in the trestle's own frame rather than in world
        // axes — see burstChips. The frame itself is discarded with the matrix it was built for.
        forward: frame.forward.clone(), right: frame.right.clone(),
      });

      // The ramp is bolted to the road, so it joins the static mesh — transformed into world space
      // here because that mesh has no frame of its own.
      for (const geo of ramp) { geo.applyMatrix4(frame.matrix); ramps.push(geo); }
    }

    parts.push(...ramps);

    // Spoil and its hole, off-centre along the block so the zone isn't symmetrical.
    const site = roadPoint(edge, rng.range(0.35, 0.6), 0);
    const off = rng.range(-1.4, 1.4);
    parts.push(...spoilParts(site.x + site.rx * off, site.z + site.rz * off, rng));

    const mesh = new THREE.Mesh(mergeAll(parts), propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'roadwork-static';
    group.add(mesh);
    materials.push(mesh.material);
    return { mesh, site: { ...site, off } };
  }

  function buildCones(edge) {
    const geometry = coneGeometry();
    coneMesh = new THREE.InstancedMesh(geometry, propMaterial(), CONES);
    coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Three caches an InstancedMesh's bounding sphere once, and this pool's slots move a long way
    // from where they started when the taxi arrives. Same reason every pool in game/ turns it off.
    coneMesh.frustumCulled = false;
    coneMesh.castShadow = true;
    group.add(coneMesh);
    materials.push(coneMesh.material);

    // Two rows down the sides of the works, six a side, evenly spaced between the barricades.
    //
    // This was a sine zigzag with 0.9 of jitter on top, meant to read as a crew that put them down
    // by hand. It read as neither: a wave that wanders across the centreline has no rule you can
    // see, so it looked like cones dropped at random rather than like a coned-off lane. Real
    // roadworks are laid out in lines, and a line with a hand's worth of slop on it is the thing
    // that reads as placed — the order has to be legible before the imperfection means anything.
    const perRow = CONES / 2;
    const [u0, u1] = CONE_SPAN;
    for (let n = 0; n < CONES; n++) {
      const row = n % 2 === 0 ? 1 : -1;
      const step = Math.floor(n / 2);
      const u = u0 + (u1 - u0) * (perRow === 1 ? 0.5 : step / (perRow - 1));
      const at = roadPoint(
        edge,
        u + rng.jitter(CONE_JITTER_ALONG) / edge.lanes[0].length,
        row * CONE_ROW + rng.jitter(CONE_JITTER_SIDE),
      );
      cones.push({
        x: at.x,
        z: at.z,
        y: 0,
        yaw: rng.range(0, Math.PI * 2),
        knocked: false, age: 0, dur: 1,
        x0: 0, z0: 0, vx: 0, vy: 0, vz: 0, quat: null,
      });
    }
    writeCones();
  }

  /**
   * The pool of plank splinters, dormant until a trestle is hit.
   *
   * Built with the zone rather than on the smash, for the same reason every pool in game/ is: the
   * smash is the one frame in the run where a hitch is unaffordable, and building an InstancedMesh
   * there means compiling a material and uploading a buffer inside it.
   *
   * Slots start scaled to zero. A dormant instance at the origin would otherwise be a small striped
   * chip sitting in the middle of the city — the mesh has no per-instance visibility flag, so
   * "absent" has to be spelled as "zero size".
   */
  function buildChips() {
    chipMesh = new THREE.InstancedMesh(splinterGeometry(), propMaterial(), CHIPS);
    chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    chipMesh.frustumCulled = false;   // same reason as the cones: these leave their bounding sphere
    chipMesh.castShadow = true;
    group.add(chipMesh);
    materials.push(chipMesh.material);

    for (let n = 0; n < CHIPS; n++) {
      chips.push({
        live: false, age: 0, dur: 1,
        x: 0, y: 0, z: 0, x0: 0, y0: 0, z0: 0,
        vx: 0, vy: 0, vz: 0,
        spin: 0, axisX: 0, axisY: 0, axisZ: 0,
        long: 1, restYaw: 0,
        quat: new THREE.Quaternion(),
      });
    }
    writeChips();
  }

  function buildWorkers(edge, site) {
    for (let n = 0; n < WORKERS; n++) {
      const person = createPerson({
        body: PALETTE.hiVis, hat: PALETTE.hardHat, pickable: null,
      });
      // Parented so the figure's own animations stay in the local space they are written in —
      // the same arrangement geometry/marker.js uses to stand a rider on a kerb corner.
      const holder = new THREE.Group();

      // One either side of the hole. Both offsets are from the road centreline, which is also what
      // the flee target below is measured in — the two have to be in the same frame or a worker
      // runs to a kerb that is nowhere near the one they are standing beside.
      const side = site.off + (n === 0 ? 1 : -1) * rng.range(1.4, 2.1);
      const spot = roadPoint(edge, site.u + rng.jitter(0.04), side);
      holder.position.set(spot.x, 0, spot.z);
      holder.add(person.group);
      group.add(holder);
      const mats = person.group.children.map((mesh) => mesh.material);
      materials.push(...mats);

      // Straight out to the kerb on whichever side they are already nearest. Expressed as a delta
      // along the lateral axis, so a diagonal street works with no extra case.
      const outward = Math.sign(side) || 1;
      const travel = KERB_OUT * outward - side;
      workers.push({
        person, holder, mats,
        dx: spot.rx * travel,
        dz: spot.rz * travel,
        phase: rng.range(0, Math.PI * 2),
        fleeing: 0,
        held: 0,      // seconds spent standing at the kerb since the run finished
        fade: 1,      // their own, multiplied into the zone's — see setAlpha
      });
    }
  }

  /**
   * Stand a zone on `edge`. Public so shot mode and the probe can stage one instead of waiting out
   * the cooldown — the same reason `flyover.launch()` is public.
   */
  function build(edge) {
    state.edge = edge;
    state.closedLaneIds = edge.lanes.map((l) => l.id);
    const { site } = buildStatic(edge);
    buildCones(edge);
    buildChips();
    buildWorkers(edge, site);
    // Published from here rather than polled by main.js: it changes exactly once in a run, and
    // anything that stages a zone directly — shot mode, tools/probe.mjs — gets the closure with it
    // instead of having to remember a second call.
    //
    // The same ids go two ways, and the two say opposite things. `setClosedLanes` tells ambient
    // traffic these turns are forbidden; `setRoadworkLanes` tells the taxi's router they are cheap.
    // That is the whole vignette in two lines: the city empties the street and the fare sends the
    // player down it.
    setClosedLanes(state.closedLaneIds);
    setRoadworkLanes(state.closedLaneIds);

    emit(placeListeners, { edge, ends: endJunctions(edge) });

    state.phase = 'fading';
    state.fade = 0;
    state.t = 0;
    group.visible = true;
    setAlpha(0);
  }

  function place(taxi, cars = [], busy = []) {
    if (state.phase !== 'waiting') return false;
    const net = cityNetwork();
    const open = net.edges.filter((edge) => eligible(edge, taxi, cars, busy));
    if (!open.length) return false;
    const hidden = open.filter(offScreen);
    build(rng.pick(hidden.length ? hidden : open));
    return true;
  }

  // --- Fading in --------------------------------------------------------------

  /**
   * Ramp the whole zone's opacity together.
   *
   * `transparent` and `depthWrite` are shader-define switches in three — setting them at runtime
   * does nothing until `needsUpdate` forces a recompile — so they are flipped only on the
   * transitions, the same guard geometry/person.js and game/vanish.js both carry.
   */
  function setAlpha(a) {
    state.alpha = a;
    // A fading worker forces the whole zone onto the transparent path even at full zone alpha —
    // otherwise `depthWrite` stays on and the worker's own opacity is simply ignored. It costs a
    // recompile at the start and end of the flee, which is two frames in a run.
    const opaque = a >= 1 && workers.every((w) => w.fade >= 1);
    for (const material of materials) {
      if (opaque === material.transparent) {
        material.transparent = !opaque;
        material.depthWrite = opaque;
        material.needsUpdate = true;
      }
      material.opacity = a;
    }
    // Workers second, so their own fade multiplies the zone's rather than being overwritten by it.
    for (const worker of workers) {
      if (worker.fade >= 1) continue;
      for (const material of worker.mats) material.opacity = a * worker.fade;
    }
  }

  // --- Wrecking it ------------------------------------------------------------

  /**
   * Send a cone flying, away from (fromX, fromZ).
   *
   * `power` is the difference between being clipped by a passing wheel and being inside a trestle
   * as it comes apart — see SMASH_POWER.
   */
  function knock(cone, fromX, fromZ, speed, power = 1) {
    if (cone.knocked) return;
    cone.knocked = true;
    cone.age = 0;
    cone.x0 = cone.x;
    cone.z0 = cone.z;

    let dx = cone.x - fromX;
    let dz = cone.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    // Thrown away from whatever hit it, harder the faster that thing was going. The floor on the
    // speed term is what keeps a cone nudged at walking pace from simply falling over in place.
    const kick = 0.55 + Math.min(1.6, speed / 12);
    cone.vx = dx * rng.range(2.6, 6.4) * kick * power + rng.jitter(1.2 * power);
    cone.vz = dz * rng.range(2.6, 6.4) * kick * power + rng.jitter(1.2 * power);
    cone.vy = Math.min(CONE_VY_MAX, rng.range(4.2, 7.6) * kick * power);
    // Time to fall back to the road, from the same closed form the position uses. Deriving it
    // rather than picking a duration is what keeps the settle landing exactly when the cone does.
    cone.dur = (2 * cone.vy) / CONE_GRAVITY;
    // Was 7..15, which at a cone's flight time is a turn and a half — enough to see it move, not
    // enough to see it *flip*. At 12..26 a cone thrown by a smash turns three to five times on its
    // way up and over, which is what carries the chaos: the tumble is the thing the eye reads, not
    // the height. Scaled by the same power, so a wheel-clipped cone still just topples.
    cone.spin = rng.range(12, 26) * power * (rng.chance(0.5) ? 1 : -1);
    cone.axisX = rng.range(-1, 1);
    cone.axisZ = rng.range(-1, 1);
    cone.restYaw = rng.range(0, Math.PI * 2);
    cone.restTilt = rng.range(-0.35, 0.35);
  }

  /**
   * Blow the pool of chips off a trestle that has just been hit.
   *
   * Thrown in the local frame the trestle was placed in — across / up / downfield — for the same
   * reason its own flight is written that way: "wood going the way the taxi was going" is the
   * statement, and in world axes that is a different pair of numbers on every street in the city.
   *
   * The `live` guard is what makes a second smash cheap rather than wrong: only one trestle per
   * zone is ever reachable today (see the known issue in docs/traffic.md), but if both became
   * reachable the second would take whatever the first had not, instead of resetting chips that
   * are still in the air.
   */
  function burstChips(barrier, taxi) {
    const speed = Math.max(Math.abs(taxi.v), 6);
    let spawned = 0;

    for (const chip of chips) {
      if (chip.live) continue;
      spawned += 1;

      chip.live = true;
      chip.age = 0;
      chip.x0 = barrier.x + barrier.right.x * rng.jitter(2.6);
      chip.z0 = barrier.z + barrier.right.z * rng.jitter(2.6);
      chip.y0 = CHIP_PLANK_Y + rng.jitter(0.35);
      chip.x = chip.x0;
      chip.y = chip.y0;
      chip.z = chip.z0;

      // Mostly downfield, some sideways spray. The forward term carries the taxi's speed and the
      // lateral one does not: a plank pushed out of the way goes out of the way at the speed the
      // crowbar was swung, but what sends it *down the street* is the car.
      const along = rng.range(0.45, 1) * (2.5 + speed * 0.42);
      const across = rng.range(-4.6, 4.6);
      chip.vx = barrier.forward.x * along + barrier.right.x * across;
      chip.vz = barrier.forward.z * along + barrier.right.z * across;
      chip.vy = rng.range(3.4, 8.2);

      // Fall time from the plank line to the road, out of the same quadratic the position uses —
      // not the cone's symmetric 2·vy/g, because a chip starts a metre up and lands at zero, so its
      // rise and its fall are different lengths.
      const drop = chip.y0 - SPLINTER_REST_Y;
      chip.dur = (chip.vy + Math.sqrt(chip.vy * chip.vy + 2 * CHIP_GRAVITY * drop)) / CHIP_GRAVITY;

      // Tumbling end over end about a random axis. Faster than a cone: it is a lighter thing hit by
      // the same car, and the flutter is most of what tells wood from plastic at this size.
      chip.spin = rng.range(16, 34) * (rng.chance(0.5) ? 1 : -1);
      chip.axisX = rng.range(-1, 1);
      chip.axisY = rng.range(-0.6, 0.6);
      chip.axisZ = rng.range(-1, 1);
      chip.long = rng.range(0.7, 1.7);      // splinters and stubs off the same plank
      chip.restYaw = rng.range(0, Math.PI * 2);
    }

    if (spawned) writeChips();
    return spawned;
  }

  function smash(barrier, taxi) {
    barrier.hit = true;
    barrier.hitAt = state.t;
    state.smashed = true;
    launchHop(taxi);
    for (const cone of cones) {
      if (Math.hypot(cone.x - barrier.x, cone.z - barrier.z) <= SMASH_SCATTER) {
        knock(cone, barrier.x, barrier.z, taxi.v, SMASH_POWER);
      }
    }
    burstChips(barrier, taxi);
    // **Everyone** goes, not just whoever the taxi got close to. The proximity test below is the
    // right rule for a taxi merely driving down the street; once a barricade is in the air it is
    // the wrong one — a worker calmly holding a shovel eight units from a trestle cartwheeling past
    // reads as a figure that has not been told what scene it is in.
    for (const worker of workers) if (worker.fleeing === 0) worker.fleeing = 1e-6;
    emit(smashListeners, { x: barrier.x, z: barrier.z, v: taxi.v });
  }

  // --- Per frame --------------------------------------------------------------

  function writeCones() {
    for (let n = 0; n < cones.length; n++) {
      const cone = cones[n];
      dummy.position.set(cone.x, cone.y, cone.z);
      if (cone.quat) dummy.quaternion.copy(cone.quat);
      else dummy.quaternion.setFromAxisAngle(UP, cone.yaw);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      coneMesh.setMatrixAt(n, dummy.matrix);
    }
    coneMesh.instanceMatrix.needsUpdate = true;
  }

  function writeChips() {
    for (let n = 0; n < chips.length; n++) {
      const chip = chips[n];
      if (!chip.live) {
        dummy.scale.setScalar(0);
        dummy.position.set(0, 0, 0);
        dummy.quaternion.identity();
      } else {
        dummy.position.set(chip.x, chip.y, chip.z);
        dummy.quaternion.copy(chip.quat);
        dummy.scale.set(chip.long, 1, 1);
      }
      dummy.updateMatrix();
      chipMesh.setMatrixAt(n, dummy.matrix);
    }
    chipMesh.instanceMatrix.needsUpdate = true;
  }

  function updateChips(dt) {
    let moving = 0;

    for (const chip of chips) {
      if (!chip.live || chip.age >= chip.dur) continue;
      moving += 1;

      chip.age = Math.min(chip.dur, chip.age + dt);
      const age = chip.age;

      // Closed form, like the cones and the blast's shards: a curve of age rather than an
      // integrated velocity, so slow-mo is the same shape as full speed and nothing accumulates.
      chip.x = chip.x0 + chip.vx * age;
      chip.z = chip.z0 + chip.vz * age;
      chip.y = Math.max(SPLINTER_REST_Y, chip.y0 + chip.vy * age - 0.5 * CHIP_GRAVITY * age * age);

      spinAxis.set(chip.axisX, chip.axisY, chip.axisZ).normalize();
      qTumble.setFromAxisAngle(spinAxis, chip.spin * age);
      const settle = clamp01((age / chip.dur - (1 - CHIP_SETTLE)) / CHIP_SETTLE);
      if (settle > 0) {
        // Flat on the road under a yaw of its own — the chip's thin axis is already y, so the
        // resting pose is a plain heading with a degree or two of lift on one corner. Slerped in
        // for the same reason the cone's is: blending Eulers gimbals and snaps.
        restEuler.set(0, chip.restYaw, 0.06);
        qRest.setFromEuler(restEuler);
        qTumble.slerp(qRest, smoothstep(settle));
      }
      chip.quat.copy(qTumble);
    }

    if (moving) writeChips();
    return moving;
  }

  function updateCones(dt, taxi) {
    let moving = 0;

    for (const cone of cones) {
      if (!cone.knocked) {
        if (Math.abs(taxi.v) > KNOCK_V
          && Math.hypot(cone.x - taxi.x, cone.z - taxi.z) < KNOCK_R) {
          knock(cone, taxi.x, taxi.z, taxi.v);
        }
        continue;
      }
      if (cone.age >= cone.dur) continue;

      moving += 1;
      cone.age = Math.min(cone.dur, cone.age + dt);
      const age = cone.age;

      // Closed form, like the blast's shards: position is a curve of age rather than an integrated
      // velocity, so nothing accumulates and a slow-motion frame is the same shape as a full-speed
      // one. Unlike the shards these come to rest — the camera is still here afterwards.
      cone.x = cone.x0 + cone.vx * age;
      cone.z = cone.z0 + cone.vz * age;
      cone.y = Math.max(CONE_REST_Y, cone.vy * age - 0.5 * CONE_GRAVITY * age * age);

      spinAxis.set(cone.axisX, 0, cone.axisZ).normalize();
      qTumble.setFromAxisAngle(spinAxis, cone.spin * age);
      const settle = clamp01((age / cone.dur - (1 - CONE_SETTLE)) / CONE_SETTLE);
      if (settle > 0) {
        // Lying on its side: a quarter turn about a horizontal axis, under a yaw of its own. Eased
        // in by slerp rather than by blending Eulers, which gimbals through the flat pose and makes
        // a cone snap ninety degrees in the last frame.
        restEuler.set(Math.PI / 2 + cone.restTilt, cone.restYaw, 0);
        qRest.setFromEuler(restEuler);
        qTumble.slerp(qRest, smoothstep(settle));
      }
      cone.quat = (cone.quat ?? new THREE.Quaternion()).copy(qTumble);
    }

    if (moving) writeCones();
    return moving;
  }

  function updateBarriers(taxi) {
    let flying = 0;

    for (const barrier of barriers) {
      if (!barrier.hit) {
        // Bookkeeping, not geometry. A distance test would be tunnelled straight through at the
        // overdrive top, where the taxi covers 0.38 units a frame; a lane id and an arc length
        // cannot be missed.
        //
        // A *crossing*, though, not a comparison. `s >= barrier.s` alone is true for the whole
        // rest of the lane, so a taxi that was already past the line when the zone finished rising
        // would be launched off a barricade it never reached. Placement keeps the zone well clear
        // of the taxi so a live run cannot reach that state, but a staged one can, and a test that
        // has to avoid a state is a test of the harness rather than of the game.
        const crossed = taxi.lane?.id === barrier.laneId
          && state.lastLaneId === barrier.laneId
          && state.lastS < barrier.s && taxi.s >= barrier.s;
        if (crossed) smash(barrier, taxi);
        continue;
      }

      const u = clamp01((state.t - barrier.hitAt) / TRESTLE_FLIGHT);
      if (u >= 1) continue;
      flying += 1;

      const ease = 1 - (1 - u) ** 2;
      barrier.mesh.position.set(
        barrier.throwX * ease,
        Math.sin(Math.PI * u) * 1.25,
        TRESTLE_THROW * ease,
      );
      // Tips away down the road and lands past flat, which reads as slammed rather than as laid
      // down. Negative x swings the top toward +Z, the direction the taxi was going.
      barrier.mesh.rotation.set(-1.95 * ease, barrier.twist * ease, 0);
    }

    return flying;
  }

  function updateWorkers(dt, taxi) {
    const near = state.closedLaneIds.includes(taxi.lane?.id);
    let faded = false;

    for (const worker of workers) {
      // Run finished: they are at the kerb, turned round, looking back at the road. Hold that pose
      // for WORKER_HOLD and then fade them out — a figure standing at a kerb forever beside a
      // wrecked site is the tell that nothing here is going to be cleared up, and a figure that
      // starts dissolving the instant they stop never reads as having got there.
      if (worker.fleeing >= FLEE_DUR) {
        worker.held += dt;
        if (worker.held >= WORKER_HOLD && worker.fade > 0) {
          worker.fade = Math.max(0, worker.fade - dt / WORKER_FADE);
          faded = true;
        }
        continue;
      }

      if (worker.fleeing > 0) {
        worker.fleeing = Math.min(FLEE_DUR, worker.fleeing + dt);
        worker.person.flee(worker.fleeing / FLEE_DUR, worker.dx, worker.dz);
        continue;
      }

      const spooked = near && Math.hypot(
        worker.holder.position.x - taxi.x,
        worker.holder.position.z - taxi.z,
      ) < FLEE_R;
      if (spooked) worker.fleeing = 1e-6;
      else worker.person.idle(state.t, worker.phase);
    }

    if (faded) setAlpha(state.alpha);
  }

  /**
   * Take the zone down and **give the street back**.
   *
   * Reopening is the part that is not cosmetic. `setClosedLanes` is what keeps ambient traffic out
   * and `setRoadworkLanes` is what tempts the taxi in; leaving either set behind would give the
   * city an invisible closure it drives around for the rest of the run, and the router a shortcut
   * down a street with nothing on it — the exact failure the placement rules exist to avoid, only
   * with no barricade to explain it.
   */
  function teardown() {
    state.phase = 'gone';
    setClosedLanes([]);
    setRoadworkLanes([]);

    group.visible = false;
    scene.remove(group);
    // Before the dispose below, not after: the AO prepass holds a hard reference to every occluder
    // and swaps its material each frame, so a freed mesh left enrolled is both a leak and a swap
    // onto disposed geometry.
    unmarkOccluder(group);
    group.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      object.material.dispose();
    });
    materials.length = 0;
    emit(clearListeners, { edge: state.edge });
  }

  function update(dt, taxi, cars = [], busy = []) {
    if (state.phase === 'gone') return;

    if (state.phase === 'waiting') {
      state.cooldown -= dt;
      if (state.cooldown <= 0) {
        if (!place(taxi, cars, busy)) state.cooldown = RETRY_WAIT;
      }
      return;
    }

    state.t += dt;

    if (state.phase === 'fading') {
      state.fade = Math.min(1, state.fade + dt / FADE_IN);
      const ease = smoothstep(state.fade);
      setAlpha(ease);
      // Grows up out of the road rather than appearing on it. The slab is opaque and drawn first,
      // so the part still below y = 0 fails the depth test and is simply not there yet.
      group.position.y = -RISE * (1 - ease);
      if (state.fade >= 1) {
        state.phase = 'live';
        group.position.y = 0;
      }
      return;
    }

    // Packing up, once the taxi has been through and got clear. Opacity plus a sink back under the
    // road — the mirror of the arrival, and for the same reason it works: the slab is opaque and
    // drawn first, so whatever has gone below y = 0 fails the depth test for free.
    if (state.phase === 'leaving') {
      state.fade = Math.max(0, state.fade - dt / FADE_OUT);
      const ease = smoothstep(state.fade);
      setAlpha(ease);
      group.position.y = -SINK * (1 - ease);
      // Cones and trestles are still finishing their flights underneath this, deliberately: the
      // last thing that happens is not everything stopping, it is everything going.
      updateCones(dt, taxi);
      updateChips(dt);
      updateBarriers(taxi);
      updateWorkers(dt, taxi);
      if (state.fade <= 0) teardown();
      return;
    }

    // Occlusion is claimed once the materials are opaque again: markOccluder skips anything
    // transparent, so calling it mid-fade would silently enrol nothing.
    if (!state.occluded) {
      markOccluder(group);
      state.occluded = true;
    }

    if (taxi.crashed) return;

    updateBarriers(taxi);
    updateCones(dt, taxi);
    updateChips(dt);
    updateWorkers(dt, taxi);

    // The hop is rendered by traffic.js off `hopFrom`, which it clears on touchdown — so touchdown
    // is the frame that flag goes away, and the previous frame's value is the only way to see it.
    // Reading it twice inside one update() cannot work: traffic.js has already run by then, so the
    // flag is gone before this module is ever asked. Keeping the arc's length here and recomputing
    // the landing would work too, and would be a second copy of a curve to keep in step.
    const airborne = taxi.hopFrom != null;
    if (state.airborne && !airborne) emit(landListeners, { x: taxi.x, z: taxi.z, v: taxi.v });
    state.airborne = airborne;
    state.lastLaneId = taxi.lane?.id ?? null;
    state.lastS = taxi.s;

    // "Through" is *off the closed lanes and back on the ground*, not "has smashed something". The
    // taxi smashes the barricade at the mouth of the street and then has the whole block still to
    // drive; starting the fade at the smash would dissolve the site around it while it is still
    // inside, which is both the wrong beat and the wrong reading — it did not clear the works, it
    // is in them.
    //
    // And the crew has to be gone before the site is, not with it. Every worker flees on the smash,
    // so this is only ever a wait, never a deadlock — but it is a wait the fast case genuinely
    // needs: at overdrive the taxi is clear of the street before the two of them have finished
    // running. Sequencing it here rather than by lengthening LEAVE_DWELL keeps the beat correct at
    // both speeds, where a fixed number is only ever right at one of them.
    const crewGone = workers.every((worker) => worker.fade <= 0);
    if (state.smashed && state.leaveAt === null && crewGone
      && !state.closedLaneIds.includes(taxi.lane?.id) && !airborne) {
      state.leaveAt = state.t + LEAVE_DWELL;
    }
    if (state.leaveAt !== null && state.t >= state.leaveAt) state.phase = 'leaving';
  }

  /** How many pieces are still in the air. Zero once everything has come to rest. */
  function active() {
    let n = 0;
    for (const cone of cones) if (cone.knocked && cone.age < cone.dur) n += 1;
    for (const chip of chips) if (chip.live && chip.age < chip.dur) n += 1;
    for (const barrier of barriers) {
      if (barrier.hit && state.t - barrier.hitAt < TRESTLE_FLIGHT) n += 1;
    }
    return n;
  }

  return {
    group,
    state,
    place,
    update,
    active,
    cones,
    chips,
    barriers,
    /** How many workers are running or have run. For tools/probe.mjs. */
    workersFleeing: () => workers.filter((w) => w.fleeing > 0).length,
    /** ...how many have finished the run and are standing at the kerb. */
    workersClear: () => workers.filter((w) => w.fleeing >= FLEE_DUR).length,
    /** ...and how many have faded out afterwards. The zone waits on this one — see update(). */
    workersGone: () => workers.filter((w) => w.fade <= 0).length,
    get closedLaneIds() { return state.closedLaneIds; },
    onSmash: (cb) => { smashListeners.push(cb); },
    onLand: (cb) => { landListeners.push(cb); },
    // Fires once, when a zone is stood up, with the two junctions it runs between. main.js uses it
    // to aim one fare's drop-off at the far end of the closed street.
    onPlaced: (cb) => { placeListeners.push(cb); },
    // ...and once when it has been cleared away and the street is open again.
    onCleared: (cb) => { clearListeners.push(cb); },
  };
}
