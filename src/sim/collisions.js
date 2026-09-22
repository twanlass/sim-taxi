import { CAR_LEN, CIRCLE_OFFSET, CIRCLE_R, knockCar } from './traffic.js';

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
//
// Both constants now live in `traffic.js`. Not because they belong there — this is where they are
// used — but because the overtake has to *steer by* them, and this file already imports from that
// one. Two copies is two numbers that drift, and the copy that drifts is the one nobody runs: this
// detector would go on firing at its own width while the manoeuvre aimed itself at the other.

// --- Hit points ---------------------------------------------------------------
//
// The taxi can take a few hits before one wrecks it. `taxi.hp` is opt-in: main.js arms it at the
// start of a run, and a taxi without one keeps the old rule that the first contact is the wreck.
// That is deliberate — tools/lab.mjs and tools/probe.mjs measure Loco Mode by *when it first
// touches something*, and every number they have written down is in that currency.
//
// Damage is priced off the closing speed rather than a flat count, so the same button is riskier
// the harder it is leant on. Worked through against the speeds that actually happen, at 100 HP:
//   rear-ending a car at boost cruise (~19 against 8.5, closing ~10.5)   → 24, four of those
//   T-boning cross traffic at boost cruise (closing ~21)                   → 37, three
//   anything in the overdrive band (closing 30+)                           → 49–55, two
// so a clumsy tailgate is forgiven a few times and a red light run flat out is not.
export const TAXI_HP = 100;
const BUMP_BASE = 10;
const BUMP_PER_UNIT = 1.3;       // HP per u/s of closing speed
const BUMP_MIN = 12;
const BUMP_MAX = 60;
export const bumpDamage = (closing) =>
  Math.round(Math.max(BUMP_MIN, Math.min(BUMP_MAX, BUMP_BASE + closing * BUMP_PER_UNIT)));

// What a survivable hit does to the two cars. The taxi keeps under half its speed — enough that it
// visibly *hit* something, not so much that the pill is dead under the thumb — and gets a short
// grace in which it cannot be hit again, because it is still overlapping the car it just shunted
// and would otherwise take the same bump every frame until the two had slid apart.
const BUMP_KEEP = 0.45;
const BUMP_GRACE = 0.8;          // s
const STRUCK_STUN = 1.4;         // s the struck car sits on its brakes (sim/traffic.js `stun`)
// The shove, in u/s along the line between the two centres, and the slew in rad/s. Both capped
// again inside `knockCar`. The taxi's own recoil is a fraction of it and deliberately small: the
// player's car flying about is the player losing the road, which is a worse feeling than a dent.
const SHOVE_BASE = 2.5;
const SHOVE_PER_UNIT = 0.3;
const STRUCK_SPIN_BASE = 1.6;
const STRUCK_SPIN_PER_UNIT = 0.1;
const TAXI_RECOIL = 0.25;
const TAXI_SPIN = 0.9;

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
  const bumpListeners = [];
  const onImpact = (cb) => { listeners.push(cb); };
  const onBump = (cb) => { bumpListeners.push(cb); };
  const emit = (event) => { for (const cb of listeners) cb(event); };
  let grace = 0;

  function update(dt = 1 / 60) {
    grace = Math.max(0, grace - dt);
    // Nothing to detect unless the taxi has left the safety of its lane. A crashed taxi is done
    // for good, and so is anything it has already hit.
    if (taxi.crashed) return;
    if (!taxi.boost) return;
    if (grace > 0) return;

    for (const other of cars) {
      if (other === taxi) continue;
      if (other.crashed) continue;
      // A car still reeling from the last bump is out of play until it has pulled itself together
      // — the grace above covers the taxi, and this covers a taxi that is still stuck to it after.
      if (other.knock) continue;
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

      if (taxi.hp != null) {
        // Closing speed, not the taxi's own: a car driving away from the bumper is a nudge, one
        // crossing in front of it is not.
        const rvx = Math.cos(taxi.yaw) * taxi.v - Math.cos(other.yaw) * other.v;
        const rvz = -Math.sin(taxi.yaw) * taxi.v + Math.sin(other.yaw) * other.v;
        const closing = Math.hypot(rvx, rvz);
        const damage = bumpDamage(closing);
        taxi.hp = Math.max(0, taxi.hp - damage);
        if (taxi.hp > 0) {
          bump(other, closing, damage, px, pz);
          return;
        }
        // Out of hit points: this one is the wreck, through exactly the path it always was.
      }

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

  function bump(other, closing, damage, px, pz) {
    // Shoved directly away from the taxi, which gives every angle of hit the answer it wants
    // without a case per angle: a rear-end pushes the car on down its lane, a T-bone pushes it
    // sideways off its line.
    let nx = other.x - taxi.x;
    let nz = other.z - taxi.z;
    const n = Math.hypot(nx, nz);
    if (n > 1e-6) { nx /= n; nz /= n; } else { nx = Math.cos(taxi.yaw); nz = -Math.sin(taxi.yaw); }
    // Which side of the taxi's line the car was on, as in main.js's wreck: struck on its left it is
    // turned right, and the taxi recoils the other way.
    const fx = Math.cos(taxi.yaw);
    const fz = -Math.sin(taxi.yaw);
    const side = Math.sign(fx * (other.z - taxi.z) - fz * (other.x - taxi.x)) || 1;
    const shove = SHOVE_BASE + closing * SHOVE_PER_UNIT;
    knockCar(other, nx * shove, nz * shove,
      side * (STRUCK_SPIN_BASE + closing * STRUCK_SPIN_PER_UNIT), STRUCK_STUN);
    knockCar(taxi, -nx * shove * TAXI_RECOIL, -nz * shove * TAXI_RECOIL, -side * TAXI_SPIN);
    const speed = taxi.v;
    taxi.v *= BUMP_KEEP;
    grace = BUMP_GRACE;
    for (const cb of bumpListeners) {
      cb({ x: px, z: pz, speed, closing, damage, hp: taxi.hp, taxi, other });
    }
  }

  return { update, onImpact, onBump };
}
