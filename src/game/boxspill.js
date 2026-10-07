import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { CAR_LEN, CAR_W, TRUCK_LEN, TRUCK_W, TRUCK_CHASSIS_TOP } from '../sim/traffic.js';
import { TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';
import { propMaterial } from '../util/geo.js';
import { riverBanks } from '../city/grid.js';
import { deckHeightAt } from '../city/river.js';
import { markOccluder } from './ssao.js';
import { crateGeometry, CRATE, CRATE_REST_Y } from '../geometry/crate.js';
import {
  doorLeafGeometry, holdGeometry, BOX_REAR, BOX_MID_Y, HINGE_OUT,
} from '../geometry/truckdoors.js';

// Ram a box truck and its back doors burst open and part of its load comes out — more of it the
// harder the hit. Tyler's vignette: "if you ram into one of the box trucks, we should have all of
// the boxes fall off of the truck. Or some of the boxes, depending on how hard the taxi hits".
//
// **Scenery, not an obstacle.** Nothing here is in sim/collisions.js: a box costs the taxi no HP
// and holds up no traffic. What a car does to a box is the other way round — anything that drives
// into one punts it down the road (`punt`), because the alternative is the taxi ghosting through a
// box it just knocked off, which is the one thing a prop in the road must never do.
//
// The load is the flatbed's timber crate (geometry/crate.js), and for the flatbed's reason: a
// kraft-brown box in the road is a courier parcel to collect, and this is not one.
//
// The doors are drawn over the truck rather than cut into it — two leaves and a dark hold riding
// the truck's own instance matrix, the way game/flatbed.js rides its deck — so the truck builders
// in sim/traffic.js do not change. A truck keeps its doors hanging open for the rest of the run.
//
// Integrated per frame, not closed form like the flatbed's crates: a box can come off on an arched
// bridge, where the ground it falls to is a curve, and be punted again after it lands.

// How many come out for a hit, off the closing speed sim/collisions.js prices damage with. A nudge
// is one; a rear-end at Loco cruise (closing ~10.5) is three; a T-bone at cruise (~21) is seven;
// the overdrive band empties the box. EJECT_CLOSING's 18 (game/ejection.js) — the game's own "hard
// hit" — lands at six.
const SPILL_FROM = 2;
const SPILL_PER = 2.6;            // u/s of closing speed per box
const SPILL_MAX = 8;
/** What a truck carries. A second hit takes what the first left; a wreck takes the rest. */
export const TRUCK_LOAD = 10;
export const boxesFor = (closing) =>
  Math.max(1, Math.min(SPILL_MAX, Math.round((closing - SPILL_FROM) / SPILL_PER)));

const POOL = 32;                  // boxes in the world at once — three full spills and change
const DOOR_SLOTS = 6;             // trucks with their doors open at once
const STAGGER = 0.07;             // s between one box and the next, so it pours rather than pops
const FIRST_OUT = 0.06;           // ...and after the doors start to go

// Out the back, in the truck's frame: thrown backwards off the load shifting, and up a little.
const KICK = [2.4, 4.2];          // u/s backwards
const KICK_PER_UNIT = 0.08;       // ...plus this per u/s of closing speed
const POP_VY = [1.4, 3.4];
// Sideways, kept inside the lane for the flatbed's reason (SPREAD in game/flatbed.js): a truck's
// lane centre is 2 off the kerb. Over the river, none — a bridge is a lane wide between railings.
const SPREAD = 0.9;
const SIDE_PUSH = 0.06;           // of a T-bone's closing speed, along the hit, capped:
const SIDE_MAX = 1.2;
const TUMBLE = [5, 10];           // rad/s
const RIVER_MARGIN = 6;

const GRAVITY = 24;
const BOUNCE = 0.32;              // of the speed it lands with, on the one bounce it gets
const BOUNCE_MIN_VY = 3;
const BOUNCE_KEEP = 0.6;          // horizontal speed kept through the bounce
const SKID_DECEL = 11;
const SETTLE = 0.24;

// Lying in the road for a few seconds, then down through the tarmac — the road is opaque and drawn
// first, so whatever is under it fails the depth test for free. Shorter on a bridge, where the
// drawbridge can lift out from under one.
const REST_LIFE = 6;
const REST_LIFE_RIVER = 1.5;
const SINK_TIME = 0.8;

// Punted: off the front of whatever drove into it.
const HIT_Y = 1.5;
const PUNT_MIN_V = 3;
const PUNT_V = 1.15;              // × the car's speed
const PUNT_VY = [2.2, 4];
const PUNT_COOLDOWN = 0.5;

// The doors: a damped spring toward hanging open, kicked by each hit, stopped by the box side.
// Measured from shut: a quarter turn points a leaf straight back, a half turn straight out to the
// side, and three quarters lays it flat along the side of the box, which is as far as it can go.
const DOOR_OPEN = 2.4;            // rad — hanging back and out, swinging between the two
const DOOR_STOP = 4.2;            // two thirds of the way round: past that the hinge side digs into the box
const DOOR_K = 38;
const DOOR_C = 4.5;
const DOOR_KICK = 16;             // rad/s on a hit
const DOOR_KICK_PER_UNIT = 0.35;

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Can this car spill? An ordinary box truck: not the flatbed, not a guest, not a wreck. */
export function spills(car) {
  return !!car && car.isTruck && !car.flatbed && !car.guest && !car.police && !car.isTaxi;
}

/**
 * @param rng     the run's stream for this vignette
 * @param traffic createTraffic's handle — `truckMesh` for the pose the doors ride on
 */
export function createBoxSpill(rng, scene, traffic) {
  const group = new THREE.Group();
  group.name = 'boxspill';
  scene.add(group);

  const landListeners = [];
  const puntListeners = [];
  const emit = (list, event) => { for (const cb of list) cb(event); };

  // Pools built up front, all ordinary propMaterials — the program every prop already linked, so
  // the first ram compiles nothing.
  const boxMesh = skipWhenEmpty(new THREE.InstancedMesh(crateGeometry(), propMaterial(), POOL));
  boxMesh.name = 'spilt-boxes';
  boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boxMesh.frustumCulled = false;   // they go all over the city; see CLAUDE.md on InstancedMesh
  boxMesh.castShadow = true;
  boxMesh.receiveShadow = true;
  group.add(boxMesh);

  const leafMesh = skipWhenEmpty(new THREE.InstancedMesh(doorLeafGeometry(), propMaterial(), DOOR_SLOTS * 2));
  leafMesh.name = 'truck-doors';
  leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  leafMesh.frustumCulled = false;
  leafMesh.castShadow = true;
  leafMesh.receiveShadow = true;
  group.add(leafMesh);

  const holdMesh = skipWhenEmpty(new THREE.InstancedMesh(holdGeometry(), propMaterial(), DOOR_SLOTS));
  holdMesh.name = 'truck-holds';
  holdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  holdMesh.frustumCulled = false;
  holdMesh.receiveShadow = true;
  group.add(holdMesh);

  markOccluder(group);

  const boxes = Array.from({ length: POOL }, () => ({
    phase: 'free',          // free | wait | air | skid | rest | sink
    age: 0, wait: 0, life: REST_LIFE, born: 0,
    from: null,             // the truck it came off, which it cannot be punted by
    spec: null,             // where to come out of, filled at `wait`
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 0, cool: 0,
    axis: new THREE.Vector3(), spin: 0,
    quat: new THREE.Quaternion(), qLand: new THREE.Quaternion(), restYaw: 0,
    sx: 0, sz: 0, dirX: 0, dirZ: 0, skidV: 0, tSkid: 0,
  }));

  const doors = Array.from({ length: DOOR_SLOTS }, () => ({
    car: null,
    // Two leaves, each its own spring so they never move in lockstep.
    leaves: [{ a: 0, w: 0, k: DOOR_K }, { a: 0, w: 0, k: DOOR_K * 1.15 }],
    used: 0,
  }));

  const load = new WeakMap();      // truck → boxes still aboard
  let clock = 0;

  const truckMatrix = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const qTmp = new THREE.Quaternion();
  const qFlip = new THREE.Quaternion().setFromAxisAngle(X_AXIS, Math.PI);
  const one = new THREE.Vector3(1, 1, 1);
  const scl = new THREE.Vector3();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  function overRiver(z) {
    const banks = riverBanks();
    return !!banks && z > banks.z0 - RIVER_MARGIN && z < banks.z1 + RIVER_MARGIN;
  }
  const ground = (x, z) => deckHeightAt(x, z).y;

  /** The truck's drawn pose: its instance matrix while it has one, its sim pose once it hasn't. */
  function poseOf(car, out) {
    if (!car.crashed && traffic.truckMesh && car.instanceIndex != null
      && car.instanceIndex < traffic.truckMesh.count) {
      traffic.truckMesh.getMatrixAt(car.instanceIndex, out);
      // A zeroed instance (a wreck mid-handover) has no frame to ride on.
      if (out.elements[0] !== 0 || out.elements[2] !== 0) return out;
    }
    pos.set(car.x, ground(car.x, car.z), car.z);
    quat.setFromAxisAngle(UP, car.yaw);
    return out.compose(pos, quat, one);
  }

  // --- Doors ----------------------------------------------------------------------

  function doorFor(car) {
    let slot = doors.find((d) => d.car === car);
    if (slot) return slot;
    // A free slot, or the one opened longest ago — its truck shuts its doors, which off in the
    // city somewhere nobody is looking at is the cheaper of the two pops.
    slot = doors.find((d) => !d.car) ?? doors.reduce((a, b) => (a.used <= b.used ? a : b));
    slot.car = car;
    for (const leaf of slot.leaves) { leaf.a = 0; leaf.w = 0; }
    return slot;
  }

  function kickDoors(car, closing) {
    const slot = doorFor(car);
    slot.used = clock;
    for (const leaf of slot.leaves) {
      leaf.w += (DOOR_KICK + closing * DOOR_KICK_PER_UNIT) * rng.range(0.85, 1.15);
    }
  }

  function updateDoors(dt) {
    for (const slot of doors) {
      if (!slot.car) continue;
      // A wrecked truck went to game/wreckage.js as a shell without them; it has no matrix left.
      if (slot.car.crashed) { slot.car = null; continue; }
      for (const leaf of slot.leaves) {
        // Semi-implicit Euler, sub-stepped: the spring is stiff and a dropped frame is not.
        const n = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / n;
        for (let s = 0; s < n; s++) {
          leaf.w += (leaf.k * (DOOR_OPEN - leaf.a) - DOOR_C * leaf.w) * h;
          leaf.a += leaf.w * h;
          if (leaf.a > DOOR_STOP) { leaf.a = DOOR_STOP; leaf.w = -0.35 * Math.abs(leaf.w); }
          if (leaf.a < 0) { leaf.a = 0; leaf.w = 0.3 * Math.abs(leaf.w); }
        }
      }
    }
  }

  // --- Boxes ----------------------------------------------------------------------

  function takeBox() {
    const free = boxes.find((b) => b.phase === 'free');
    if (free) return free;
    // Pool full: the oldest one already lying in the road goes, under whatever is new.
    let oldest = null;
    for (const b of boxes) {
      if ((b.phase === 'rest' || b.phase === 'sink') && (!oldest || b.born < oldest.born)) oldest = b;
    }
    return oldest;
  }

  function queue(car, n, { closing, nx = 0, nz = 0, wreck = false }) {
    for (let k = 0; k < n; k++) {
      const box = takeBox();
      if (!box) return k;
      box.phase = 'wait';
      box.wait = FIRST_OUT + k * STAGGER;
      box.from = car;
      box.born = clock;
      box.spec = { closing, nx, nz, wreck, row: k % 4 };
    }
    return n;
  }

  /** Out through the doors: placed in the truck's frame, handed to the world's. */
  function emerge(box) {
    const car = box.from;
    const { closing, nx, nz, wreck, row } = box.spec;
    poseOf(car, truckMatrix);
    // Two across and two high, the way they'd be stacked at the tail of the hold.
    const across = (row % 2 ? 1 : -1) * (CRATE / 2 + 0.03) + rng.jitter(0.05);
    const up = TRUCK_CHASSIS_TOP + CRATE / 2 + (row >= 2 ? CRATE : 0) + 0.02;
    pos.set(BOX_REAR + CRATE * 0.2, up, across);
    quat.setFromAxisAngle(UP, rng.jitter(0.15));
    local.compose(pos, quat, one);
    m.multiplyMatrices(truckMatrix, local);
    m.decompose(pos, quat, scl);

    const fx = Math.cos(car.yaw);
    const fz = -Math.sin(car.yaw);
    const rx = Math.sin(car.yaw);
    const rz = Math.cos(car.yaw);
    const river = overRiver(pos.z) || overRiver(car.z);
    const back = rng.range(KICK[0], KICK[1]) + closing * KICK_PER_UNIT;
    let side = river ? 0 : rng.jitter(SPREAD);
    // A side hit throws the load away from the taxi, along whatever of the hit is across the truck.
    if (!river) side += Math.max(-SIDE_MAX, Math.min(SIDE_MAX, (nx * rx + nz * rz) * closing * SIDE_PUSH));
    // The truck's own speed comes with it — a rear-ended truck is launched down its lane, and its
    // load falls out behind it rather than standing still in the air.
    const along = Math.max(0, car.v) - back;
    box.x = pos.x; box.y = pos.y; box.z = pos.z;
    box.vx = fx * along + rx * side;
    box.vz = fz * along + rz * side;
    box.vy = rng.range(POP_VY[0], POP_VY[1]) * (wreck ? 1.5 : 1);
    box.quat.copy(quat);
    // End over end backwards, which is the truck's across axis, give or take.
    box.axis.set(rx + rng.jitter(0.3), rng.jitter(0.2), rz + rng.jitter(0.3)).normalize();
    box.spin = rng.range(TUMBLE[0], TUMBLE[1]) * (rng.chance(0.2) ? -1 : 1);
    box.bounces = 1;
    box.cool = 0;
    box.phase = 'air';
    box.age = 0;
  }

  function land(box, g) {
    box.y = g + CRATE_REST_Y;
    const h = Math.hypot(box.vx, box.vz);
    emit(landListeners, { x: box.x, z: box.z, v: h });
    if (box.bounces > 0 && -box.vy > BOUNCE_MIN_VY) {
      box.bounces -= 1;
      box.vy = -box.vy * BOUNCE;
      box.vx *= BOUNCE_KEEP;
      box.vz *= BOUNCE_KEEP;
      box.spin *= 0.5;
      return;
    }
    box.phase = 'skid';
    box.age = 0;
    box.sx = box.x;
    box.sz = box.z;
    box.skidV = h;
    box.dirX = h > 1e-6 ? box.vx / h : 0;
    box.dirZ = h > 1e-6 ? box.vz / h : 0;
    box.tSkid = h / SKID_DECEL;
    box.qLand.copy(box.quat);
    box.restYaw = Math.atan2(-box.dirZ, box.dirX) + rng.jitter(0.6);
    box.life = overRiver(box.z) ? REST_LIFE_RIVER : REST_LIFE;
  }

  function updateBox(box, dt) {
    box.cool = Math.max(0, box.cool - dt);
    if (box.phase === 'wait') {
      box.wait -= dt;
      if (box.wait <= 0) emerge(box);
      return;
    }
    box.age += dt;

    if (box.phase === 'air') {
      box.vy -= GRAVITY * dt;
      box.x += box.vx * dt;
      box.y += box.vy * dt;
      box.z += box.vz * dt;
      qTmp.setFromAxisAngle(box.axis, box.spin * dt);
      box.quat.premultiply(qTmp);
      const g = ground(box.x, box.z);
      if (box.vy < 0 && box.y <= g + CRATE_REST_Y) land(box, g);
      return;
    }

    if (box.phase === 'skid') {
      const t = Math.min(box.age, box.tSkid);
      const d = box.skidV * t - 0.5 * SKID_DECEL * t * t;
      box.x = box.sx + box.dirX * d;
      box.z = box.sz + box.dirZ * d;
      box.y = ground(box.x, box.z) + CRATE_REST_Y;
      // Slerped square onto a face, as the flatbed's crates are: an Euler blend gimbals.
      qTmp.setFromAxisAngle(UP, box.restYaw);
      box.quat.copy(box.qLand).slerp(qTmp, smoothstep(clamp01(box.age / SETTLE)));
      if (box.age >= Math.max(box.tSkid, SETTLE)) {
        box.phase = 'rest';
        box.age = 0;
        box.quat.copy(qTmp);
      }
      return;
    }

    if (box.phase === 'rest') {
      if (box.age >= box.life) { box.phase = 'sink'; box.age = 0; }
      return;
    }

    if (box.phase === 'sink') {
      box.y = ground(box.x, box.z) + CRATE_REST_Y - (CRATE + 0.1) * smoothstep(clamp01(box.age / SINK_TIME));
      if (box.age >= SINK_TIME) { box.phase = 'free'; box.from = null; }
    }
  }

  // --- Punting --------------------------------------------------------------------

  /** Half-extents a car covers, in its own frame. The taxi is drawn 1.18× its sim size. */
  function extents(car) {
    if (car.isTaxi) return [TAXI_TAILPIPE_BACK, CAR_W * 0.59];
    if (car.isTruck) return [TRUCK_LEN / 2, TRUCK_W / 2];
    return [CAR_LEN / 2, CAR_W / 2];
  }

  function touching(box, car) {
    const [hl, hw] = extents(car);
    const dx = box.x - car.x;
    const dz = box.z - car.z;
    const fx = Math.cos(car.yaw);
    const fz = -Math.sin(car.yaw);
    return Math.abs(dx * fx + dz * fz) < hl + CRATE / 2
      && Math.abs(dx * fz - dz * fx) < hw + CRATE / 2;
  }

  function punt(box, car) {
    const dir = Math.sign(car.v) || 1;
    const fx = Math.cos(car.yaw) * dir;
    const fz = -Math.sin(car.yaw) * dir;
    const speed = Math.max(PUNT_MIN_V, Math.abs(car.v) * PUNT_V);
    // Off the bumper and out of the car's way, to whichever side of its line the box already was.
    const side = Math.sign((box.x - car.x) * fz - (box.z - car.z) * fx) || (rng.chance(0.5) ? 1 : -1);
    const spray = overRiver(box.z) ? 0 : side * rng.range(0.5, 2);
    box.vx = fx * speed + fz * spray;
    box.vz = fz * speed - fx * spray;
    box.vy = rng.range(PUNT_VY[0], PUNT_VY[1]) + Math.min(2, Math.abs(car.v) * 0.08);
    box.y = Math.max(box.y, ground(box.x, box.z) + CRATE_REST_Y + 0.01);
    box.axis.set(fz + rng.jitter(0.3), rng.jitter(0.3), -fx + rng.jitter(0.3)).normalize();
    box.spin = rng.range(TUMBLE[0], TUMBLE[1]);
    box.bounces = 1;
    box.cool = PUNT_COOLDOWN;
    box.phase = 'air';
    box.age = 0;
    emit(puntListeners, { x: box.x, z: box.z, yaw: car.yaw, v: car.v, byTaxi: !!car.isTaxi });
  }

  function testPunts(cars) {
    for (const box of boxes) {
      if (box.cool > 0) continue;
      const low = box.phase === 'skid' || box.phase === 'rest' || (box.phase === 'air' && box.y < HIT_Y);
      if (!low) continue;
      for (const car of cars) {
        if (car === box.from || car.crashed) continue;
        if (touching(box, car)) { punt(box, car); break; }
      }
    }
  }

  // --- Drawing --------------------------------------------------------------------

  function write() {
    for (let n = 0; n < POOL; n++) {
      const box = boxes[n];
      if (box.phase === 'free' || box.phase === 'wait') { boxMesh.setMatrixAt(n, ZERO); continue; }
      pos.set(box.x, box.y, box.z);
      m.compose(pos, box.quat, one);
      boxMesh.setMatrixAt(n, m);
    }
    boxMesh.instanceMatrix.needsUpdate = true;

    for (let n = 0; n < DOOR_SLOTS; n++) {
      const slot = doors[n];
      if (!slot.car) {
        leafMesh.setMatrixAt(n * 2, ZERO);
        leafMesh.setMatrixAt(n * 2 + 1, ZERO);
        holdMesh.setMatrixAt(n, ZERO);
        continue;
      }
      poseOf(slot.car, truckMatrix);
      holdMesh.setMatrixAt(n, truckMatrix);
      for (let s = 0; s < 2; s++) {
        // The left leaf hangs off the −Z edge and swings its free edge back and round with a
        // negative turn about Y; the right is the same leaf turned half over about X, so it runs
        // out along −Z, and swings with a positive one. Both open outward, away from the hold.
        const sign = s ? 1 : -1;
        pos.set(BOX_REAR - HINGE_OUT, BOX_MID_Y, sign * (TRUCK_W / 2));
        quat.setFromAxisAngle(UP, sign * slot.leaves[s].a);
        if (s) quat.multiply(qFlip);
        local.compose(pos, quat, one);
        m.multiplyMatrices(truckMatrix, local);
        leafMesh.setMatrixAt(n * 2 + s, m);
      }
    }
    leafMesh.instanceMatrix.needsUpdate = true;
    holdMesh.instanceMatrix.needsUpdate = true;
  }

  write();

  // --- API ------------------------------------------------------------------------

  /**
   * A survivable hit on `car`, from sim/collisions.js's bump. Opens the doors and lets out a share
   * of the load sized off `closing`. Answers how many boxes came out.
   */
  function hit(car, closing, nx = 0, nz = 0) {
    if (!spills(car) || car.crashed) return 0;
    const aboard = load.has(car) ? load.get(car) : TRUCK_LOAD;
    kickDoors(car, closing);
    const n = queue(car, Math.min(aboard, boxesFor(closing)), { closing, nx, nz });
    load.set(car, aboard - n);
    return n;
  }

  /** The hit that wrecked `car`: everything still aboard comes out, thrown by the blast. */
  function wreck(car, closing) {
    if (!spills(car)) return 0;
    const aboard = load.has(car) ? load.get(car) : TRUCK_LOAD;
    const n = queue(car, Math.min(aboard, SPILL_MAX), { closing, wreck: true });
    load.set(car, aboard - n);
    return n;
  }

  /** Call after `traffic.update`, so a truck's instance matrix is this frame's. */
  function update(dt, cars = []) {
    clock += dt;
    updateDoors(dt);
    for (const box of boxes) if (box.phase !== 'free') updateBox(box, dt);
    testPunts(cars);
    write();
  }

  return {
    group,
    boxes,
    doors,
    hit,
    wreck,
    update,
    /** Boxes still aboard `car`. */
    aboard: (car) => (load.has(car) ? load.get(car) : TRUCK_LOAD),
    /** Called with `{ x, z, v }` each time a box hits the road. */
    onLand: (cb) => { landListeners.push(cb); },
    /** Called with `{ x, z, yaw, v, byTaxi }` when a car drives into a box and knocks it on. */
    onPunt: (cb) => { puntListeners.push(cb); },
  };
}
