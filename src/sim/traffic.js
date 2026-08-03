import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { KERB_H } from '../city/ground.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import {
  GRID, PITCH, HALF_ROAD, LANE, lineCoord, isXAxis, dirSign, dirYaw, leftOf, rightOf, opposite,
  laneOffsetCoord, entryPoint, exitPoint, turnControl, nextIntersection, legalExits, isSegmentClosed,
  ringAxisAt, isUnsignalised,
} from '../city/grid.js';

export { ringAxisAt, isUnsignalised };   // re-exported: callers of the sim ask it about junctions

// --- Signals ----------------------------------------------------------------

// Signal timing.
//
// The original scheme was `phaseOffset = ((i + j) % 4) * (CYCLE / 4)` on a 16.2s cycle, which
// measured out as: four distinct timings across all 36 junctions, half the city flipping within
// the same half-second, and green-on-arrival at exactly 50% — i.e. pure chance, no coordination
// whatsoever. It waved along the *diagonal*, which looks synchronised while helping no road.
//
// Three things replace it:
//   - offsets derived from travel time, so a platoon meets consecutive greens (a real green wave)
//   - a longer cycle, so the city stops blinking and proportionally less time is lost to yellow
//   - arterials, which take a larger share of green and give the map a fast/slow grain to learn
//
// Cycle length stays common across the city on purpose: shared cycle length is the precondition
// for coordination. Variety comes from splits and offsets instead.

const SPEED = 8.5;

// Forward distance the boosting taxi takes to cross the one lane width out to the centreline.
// 9 units on a 20-unit pitch: under half a block, so the manoeuvre finishes well before the next
// junction, and the implied steering angle — atan(LANE / this) — stays a believable 13°.
const LANE_CHANGE_LEN = 9;

const SIGNAL = {
  // 16s, not the 28s first tried. A sweep of cycle length against throughput came back monotonic
  // — 14s gave 3.80 units/s per car, 28s gave 2.36 — because with sparse, randomly-turning
  // traffic a long cycle costs every car waiting time and the wave can only repay some of it.
  // The calm comes from spreading the offsets, not from slowing the cycle down.
  cycle: 16,
  yellow: 1.6,
  arterialShare: 0.64,          // green share for an arterial where it meets a side street
  arterialX: new Set(),         // j values: roads running along X
  arterialZ: new Set(),         // i values: roads running along Z
  dirX: new Map(),              // j -> +1 / -1, the coordinated direction of travel
  dirZ: new Map(),
};

export function configureSignals(config) {
  Object.assign(SIGNAL, config);
}

export const signalCycle = () => SIGNAL.cycle;

/**
 * Road hierarchy of the edge you get by leaving (i, j) in direction d.
 *
 * 'ring'     — outermost road, unsignalised except at the four corners
 * 'arterial' — one of the two main streets: 64% green share, offsets timed for the wave
 * 'side'     — everything else
 *
 * `withWave` matters only for arterials: an arterial's offsets are computed with a
 * coordinated travel direction; traversing it that way meets consecutive greens, the other
 * way meets consecutive reds. For a side street the concept doesn't apply.
 */
export function edgeClass(i, j, d) {
  const axisIsX = isXAxis(d);
  const line = axisIsX ? j : i;
  const onOuter = line === 0 || line === GRID;
  if (onOuter) return { kind: 'ring', withWave: true };

  const arterialSet = axisIsX ? SIGNAL.arterialX : SIGNAL.arterialZ;
  if (arterialSet.has(line)) {
    const coordinated = (axisIsX ? SIGNAL.dirX : SIGNAL.dirZ).get(line) ?? 1;
    return { kind: 'arterial', withWave: dirSign(d) === Math.sign(coordinated) };
  }
  return { kind: 'side', withWave: false };
}

/** Seconds a platoon takes to cover one block at cruising speed — the basis of every offset. */
const blockTime = () => PITCH / SPEED;

/** How much clear road a joining car needs before pulling out in front of ring traffic. */
const RING_YIELD = 24;

/**
 * Clearance a car needs before turning right on a red.
 *
 * Shorter than the ring's, because the conflict is smaller: a right turn merges into the near
 * lane of the cross street rather than crossing it. The landing itself is still governed by the
 * usual don't-block-the-box check further down.
 */
const RIGHT_ON_RED_YIELD = 15;

/**
 * How far back from the junction boundary a car actually holds.
 *
 * Cars used to stop with their *centre* on the boundary, putting the nose 1.7 units inside the
 * junction and squarely across the crosswalk. The outer crosswalk bar sits 5.65 from the junction
 * centre, so the centre has to hold at ~7.35 for the nose to clear it.
 */
const STOP_SETBACK = 3.4;

// --- Priority corridor ------------------------------------------------------
//
// An emergency vehicle holds every signal along its road green and every crossing road red. It is
// applied here, inside lightPhase, rather than anywhere near the vehicles: `canProceed` is the one
// place any car asks "may I enter?", so overriding the phase makes the whole city react correctly
// — corridor traffic flows, cross traffic stops — without touching the car logic at all.
let corridor = null;   // { axis: 'x' | 'z', line: number }

export function setPriorityCorridor(next) {
  corridor = next;
}

export const getPriorityCorridor = () => corridor;

// A single junction held green for one axis. Used by the boosting taxi: rather than running the
// red — which would drive it through cross traffic that has a legitimate green, and this game has
// no collision resolution at all — the junction ahead simply yields. Same outcome for the player,
// nothing overlaps.
let priorityJunction = null;

export function setPriorityJunction(next) {
  priorityJunction = next;
}

/** Whether a live corridor passes through this junction. */
export const corridorCovers = (i, j) =>
  Boolean(corridor) && (corridor.axis === 'x' ? j === corridor.line : i === corridor.line);

/**
 * Signal state at an intersection. `axis` is the axis currently permitted to move; yellow is
 * treated as stop, which keeps the rule "may I enter?" a single boolean everywhere else.
 */
export function lightPhase(i, j, t) {
  if (priorityJunction && priorityJunction.i === i && priorityJunction.j === j) {
    return { axis: priorityJunction.axis, yellow: false, remaining: Infinity };
  }

  // A siren outranks everything, including the ring — otherwise a corridor crossing the ring
  // would leave a gap in the middle of the green path it is supposed to be clearing.
  if (corridorCovers(i, j)) return { axis: corridor.axis, yellow: false, remaining: Infinity };

  // Otherwise, unsignalised ring junctions have no phase to report: the ring simply has priority.
  const ring = ringAxisAt(i, j);
  if (ring) return { axis: ring, yellow: false, remaining: Infinity };

  const { cycle, yellow, arterialShare } = SIGNAL;
  const xArterial = SIGNAL.arterialX.has(j);
  const zArterial = SIGNAL.arterialZ.has(i);

  // Split: an arterial crossing a side street takes the larger share. Arterial-meets-arterial and
  // side-meets-side both fall back to an even split.
  let xShare = 0.5;
  if (xArterial && !zArterial) xShare = arterialShare;
  else if (zArterial && !xArterial) xShare = 1 - arterialShare;

  const totalGreen = cycle - 2 * yellow;
  const greenX = totalGreen * xShare;
  const greenZ = totalGreen - greenX;

  // Offset: shift this junction's green earlier by the time a platoon takes to reach it, so the
  // wave travels with the traffic. Each junction coordinates with whichever road through it
  // matters more; a junction of two side streets defaults to coordinating along X.
  const alongX = xArterial || !zArterial;
  const step = blockTime();

  let offset;
  if (alongX) {
    const blocks = (SIGNAL.dirX.get(j) ?? 1) > 0 ? i : GRID - i;
    offset = -blocks * step;
  } else {
    const blocks = (SIGNAL.dirZ.get(i) ?? 1) > 0 ? j : GRID - j;
    // The Z green starts partway through the cycle, so the wave has to line up with that instead.
    offset = greenX + yellow - blocks * step;
  }

  const local = (((t + offset) % cycle) + cycle) % cycle;
  if (local < greenX) return { axis: 'x', yellow: false, remaining: greenX - local };
  if (local < greenX + yellow) return { axis: 'x', yellow: true, remaining: greenX + yellow - local };
  if (local < greenX + yellow + greenZ) {
    return { axis: 'z', yellow: false, remaining: greenX + yellow + greenZ - local };
  }
  return { axis: 'z', yellow: true, remaining: cycle - local };
}

const canProceed = (d, i, j, t) => {
  const phase = lightPhase(i, j, t);
  return phase.axis === (isXAxis(d) ? 'x' : 'z') && !phase.yellow;
};

/**
 * The taxi runs yellows. A yellow on the taxi's axis stops being a hard "no": it becomes
 * "yes if we can still clear the junction before it goes red." That is what a real driver
 * does when they have already committed, and it is why running a yellow does not feel like
 * running a red — cross traffic still has their own yellow buffer before they start moving.
 *
 * Ambient traffic keeps stopping on yellow, so the streets don't turn into a demolition derby.
 * "Clear" here means the front of the car is past the far edge of the junction; that is the
 * point past which cross traffic on their fresh green no longer has to weave. Half a yellow
 * length of slack on top, because the taxi is aggressive by design and cross cars have to
 * launch from standing anyway.
 */
function taxiClearsYellow(car, distToLine, t) {
  if (!car.isTaxi) return false;
  const phase = lightPhase(car.i, car.j, t);
  if (!phase.yellow || phase.axis !== (isXAxis(car.d) ? 'x' : 'z')) return false;
  const clearDist = Math.max(0, distToLine) + STOP_SETBACK + HALF_ROAD * 2;
  // A near-stopped taxi still commits: without this floor a car that just crept up to the line
  // would refuse to move even with the whole yellow left to use.
  const v = Math.max(car.v, SPEED * 0.7);
  return clearDist / v <= phase.remaining + SIGNAL.yellow * 0.5;
}

// --- Cars -------------------------------------------------------------------

export const CAR_LEN = 3.4;
export const CAR_W = 1.7;
const MIN_GAP = CAR_LEN + 1.9;   // centre-to-centre
const YIELD_RANGE = 15;          // how far ahead oncoming traffic blocks a left turn
const TURN_WEIGHTS = [0.62, 0.24, 0.14]; // straight, right, left

// Cars used to teleport between full speed and stopped. These give them mass: they ease away
// from a green and, more importantly, *anticipate* — a car reads the signal ahead and sheds speed
// over the approach instead of arriving at 8.5 and stopping dead on the line.
const ACCEL = 6;              // units/s^2 pulling away

// Boost tuning. The first pass only raised the speed *cap*, which barely registered: at 6 u/s^2 a
// car needs 24 units to reach 17 u/s, and junctions are 20 apart, so it never actually got there.
// Punch comes from the acceleration, not the ceiling.
const BOOST_SPEED = 2.2;      // multiplier on top speed
const BOOST_ACCEL = 24;       // reaches full boost speed in well under a block
const BOOST_KICK = 1.25;      // instant surge on activation, so the press has a feel
const BRAKE = 11;             // units/s^2 shedding speed; ~3.3 units to stop from cruise
const CORNER_SPEED = SPEED * 0.7;
export const WHEEL_R = 0.32;
// Vehicles previously rode at KERB_H + 0.05, floating 0.4 above the tarmac — invisible without
// wheels, glaring with them. They now sit just clear of the road markings.
export const ROAD_Y = 0.04;

/**
 * Wheels for a vehicle whose origin sits on the road surface.
 *
 * Baked dark rather than white: the shared material reads vertex colours and instanceColor
 * multiplies on top, so a dark base stays dark whatever colour the car is tinted.
 */
export function wheelGeometries(len = CAR_LEN, width = CAR_W) {
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.26, 8);
      wheel.rotateX(Math.PI / 2);   // axle across the car
      wheel.translate(sx * (len * 0.3), WHEEL_R, sz * (width / 2 - 0.02));
      out.push(bakeColor(wheel, new THREE.Color(0.16, 0.16, 0.18)));
    }
  }
  return out;
}

function carGeometry() {
  // Body is left white so the per-instance colour tints it; the glass is dark enough that the
  // same multiply leaves it dark whatever colour the car is.
  const parts = [];

  // Body sits clear of the wheels so they actually show below the sill.
  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78, 0);
  parts.push(bakeColor(body, new THREE.Color(1, 1, 1)));

  const cabin = new THREE.BoxGeometry(CAR_LEN * 0.5, 0.6, CAR_W * 0.86);
  cabin.translate(-0.2, 1.45, 0);
  parts.push(bakeColor(cabin, color('carGlass')));

  parts.push(...wheelGeometries());

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Coordinate along the travel axis for a point. */
const along = (d, p) => (isXAxis(d) ? p.x : p.z);

function spawnCars(rng, count) {
  const cars = [];
  const attempts = count * 12;

  for (let n = 0; n < attempts && cars.length < count; n++) {
    const d = rng.int(0, 3);
    const line = rng.int(0, GRID);   // the road the car drives along
    const seg = rng.int(0, GRID - 1); // which gap between intersections

    // That stretch of road may have been built over by a park district.
    if (isXAxis(d) ? isSegmentClosed(seg, line, 0) : isSegmentClosed(line, seg, 1)) continue;

    const lo = lineCoord(seg) + HALF_ROAD;
    const hi = lineCoord(seg + 1) - HALF_ROAD;
    const s = rng.range(lo + 0.5, hi - 0.5);

    // Target intersection is whichever end of the segment the car is heading for.
    const targetIndex = dirSign(d) > 0 ? seg + 1 : seg;
    const i = isXAxis(d) ? targetIndex : line;
    const j = isXAxis(d) ? line : targetIndex;

    const laneKey = isXAxis(d) ? `x|${d}|${j}` : `z|${d}|${i}`;
    const clash = cars.some((c) => c.laneKey === laneKey && Math.abs(c.s - s) < MIN_GAP + 1);
    if (clash) continue;

    cars.push({
      d, i, j, s, laneKey,
      state: 'drive',
      turnT: 0,
      turnLen: 1,
      entry: null, control: null, exit: null, hold: null, leadIn: 0, dOut: d,
      colorIndex: rng.int(0, PALETTE.carBody.length - 1),
      // Drives the idle bob. Per-car phase so a queue doesn't bounce in lockstep.
      travelled: 0,
      phase: rng.range(0, Math.PI * 2),
      speedFactor: 0,
      v: SPEED,     // already rolling, so the city doesn't lurch into motion on frame one
      prevV: SPEED, // paired with car.v so accel = Δv/dt on frame one is a clean zero, not a spike
      // Longitudinal-accel rocking. Spring-damped, so both a stop and a pull-away end on a bounce.
      pitch: 0,
      pitchV: 0,
      boost: false,
      wasBoosting: false,
      lateral: 0,   // 0 = own lane, 1 = out on the centreline overtaking
      steer: 0,     // yaw offset while crossing between the two, so the car points where it slides
      // Ambient cars leave `route` empty and fall through to random turns. The taxi's route is
      // filled in by the game layer; see the turn decision below.
      route: [],
      routeConsumed: false,
      // A taxi with a fare aboard waits at the kerb until the player says where to. Releasing on
      // "has a route" rather than on an explicit call means every caller — the game, the probe,
      // the auto-play soak — releases it just by giving the car somewhere to go.
      parked: false,
      isTaxi: false,
      instanceIndex: -1,
      x: 0, z: 0, yaw: dirYaw(d),
      // Impact state. `stunned` is a small drift-physics packet set by src/sim/collisions.js;
      // while it's non-null the car is off the lane grid and the usual driving/turning logic is
      // skipped. `collisionCooldown` blocks a re-collision for a beat after recovery. `crashed`
      // is set on the taxi only, permanently — every loop below skips it so the wreck sits still
      // while the run-end banner comes up.
      stunned: null,
      collisionCooldown: 0,
      crashed: false,
    });
  }

  return cars;
}

const laneKeyFor = (d, i, j) => (isXAxis(d) ? `x|${d}|${j}` : `z|${d}|${i}`);

/**
 * Put a stunned car back onto the lane grid so normal driving logic can pick it up next frame.
 * Snaps position to the nearest lane centre along the car's travel axis and points it at the
 * next intersection in that direction. A car mid-turn adopts its exit direction, which is what
 * it was heading for anyway; the route (if any) survives, but a routed step that's no longer a
 * legal exit will be dropped by the normal turn logic and counted as a desync.
 */
function recoverFromStun(car) {
  const d = car.state === 'turn' ? car.dOut : car.d;
  const sign = dirSign(d);

  if (isXAxis(d)) {
    let bestJ = 0;
    let bestErr = Infinity;
    for (let j = 0; j <= GRID; j++) {
      const err = Math.abs(car.z - (lineCoord(j) + sign * LANE));
      if (err < bestErr) { bestErr = err; bestJ = j; }
    }
    let targetI = null;
    if (sign > 0) {
      for (let i = 0; i <= GRID; i++) if (lineCoord(i) > car.x + 0.5) { targetI = i; break; }
      if (targetI === null) targetI = GRID;
    } else {
      for (let i = GRID; i >= 0; i--) if (lineCoord(i) < car.x - 0.5) { targetI = i; break; }
      if (targetI === null) targetI = 0;
    }
    car.i = targetI;
    car.j = bestJ;
    car.z = lineCoord(bestJ) + sign * LANE;
    car.s = car.x;
    car.laneKey = `x|${d}|${bestJ}`;
  } else {
    let bestI = 0;
    let bestErr = Infinity;
    for (let i = 0; i <= GRID; i++) {
      const err = Math.abs(car.x - (lineCoord(i) - sign * LANE));
      if (err < bestErr) { bestErr = err; bestI = i; }
    }
    let targetJ = null;
    if (sign > 0) {
      for (let j = 0; j <= GRID; j++) if (lineCoord(j) > car.z + 0.5) { targetJ = j; break; }
      if (targetJ === null) targetJ = GRID;
    } else {
      for (let j = GRID; j >= 0; j--) if (lineCoord(j) < car.z - 0.5) { targetJ = j; break; }
      if (targetJ === null) targetJ = 0;
    }
    car.i = bestI;
    car.j = targetJ;
    car.x = lineCoord(bestI) - sign * LANE;
    car.s = car.z;
    car.laneKey = `z|${d}|${bestI}`;
  }

  car.d = d;
  car.dOut = d;
  car.yaw = dirYaw(d);
  car.state = 'drive';
  car.turnT = 0;
  car.v = 0;
  car.prevV = 0;
  car.lateral = 0;
  car.steer = 0;
  car.collisionCooldown = car.stunned?.postCooldown ?? 0.8;
  car.stunned = null;
}

function bezier(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    z: mt * mt * p0.z + 2 * mt * t * p1.z + t * t * p2.z,
  };
}

/** Shortest-path angular interpolation, so a car turning past ±π doesn't spin the long way. */
function lerpAngle(a, b, t) {
  const delta = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + delta * t;
}

export function createTraffic(rng, scene, count = 24) {
  const cars = spawnCars(rng, count);

  // The player's taxi is an ordinary car in this same array — that is what subjects it to
  // following distance, signals and intersection reservations exactly like everyone else. It is
  // simply drawn as its own mesh instead of an instance, so it can be raycast and highlighted.
  const taxi = cars[0];
  taxi.isTaxi = true;
  const { group: taxiGroup, selection: taxiSelection, setFareColor: setTaxiFareColor } = createTaxiMesh();
  scene.add(taxiGroup);
  scene.add(taxiSelection);   // ground decal, kept out of the car so it never tilts

  const ambient = cars.filter((c) => !c.isTaxi);
  ambient.forEach((car, index) => { car.instanceIndex = index; });

  const mesh = new THREE.InstancedMesh(carGeometry(), propMaterial(), ambient.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.name = 'cars';

  const tint = new THREE.Color();
  ambient.forEach((car, index) => {
    tint.set(PALETTE.carBody[car.colorIndex]);
    mesh.setColorAt(index, tint);
  });
  // With ?cars=1 there are no ambient vehicles at all, so setColorAt is never called and
  // instanceColor is still null.
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);

  // --- Stop bars ------------------------------------------------------------
  //
  // The signal lives on the road, not on a pole. Corner-mounted heads were unreadable from this
  // camera: one head served two opposing approaches, it sat nearer the block corner than the road
  // it governed, and nothing about it said which direction it applied to. A bar painted across
  // the lane you are driving, at the point you would stop, removes both ambiguities — there is
  // exactly one bar for your approach and it is directly in front of you.
  //
  // Placed just outside the crosswalk, so a car holding at the line sits behind the bar rather
  // than on top of it.
  const BAR_DISTANCE = HALF_ROAD + 2.05;

  const barGeo = bakeColor(new THREE.PlaneGeometry(0.7, 3.6), new THREE.Color(1, 1, 1));
  barGeo.rotateX(-Math.PI / 2);

  const bars = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (isUnsignalised(i, j)) continue;         // ring junctions are yield-controlled
      for (let d = 0; d < 4; d++) {
        // Only worth a bar if traffic can actually arrive on this approach.
        if (!nextIntersection(opposite(d), i, j)) continue;
        if (isSegmentClosed(i, j, opposite(d))) continue;

        const lane = laneOffsetCoord(d, i, j);
        const back = -dirSign(d) * BAR_DISTANCE;
        bars.push({
          i,
          j,
          d,
          x: isXAxis(d) ? lineCoord(i) + back : lane,
          z: isXAxis(d) ? lane : lineCoord(j) + back,
          turned: !isXAxis(d),
        });
      }
    }
  }

  const barMesh = new THREE.InstancedMesh(barGeo, propMaterial(), bars.length);
  barMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  barMesh.name = 'stopBars';
  const dummy = new THREE.Object3D();
  bars.forEach((bar, index) => {
    dummy.position.set(bar.x, 0.05, bar.z);
    dummy.rotation.set(0, bar.turned ? Math.PI / 2 : 0, 0);
    dummy.updateMatrix();
    barMesh.setMatrixAt(index, dummy.matrix);
  });
  barMesh.instanceMatrix.needsUpdate = true;
  scene.add(barMesh);

  // `distance` is the honest throughput measure. Counting how many cars are moving at one
  // instant is far too noisy to tune signal timing against — it swings with whatever the
  // phase happens to be at the moment you sample it.
  const stats = {
    time: 0, violations: 0, minGap: Infinity, moving: 0, waiting: 0,
    distance: 0, routeDesync: 0, rightOnRed: 0,
  };

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const headColor = new THREE.Color();

  /**
   * May a car joining the ring pull out? Only if nothing on the ring is bearing down on the
   * junction — the ring never stops, so the gap has to be a real one.
   */
  /** Is the cross traffic that currently holds the green far enough away to turn right on red? */
  function rightOnRedClear(car, t, approaching) {
    const phase = lightPhase(car.i, car.j, t);
    const movingDirs = phase.axis === 'x' ? [0, 2] : [1, 3];
    for (const d of movingDirs) {
      for (const other of approaching.get(`${car.i},${car.j},${d}`) ?? []) {
        const stop = along(other.d, entryPoint(other.d, other.i, other.j));
        const gap = (stop - other.s) * dirSign(other.d);
        if (gap >= 0 && gap < RIGHT_ON_RED_YIELD) return false;
      }
    }
    return true;
  }

  function ringGapClear(car, ring, approaching) {
    const dirs = ring === 'x' ? [0, 2] : [1, 3];
    for (const d of dirs) {
      for (const other of approaching.get(`${car.i},${car.j},${d}`) ?? []) {
        const stop = along(other.d, entryPoint(other.d, other.i, other.j));
        const gap = (stop - other.s) * dirSign(other.d);
        if (gap >= 0 && gap < RING_YIELD) return false;
      }
    }
    return true;
  }

  function update(dt) {
    stats.time += dt;
    const t = stats.time;

    // Set before any car evaluates a signal this frame. Ring junctions are left alone — they are
    // yield-controlled, so there is no phase to override and the taxi waits for a gap like anyone.
    // A stunned or crashed taxi is off the lane grid: releasing its priority hold lets signals run.
    const taxiActive = !taxi.crashed;
    setPriorityJunction(taxiActive && taxi.boost && !taxi.stunned && !isUnsignalised(taxi.i, taxi.j)
      ? { i: taxi.i, j: taxi.j, axis: isXAxis(taxi.d) ? 'x' : 'z' }
      : null);

    if (taxiActive && taxi.boost && !taxi.wasBoosting && !taxi.stunned) {
      taxi.v = Math.max(taxi.v, SPEED * BOOST_KICK);
    }
    taxi.wasBoosting = taxi.boost;

    // Ease out to the centreline and back, so overtaking is a manoeuvre rather than a teleport.
    // Skipped while the taxi is stunned — the drift physics owns its position for the moment.
    //
    // Paced by *distance travelled*, not by elapsed time, and only while running straight. The
    // first version ramped on a 0.45s timer regardless of what the car was doing, which produced
    // the two things that read as a bug rather than an overtake: it slid sideways while sitting
    // still at a red, and starting or ending mid-corner pushed the car off its own Bézier arc
    // partway round. Distance pacing means a stopped car cannot drift at all, and freezing the
    // ramp through a junction keeps the whole corner on one consistent offset.
    if (taxiActive && !taxi.stunned) {
      const lateralTarget = taxi.boost ? 1 : 0;
      let lateralRate = 0;
      if (taxi.state === 'drive') {
        const delta = lateralTarget - taxi.lateral;
        const step = Math.min(Math.abs(delta), (taxi.v * dt) / LANE_CHANGE_LEN);
        taxi.lateral += Math.sign(delta) * step;
        lateralRate = (Math.sign(delta) * step) / Math.max(dt, 1e-6);
      }

      // Steer into it. Without a yaw offset the car crabs — translating sideways across the road
      // while still pointing straight down it — and *that* is what actually looked broken, not the
      // offset itself. Distance pacing makes the angle constant, atan(LANE / LANE_CHANGE_LEN) ≈ 13°,
      // at any speed; the ease is only there so the wheel straightens instead of snapping.
      const steerTarget = Math.atan2(lateralRate * LANE, Math.max(taxi.v, 1));
      taxi.steer += (steerTarget - taxi.steer) * Math.min(1, dt / 0.1);
    }

    // --- Index cars by lane so each one can see the vehicle immediately ahead.
    // A car mid-turn keeps a presence in its entry lane for the first part of the turn,
    // otherwise following cars pile into the intersection behind it.
    const lanes = new Map();
    const approaching = new Map(); // for left-turn yielding
    // Intersections with a car stuck mid-turn, waiting for room to land. Cross traffic must not
    // be released into one of these or it drives straight through the stranded car.
    const heldAt = new Set();

    for (const car of cars) {
      if (car.state === 'turn' && car.turnT >= 0.95) heldAt.add(`${car.i},${car.j}`);
    }

    for (const car of cars) {
      let key = null;
      let laneS = 0;
      let laneDir = car.d;

      // A boosting taxi has left its lane, so nobody should be queueing behind it. A stunned car
      // is off the grid entirely — followers just have to see it as an obstacle at render time.
      // A crashed taxi is not in traffic at all.
      if (car.boost || car.stunned || car.crashed) continue;

      if (car.state === 'drive') {
        key = car.laneKey;
        laneS = car.s;
        const arrivalKey = `${car.i},${car.j},${car.d}`;
        if (!approaching.has(arrivalKey)) approaching.set(arrivalKey, []);
        approaching.get(arrivalKey).push(car);
      } else if (car.turnT < 0.6) {
        // First half of the turn: still queued behind in the lane it came from.
        key = laneKeyFor(car.d, car.i, car.j);
        laneS = along(car.d, car.entry) + dirSign(car.d) * car.turnT * 5;
      } else {
        // Second half: hand the car over to the lane it is about to land in. Without this it
        // is invisible to that lane's traffic for the rest of the turn, and then materialises
        // on top of whatever drove into the gap.
        laneDir = car.dOut;
        key = laneKeyFor(car.dOut, car.i, car.j);
        laneS = along(car.dOut, car.exit) - dirSign(car.dOut) * (1 - car.turnT) * 5;
      }

      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push({ car, laneS, laneDir });
    }

    // Nearest car ahead, per lane.
    const leaderGap = new Map();
    for (const [, members] of lanes) {
      // Every member of a lane shares its travel direction; use the recorded lane direction
      // rather than car.d, which still holds the entry direction for a turning car.
      const sign = dirSign(members[0].laneDir);
      members.sort((a, b) => (b.laneS - a.laneS) * sign);
      for (let k = 1; k < members.length; k++) {
        const behind = members[k];
        const ahead = members[k - 1];
        const gap = (ahead.laneS - behind.laneS) * sign;
        // Only measure real lane geometry. A turning car's lane position is a synthetic stand-in
        // used for queueing, so including it here reports overlaps that don't exist on screen.
        if (behind.car.state === 'drive' && ahead.car.state === 'drive' && gap < stats.minGap) {
          stats.minGap = gap;
        }
        leaderGap.set(behind.car, ahead.laneS);
      }
    }

    stats.moving = 0;
    stats.waiting = 0;

    for (const car of cars) {
      if (car.crashed) continue;
      if (car.collisionCooldown > 0) car.collisionCooldown = Math.max(0, car.collisionCooldown - dt);

      if (car.stunned) {
        // Drift under the impact kick, wobble in yaw, sit at v=0 so exit-speedFactor logic doesn't
        // spike. Damping settles both linear and angular so the car isn't still sliding when the
        // timer runs out and recovery snaps it back to a lane centre.
        const s = car.stunned;
        s.timeLeft -= dt;
        car.x += s.vx * dt;
        car.z += s.vz * dt;
        car.yaw += s.yawRate * dt;
        const damp = Math.exp(-4 * dt);
        s.vx *= damp;
        s.vz *= damp;
        s.yawRate *= damp * 0.85;
        car.v = 0;
        car.speedFactor = 0;
        if (s.timeLeft <= 0) recoverFromStun(car);
        continue;
      }

      if (car.state === 'drive') {
        const sign = dirSign(car.d);
        const stopS = along(car.d, entryPoint(car.d, car.i, car.j));
        const holdS = stopS - sign * STOP_SETBACK;
        const distToLine = (holdS - car.s) * sign;

        // --- How much road is this car actually allowed to use before it must be stopped?
        let allowed = Infinity;

        // The signal ahead, read now rather than on arrival — this is what lets it slow early.
        const ringAxis = corridorCovers(car.i, car.j) ? null : ringAxisAt(car.i, car.j);
        const onRingNow = ringAxis !== null && (isXAxis(car.d) ? 'x' : 'z') === ringAxis;
        const open = ringAxis !== null
          ? onRingNow
          : canProceed(car.d, car.i, car.j, t) || taxiClearsYellow(car, distToLine, t);
        if (!open) allowed = Math.min(allowed, Math.max(0, distToLine));

        // The car ahead — irrelevant to a boosting taxi, which is out on the centreline.
        const aheadS = car.boost ? undefined : leaderGap.get(car);
        if (aheadS !== undefined) {
          allowed = Math.min(allowed, Math.max(0, (aheadS - car.s) * sign - MIN_GAP));
        }

        if (car.parked) {
          if (car.route.length) car.parked = false;
          else allowed = 0;   // eases to a halt rather than stopping dead
        }

        // Fastest speed still stoppable inside `allowed`, approached under real accel limits.
        const topSpeed = car.boost ? SPEED * BOOST_SPEED : SPEED;
        const accel = car.boost ? BOOST_ACCEL : ACCEL;
        const desired = Math.min(topSpeed, Math.sqrt(2 * BRAKE * Math.max(0, allowed)));
        car.v = desired > car.v
          ? Math.min(desired, car.v + accel * dt)
          : Math.max(desired, car.v - BRAKE * dt);

        let step = Math.min(car.v * dt, Math.max(0, allowed));
        // Braking only asymptotes toward the line; snap the last sliver so arrival happens.
        if (allowed < 0.05) { step = Math.max(0, allowed); car.v = 0; }

        // No `distToLine > 0` guard: with the hold line set back from the junction, a car can
        // spawn already beyond it, and requiring it to still be approaching meant the decision
        // never fired and the car drove off the map forever.
        if (distToLine - step <= 0) {
          // About to reach the stop line — decide whether to enter the intersection.
          // A corridor temporarily signalises the ring, so the siren's green path is unbroken.
          const ring = corridorCovers(car.i, car.j) ? null : ringAxisAt(car.i, car.j);
          const onRing = ring !== null && (isXAxis(car.d) ? 'x' : 'z') === ring;

          let green;
          let viaRightOnRed = false;
          if (ring !== null) {
            // No signal here. Ring traffic runs; anyone joining waits for a real gap.
            green = onRing || ringGapClear(car, ring, approaching);
          } else {
            const held = heldAt.has(`${car.i},${car.j}`);
            green = (canProceed(car.d, car.i, car.j, t) || taxiClearsYellow(car, distToLine, t))
              && !held;

            // Right on red. Permitted only as a right turn, only with a gap in the traffic that
            // currently holds the green, and never into a junction an emergency vehicle is
            // clearing or one already blocked by a stranded car.
            if (!green && !held && !corridorCovers(car.i, car.j)
                && legalExits(car.d, car.i, car.j).includes(rightOf(car.d))
                && rightOnRedClear(car, t, approaching)) {
              viaRightOnRed = true;
            }
          }

          let dOut = null;

          if (viaRightOnRed) {
            // The only legal move is the right turn. A routed car takes it if its plan agrees;
            // otherwise it waits for the green like anyone else.
            const turn = rightOf(car.d);
            if (!car.route?.length || car.route[0] === turn) {
              dOut = turn;
              if (car.route?.length) car.routeConsumed = true;
            }
          } else if (green) {
            const options = legalExits(car.d, car.i, car.j);

            // A routed car (the player's taxi) takes the next turn its route calls for; everyone
            // else rolls the weighted straight/right/left dice. This single branch is the entire
            // difference between ambient traffic and a directed vehicle — everything below it
            // (yielding, don't-block-the-box, signals, following distance) applies identically,
            // so the taxi cannot cheat its way to a destination.
            if (car.route?.length && options.includes(car.route[0])) {
              dOut = car.route[0];
              car.routeConsumed = true;
            } else {
              // A routed car whose next step is not a legal exit has desynced from its plan.
              // Silently falling through to a random turn would let it wander while still holding
              // a stale route, so drop the route and count it — this should never fire.
              if (car.route?.length) {
                stats.routeDesync += 1;
                car.route.length = 0;
              }
              // Weight straight/right/left, then fall back to whatever is legal here.
              const weighted = [];
              options.forEach((d) => {
                const kind = d === car.d ? 0 : d === leftOf(car.d) ? 2 : 1;
                weighted.push({ d, w: TURN_WEIGHTS[kind] });
              });
              const total = weighted.reduce((sum, o) => sum + o.w, 0);
              let roll = rng.next() * total;
              for (const option of weighted) {
                roll -= option.w;
                if (roll <= 0) { dOut = option.d; break; }
              }
              dOut ??= options[0];
            }

            // Left turns yield to oncoming traffic close to the same intersection.
            if (dOut === leftOf(car.d)) {
              const oncoming = approaching.get(`${car.i},${car.j},${opposite(car.d)}`) ?? [];
              const blocked = oncoming.some((other) => {
                const otherStop = along(other.d, entryPoint(other.d, other.i, other.j));
                const otherDist = (otherStop - other.s) * dirSign(other.d);
                return otherDist >= 0 && otherDist < YIELD_RANGE;
              });
              if (blocked) dOut = null;
            }

            // Don't block the box: refuse to enter unless there's room to land in the exit lane.
            // Without this, a car finishing a turn is teleported to the exit point regardless of
            // what's already sitting there, which is how cars ended up overlapping.
            if (dOut !== null) {
              const exitKey = laneKeyFor(dOut, car.i, car.j);
              const exitS = along(dOut, exitPoint(dOut, car.i, car.j));
              const exitSign = dirSign(dOut);
              const occupied = (lanes.get(exitKey) ?? []).some(({ car: other, laneS }) => {
                if (other === car || other.state !== 'drive') return false;
                // Clearance is needed on both sides: a car approaching from behind the exit
                // point gets landed on just as hard as one already sitting in front of it.
                // Extra margin on top of the following distance: the exit lane can still back
                // up during the second or so the turn takes, and holding mid-intersection is
                // far more disruptive than simply waiting at the line.
                const ahead = (laneS - exitS) * exitSign;
                return Math.abs(ahead) < MIN_GAP * 1.5;
              });
              if (occupied) dOut = null;
            }
          }

          if (dOut === null) {
            // Held at the line after all — the routed turn was never taken, so the route must not
            // advance. It will be reconsidered next frame.
            car.routeConsumed = false;
            car.s = holdS - sign * 0.02; // hold at the line, clear of the crosswalk
            stats.waiting += 1;
            continue;
          }

          // The turn is now committed, so it is safe to consume the routed step.
          if (car.routeConsumed) {
            car.route.shift();
            car.routeConsumed = false;
          }

          // Structurally impossible given the gate above, but asserted so a future change to
          // the turn logic can't quietly start running red lights. Ring junctions are exempt —
          // they have no phase to obey.
          if (viaRightOnRed) stats.rightOnRed += 1;
          else if (ring === null && !canProceed(car.d, car.i, car.j, t)
              && !taxiClearsYellow(car, distToLine, t)) stats.violations += 1;

          car.entry = entryPoint(car.d, car.i, car.j);
          car.exit = exitPoint(dOut, car.i, car.j);
          car.control = turnControl(car.d, dOut, car.i, car.j);
          car.dOut = dOut;
          car.turnT = 0;

          // The hold line is now behind the junction boundary, so crossing it is a straight
          // run-up followed by the arc. Keeping the arc itself anchored at the boundary is what
          // preserves crisp corners — starting the curve from the hold line instead would turn
          // every corner into a long lazy sweep.
          const lane = laneOffsetCoord(car.d, car.i, car.j);
          car.hold = isXAxis(car.d) ? { x: holdS, z: lane } : { x: lane, z: holdS };
          car.leadIn = STOP_SETBACK;
          car.turnLen = car.leadIn + Math.max(
            0.1,
            Math.hypot(car.control.x - car.entry.x, car.control.z - car.entry.z)
            + Math.hypot(car.exit.x - car.control.x, car.exit.z - car.control.z),
          );
          car.state = 'turn';
          stats.moving += 1;
          continue;
        }

        car.s += sign * step;
        car.travelled += step;
        car.speedFactor = car.v / SPEED;
        stats.distance += step;
        if (step > 0.0001) stats.moving += 1; else stats.waiting += 1;
      } else {
        // --- Mid-turn: follow the arc through the intersection.
        // Corners are taken slower, and the car has to spend real time getting back up to speed
        // on the way out.
        // Crossing a junction is not the same as cornering. Every junction transition runs through
        // this state, including going straight on, and clamping all of them to a corner speed made
        // cars sag at every block — the boosting taxi especially, which would hit top speed on the
        // straight and then shed a third of it to cross an empty junction in a straight line.
        const straightOn = car.dOut === car.d;
        const cruise = car.boost ? SPEED * BOOST_SPEED : SPEED;
        // Crazy mode doesn't lift for left-turns or straights — it goes round them at full pelt,
        // and the lean plus the rubber on the road sell it instead of a speed drop. Right turns
        // are the exception: with right-hand traffic they cut across the near corner (chord ≈
        // HALF_ROAD − LANE per leg) instead of the far diagonal a left turn sweeps, so at full
        // boost the whole arc completes in ~0.35s vs a left's ~0.7s and reads as *sped up*. A
        // softer target on rights (0.75× cruise) keeps the no-brakes feel while giving the tight
        // arc back its visual weight.
        const isRight = !straightOn && car.dOut === rightOf(car.d);
        const boostTurn = car.boost ? (isRight ? cruise * 0.75 : cruise) : CORNER_SPEED;
        const cornerTarget = straightOn ? cruise : boostTurn;
        car.v = car.v > cornerTarget
          ? Math.max(cornerTarget, car.v - BRAKE * dt)
          : Math.min(cornerTarget, car.v + (car.boost ? BOOST_ACCEL : ACCEL) * dt);
        car.turnT += (car.v * dt) / car.turnLen;
        car.travelled += car.v * dt;
        car.speedFactor = car.v / SPEED;
        if (car.turnT < 1) stats.distance += SPEED * dt;

        if (car.turnT >= 1) {
          // Re-check the landing spot. Clearance was verified on entry, but the arc takes over
          // a second to traverse and the exit lane can back up in that time — completing
          // regardless is a teleport straight into the car in front.
          const exitS = along(car.dOut, car.exit);
          const exitSign = dirSign(car.dOut);
          const exitKey = laneKeyFor(car.dOut, car.i, car.j);
          const blocked = (lanes.get(exitKey) ?? []).some(({ car: other, laneS }) => {
            if (other === car || other.state !== 'drive') return false;
            const ahead = (laneS - exitS) * exitSign;
            return ahead > -0.1 && ahead < MIN_GAP;
          });

          if (blocked) {
            // Hold just short of completion; the phantom lane entry keeps followers queued.
            car.turnT = 0.999;
            stats.waiting += 1;
            continue;
          }

          const next = nextIntersection(car.dOut, car.i, car.j);
          car.d = car.dOut;
          car.i = next.i;
          car.j = next.j;
          car.s = along(car.d, car.exit);
          car.laneKey = laneKeyFor(car.d, car.i, car.j);
          car.state = 'drive';
          car.turnT = 0;
        }
        stats.moving += 1;
      }
    }

    // --- Resolve render transforms.
    for (let index = 0; index < cars.length; index++) {
      const car = cars[index];

      // A crashed taxi's mesh was hidden by the collision handler; nothing to compose.
      if (car.crashed) continue;

      if (car.stunned) {
        // Position and yaw were stepped by the stun physics; write them straight into the mesh
        // with a slight lift so the car reads as jolted rather than sunken into the tarmac.
        const lift = 0.06;
        if (car.isTaxi) {
          taxiGroup.position.set(car.x, ROAD_Y + lift, car.z);
          taxiGroup.rotation.set(0, car.yaw, 0);
          taxiSelection.position.set(car.x, ROAD_Y + 0.02, car.z);
        } else {
          pos.set(car.x, ROAD_Y + lift, car.z);
          quat.setFromEuler(euler.set(0, car.yaw, 0, 'YXZ'));
          matrix.compose(pos, quat, scl);
          mesh.setMatrixAt(car.instanceIndex, matrix);
        }
        continue;
      }

      if (car.state === 'drive') {
        const lane = laneOffsetCoord(car.d, car.i, car.j);
        car.x = isXAxis(car.d) ? car.s : lane;
        car.z = isXAxis(car.d) ? lane : car.s;
        car.yaw = dirYaw(car.d);
      } else {
        const travelled = Math.min(car.turnT, 1) * car.turnLen;
        if (travelled < car.leadIn) {
          // Straight run-up from the hold line to the junction boundary.
          const t = travelled / car.leadIn;
          car.x = car.hold.x + (car.entry.x - car.hold.x) * t;
          car.z = car.hold.z + (car.entry.z - car.hold.z) * t;
          car.yaw = dirYaw(car.d);
        } else {
          const t = (travelled - car.leadIn) / (car.turnLen - car.leadIn);
          const p = bezier(car.entry, car.control, car.exit, t);
          car.x = p.x;
          car.z = p.z;
          car.yaw = lerpAngle(dirYaw(car.d), dirYaw(car.dOut), t);
        }
      }

      // Overtaking offset. Applied at render only: the simulation keeps the car on its lane
      // coordinate, and the boosting taxi is excluded from lane bookkeeping anyway.
      //
      // Order matters — the offset is perpendicular to the *lane*, so it has to be taken off the
      // unsteered heading before the steering angle is added on top.
      if (car.lateral > 0.001) {
        car.x -= Math.sin(car.yaw) * LANE * car.lateral;
        car.z -= Math.cos(car.yaw) * LANE * car.lateral;
      }
      if (car.steer) car.yaw += car.steer;

      // A little vertical bob, scaled by how fast the car is actually going, so stopped traffic
      // sits still instead of idling like a boat.
      const bob = Math.sin(car.travelled * 2.4 + car.phase) * 0.045 * car.speedFactor;

      // Body roll through a corner. Leans *outward* — away from the turn centre — because that
      // is what weight transfer does, and leaning inward reads as a motorbike.
      let roll = 0;
      if (car.state === 'turn') {
        const along01 = (Math.min(car.turnT, 1) * car.turnLen - car.leadIn)
          / Math.max(1e-6, car.turnLen - car.leadIn);
        if (along01 > 0) {
          const turnDir = car.dOut === rightOf(car.d) ? 1 : car.dOut === leftOf(car.d) ? -1 : 0;
          const lean = 0.3 * Math.min(2.2, Math.max(0.7, car.v / SPEED));
          roll = -turnDir * lean * Math.sin(Math.PI * Math.min(1, along01));
        }
      }

      // Rocking. Pitch is a spring-damper driven by longitudinal acceleration: braking dips the
      // nose forward, easing off the brake lifts it, and the underdamping (ζ ≈ 0.4) makes both
      // events end on a small bounce so it reads as suspension travel. Impulse to pitchV works
      // out as K·SCALE·Δv, independent of dt — a one-frame velocity jump (boost kick, stop-line
      // snap) delivers the same rock at any frame rate.
      const accel = dt > 1e-6 ? (car.v - car.prevV) / dt : 0;
      car.prevV = car.v;
      const targetPitch = Math.max(-0.13, Math.min(0.13, accel * 0.014));
      car.pitchV += ((targetPitch - car.pitch) * 60 - car.pitchV * 6) * dt;
      car.pitch += car.pitchV * dt;

      // Roll and pitch both pivot on the car's origin at road level, so tilting drives one edge
      // underground. Lifting by the sagitta of each keeps the low edge on the tarmac and reads as
      // suspension travel rather than clipping.
      const lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
        + Math.abs(Math.sin(car.pitch)) * (CAR_LEN / 2);

      if (car.isTaxi) {
        taxiGroup.position.set(car.x, ROAD_Y + bob + lift, car.z);
        taxiGroup.rotation.set(roll, car.yaw, car.pitch);
        // Decal stays flat on the road, unaffected by roll, pitch or bob.
        taxiSelection.position.set(car.x, ROAD_Y + 0.02, car.z);
        continue;
      }

      pos.set(car.x, ROAD_Y + bob + lift, car.z);
      quat.setFromEuler(euler.set(roll, car.yaw, car.pitch, 'YXZ'));
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(car.instanceIndex, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // --- Stop bar colours, one per approach.
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      const phase = lightPhase(bar.i, bar.j, t);
      const mine = phase.axis === (isXAxis(bar.d) ? 'x' : 'z');
      headColor.set(mine
        ? (phase.yellow ? PALETTE.lightYellow : PALETTE.lightGreen)
        : PALETTE.lightRed);
      barMesh.setColorAt(index, headColor);
    }
    if (barMesh.instanceColor) barMesh.instanceColor.needsUpdate = true;
  }

  /** Fixed-step warm-up so screenshots show settled traffic, deterministically. */
  function warmup(seconds, step = 1 / 60) {
    for (let elapsed = 0; elapsed < seconds; elapsed += step) update(step);
  }

  return { cars, taxi, taxiGroup, taxiSelection, setTaxiFareColor, mesh, barMesh, update, warmup, stats, lightPhase };
}
