import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { CAR_LEN, CAR_W, TRUCK_LEN, TRUCK_W, TRUCK_BOX_X } from '../sim/traffic.js';
import { TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';
import { propMaterial } from '../util/geo.js';
import { riverBanks } from '../city/grid.js';
import { markOccluder } from './ssao.js';
import {
  crateGeometry, crateChipGeometry, flatbedDeckGeometry,
  CRATE, CRATE_REST_Y, CRATE_CHIP_REST_Y, DECK_TOP, DECK_REAR,
} from '../geometry/crate.js';

// A flatbed shedding its load. One of the city's box trucks is an open-deck truck stacked with
// timber crates, and some while into the run it starts hitting bumps: it jolts, the load hops,
// and crates slide off the back and tumble into the road. Anything that drives into one smashes
// it — the taxi included, and **the taxi takes no damage**: this module never touches
// sim/collisions.js, and the crates are not in anything it tests. It is scenery you can hit.
//
// **The bumps are not in the road.** The truck is jolted by three render-only fields on the car
// (`jolt`, `joltRoll`, `joltPitch`) that sim/traffic.js adds into the pose it draws and nowhere
// else, so a pothole here cannot move a car's `s`, its following distance or its signal decision.
//
// **The truck is a real ambient truck, claimed rather than spawned.** `car.flatbed` tells
// traffic.js to collapse that instance's cargo box, and the deck and its load are drawn here off
// the same instance matrix — so the flatbed queues, signals and turns exactly as the truck it
// was, and there is no second vehicle to keep in step with the first. It is claimed from the
// start of the run (or the moment the first truck spawns), so a player who notices it has been
// driving round loaded for a while before anything falls off; only the *shedding* is scheduled.
//
// Scheduling is off the difficulty curve, like the roadworks and the flyover: nothing here is
// pressure. One truck, one load, one go.

const SHED_WAIT = [35, 75];    // seconds into the run before the bumps start
const SOON_WAIT = 3;           // ?flatbed=soon, for looking at it without waiting a minute
const CLAIM_RETRY = 2;         // no truck yet — the ramp adds cars as it goes, ask again shortly

// Shedding only happens where it can be seen and where the taxi might meet it. On a phone the
// frame is roughly the taxi's neighbourhood already; on a desktop the whole city is in shot, and
// the range is what keeps the crates from landing somewhere the player is not looking.
const DROP_RANGE = 55;
const MOVING_V = 1.2;          // a truck held at a red is not going over bumps
// Nor on a bridge. Everything below lands crates at road level, and a fixed span arches 1.1 above
// it at the crest — a crate dropped there would rest half buried in the deck. The drawbridge is
// flat, but its leaf lifts, and a crate lying on it would stay hanging in the air where the road
// had been. So nothing is shed anywhere between the banks: tested under the truck and this far
// behind it, which is further than a crate travels before it comes to rest.
//
// The margin takes in the two bank roads as well. Their far kerb *is* the channel wall, and a
// crate thrown SPREAD sideways and then skidding can cross a 2-unit gap to it; one resting in the
// air over the water is the "white speck at the river" class of bug from the other direction.
// 6 clears the half-width of a divided arterial (5.33) with a little over.
const FLAT_BEHIND = 7;
const RIVER_MARGIN = 6;

const BUMP_GAP = [0.9, 2.1];   // seconds between jolts while shedding

// Road the truck covers between one crate going and the next, measured in distance rather than
// jolts. It was a 55% chance per jolt with at most two dry jolts in a row, which shed a crate
// every ~2s — the whole load inside a block and a half, in a heap. At 16–28 units a crate goes
// every one and a half to two and a half blocks (3–5s at truck cruise), so the load is strewn
// down a street or two and the taxi meets them one at a time. The jolts in between still happen;
// most of them just don't shake anything loose.
const DROP_SPACING = [16, 28];

// The jolt: a damped bounce, and the load hops a beat behind the chassis, which is what sells a
// crate as loose rather than bolted on. Amplitudes are in world units / radians; at play zoom
// 0.14 is about a pixel of chassis and two of load.
const JOLT_Y = 0.14;
const JOLT_ROLL = 0.06;
const JOLT_PITCH = 0.05;
const JOLT_W = 21;             // rad/s — about three and a half cycles a second
const JOLT_DECAY = 6.5;
const LOAD_HOP = 0.2;
const LOAD_LAG = 0.05;

// Sliding off. In the truck's frame: a shove backwards off the jolt, then accelerating as the
// deck tips it out, until its centre is past whatever it was resting on.
const SLIDE_KICK = 1.6;
const SLIDE_ACC = 9;

// Falling. Closed form in world space, like every thrown thing in game/.
const GRAVITY = 24;
const POP_VY = [1.2, 2.6];     // the jolt throws it up a little as it goes
// Lateral scatter, so they don't all land in a line. Kept inside the lane: a truck's lane centre
// is 2 off the kerb and a crate is 0.45 from its centre to its side, so 0.9 either way is the
// most that cannot put one half into a raised kerb.
const SPREAD = 0.9;
const TUMBLE = [5, 9];         // rad/s end over end
const SKID_DECEL = 11;
const SETTLE = 0.24;           // seconds to come to rest square on the road after touching down
const LANDING_HOP = 0.3;

// Lying in the road. Long enough for the taxi to come round the block for one; then it sinks
// through the tarmac the way the roadworks leave — the road is opaque and drawn first, so
// whatever is under y = 0 fails the depth test for free.
const REST_LIFE = 22;
const SINK_TIME = 0.9;

// What a car has to be inside of to hit one — a crate rests on its face, so a box test in the
// car's own frame, padded by half a crate. Only crates low enough to reach a bonnet count.
const HIT_Y = 1.5;
const CHIPS_PER = 9;
const CHIP_POOL = 36;
const CHIP_GRAVITY = 30;
const CHIP_SETTLE = 0.35;

const UP = new THREE.Vector3(0, 1, 0);
const ACROSS = new THREE.Vector3(0, 0, 1);   // the truck frame's +Z
const TIP_MAX = 0.5;           // how far a crate has rolled over the edge when it lets go
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

// The stack, in the truck's frame (+X forward). Three pairs on the deck and two on top,
// staggered across the pairs below them. Listed in the order they come off: the top ones first,
// then the bottom row from the tail forward — a crate can only slide off the back once whatever
// was behind it has gone.
// Across: two either side of the centreline with 0.04 between them, which the hand-loaded yaw
// below can eat without two crates meeting or one pushing through a side rail.
const ROW = CRATE / 2 + 0.02;
const PITCH = 1.0;
const X_REAR = TRUCK_BOX_X - PITCH;
const Y_LOW = DECK_TOP + CRATE / 2;
const Y_HIGH = Y_LOW + CRATE;
const SLOTS = [
  { x: X_REAR + PITCH / 2, y: Y_HIGH, z: -ROW, top: true },
  { x: X_REAR + PITCH * 1.5, y: Y_HIGH, z: ROW, top: true },
  { x: X_REAR, y: Y_LOW, z: -ROW },
  { x: X_REAR, y: Y_LOW, z: ROW },
  { x: X_REAR + PITCH, y: Y_LOW, z: ROW },
  { x: X_REAR + PITCH, y: Y_LOW, z: -ROW },
  { x: X_REAR + PITCH * 2, y: Y_LOW, z: -ROW },
  { x: X_REAR + PITCH * 2, y: Y_LOW, z: ROW },
];
export const CRATES = SLOTS.length;
/** How far off square a crate is loaded, either way. Small: the side rails are 0.03 away. */
export const LOAD_YAW = 0.04;

/**
 * @param rng     the run's stream for this vignette
 * @param traffic createTraffic's handle — `trucks` to claim from, `truckMesh` to ride on
 * @param camera  optional; with it, shedding waits for the truck to be in frame
 * @param opts.soon start shedding a few seconds in rather than a minute, and wherever the truck is
 *                  rather than near the taxi (`?flatbed=soon`)
 */
export function createFlatbed(rng, scene, traffic, camera = null, { soon = false } = {}) {
  const group = new THREE.Group();
  group.name = 'flatbed';
  scene.add(group);

  const smashListeners = [];
  const landListeners = [];
  const emit = (list, event) => { for (const cb of list) cb(event); };

  // Built up front, for the reason every pool in game/ is: the frame a truck is claimed and the
  // frame a crate is smashed are both frames where compiling a material would show. All three
  // are ordinary propMaterials, so they share the program every prop in the city already linked.
  const deck = new THREE.Mesh(flatbedDeckGeometry(), propMaterial());
  deck.name = 'flatbed-deck';
  deck.matrixAutoUpdate = false;
  deck.castShadow = true;
  deck.receiveShadow = true;
  deck.visible = false;
  group.add(deck);

  const crateMesh = new THREE.InstancedMesh(crateGeometry(), propMaterial(), CRATES);
  crateMesh.name = 'flatbed-crates';
  crateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // It drives round the whole city, and three latches an InstancedMesh's bounding sphere once.
  crateMesh.frustumCulled = false;
  crateMesh.castShadow = true;
  crateMesh.receiveShadow = true;
  group.add(crateMesh);

  const chipMesh = skipWhenEmpty(new THREE.InstancedMesh(crateChipGeometry(), propMaterial(), CHIP_POOL));
  chipMesh.name = 'flatbed-chips';
  chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chipMesh.frustumCulled = false;
  chipMesh.castShadow = true;
  group.add(chipMesh);

  markOccluder(group);

  const state = {
    phase: 'unclaimed',     // unclaimed | loaded | shedding | empty
    t: 0,                   // seconds since construction
    claimIn: 0,
    shedAt: soon ? SOON_WAIT : rng.range(SHED_WAIT[0], SHED_WAIT[1]),
    bumpIn: 0,
    bumpAt: -Infinity,
    bumpRoll: 1,
    rolled: 0,              // road covered since the last crate went, while shedding is live
    spacing: 0,             // ...and how much it has to be before the next one does (0: first)
    next: 0,                // index into SLOTS of the next crate to go
    truck: null,
  };

  const crates = SLOTS.map((slot) => ({
    slot,
    phase: 'deck',          // deck | slide | air | skid | rest | sink | smashed
    yaw: rng.jitter(LOAD_YAW),  // loaded by hand, not by a machine
    wobble: rng.range(0, Math.PI * 2),
    age: 0,
    // slide, in the truck frame
    lx: slot.x, edge: 0,
    // flight and skid, in the world
    x: 0, y: 0, z: 0, x0: 0, y0: 0, z0: 0,
    vx: 0, vy: 0, vz: 0, tAir: 0,
    dirX: 0, dirZ: 0, skidV: 0, tSkid: 0, sx: 0, sz: 0,
    spinAxis: new THREE.Vector3(), spin: 0,
    q0: new THREE.Quaternion(), quat: new THREE.Quaternion(), qLand: new THREE.Quaternion(),
    restYaw: 0,
  }));

  const chips = Array.from({ length: CHIP_POOL }, () => ({
    live: false, age: 0, dur: 1,
    x0: 0, y0: 0, z0: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    spin: 0, axis: new THREE.Vector3(), restYaw: 0, quat: new THREE.Quaternion(),
  }));

  const truckMatrix = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const dummy = new THREE.Object3D();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const qTmp = new THREE.Quaternion();
  const qRest = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  // --- The truck ----------------------------------------------------------------

  /** Is this point outside the frame? Same recipe as game/roadwork.js's `offScreen`. */
  function offScreen(x, z) {
    if (!camera) return false;
    const v = new THREE.Vector3(x, 1, z).project(camera);
    return Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
  }

  function usable(car) {
    return car && car.isTruck && !car.crashed && !car.isTaxi && !car.police;
  }

  /**
   * Take one of the city's trucks. An off-screen one where there is a choice, since the box
   * vanishing and a stack of crates appearing in its place is a pop; the city is at its busiest
   * just after the entrance, which is when this first runs, so a pop there is lost in it anyway.
   */
  function claim() {
    const pool = (traffic.trucks ?? []).filter(usable);
    if (!pool.length) return false;
    const hidden = pool.filter((car) => offScreen(car.x, car.z));
    const truck = rng.pick(hidden.length ? hidden : pool);
    truck.flatbed = true;
    state.truck = truck;
    state.phase = 'loaded';
    deck.visible = true;
    return true;
  }

  /** Are the truck, and the road behind it where the crates will land, clear of the river? */
  function onFlat(truck) {
    const banks = riverBanks();
    if (!banks) return true;
    const bz = truck.z + Math.sin(truck.yaw) * FLAT_BEHIND;
    const over = (z) => z > banks.z0 - RIVER_MARGIN && z < banks.z1 + RIVER_MARGIN;
    return !over(truck.z) && !over(bz);
  }

  function readTruck() {
    traffic.truckMesh.getMatrixAt(state.truck.instanceIndex, truckMatrix);
  }

  // --- Jolts ----------------------------------------------------------------------

  function joltAt(age) {
    if (age < 0 || age > 1.2) return 0;
    return Math.exp(-JOLT_DECAY * age) * Math.sin(JOLT_W * age);
  }

  function bump() {
    state.bumpAt = state.t;
    state.bumpRoll = rng.chance(0.5) ? 1 : -1;
    if (state.rolled >= state.spacing && state.next < crates.length) {
      startSlide(crates[state.next]);
      state.next += 1;
      state.rolled = 0;
      state.spacing = rng.range(DROP_SPACING[0], DROP_SPACING[1]);
    }
  }

  function writeJolt(truck) {
    const a = joltAt(state.t - state.bumpAt);
    // Up first (sin starts rising), then down through the rest position and back — a wheel
    // going over a lip and the springs answering.
    truck.jolt = Math.max(-0.4 * JOLT_Y, JOLT_Y * a);
    truck.joltRoll = JOLT_ROLL * state.bumpRoll * joltAt(state.t - state.bumpAt - 0.03);
    truck.joltPitch = JOLT_PITCH * joltAt(state.t - state.bumpAt - 0.06);
  }

  // --- The load -------------------------------------------------------------------

  /** Where a crate's slide ends: past the rear face of whatever is holding it up. */
  function slideEdge(crate) {
    if (!crate.slot.top) return DECK_REAR;
    // A top crate is carried by the bottom row, and the rear pair always outlasts it (see SLOTS).
    return X_REAR - CRATE / 2;
  }

  function startSlide(crate) {
    crate.phase = 'slide';
    crate.age = 0;
    crate.lx = crate.slot.x;
    crate.edge = slideEdge(crate);
  }

  /** Lift of the load off the deck at this instant: the chassis's jolt, late and larger. */
  function loadHop(crate) {
    const a = joltAt(state.t - state.bumpAt - LOAD_LAG);
    return Math.max(0, LOAD_HOP * a) * (0.8 + 0.4 * Math.sin(crate.wobble));
  }

  function composeOnDeck(crate, lx, extraY, tip) {
    pos.set(lx, crate.slot.y + extraY, crate.slot.z);
    quat.setFromAxisAngle(UP, crate.yaw);
    if (tip) {
      // Tipping backwards over the edge: the rear (-X) face goes down, which is a positive turn
      // about the truck's across axis.
      qTmp.setFromAxisAngle(ACROSS, tip);
      quat.premultiply(qTmp);
    }
    local.compose(pos, quat, one);
    world.multiplyMatrices(truckMatrix, local);
    return world;
  }

  /** How far over the edge a sliding crate has rolled: nothing until its centre is near it. */
  function tipFor(crate) {
    return TIP_MAX * clamp01(1 - (crate.lx - crate.edge) / (CRATE * 0.6));
  }

  /**
   * Off the back: hand the crate from the truck's frame to the world's, keeping its velocity and
   * the tip it had already started — a crate that levelled out on the frame it let go would snap.
   */
  function detach(crate, truck) {
    const m = composeOnDeck(crate, crate.lx, 0, tipFor(crate));
    m.decompose(pos, quat, dummy.scale);
    const fx = Math.cos(truck.yaw);
    const fz = -Math.sin(truck.yaw);
    const rx = Math.sin(truck.yaw);
    const rz = Math.cos(truck.yaw);
    // The truck's own speed, less how fast the crate was sliding back along the deck. At truck
    // cruise (~5.5) that is a little forward or a little back — it lands behind the truck because
    // the truck drives on, which is what "fell off the back" looks like from above.
    const along = truck.v - (SLIDE_KICK + SLIDE_ACC * crate.age);
    const side = rng.jitter(SPREAD);
    crate.x0 = pos.x; crate.y0 = pos.y; crate.z0 = pos.z;
    crate.x = pos.x; crate.y = pos.y; crate.z = pos.z;
    crate.vx = fx * along + rx * side;
    crate.vz = fz * along + rz * side;
    crate.vy = rng.range(POP_VY[0], POP_VY[1]);
    crate.q0.copy(quat);
    // Carrying on the roll it started over the edge: the truck's across axis (its local +Z, which
    // is (rx, rz) in the world), turning the same way the tip did.
    crate.spinAxis.set(rx, 0, rz).normalize();
    crate.spin = rng.range(TUMBLE[0], TUMBLE[1]);
    // Time to meet the road, from the same quadratic the position uses.
    const drop = crate.y0 - CRATE_REST_Y;
    crate.tAir = (crate.vy + Math.sqrt(crate.vy * crate.vy + 2 * GRAVITY * drop)) / GRAVITY;
    crate.restYaw = truck.yaw + rng.range(-0.7, 0.7);
    crate.phase = 'air';
    crate.age = 0;
  }

  function land(crate) {
    crate.phase = 'skid';
    crate.age = 0;
    crate.sx = crate.x;
    crate.sz = crate.z;
    const h = Math.hypot(crate.vx, crate.vz);
    crate.skidV = h;
    crate.dirX = h > 1e-6 ? crate.vx / h : 0;
    crate.dirZ = h > 1e-6 ? crate.vz / h : 0;
    crate.tSkid = h / SKID_DECEL;
    crate.qLand.copy(crate.quat);
    emit(landListeners, { x: crate.x, z: crate.z, v: h });
  }

  function updateCrate(crate, dt, truck) {
    crate.age += dt;
    const age = crate.age;

    if (crate.phase === 'slide') {
      if (!truck) { crate.phase = 'smashed'; return; }
      crate.lx = crate.slot.x - (SLIDE_KICK * age + 0.5 * SLIDE_ACC * age * age);
      if (crate.lx < crate.edge) detach(crate, truck);
      return;
    }

    if (crate.phase === 'air') {
      crate.x = crate.x0 + crate.vx * age;
      crate.z = crate.z0 + crate.vz * age;
      crate.y = crate.y0 + crate.vy * age - 0.5 * GRAVITY * age * age;
      qTmp.setFromAxisAngle(crate.spinAxis, crate.spin * age);
      crate.quat.copy(crate.q0).premultiply(qTmp);
      if (age >= crate.tAir) {
        crate.y = CRATE_REST_Y;
        land(crate);
      }
      return;
    }

    if (crate.phase === 'skid') {
      const t = Math.min(age, crate.tSkid);
      const d = crate.skidV * t - 0.5 * SKID_DECEL * t * t;
      crate.x = crate.sx + crate.dirX * d;
      crate.z = crate.sz + crate.dirZ * d;
      // One small bounce off the first corner to touch, then flat.
      crate.y = CRATE_REST_Y + LANDING_HOP * Math.max(0, Math.sin(Math.PI * age / SETTLE)) * (age < SETTLE ? 1 : 0);
      // Slerped square onto a face rather than blended in Euler, the cones' reason: a blend
      // gimbals through the flat pose and snaps in the last frame.
      qRest.setFromAxisAngle(UP, crate.restYaw);
      crate.quat.copy(crate.qLand).slerp(qRest, smoothstep(clamp01(age / SETTLE)));
      if (age >= Math.max(crate.tSkid, SETTLE)) {
        crate.phase = 'rest';
        crate.age = 0;
        crate.y = CRATE_REST_Y;
        crate.quat.copy(qRest);
      }
      return;
    }

    if (crate.phase === 'rest') {
      if (age >= REST_LIFE) { crate.phase = 'sink'; crate.age = 0; }
      return;
    }

    if (crate.phase === 'sink') {
      crate.y = CRATE_REST_Y - (CRATE + 0.1) * smoothstep(clamp01(age / SINK_TIME));
      if (age >= SINK_TIME) crate.phase = 'gone';
    }
  }

  // --- Smashing -------------------------------------------------------------------

  /** Half-extents a car covers, in its own frame. The taxi is drawn 1.18× its sim size. */
  function extents(car) {
    if (car.isTaxi) return [TAXI_TAILPIPE_BACK, CAR_W * 0.59];
    if (car.isTruck) return [TRUCK_LEN / 2, TRUCK_W / 2];
    return [CAR_LEN / 2, CAR_W / 2];
  }

  function hitBy(crate, car) {
    const [hl, hw] = extents(car);
    const dx = crate.x - car.x;
    const dz = crate.z - car.z;
    const fx = Math.cos(car.yaw);
    const fz = -Math.sin(car.yaw);
    const along = dx * fx + dz * fz;
    const across = dx * fz - dz * fx;
    return Math.abs(along) < hl + CRATE / 2 && Math.abs(across) < hw + CRATE / 2;
  }

  function smash(crate, car) {
    crate.phase = 'smashed';
    const speed = Math.max(Math.abs(car.v), 3);
    const fx = Math.cos(car.yaw) * Math.sign(car.v || 1);
    const fz = -Math.sin(car.yaw) * Math.sign(car.v || 1);
    let spawned = 0;
    for (const chip of chips) {
      if (spawned >= CHIPS_PER) break;
      if (chip.live && chip.age < chip.dur) continue;
      spawned += 1;
      chip.live = true;
      chip.age = 0;
      chip.x0 = crate.x + rng.jitter(0.35);
      chip.z0 = crate.z + rng.jitter(0.35);
      chip.y0 = Math.max(0.2, crate.y + rng.jitter(0.3));
      // Mostly the way the car was going, some spray to the sides — the trestle's splinters'
      // reasoning: what sends wood down the street is the car.
      const ahead = rng.range(0.4, 1) * (2 + speed * 0.45);
      const spray = rng.range(-3.8, 3.8);
      chip.vx = fx * ahead + fz * spray;
      chip.vz = fz * ahead - fx * spray;
      chip.vy = rng.range(3, 7.5);
      chip.dur = (chip.vy + Math.sqrt(chip.vy * chip.vy
        + 2 * CHIP_GRAVITY * (chip.y0 - CRATE_CHIP_REST_Y))) / CHIP_GRAVITY;
      chip.spin = rng.range(14, 30) * (rng.chance(0.5) ? 1 : -1);
      chip.axis.set(rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)).normalize();
      chip.restYaw = rng.range(0, Math.PI * 2);
    }
    emit(smashListeners, { x: crate.x, z: crate.z, yaw: car.yaw, v: car.v, byTaxi: !!car.isTaxi });
  }

  function testHits(cars) {
    for (const crate of crates) {
      const loose = crate.phase === 'skid' || crate.phase === 'rest'
        || (crate.phase === 'air' && crate.y < HIT_Y);
      if (!loose) continue;
      for (const car of cars) {
        if (car === state.truck || car.crashed) continue;
        if (hitBy(crate, car)) { smash(crate, car); break; }
      }
    }
  }

  function updateChips(dt) {
    let live = 0;
    for (const chip of chips) {
      if (!chip.live) continue;
      live += 1;
      if (chip.age >= chip.dur) continue;
      chip.age = Math.min(chip.dur, chip.age + dt);
      const age = chip.age;
      chip.x = chip.x0 + chip.vx * age;
      chip.z = chip.z0 + chip.vz * age;
      // Snapped on the last frame rather than left to the quadratic, which lands a few ulps
      // above the rest height and leaves a chip hovering by exactly that much.
      chip.y = age >= chip.dur ? CRATE_CHIP_REST_Y : Math.max(CRATE_CHIP_REST_Y,
        chip.y0 + chip.vy * age - 0.5 * CHIP_GRAVITY * age * age);
      chip.quat.setFromAxisAngle(chip.axis, chip.spin * age);
      const settle = clamp01((age / chip.dur - (1 - CHIP_SETTLE)) / CHIP_SETTLE);
      if (settle > 0) {
        qRest.setFromAxisAngle(UP, chip.restYaw);
        chip.quat.slerp(qRest, smoothstep(settle));
      }
    }
    return live;
  }

  // --- Drawing --------------------------------------------------------------------

  function write(truck) {
    for (let n = 0; n < crates.length; n++) {
      const crate = crates[n];
      if (crate.phase === 'deck' || crate.phase === 'slide') {
        if (!truck) { crateMesh.setMatrixAt(n, ZERO); continue; }
        const onDeck = crate.phase === 'deck';
        const lx = onDeck ? crate.slot.x : crate.lx;
        // Tips a little as its centre nears the edge it is going over.
        const tip = onDeck ? 0 : tipFor(crate);
        crateMesh.setMatrixAt(n, composeOnDeck(crate, lx, loadHop(crate), tip));
        continue;
      }
      if (crate.phase === 'smashed' || crate.phase === 'gone') {
        crateMesh.setMatrixAt(n, ZERO);
        continue;
      }
      dummy.position.set(crate.x, crate.y, crate.z);
      dummy.quaternion.copy(crate.quat);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      crateMesh.setMatrixAt(n, dummy.matrix);
    }
    crateMesh.instanceMatrix.needsUpdate = true;

    for (let n = 0; n < chips.length; n++) {
      const chip = chips[n];
      if (!chip.live) { chipMesh.setMatrixAt(n, ZERO); continue; }
      dummy.position.set(chip.x, chip.y, chip.z);
      dummy.quaternion.copy(chip.quat);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      chipMesh.setMatrixAt(n, dummy.matrix);
    }
    chipMesh.instanceMatrix.needsUpdate = true;
  }

  // Dormant until claimed: every slot collapsed, so nothing sits at the origin.
  write(null);

  // --- Per frame ------------------------------------------------------------------

  /**
   * Call after `traffic.update`, so the truck's instance matrix is this frame's. The jolt written
   * here is drawn on the next one — a frame's lag on a bump nobody can see the cause of.
   */
  function update(dt, taxi, cars) {
    state.t += dt;

    if (state.phase === 'unclaimed') {
      state.claimIn -= dt;
      if (state.claimIn <= 0 && !claim()) state.claimIn = CLAIM_RETRY;
      return;
    }

    let truck = state.truck;
    if (truck && truck.crashed) {
      // Wrecked: the shell has gone to game/wreckage.js and the instance to zero scale, so there
      // is no matrix left to ride on. What is still on it goes with it.
      deck.visible = false;
      truck.jolt = truck.joltRoll = truck.joltPitch = 0;
      state.truck = null;
      truck = null;
      if (state.phase !== 'empty') state.phase = 'empty';
    }

    if (truck) {
      readTruck();
      deck.matrix.copy(truckMatrix);
      deck.matrixWorldNeedsUpdate = true;
    }

    if (truck && state.phase === 'loaded' && state.t >= state.shedAt) {
      state.phase = 'shedding';
      state.bumpIn = 0;
    }

    if (truck && state.phase === 'shedding') {
      // `soon` is for looking at the thing, so it sheds wherever the truck is.
      const near = soon || Math.hypot(truck.x - taxi.x, truck.z - taxi.z) <= DROP_RANGE;
      const rolling = Math.abs(truck.v) > MOVING_V && !truck.crashed;
      if (rolling && near && onFlat(truck) && !offScreen(truck.x, truck.z)) {
        // Only road covered where a drop could happen counts, so a stretch spent off screen or
        // over the river does not bank a crate to drop the instant the truck comes back.
        state.rolled += Math.abs(truck.v) * dt;
        state.bumpIn -= dt;
        if (state.bumpIn <= 0) {
          bump();
          state.bumpIn = rng.range(BUMP_GAP[0], BUMP_GAP[1]);
        }
      }
      if (state.next >= crates.length) state.phase = 'empty';
    }

    if (truck) writeJolt(truck);

    for (const crate of crates) {
      if (crate.phase === 'deck' || crate.phase === 'smashed' || crate.phase === 'gone') continue;
      updateCrate(crate, dt, truck);
    }
    testHits(cars);
    updateChips(dt);
    write(truck);
  }

  /**
   * Start the shedding now rather than at its scheduled time — for shot mode and the probe, the
   * same reason `roadwork.place()` is public. Claims a truck first if it has not got one.
   */
  function stage() {
    if (state.phase === 'unclaimed' && !claim()) return false;
    if (state.phase === 'loaded') state.shedAt = state.t;
    return true;
  }

  return {
    group,
    state,
    crates,
    chips,
    update,
    stage,
    /** Crates still on the truck. */
    loaded: () => crates.filter((c) => c.phase === 'deck').length,
    /** Crates lying in the road right now, smashable. */
    loose: () => crates.filter((c) => c.phase === 'skid' || c.phase === 'rest').length,
    smashed: () => crates.filter((c) => c.phase === 'smashed').length,
    /** Called with `{ x, z, yaw, v, byTaxi }` when anything drives into a crate. */
    onSmash: (cb) => { smashListeners.push(cb); },
    /** Called with `{ x, z, v }` when a crate hits the road. */
    onLand: (cb) => { landListeners.push(cb); },
  };
}
