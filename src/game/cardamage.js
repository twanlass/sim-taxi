import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { bakeColor, propMaterial, setFinish, FINISH } from '../util/geo.js';
import { color } from '../palette.js';
import { lightPodAnchor } from '../geometry/lights.js';
import { BUMPER_H, bumperLength } from '../geometry/bumpers.js';
import {
  BOOT_HINGE_X, HOOD_HINGE_X, HOOD_LEN, BODY_TOP, BOOT_LEN, LAMP_WIRE, LAMP_SIZE, lampSocket, lampHang,
  bumperHinge,
} from '../geometry/damage.js';
import { CAR_LEN, CAR_W, TRUCK_LEN, TRUCK_W } from '../sim/traffic.js';
import {
  stepLid, stepLamp, looseLamp, BOOT_REST, BOOT_HIT_KICK, HOOD_REST, HOOD_POP, SPARK_MIN_V,
} from './taxidamage.js';

// The cars the taxi hits wear it too: the same bonnet and boot lid flapping on the same spring, the
// same lamp swinging on its wire, the same bumper hanging off a corner dragging sparks — the parts
// game/taxidamage.js puts on the taxi, sized by geometry/damage.js and stepped by its springs.
//
// **Only a charged hit marks a car**, which is a boosting one (`onBump` in sim/collisions.js). Off
// boost the taxi drives itself and contact is a shove that costs nothing: the never-boosting
// harness grazed a car in a junction once every ~100s, all of them turn arcs brushing, and a car
// walking away from one of those with its bonnet up would be damage the player did not do. The
// taxi does not dent on them either, so the two stay one rule.
//
// What a hit does, read off where on the struck car it landed:
//   - the lid at that end flies open — the boot for a car rear-ended, the bonnet for one nosed into
//     (a T-bone lands on whichever half the taxi's nose found) — and one already open slams;
//   - the lamp at that corner comes out of its socket and swings on its wire, still lit;
//   - a second hit, or one hard enough to be a T-bone (BUMPER_CLOSING), knocks the bumper off the
//     most-hit end to hang by a corner and drag on the road.
// It stays for as long as the car is on the map: seeing a car you hit three blocks ago still driving
// round with its boot flapping is most of the fun. No smoke and no list — on the taxi those are its
// hit points, and a smoking car that is not the taxi would muddy the one gauge the player reads.
//
// Trucks keep their lamps and their bumper but have no lids: the cab runs to within 0.1 of the nose
// and the back is a cargo box. The cruiser and the guests (the fire engine) are drawn by meshes of
// their own and are left out; a cop car in the fleet is an ordinary car and dents like one.
//
// **Cost.** Up to ~22 cars can be on screen, so none of this is per car: the parts are four
// instanced meshes over a pool of `POOL_SIZE` rigs, every instance at a zero scale until it is used, and the
// bumper and the swinging pods ride the fleet's own instances through `car.wear` (sim/traffic.js
// reads it in `writeAmbient`). A pool full of dented cars gives up the rig whose car is furthest
// from the taxi — almost always one off screen.

const POOL_SIZE = 8;
// Closing speed at which the first hit already knocks the bumper off. Rear-ending traffic at boost
// cruise closes at ~10.5 and a T-bone at ~21 (the table in sim/collisions.js): a tailgate takes two,
// a red light run takes one.
const BUMPER_CLOSING = 15;
// A lid knocked open flies up rather than falling open: the bonnet's burst-catch kick, for both.
const LID_POP = HOOD_POP;
// Half the taxi's spark rate. The pool is 64 sparks shared with the taxi's own bumper, and a few
// dented cars dragging at full rate would starve the one the player is watching.
const SPARK_EVERY = 0.09;

export function createCarDamage({ scene, traffic, sparks, roadY, rng = Math.random, pool: POOL = POOL_SIZE }) {
  const instanced = (geometry, max, name) => {
    const mesh = skipWhenEmpty(new THREE.InstancedMesh(geometry, propMaterial(), max));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Every instance moves with its car, all over the map — see `neverCull` in sim/traffic.js.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    // Always visible, with every unused instance at a zero scale. Hiding the lot until the first hit
    // would leave these programs unlinked until then, and a link is a stall inside the driver — so
    // it would land on the very frame of the hit (see tools/links.mjs).
    scene.add(mesh);
    return mesh;
  };

  // A lid one unit long, hinged at its own origin and running along +x; each one's length is a
  // scale. White, for the car's paint to tint through `instanceColor`.
  const lidGeo = new THREE.BoxGeometry(1, 0.06, CAR_W * 0.94);
  lidGeo.translate(0.5, 0.03, 0);
  const lids = instanced(setFinish(bakeColor(lidGeo, new THREE.Color(1, 1, 1)), FINISH.PAINT),
    POOL * 2, 'carDamageLids');
  // The dark opening under a lid. The taxi's trim colour, which is what the taxi's own opening is.
  const holeGeo = new THREE.BoxGeometry(1, 0.02, CAR_W * 0.82);
  holeGeo.translate(0, 0.01, 0);
  const holes = instanced(bakeColor(holeGeo, color('taxiTrim')), POOL * 2, 'carDamageOpenings');
  // Lamp housings, white for the lens colour to tint, and the wires they hang from.
  const housings = instanced(bakeColor(new THREE.BoxGeometry(...LAMP_SIZE), new THREE.Color(1, 1, 1)),
    POOL * 4, 'carDamageLamps');
  const wireGeo = new THREE.BoxGeometry(0.05, 1, 0.05);
  wireGeo.translate(0, -0.5, 0);
  const wires = instanced(bakeColor(wireGeo, color('taxiTrim')), POOL * 4, 'carDamageWires');
  const meshes = [lids, holes, housings, wires];
  const front = color('headlight');
  const rear = color('lightRed');
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let k = 0; k < POOL * 4; k++) {
    housings.setColorAt(k, k % 4 < 2 ? front : rear);
    housings.setMatrixAt(k, ZERO);
    wires.setMatrixAt(k, ZERO);
  }
  for (let k = 0; k < POOL * 2; k++) {
    lids.setColorAt(k, front);
    lids.setMatrixAt(k, ZERO);
    holes.setMatrixAt(k, ZERO);
  }

  // The four corners in instance order — two front, two rear, matching the housing tints above.
  const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const homes = (len, width) => CORNERS.map(([sx, sz]) => lampSocket(lightPodAnchor(sx, sz, len, width), sx));
  const SOCKETS = { car: homes(CAR_LEN, CAR_W), truck: homes(TRUCK_LEN, TRUCK_W) };

  /** @type {Array<null | object>} */
  const rigs = new Array(POOL).fill(null);
  let active = 0;
  const paint = new THREE.Color();

  function release(slot) {
    const rig = rigs[slot];
    if (!rig) return;
    if (rig.car.wear === rig.wear) rig.car.wear = null;
    rigs[slot] = null;
    active -= 1;
    for (let k = 0; k < 2; k++) {
      lids.setMatrixAt(slot * 2 + k, ZERO);
      holes.setMatrixAt(slot * 2 + k, ZERO);
    }
    for (let k = 0; k < 4; k++) {
      housings.setMatrixAt(slot * 4 + k, ZERO);
      wires.setMatrixAt(slot * 4 + k, ZERO);
    }
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  const posed = new THREE.Quaternion();
  const euler = new THREE.Euler();
  function rigFor(car) {
    const have = rigs.findIndex((r) => r?.car === car);
    if (have !== -1) return rigs[have];
    let slot = rigs.indexOf(null);
    if (slot === -1) {
      // Full: give up the dented car furthest from the taxi.
      const { taxi } = traffic;
      let far = -1;
      for (let k = 0; k < POOL; k++) {
        const d = Math.hypot(rigs[k].car.x - taxi.x, rigs[k].car.z - taxi.z);
        if (d > far) { far = d; slot = k; }
      }
      release(slot);
    }
    // Posed where the car stands until traffic writes the real body matrix on its next frame.
    posed.setFromEuler(euler.set(0, car.yaw, 0, 'YXZ'));
    const wear = {
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(car.x, roadY, car.z), posed, new THREE.Vector3(1, 1, 1)),
      lamps: new Map(),
      bumper: null,
    };
    const rig = {
      car, wear, slot,
      hood: null, boot: null,
      lamps: new Map(),
      corners: new Map(),
      worst: { end: -1, side: 1 },
      hits: 0, phase: rng() * 10, sparkIn: 0, lastV: Math.max(0, car.v ?? 0),
    };
    car.wear = wear;
    rigs[slot] = rig;
    active += 1;
    paint.set(traffic.bodyColor(car));
    lids.setColorAt(slot * 2, paint);
    lids.setColorAt(slot * 2 + 1, paint);
    lids.instanceColor.needsUpdate = true;
    return rig;
  }

  const lid = (rest) => ({ angle: 0, v: LID_POP, roadIn: rng() * 0.2, rest });

  /**
   * The taxi has hit `car` at world (x, z), closing at `closing` u/s. A no-op for a car this cannot
   * draw on — see the header.
   */
  function hit(car, x, z, { closing = 0 } = {}) {
    if (!car || car.isTaxi || car.guest || car.skin || car.crashed) return;
    const rig = rigFor(car);
    // Into the struck car's own frame, as game/taxidamage.js reads a hit on the taxi.
    const dx = x - car.x;
    const dz = z - car.z;
    const lx = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
    const lz = dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw);
    const end = lx >= 0 ? 1 : -1;
    const side = lz >= 0 ? 1 : -1;
    const key = `${end},${side}`;
    rig.corners.set(key, (rig.corners.get(key) ?? 0) + 1);
    let top = -1;
    for (const [k, n] of rig.corners) {
      if (n > top || (n === top && k === key)) {
        top = n;
        const [e, s] = k.split(',').map(Number);
        rig.worst = { end: e, side: s };
      }
    }
    rig.hits += 1;

    // Whatever is already open slams; the lid at the struck end flies open if it was not.
    if (rig.hood) rig.hood.v -= BOOT_HIT_KICK;
    if (rig.boot) rig.boot.v -= BOOT_HIT_KICK;
    if (!car.isTruck) {
      if (end > 0 && !rig.hood) rig.hood = lid(HOOD_REST);
      if (end < 0 && !rig.boot) rig.boot = lid(BOOT_REST);
    }

    const lamp = rig.lamps.get(key);
    if (lamp) lamp.v += (rng() - 0.5) * 2 * BOOT_HIT_KICK * 0.4;
    else rig.lamps.set(key, looseLamp(end, side, rng));

    if (!rig.wear.bumper && (rig.hits >= 2 || closing >= BUMPER_CLOSING)) {
      // Hinged on the far side so its free end, the one dragging, is at the damaged corner.
      rig.wear.bumper = { end: rig.worst.end, side: -rig.worst.side, lift: 0 };
    }
  }

  const m = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  const Y = new THREE.Vector3(0, 1, 0);
  const FLIP = new THREE.Quaternion().setFromAxisAngle(Y, Math.PI);
  const hingePos = new THREE.Vector3();
  const hingeRot = new THREE.Euler();
  const tip = new THREE.Vector3();

  // One lid and its opening, through the car's body matrix. `dir` +1 runs the lid forward off its
  // hinge (the bonnet), −1 back (the boot) — turned half round rather than mirrored, so the winding
  // holds — and the angle lifts the free end either way.
  function writeLid(slot, k, wear, state, hingeX, len, dir) {
    if (!state) {
      lids.setMatrixAt(slot * 2 + k, ZERO);
      holes.setMatrixAt(slot * 2 + k, ZERO);
      return;
    }
    q.setFromAxisAngle(Z, state.angle);
    if (dir < 0) q.premultiply(FLIP);
    local.compose(at.set(hingeX, BODY_TOP, 0), q, s.set(len, 1, 1));
    lids.setMatrixAt(slot * 2 + k, m.multiplyMatrices(wear.matrix, local));
    local.makeScale(len * 0.9, 1, 1).setPosition(hingeX + dir * len / 2, BODY_TOP + 0.01, 0);
    holes.setMatrixAt(slot * 2 + k, m.multiplyMatrices(wear.matrix, local));
  }

  function update(dt) {
    if (!active) return;
    for (let slot = 0; slot < POOL; slot++) {
      const rig = rigs[slot];
      if (!rig) continue;
      const { car, wear } = rig;
      // Gone: wrecked (its shell is game/wreckage.js's now), or off the map — a cop leaving at the
      // end of a robbery is spliced out of `cars`.
      if (car.crashed || car.wear !== wear || !traffic.cars.includes(car)) { release(slot); continue; }

      const v = Math.max(0, car.v ?? 0);
      const moving = Math.min(1, v / 8);
      const accel = dt > 1e-6 ? (v - rig.lastV) / dt : 0;
      rig.lastV = v;
      rig.phase += dt * (5 + v * 0.7);

      if (rig.hood) stepLid(rig.hood, dt, moving, accel, rng);
      if (rig.boot) stepLid(rig.boot, dt, moving, accel, rng);
      writeLid(slot, 0, wear, rig.hood, HOOD_HINGE_X, HOOD_LEN, 1);
      writeLid(slot, 1, wear, rig.boot, BOOT_HINGE_X, BOOT_LEN, -1);

      const sockets = car.isTruck ? SOCKETS.truck : SOCKETS.car;
      for (let c = 0; c < 4; c++) {
        const [sx, sz] = CORNERS[c];
        const key = `${sx},${sz}`;
        const lamp = rig.lamps.get(key);
        if (!lamp) {
          housings.setMatrixAt(slot * 4 + c, ZERO);
          wires.setMatrixAt(slot * 4 + c, ZERO);
          continue;
        }
        stepLamp(lamp, dt, moving, accel, rng);
        // traffic.js hangs the lit pods off this same angle (`writeLight`).
        wear.lamps.set(key, lamp.angle);
        q.setFromAxisAngle(Z, lamp.angle);
        local.compose(lampHang(sockets[c], lamp.angle, at), q, s.set(1, 1, 1));
        housings.setMatrixAt(slot * 4 + c, m.multiplyMatrices(wear.matrix, local));
        local.compose(sockets[c], q, s.set(1, LAMP_WIRE, 1));
        wires.setMatrixAt(slot * 4 + c, m.multiplyMatrices(wear.matrix, local));
      }

      const bumper = wear.bumper;
      if (bumper) {
        // Bouncing clear of the road now and then and coming back down on it, as the taxi's does.
        bumper.lift = 0.06 * moving * Math.max(0, Math.sin(rig.phase * 1.7));
        rig.sparkIn -= dt;
        if (v > SPARK_MIN_V && bumper.lift < 0.02 && rig.sparkIn <= 0) {
          rig.sparkIn = SPARK_EVERY;
          const len = car.isTruck ? TRUCK_LEN : CAR_LEN;
          const width = car.isTruck ? TRUCK_W : CAR_W;
          bumperHinge(len, width, bumper.side, bumper.end, bumper.lift, hingePos, hingeRot);
          local.compose(hingePos, q.setFromEuler(hingeRot), s.set(1, 1, 1));
          tip.set(0, -BUMPER_H / 2, -bumperLength(width)).applyMatrix4(local).applyMatrix4(wear.matrix);
          sparks.burst(tip.x, roadY, tip.z, car.yaw + Math.PI, 1, v * 0.4);
        }
      }
    }
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  function reset() {
    for (let slot = 0; slot < POOL; slot++) release(slot);
  }

  return {
    hit, update, reset, meshes,
    /** The rig on `car`, for a check to read — null if it has not been hit. */
    rigOf: (car) => rigs.find((r) => r?.car === car) ?? null,
    active: () => active,
  };
}
