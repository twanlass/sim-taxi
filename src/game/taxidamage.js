import * as THREE from 'three';
import { color } from '../palette.js';

// The taxi wearing its damage — three tiers, each keyed to the HP bar's own colour steps so the car
// itself doubles as the gauge. See buildDamage() in geometry/taxi.js for the parts and why they are
// what they are (silhouette, because at ~30px long nothing finer reads).
//
//   1  any hit      the roof sign is knocked crooked
//   2  ≤ 67% (amber) the boot lid is up and bouncing, and a bumper hangs off the back dragging sparks
//
// And one piece off the tiers: **rear-ending a car pops the bonnet**, whatever the bar says, and it
// flaps on the same spring as the boot for the rest of the run. It belongs to the kind of hit rather
// than to the running total — a nose driven into a boot is the one collision that obviously bursts a
// bonnet catch — which also gives the first tier something louder than a crooked sign when the first
// hit is the commonest one in Loco Mode.
//   3  ≤ 34% (red)   smoke off the bonnet going from steam to black, the sign sputtering, and the car
//                   sitting low on its damaged side and rattling
//
// Each tier *adds* a distinct ingredient rather than turning the previous one up, so which tier the
// car is in can be read off it at a glance. All of it is render-only: the sim never learns the car is
// damaged, so none of this can move a car off its lane or change a speed.

const MID = 0.67;                 // matches game/hpmeter.js
const LOW = 0.34;

const SIGN_ROLL = 0.26;           // rad, first hit
const SIGN_ROLL_STEP = 0.07;      // each later one
const SIGN_ROLL_MAX = 0.45;
const SIGN_YAW = 0.18;

// The boot lid is a damped spring on its hinge, not a sine: it rides open at BOOT_REST, gets kicked
// by the road, by the car braking and accelerating, and by every hit, and when it swings shut it
// *slams* against the body and bounces back up. The first cut was a two-sine wobble of ±0.2 rad,
// which read as a lid that was open — the bounce is what says it is broken. Underdamped on purpose
// (ζ ≈ 0.2): a kick rings for three or four flaps before it settles.
const BOOT_REST = 0.6;            // rad, where the lid hangs when nothing is moving it
const BOOT_MAX = 1.35;            // rad, about as far as the hinge goes
const BOOT_K = 55;                // 1/s², spring toward rest
const BOOT_C = 3;                 // 1/s, damping
const BOOT_SLAM = 0.55;           // of the swing kept when it hits the body and bounces
const BOOT_ROAD = [0.12, 0.35];   // s between road kicks at speed
const BOOT_ROAD_KICK = 7;         // rad/s per kick at full speed
const BOOT_ACCEL = 1.2;           // rad/s² on the lid per u/s² of the car's own acceleration
const BOOT_HIT_KICK = 14;         // rad/s, on every bump — it slams shut and flies open
// The bonnet rides the same spring. It rests a little lower — a raised bonnet is in front of the
// windscreen, and a lid that stood as high as the boot's hid the cabin at this camera — and its first
// kick is *up*: the catch lets go and it flies open off the body, where the boot's is a slam.
const HOOD_REST = 0.45;
const HOOD_POP = 11;              // rad/s, the burst catch
const SPARK_EVERY = 0.045;        // s between bursts off the bumper while it is dragging
const SPARK_MIN_V = 2.5;          // u/s — a bumper at walking pace scrapes, it does not spark

const SMOKE_SLOW = 0.2;           // s between puffs at the top of the red
const SMOKE_FAST = 0.06;          // ... and at the bottom
const LEAN = 0.07;                // rad of list toward the damaged side
const LEAN_SINK = 0.05;           // units the body drops on that side
const RATTLE = 0.035;             // rad of shake at speed
const RATTLE_BOB = 0.03;          // units
const FLICKER_MEAN = 0.5;         // s between sputters
const FLICKER_OUT = [0.04, 0.14]; // s each dropout lasts

export function createTaxiDamage({ damage, group, taxi, maxHp, sparks, dust, roadY, rng = Math.random }) {
  const smokeLight = color('damageSmokeLight');
  const smokeDark = color('damageSmokeDark');
  const smokeTint = new THREE.Color();
  const tip = new THREE.Vector3();

  let hits = 0;
  // Hits per corner, keyed `${end},${side}` — end +1 the nose, side +1 the right. The bumper hangs
  // off the worst one, its free end dragging at that corner, and the list and the sign lean that
  // way; a tie goes to the corner hit last.
  const corners = new Map();
  let worst = { end: -1, side: 1 };
  let side = 1;
  let phase = 0;
  let sparkIn = 0;
  let smokeIn = 0;
  let flickerIn = FLICKER_MEAN;
  let flickerOut = 0;
  // One spring per lid. Separate road-kick clocks, so the two do not flap in step.
  const boot = { angle: BOOT_REST, v: 0, roadIn: 0, rest: BOOT_REST };
  const hood = { angle: 0, v: 0, roadIn: 0.1, rest: HOOD_REST, open: false };
  let lastV = 0;

  function stepLid(lid, dt, moving, accel) {
    // Road kicks, both ways, more often and harder the faster the car goes.
    lid.roadIn -= dt;
    if (lid.roadIn <= 0 && moving > 0.05) {
      lid.roadIn = BOOT_ROAD[0] + (BOOT_ROAD[1] - BOOT_ROAD[0]) * rng();
      lid.v += (rng() - 0.35) * 2 * BOOT_ROAD_KICK * moving;
    }
    // The car's own acceleration swings it — clamped, because a bump drops the car's speed in one
    // frame and reads as hundreds of u/s²; the hit has a kick of its own.
    lid.v += Math.max(-40, Math.min(40, accel)) * BOOT_ACCEL * dt;
    lid.v += (-BOOT_K * (lid.angle - lid.rest) - BOOT_C * lid.v) * dt;
    lid.angle += lid.v * dt;
    if (lid.angle < 0) { lid.angle = 0; lid.v = -lid.v * BOOT_SLAM; }
    if (lid.angle > BOOT_MAX) { lid.angle = BOOT_MAX; lid.v = -lid.v * BOOT_SLAM; }
  }

  const fraction = () => (taxi.hp ?? maxHp) / maxHp;
  const tier = () => {
    if (!hits) return 0;
    const f = fraction();
    return f <= LOW ? 3 : f <= MID ? 2 : 1;
  };

  /** A bump landed at world (x, z). `rearEnd` is the taxi's nose into the back of another car. */
  function hit(x, z, { rearEnd = false } = {}) {
    // Into the car's own frame: +lx toward the nose, +lz toward its right. The same basis the sim
    // uses, (cos yaw, −sin yaw) forward and (sin yaw, cos yaw) right.
    const dx = x - taxi.x;
    const dz = z - taxi.z;
    const lx = dx * Math.cos(taxi.yaw) - dz * Math.sin(taxi.yaw);
    const lz = dx * Math.sin(taxi.yaw) + dz * Math.cos(taxi.yaw);
    const key = `${lx >= 0 ? 1 : -1},${lz >= 0 ? 1 : -1}`;
    corners.set(key, (corners.get(key) ?? 0) + 1);
    let top = -1;
    for (const [k, n] of corners) {
      if (n > top || (n === top && k === key)) {
        top = n;
        const [end, s] = k.split(',').map(Number);
        worst = { end, side: s };
      }
    }
    side = worst.side;
    hits += 1;
    // Down hard, so the slam and the bounce off it are the first thing the lid does.
    boot.v -= BOOT_HIT_KICK;
    if (hood.open) {
      hood.v -= BOOT_HIT_KICK;
    } else if (rearEnd) {
      hood.open = true;
      hood.angle = 0;
      hood.v = HOOD_POP;
    }
    // Knocked the way the blow came from, a little further each time.
    const roll = Math.min(SIGN_ROLL_MAX, SIGN_ROLL + SIGN_ROLL_STEP * (hits - 1));
    damage.setSignTilt(-side * roll, (lx >= 0 ? 1 : -1) * SIGN_YAW);
  }

  /**
   * Once a frame, after the sim has written the taxi's transform — the lean and the rattle are
   * added on top of it, and it is rewritten from scratch next frame, so nothing accumulates.
   */
  function update(dt) {
    if (taxi.crashed) return;
    const t = tier();
    const v = Math.max(0, taxi.v ?? 0);
    const moving = Math.min(1, v / 8);
    phase += dt * (5 + v * 0.7);

    const accel = dt > 1e-6 ? (v - lastV) / dt : 0;
    lastV = v;
    if (hood.open) {
      stepLid(hood, dt, moving, accel);
      damage.setHood(hood.angle);
    } else {
      damage.setHood(null);
    }
    if (t >= 2) {
      stepLid(boot, dt, moving, accel);
      damage.setBoot(boot.angle);
      // The bumper bounces clear of the road now and then and comes back down on it.
      const lift = 0.06 * moving * Math.max(0, Math.sin(phase * 1.7));
      // Hinged on the far side so its free end — the one throwing sparks — is at the damaged corner.
      damage.setBumper(-worst.side, worst.end, lift);
      sparkIn -= dt;
      const airborne = taxi.hopFrom != null;
      if (v > SPARK_MIN_V && !airborne && lift < 0.02 && sparkIn <= 0) {
        sparkIn = SPARK_EVERY;
        group.updateMatrixWorld(true);
        damage.bumperTip(tip);
        sparks.burst(tip.x, roadY, tip.z, taxi.yaw + Math.PI, 2, v * 0.4);
      }
    } else {
      // Held at rest until the lid is actually loose, so a hit's kick taken in the first tier does
      // not bank up and fire the moment the car reaches amber.
      boot.angle = BOOT_REST;
      boot.v = 0;
      damage.setBoot(null);
      damage.setBumper(0);
    }

    if (t >= 3) {
      const f = fraction();
      // 0 at the top of the red, 1 at empty.
      const worse = Math.min(1, Math.max(0, 1 - f / LOW));
      smokeIn -= dt;
      if (smokeIn <= 0) {
        smokeIn = SMOKE_SLOW + (SMOKE_FAST - SMOKE_SLOW) * worse;
        smokeTint.copy(smokeLight).lerp(smokeDark, worse);
        const ahead = 1.2;
        // Bigger than the old one-size wisp (0.35), which could not be picked out even zoomed in:
        // a puff has to be a few pixels across at play zoom to register as smoke rather than grit.
        dust.add(taxi.x + Math.cos(taxi.yaw) * ahead, taxi.z - Math.sin(taxi.yaw) * ahead,
          taxi.yaw, 0.6 + 0.4 * worse, 0.25, smokeTint, roadY + 1.1);
      }

      // The sign sputters — out for a few frames, back, out again.
      if (flickerOut > 0) {
        flickerOut -= dt;
        if (flickerOut <= 0) damage.setSignOut(false);
      } else {
        flickerIn -= dt;
        if (flickerIn <= 0) {
          flickerIn = FLICKER_MEAN * (0.3 + 1.4 * rng());
          flickerOut = FLICKER_OUT[0] + (FLICKER_OUT[1] - FLICKER_OUT[0]) * rng();
          damage.setSignOut(true);
        }
      }

      // Low on the damaged side, and rattling. Roll + tips the top toward the car's right (see the
      // lean notes in sim/traffic.js), so the list toward `side` is +side.
      const shake = RATTLE * moving * (Math.sin(phase * 7.3) * 0.6 + Math.sin(phase * 11.1) * 0.4);
      group.rotation.x += side * LEAN + shake;
      group.position.y += -LEAN_SINK + RATTLE_BOB * moving * Math.sin(phase * 9.7);
    } else if (flickerOut > 0) {
      flickerOut = 0;
      damage.setSignOut(false);
    }
  }

  function reset() {
    hits = 0;
    boot.angle = BOOT_REST;
    boot.v = 0;
    hood.open = false;
    hood.angle = 0;
    hood.v = 0;
    corners.clear();
    worst = { end: -1, side: 1 };
    side = 1;
    damage.reset();
  }

  return {
    hit, update, reset, tier,
    bootAngle: () => boot.angle,
    hoodAngle: () => (hood.open ? hood.angle : null),
  };
}
