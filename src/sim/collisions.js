import { CAR_LEN, CAR_W } from './traffic.js';

// Collision detection between the taxi and ambient cars. Deliberately narrow: only the taxi is
// checked, and only while boosting — everywhere else the lane bookkeeping and following-distance
// rules keep cars apart by construction, so a global pairwise sweep would only ever fire on false
// positives (a car queued behind another at MIN_GAP is *almost* touching by design).
//
// Bodies are approximated as a pair of circles per car, offset ±CAR_LEN/4 along the yaw axis.
// A full OBB SAT test would be more accurate at odd angles, but cars are axis-aligned almost all
// the time and the two-circle proxy is a few lines instead of a helper file.
//
// Radius 0.68·CAR_W puts the summed envelope at 2.31 units, comfortably wider than the 1.87 that
// 0.55 gave — at 0.55 cars glided through each other at odd angles and the mode produced almost
// no impacts at all.
//
// What that envelope catches has changed. It was tuned when a boosting taxi drove the road
// centreline: leaders sat 2 units to one side and oncoming traffic 2 to the other, so 2.31
// overlapped *every* straight-road encounter and Loco Mode was less a skill than a lottery over
// which car you died on. The taxi now weaves inside its own lane (see SWERVE_* in traffic.js) and
// tailgates at BOOST_GAP, so same-road traffic clears: a leader is ≥4.5 back, oncoming is a lane
// away at ~3.5 even at the weave's peak. What is left is what the player can read and avoid —
// cross traffic in a junction being run, and cars turning across the taxi's path. Measured over
// 18 minutes of continuous boosting, that took the crash rate from one every 9.7s to one every
// 25.1s. Ambient-vs-ambient never runs through here, so the width is safe for lane-following
// queues (MIN_GAP still gives ~1 unit of longitudinal clearance).
const CIRCLE_OFFSET = CAR_LEN * 0.28;
const CIRCLE_R = CAR_W * 0.68;

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
    // for good, and so is anything it has already hit.
    if (taxi.crashed) return;
    if (!taxi.boost) return;

    for (const other of cars) {
      if (other === taxi) continue;
      if (other.crashed) continue;
      // Cheap broad phase before the circle-vs-circle work.
      if (Math.abs(other.x - taxi.x) > CAR_LEN || Math.abs(other.z - taxi.z) > CAR_LEN) continue;
      if (!overlap(taxi, other)) continue;

      const px = (taxi.x + other.x) / 2;
      const pz = (taxi.z + other.z) / 2;
      // Read before the two lines below zero it. Everything the crash throws downfield is sized
      // off how fast the taxi arrived — the fireball's drift, the shards, the tyres, both shells
      // and the smoke collar (see util/carry.js) — and once `taxi.v` is zeroed there is nothing
      // left in the world to recover it from: the listener runs after the fact and both cars are
      // out of the sim by then.
      const speed = taxi.v;

      // Both cars are wrecked. `crashed` is what takes a car out of the simulation entirely —
      // every loop in traffic.js skips it — so neither body drives, queues or is queued behind
      // again. main.js detonates each one and shrink-fades the two shells out from under the
      // fireballs, then ends the run.
      //
      // The car used to be merely stunned: kicked sideways, spun out, then snapped back onto a
      // lane and driven off. Two cars meet at a combined ~30 u/s, one is scrap and the other
      // shakes it off and carries on — the survivor made the taxi's own wreck look arbitrary.
      taxi.crashed = true;
      taxi.boost = false;
      taxi.v = 0;
      other.crashed = true;
      other.v = 0;

      emit({ x: px, z: pz, speed, taxi, other });
      return;   // one impact per frame is plenty — the taxi is done anyway.
    }
  }

  return { update, onImpact };
}
