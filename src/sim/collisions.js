import {
  CAR_LEN, TRUCK_LEN, CIRCLE_OFFSET, CIRCLE_R, knockCar, shoveCar,
} from './traffic.js';

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
// visibly *hit* something, not so much that the pill is dead under the thumb.
//
// There used to be a grace period after a hit, and a rule that a car still reeling from one could
// not be touched. Both were there so the same contact was not charged every frame, and both did
// it by switching the collision off — so the taxi drove straight through a car it had just
// tapped. Contact is now resolved every frame and only *charged* once (REHIT, below).
const BUMP_KEEP = 0.45;
const STRUCK_STUN = 1.4;         // s a side-struck car sits on its brakes (sim/traffic.js `stun`)
// Headings closer than this (cosine) with the struck car in front is a rear-end, and the car is
// launched down its lane at LAUNCH × the taxi's arrival speed rather than stunned.
const REAR_END = 0.7;
const LAUNCH = 0.9;
// The shove, in u/s along the line between the two centres, and the slew in rad/s. Both capped
// again inside `knockCar`. The taxi's own recoil is a fraction of it and deliberately small: the
// player's car flying about is the player losing the road, which is a worse feeling than a dent.
const SHOVE_BASE = 2.5;
const SHOVE_PER_UNIT = 0.3;
const STRUCK_SPIN_BASE = 1.6;
const STRUCK_SPIN_PER_UNIT = 0.1;
const TAXI_RECOIL = 0.25;
const TAXI_SPIN = 0.9;

// A truck is 5.6 long against a car's 3.4, and the two circles used to sit at the car's offsets
// on it too — which left 0.7 of cab and 0.7 of cargo box at either end that nothing tested, and
// the taxi drove through them. Its circles go out to its own length, and it gets a third in the
// middle so the pair does not leave a waist.
function carCircles(car) {
  const off = car.isTruck ? TRUCK_LEN * 0.28 : CIRCLE_OFFSET;
  const fx = Math.cos(car.yaw) * off;
  const fz = -Math.sin(car.yaw) * off;
  const circles = [
    { x: car.x + fx, z: car.z + fz },
    { x: car.x - fx, z: car.z - fz },
  ];
  if (car.isTruck) circles.push({ x: car.x, z: car.z });
  return circles;
}

// The deepest overlapping pair of circles between the two bodies, as a depth, the unit normal
// pointing from `a` into `b`, and the contact point (cx, cz) — the middle of the overlap between
// those two circles, which is where the bodies are actually touching — or null if they do not.
// The point matters for the effects: the midpoint of the two cars' *centres* sits in the middle of
// one of them on a T-bone, a unit and a half from the door that took the hit. Exported for tools/lab.mjs.
export function penetration(a, b) {
  const reach = CIRCLE_R * 2;
  let best = null;
  for (const p of carCircles(a)) {
    for (const q of carCircles(b)) {
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;
      const d = Math.sqrt(d2);
      const depth = reach - d;
      if (best && depth <= best.depth) continue;
      const nx = d > 1e-6 ? dx / d : Math.cos(a.yaw);
      const nz = d > 1e-6 ? dz / d : -Math.sin(a.yaw);
      const reachIn = CIRCLE_R - depth / 2;
      best = { depth, nx, nz, cx: p.x + nx * reachIn, cz: p.z + nz * reachIn };
    }
  }
  return best;
}

// How long two bodies have to be apart before touching again counts as a new hit. Contact is one
// hit however long it lasts — a taxi bulldozing a car down the road pays for the impact, not for
// every frame of the shove — and a separation shorter than this is the same contact flickering.
const REHIT = 0.35;          // s

export function createCollisions(cars, taxi) {
  const listeners = [];
  const bumpListeners = [];
  const onImpact = (cb) => { listeners.push(cb); };
  const onBump = (cb) => { bumpListeners.push(cb); };
  const emit = (event) => { for (const cb of listeners) cb(event); };
  // Sim seconds, and when each car last touched the taxi on that clock.
  let clock = 0;
  const lastTouch = new Map();

  function update(dt = 1 / 60) {
    clock += dt;
    // Nothing to detect unless the taxi has left the safety of its lane. A crashed taxi is done
    // for good, and so is anything it has already hit.
    if (taxi.crashed) return;
    if (!taxi.boost) return;

    for (const other of cars) {
      if (other === taxi) continue;
      if (other.crashed) continue;
      // Cheap broad phase before the circle-vs-circle work — wide enough for a truck.
      const reach = (CAR_LEN + TRUCK_LEN) / 2 + CIRCLE_R;
      if (Math.abs(other.x - taxi.x) > reach || Math.abs(other.z - taxi.z) > reach) continue;
      const pen = penetration(taxi, other);
      if (!pen) continue;

      const touched = lastTouch.get(other);
      lastTouch.set(other, clock);
      const fresh = touched === undefined || clock - touched > REHIT;

      // Still leaning on something it has already paid for: push it out of the way and carry on.
      // Every frame of contact does this, which is what stops the taxi ever passing through a car.
      if (!fresh && taxi.hp != null) {
        shoveCar(other, pen.nx * pen.depth, pen.nz * pen.depth);
        continue;
      }

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
          bump(other, closing, damage, pen.cx, pen.cz, pen);
          continue;
        }
        // Out of hit points: this one is the wreck, through exactly the path it always was.
      }

      // Both cars are wrecked. `crashed` is what takes a car out of the simulation entirely —
      // every loop in traffic.js skips it — so neither body drives, queues or is queued behind
      // again. main.js detonates each one and leaves both shells lying in the road, then ends the
      // run. (Every hit before this one is a bump — see `bump` below.)
      taxi.crashed = true;
      taxi.boost = false;
      taxi.v = 0;
      other.crashed = true;
      other.v = 0;

      emit({ x: px, z: pz, speed, taxi, other });
      return;   // one impact per frame is plenty — the taxi is done anyway.
    }
  }

  function bump(other, closing, damage, px, pz, pen) {
    // Shoved along the contact normal, which gives every angle of hit the answer it wants without
    // a case per angle: a rear-end pushes the car on down its lane, a T-bone pushes it sideways
    // off its line.
    const { nx, nz } = pen;
    shoveCar(other, nx * pen.depth, nz * pen.depth);
    // Which side of the taxi's line the car was on, as in main.js's wreck: struck on its left it is
    // turned right, and the taxi recoils the other way.
    const fx = Math.cos(taxi.yaw);
    const fz = -Math.sin(taxi.yaw);
    const side = Math.sign(fx * (other.z - taxi.z) - fz * (other.x - taxi.x)) || 1;
    const speed = taxi.v;
    // A rear-end is two cars pointing the same way with the struck one in front — read off the
    // headings, not the contact normal, because the normal comes from whichever pair of circles is
    // deepest and leans toward the struck car's own axis whenever the taxi's nose lands near one
    // of its circles: a square T-bone measured 0.82 "along" by the normal. A car hit from behind
    // is *launched* — it takes the taxi's speed and pulls away, which is what separates the two
    // and gives a rear-end its kick — and is not stunned, because a car stopped dead in front of a
    // boosting taxi would be hit again the moment the contact lapsed. A car hit in the side is the
    // one that spins and sits.
    const ofx = Math.cos(other.yaw);
    const ofz = -Math.sin(other.yaw);
    const rearEnd = fx * ofx + fz * ofz > REAR_END
      && (other.x - taxi.x) * ofx + (other.z - taxi.z) * ofz > 0;
    const square = Math.max(0, nx * ofx + nz * ofz);
    if (rearEnd) other.v = Math.max(other.v, speed * LAUNCH);
    const shove = SHOVE_BASE + closing * SHOVE_PER_UNIT;
    // The launch already carries a rear-ended car down its lane, so only the sideways part of the
    // normal is left for the knock to throw — shoving it forward as well would double the push.
    const lx = rearEnd ? nx - ofx * square : nx;
    const lz = rearEnd ? nz - ofz * square : nz;
    knockCar(other, lx * shove, lz * shove,
      side * (STRUCK_SPIN_BASE + closing * STRUCK_SPIN_PER_UNIT) * (rearEnd ? 0.4 : 1),
      rearEnd ? 0 : STRUCK_STUN);
    knockCar(taxi, -nx * shove * TAXI_RECOIL, -nz * shove * TAXI_RECOIL, -side * TAXI_SPIN);
    taxi.v *= BUMP_KEEP;
    for (const cb of bumpListeners) {
      cb({ x: px, z: pz, speed, closing, damage, hp: taxi.hp, taxi, other, nx, nz, rearEnd });
    }
  }

  return { update, onImpact, onBump };
}
