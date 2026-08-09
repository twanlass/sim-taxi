import * as THREE from 'three';
import { LANE, ROAD_W } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import { markOccluder } from './ssao.js';
import {
  coneGeometry, barricadeParts, spoilParts, mergeAll, CONE_REST_Y,
} from '../geometry/roadworks.js';
import { launchHop, setClosedLanes } from '../sim/traffic.js';
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

const SMASH_SCATTER = 5.5;     // cones this close to a smashed trestle go with it
const KNOCK_R = 1.7;           // and any cone the taxi drives over, anywhere in the zone
const KNOCK_V = 2;             // ...as long as it is actually moving

const CONE_GRAVITY = 26;
const CONE_SETTLE = 0.3;       // fraction of a cone's flight spent easing into its resting pose
const TRESTLE_FLIGHT = 0.85;   // seconds a knocked trestle spends cartwheeling
const TRESTLE_THROW = 4.6;     // and how far downfield it lands

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
    phase: 'waiting',                                   // waiting | fading | live
    cooldown: rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    fade: 0,
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

  let coneMesh = null;
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
    // Side streets only. Closing an arterial fights the 64% green share and the platoon offsets the
    // whole city is timed around; the ring is the road everything else escapes onto.
    if (edge.klass !== 'side') return false;
    if (edge.lanes.length !== 2) return false;
    if (edge.lanes.some((l) => l.degenerate)) return false;

    const net = cityNetwork();
    const ids = new Set(edge.lanes.map((l) => l.id));
    const a = net.nodeById.get(edge.a);
    const b = net.nodeById.get(edge.b);
    if (!a || !b) return false;
    if (strands(a, ids) || strands(b, ids)) return false;

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
      for (const mesh of person.group.children) materials.push(mesh.material);

      // Straight out to the kerb on whichever side they are already nearest. Expressed as a delta
      // along the lateral axis, so a diagonal street works with no extra case.
      const outward = Math.sign(side) || 1;
      const travel = KERB_OUT * outward - side;
      workers.push({
        person, holder,
        dx: spot.rx * travel,
        dz: spot.rz * travel,
        phase: rng.range(0, Math.PI * 2),
        fleeing: 0,
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
    const opaque = a >= 1;
    for (const material of materials) {
      if (opaque === material.transparent) {
        material.transparent = !opaque;
        material.depthWrite = opaque;
        material.needsUpdate = true;
      }
      material.opacity = a;
    }
  }

  // --- Wrecking it ------------------------------------------------------------

  function knock(cone, fromX, fromZ, speed) {
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
    cone.vx = dx * rng.range(2.6, 6.4) * kick + rng.jitter(1.2);
    cone.vz = dz * rng.range(2.6, 6.4) * kick + rng.jitter(1.2);
    cone.vy = rng.range(4.2, 7.6) * kick;
    // Time to fall back to the road, from the same closed form the position uses. Deriving it
    // rather than picking a duration is what keeps the settle landing exactly when the cone does.
    cone.dur = (2 * cone.vy) / CONE_GRAVITY;
    cone.spin = rng.range(7, 15) * (rng.chance(0.5) ? 1 : -1);
    cone.axisX = rng.range(-1, 1);
    cone.axisZ = rng.range(-1, 1);
    cone.restYaw = rng.range(0, Math.PI * 2);
    cone.restTilt = rng.range(-0.35, 0.35);
  }

  function smash(barrier, taxi) {
    barrier.hit = true;
    barrier.hitAt = state.t;
    launchHop(taxi);
    for (const cone of cones) {
      if (Math.hypot(cone.x - barrier.x, cone.z - barrier.z) <= SMASH_SCATTER) {
        knock(cone, barrier.x, barrier.z, taxi.v);
      }
    }
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

    for (const worker of workers) {
      if (worker.fleeing >= FLEE_DUR) continue;

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
  }

  function update(dt, taxi, cars = [], busy = []) {
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

    // Occlusion is claimed once the materials are opaque again: markOccluder skips anything
    // transparent, so calling it mid-fade would silently enrol nothing.
    if (!state.occluded) {
      markOccluder(group);
      state.occluded = true;
    }

    if (taxi.crashed) return;

    updateBarriers(taxi);
    updateCones(dt, taxi);
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
  }

  /** How many pieces are still in the air. Zero once everything has come to rest. */
  function active() {
    let n = 0;
    for (const cone of cones) if (cone.knocked && cone.age < cone.dur) n += 1;
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
    barriers,
    get closedLaneIds() { return state.closedLaneIds; },
    onSmash: (cb) => { smashListeners.push(cb); },
    onLand: (cb) => { landListeners.push(cb); },
    // Fires once, when a zone is stood up, with the two junctions it runs between. main.js uses it
    // to aim one fare's drop-off at the far end of the closed street.
    onPlaced: (cb) => { placeListeners.push(cb); },
  };
}
