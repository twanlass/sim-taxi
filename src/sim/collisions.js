import { CAR_LEN, CAR_W } from './traffic.js';

// Collision detection between the taxi and ambient cars. Deliberately narrow: only the taxi is
// checked, and only while boosting — everywhere else the lane bookkeeping and following-distance
// rules keep cars apart by construction, so a global pairwise sweep would only ever fire on false
// positives (a car queued behind another at MIN_GAP is *almost* touching by design).
//
// Bodies are approximated as a pair of circles per car, offset ±CAR_LEN/4 along the yaw axis.
// A full OBB SAT test would be more accurate at odd angles, but cars are axis-aligned almost all
// the time and the two-circle proxy is a few lines instead of a helper file. The taxi is a small
// bit *further* inset (its lateral offset already reads as being out of the lane) so a graze on
// the boost line doesn't count.

const CIRCLE_OFFSET = CAR_LEN * 0.28;
const CIRCLE_R = CAR_W * 0.55;

// One stun packet drives both the drift physics and the post-recovery cooldown — see
// recoverFromStun in traffic.js. Values picked so the pair visibly separates before either car
// re-enters the lane grid, and the taxi can't hit the same car again immediately.
const STUN_DURATION = 0.7;
const STUN_COOLDOWN = 0.9;
const KICK_SPEED = 6;
const YAW_KICK = 1.4;

function carCircles(car) {
  const fx = Math.cos(car.yaw) * CIRCLE_OFFSET;
  const fz = -Math.sin(car.yaw) * CIRCLE_OFFSET;
  return [
    { x: car.x + fx, z: car.z + fz },
    { x: car.x - fx, z: car.z - fz },
  ];
}

function overlap(a, b) {
  const ac = carCircles(a);
  const bc = carCircles(b);
  const rr = (CIRCLE_R * 2) * (CIRCLE_R * 2);
  for (const p of ac) {
    for (const q of bc) {
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < rr) return true;
    }
  }
  return false;
}

export function createCollisions(cars, taxi) {
  const listeners = [];
  const onImpact = (cb) => { listeners.push(cb); };
  const emit = (event) => { for (const cb of listeners) cb(event); };

  function update() {
    // Nothing to detect unless the taxi has left the safety of its lane. A crashed taxi is done
    // for good; a still-stunned other car is already spinning out from the last hit.
    if (taxi.crashed) return;
    if (!taxi.boost || taxi.stunned || taxi.collisionCooldown > 0) return;

    for (const other of cars) {
      if (other === taxi) continue;
      if (other.stunned || other.collisionCooldown > 0) continue;
      // Cheap broad phase before the circle-vs-circle work.
      if (Math.abs(other.x - taxi.x) > CAR_LEN || Math.abs(other.z - taxi.z) > CAR_LEN) continue;
      if (!overlap(taxi, other)) continue;

      const nx = taxi.x - other.x;
      const nz = taxi.z - other.z;
      const nlen = Math.hypot(nx, nz) || 1;
      const ux = nx / nlen;
      const uz = nz / nlen;

      const px = (taxi.x + other.x) / 2;
      const pz = (taxi.z + other.z) / 2;

      // Taxi is wrecked — main.js hides the mesh, kicks the smoke and sparks, and ends the run.
      // The other car still stuns and snaps back onto a lane afterward.
      taxi.crashed = true;
      taxi.boost = false;
      taxi.v = 0;
      other.stunned = {
        timeLeft: STUN_DURATION,
        vx: -ux * KICK_SPEED,
        vz: -uz * KICK_SPEED,
        yawRate: -YAW_KICK,
        postCooldown: STUN_COOLDOWN,
      };

      emit({ x: px, z: pz, taxi, other });
      return;   // one impact per frame is plenty — the taxi is done anyway.
    }
  }

  return { update, onImpact };
}
