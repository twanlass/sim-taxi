// Rigid-body physics for the taxi and nearby ambient cars, gated behind ?physics=rigid.
//
// The rail simulation in traffic.js stays authoritative for the vast majority of the fleet: it
// owns signals, following distance and every routing decision, and the tests in tools/ depend on
// its determinism. Physics runs *alongside* the rail sim, promoting cars into rigid bodies only
// when they enter a bubble around the taxi (~50 units), and snapping them back onto the nearest
// lane centreline when they leave.
//
// The taxi itself is a kinematic-position-based rigid body: its transform is driven from the rail
// sim each frame, but its cuboid collider can shove the dynamic ambient cars around. This is the
// "working degraded" shape the task description sanctioned in place of a full raycast-vehicle
// controller — the vehicle-controller path needs synthesised throttle/brake/steer from the route
// which is a significant piece of extra work; landing a shippable rigid mode first is better than
// wobbling toward a full one.
//
// Import cost: Rapier's WASM is base64-inlined in @dimforge/rapier3d-compat, so Vite 7 handles it
// natively with no plugin. But the WASM decode + module init runs a few dozen milliseconds and the
// module has zero business in headless Node — hence the isRigid()/typeof window gate at the top of
// createRigidWorld(). No import from this file may ever leak into src/sim/traffic.js or any module
// on tools/check.mjs's BOOT list.

import * as THREE from 'three';
import { isRigid } from './physics-mode.js';
import {
  GRID, PITCH, HALF_ROAD, HALF_SPAN, BLOCK, lineCoord, laneOffsetCoord, dirYaw, dirSign, isXAxis,
} from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { ROAD_Y } from './traffic.js';

// Bubble radius: cars within this of the taxi become dynamic rigid bodies. 50 world units is
// roughly two-and-a-half blocks in either direction — enough that a boosted taxi (17 u/s) has
// ~3s of physics-cars ahead of it, so a swap-in never appears at contact range.
const BUBBLE_RADIUS = 50;
const BUBBLE_RADIUS_SQ = BUBBLE_RADIUS * BUBBLE_RADIUS;

// Chassis is a coarse cuboid — the visible car mesh has bumpers, cabins and wheels sticking out,
// but for shove-behaviour a plain box is fine and much cheaper. Height is deliberately short of
// the visible mesh so kerbs (KERB_H = 0.35) can't wedge under the collider.
const CAR_HX = 1.7;    // half-length along +X (the direction the taxi initially faces)
const CAR_HY = 0.55;
const CAR_HZ = 0.85;

/**
 * Build the rigid-body world when ?physics=rigid is set.
 *
 * Returns null in every other case (arcade / off / headless / shot mode). Callers should treat a
 * null return as "physics is not in play this session" and skip all physics-mode branches.
 *
 * @param {THREE.Scene} scene              the game scene (unused today, reserved for debug wireframe)
 * @param {ReturnType<import('./traffic.js').createTraffic>} traffic  the rail-sim handle
 * @returns {Promise<{ready:true, step:(dt:number)=>void, isRigidMode:()=>boolean}|null>}
 */
export async function createRigidWorld(scene, traffic) {
  // Two gates, both required:
  //   isRigid()               — the URL says so, and this session opted in
  //   typeof window !== ...   — belt-and-braces so a probe that ever imports this module still
  //                              boots to a no-op even if isRigid() somehow reports true. Headless
  //                              tests must NEVER await a WASM promise.
  if (!isRigid() || typeof window === 'undefined') return null;

  // Dynamic import so tools that only reach this file through some indirect graph don't force the
  // WASM decode before the isRigid() gate can turn them away.
  const RAPIER = await import('@dimforge/rapier3d-compat');
  await RAPIER.init();

  // -1 g on Y, matching the game's implicit up axis (world Y is up in every mesh in this project).
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;   // matches the game's typical dt; step() clamps below when the frame is longer

  // --- Static colliders ---------------------------------------------------
  //
  // Two families: the road plane (a big fixed cuboid instead of an infinite plane so the mass/AABB
  // stays finite), and one kerb-height cuboid per city block, so dynamic cars hitting a sidewalk
  // rebound instead of tunnelling into the buildings behind it. This is cheap: a 5×5 grid gives
  // 25 static boxes plus 1 ground box — Rapier's broad phase is trivial at that scale.
  //
  // The buildings themselves are not colliders. The block AABB already sits BLOCK×BLOCK where the
  // buildings would be, so a car bouncing off "a kerb" is also bouncing off "the buildings", which
  // is close enough at this camera and skips having to reproduce the tower-splitting RNG here.
  {
    const groundDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, -0.5, 0);
    const groundBody = world.createRigidBody(groundDesc);
    const groundCollider = RAPIER.ColliderDesc.cuboid(HALF_SPAN + 20, 0.5, HALF_SPAN + 20)
      .setFriction(0.9);
    world.createCollider(groundCollider, groundBody);
  }

  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const x0 = lineCoord(bi) + HALF_ROAD;
      const z0 = lineCoord(bj) + HALF_ROAD;
      const cx = x0 + BLOCK / 2;
      const cz = z0 + BLOCK / 2;
      // Height 4 — well above any car chassis, low enough that debug-lookdowns still show the box
      // as a footprint rather than a wall of building.
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, 2, cz);
      const body = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(BLOCK / 2, 2, BLOCK / 2)
        .setFriction(0.5)
        .setRestitution(0.05);
      world.createCollider(colliderDesc, body);
    }
  }

  // --- Taxi (kinematic-position-based) ------------------------------------
  //
  // The taxi's transform stays owned by the rail sim in traffic.js — traffic.update() computes
  // {x, z, yaw} exactly as it does for arcade/off, then setNextKinematicTranslation drives the
  // physics body to that pose. Kinematic bodies are one-way: they can push dynamic ambient cars
  // but nothing pushes them back, which is what makes fares.update()'s arrival check keep working
  // (car.x/car.z still track the rail pose the fare judged the trip against).
  const taxi = traffic.taxi;
  const taxiBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(taxi.x, ROAD_Y + CAR_HY, taxi.z);
  const taxiBody = world.createRigidBody(taxiBodyDesc);
  const taxiColliderDesc = RAPIER.ColliderDesc.cuboid(CAR_HX, CAR_HY, CAR_HZ)
    .setFriction(0.7)
    .setRestitution(0.05);
  world.createCollider(taxiColliderDesc, taxiBody);

  // --- Dynamic ambient-car pool ------------------------------------------
  //
  // Kept on the car struct as car._rigid = { body, colliderHandle } while inside the bubble; unset
  // (both to null and to undefined) on the way out. Bookkeeping is defensive: on ANY error path
  // we clear the handle and put the car back onto the rails at its nearest lane centreline so a
  // physics glitch never leaves a car stuck.
  const scratch = { x: 0, y: 0, z: 0 };
  const scratchQuat = new THREE.Quaternion();
  const scratchEuler = new THREE.Euler();

  function promote(car) {
    if (car._rigid) return;
    try {
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(car.x, ROAD_Y + CAR_HY, car.z)
        // The rail sim runs a rear-wheel-forward convention (dirYaw): rotate around Y by yaw.
        .setRotation(quaternionFromYaw(car.yaw, scratchQuat))
        // Rail speed feeds the initial linear velocity so the swap-in doesn't stall a car mid-lane.
        .setLinvel(Math.cos(car.yaw) * (car.v ?? 0), 0, -Math.sin(car.yaw) * (car.v ?? 0))
        // Cars shouldn't tip on their side from a corner-clip; lock roll and pitch, leave yaw free
        // so a shove can spin the car naturally.
        .enabledRotations(false, true, false)
        .setLinearDamping(0.3)
        .setAngularDamping(1.0);
      const body = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(CAR_HX, CAR_HY, CAR_HZ)
        .setFriction(0.9)
        .setRestitution(0.05)
        .setDensity(1.2);
      const collider = world.createCollider(colliderDesc, body);
      car._rigid = { body, collider };
      // While dynamic, freeze the rail bookkeeping so followers behind this car (still on rails)
      // don't queue on a car that's about to teleport back. state='drive' + turnT=0 is the state
      // spawnCars sets up, and matches what demote() will re-establish on exit.
      car._preRigidState = { state: car.state, turnT: car.turnT, parked: car.parked };
      car.state = 'drive';
      car.turnT = 0;
      // Freeze the rail motion while physics owns the pose. `parked` is the rail sim's own
      // "stop here" flag (traffic.js:594 sets allowed = 0 for a parked car with no route), so
      // reusing it means the car eases to zero on its lane coordinate without any new plumbing —
      // and every rail-side leaderGap calculation still treats it as a real car at a real spot,
      // just one that isn't advancing. The demote() path restores the previous parked value.
      car.parked = true;
    } catch (err) {
      console.warn('[rigid] promote failed', err);
      car._rigid = null;
    }
  }

  function demote(car) {
    if (!car._rigid) return;
    try {
      world.removeRigidBody(car._rigid.body);
    } catch (err) {
      // If Rapier can't remove it, we still want the car back on the rails — swallow and continue.
      console.warn('[rigid] demote removeRigidBody failed', err);
    }
    car._rigid = null;

    // Snap the car onto the nearest legal lane centreline in whatever direction it was heading.
    // The rail sim's followingdistance/signals machinery expects (d, i, j, s, laneKey) all to be
    // consistent, and picking the nearest lane rather than reusing the pre-bubble one is what
    // handles the case where the physics push moved the car by a full block or across an
    // intersection.
    const snapped = nearestLane(car.x, car.z, car.yaw);
    if (snapped) {
      car.d = snapped.d;
      car.i = snapped.i;
      car.j = snapped.j;
      car.s = snapped.s;
      car.x = snapped.x;
      car.z = snapped.z;
      car.yaw = dirYaw(car.d);
      car.laneKey = snapped.laneKey;
      car.state = 'drive';
      car.turnT = 0;
      car.route = [];              // route may have been consumed; safest to redraw random turns
      car.routeConsumed = false;
      car.lateral = 0;
      car.steer = 0;
      car.v = Math.max(0, Math.min(car.v ?? 6, 6));
      // Restore the rail-side parked flag — an ambient car is essentially never parked, but if a
      // future change ever promoted the taxi through this path we want its kerb-hold preserved.
      car.parked = car._preRigidState?.parked ?? false;
    }
    car._preRigidState = null;
  }

  function step(dt) {
    // Clamped to a sane physics timestep. The main loop already clamps dt to 0.05s; the extra
    // sub-cap here is because Rapier gets unstable stepping more than ~2 substeps of 1/60 in one
    // go, and it's cheaper to let the sim run slightly slow for one frame than to explode.
    const stepDt = Math.min(dt, 1 / 30);
    world.timestep = stepDt;

    // Update taxi kinematic pose from rail sim first — nothing else pushes it.
    taxiBody.setNextKinematicTranslation({ x: taxi.x, y: ROAD_Y + CAR_HY, z: taxi.z });
    taxiBody.setNextKinematicRotation(quaternionFromYaw(taxi.yaw, scratchQuat));

    // Promote / demote ambient cars.
    for (const car of traffic.cars) {
      if (car.isTaxi) continue;
      const dx = car.x - taxi.x;
      const dz = car.z - taxi.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= BUBBLE_RADIUS_SQ) {
        if (!car._rigid) promote(car);
      } else if (car._rigid) {
        demote(car);
      }
    }

    world.step();

    // Write dynamic bodies' poses back to their car struct so the render loop in traffic.js sees
    // the same {x, z, yaw} it always does. Ambient cars: overwrite; taxi is kinematic so its pose
    // came from the rail sim and needs no read-back.
    for (const car of traffic.cars) {
      if (car.isTaxi || !car._rigid) continue;
      const t = car._rigid.body.translation();
      const r = car._rigid.body.rotation();
      car.x = t.x;
      car.z = t.z;
      scratchQuat.set(r.x, r.y, r.z, r.w);
      scratchEuler.setFromQuaternion(scratchQuat, 'YXZ');
      car.yaw = scratchEuler.y;
      // Rail update loop wrote lateral/steer offsets before promotion — zero them so the render
      // math (traffic.js:849) doesn't slide the mesh off the physics pose.
      car.lateral = 0;
      car.steer = 0;
    }
  }

  return {
    ready: true,
    step,
    isRigidMode: () => true,
    _debug: { world, taxiBody },   // exposed on window.__taxi.physics for probing from the console
  };
}

// --- helpers ----------------------------------------------------------------

function quaternionFromYaw(yaw, out) {
  // Yaw around +Y. Matches dirYaw()'s convention where the car body points +X at yaw=0.
  const half = yaw * 0.5;
  const s = Math.sin(half);
  const c = Math.cos(half);
  out.set(0, s, 0, c);
  return { x: 0, y: s, z: 0, w: c };
}

/**
 * Nearest legal lane centreline to (worldX, worldZ), assuming a heading close to `yaw`.
 *
 * "Nearest" means: for each direction d in {0..3}, find the road that carries a d-going lane
 * closest to the point, snap the point onto that lane, and pick the d whose snap is closest in
 * world distance AND whose heading matches car.yaw within ~90°. If nothing qualifies, returns
 * null and the caller keeps the car parked at its current spot (rail sim will eventually notice).
 */
function nearestLane(worldX, worldZ, yaw) {
  const carHeading = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  let best = null;

  for (let d = 0; d < 4; d++) {
    const dirVec = { x: Math.cos(dirYaw(d)), z: -Math.sin(dirYaw(d)) };
    const dot = dirVec.x * carHeading.x + dirVec.z * carHeading.z;
    if (dot < 0) continue;   // more than 90° off — snapping onto this lane would 180° the car

    if (isXAxis(d)) {
      // d travels along X; lane centreline is a Z-line at lineCoord(j) + dirSign(d) * LANE.
      for (let j = 0; j <= GRID; j++) {
        // Pick the intersection ahead of us in the d direction so `s` is the coordinate the sim
        // uses to measure progress toward that intersection.
        for (let i = 0; i <= GRID; i++) {
          const laneZ = laneOffsetCoord(d, i, j);
          const dz = worldZ - laneZ;
          // Only consider (i, j) if worldX is within a block of it along d.
          const targetX = lineCoord(i);
          const gap = (targetX - worldX) * dirSign(d);
          if (gap < 0 || gap > PITCH) continue;
          const distSq = dz * dz + gap * gap * 0.001;   // tiny bias toward the closer intersection
          if (!best || distSq < best.distSq) {
            best = {
              d, i, j, s: worldX, x: worldX, z: laneZ,
              laneKey: `x|${d}|${j}`,
              distSq,
            };
          }
        }
      }
    } else {
      // d travels along Z.
      for (let i = 0; i <= GRID; i++) {
        for (let j = 0; j <= GRID; j++) {
          const laneX = laneOffsetCoord(d, i, j);
          const dx = worldX - laneX;
          const targetZ = lineCoord(j);
          const gap = (targetZ - worldZ) * dirSign(d);
          if (gap < 0 || gap > PITCH) continue;
          const distSq = dx * dx + gap * gap * 0.001;
          if (!best || distSq < best.distSq) {
            best = {
              d, i, j, s: worldZ, x: laneX, z: worldZ,
              laneKey: `z|${d}|${i}`,
              distSq,
            };
          }
        }
      }
    }
  }

  return best;
}
