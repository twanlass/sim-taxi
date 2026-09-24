import * as THREE from 'three';
import { color } from '../palette.js';
import { TAXI_DECK_Y } from '../geometry/taxi.js';

// The taxi wearing its damage — four steps down its hit points, so the car itself is the gauge. See buildDamage() in geometry/taxi.js for the parts and why they are
// what they are (silhouette, because at ~30px long nothing finer reads).
//
//   1  any hit      the lamp at the corner that was struck is shaken out of its socket and swings
//                   on its wire — still lit, still blinking, still braking
//   2  ≤ 67%        the boot lid is up and bouncing, and a bumper hangs off the back dragging sparks
//
// And one piece off the tiers: **rear-ending a car pops the bonnet**, however much HP is left, and it
// flaps on the same spring as the boot for the rest of the run. It belongs to the kind of hit rather
// than to the running total — a nose driven into a boot is the one collision that obviously bursts a
// bonnet catch — which also gives the first tier something louder than a swinging lamp when the first
// hit is the commonest one in Loco Mode.
//   3  ≤ 34%        smoke off the bonnet going from steam to black, and the car
//                   sitting low on its damaged side and rattling
//   4  ≤ 20%        and under all of that, a thin dark plume that never stops — the car is one
//                   hit from the wreck
//
// **This is the whole of the health display.** There was a bar in the HUD, and it came out: the
// point of the damage is that the car says how hurt it is without the player looking away from it,
// and a bar beside it turned the car into decoration for a number. So each step has to be visible at
// play zoom on its own, and the last one has to be unmistakable.
//
// Each tier *adds* a distinct ingredient rather than turning the previous one up, so which tier the
// car is in can be read off it at a glance. All of it is render-only: the sim never learns the car is
// damaged, so none of this can move a car off its lane or change a speed.

const MID = 0.67;
const LOW = 0.34;
// The last warning. The billows above come and go in puffs; this is a stream — small, dark, one
// every PLUME_EVERY whatever the car is doing, standing or driving — so a car that is nearly done
// is never seen without it. The pool is 200 puffs of a second each; 25 a second is an eighth of it.
const CRITICAL = 0.2;
const PLUME_EVERY = 0.04;         // s
const PLUME_SIZE = 0.8;
// Where the smoke comes from: just above the bonnet, which is the top of the body — TAXI_DECK_Y, 1.77
// with TAXI_SCALE in — and a little behind the nose. The first cut spawned it at road + 1.1, *inside*
// the body; a puff rises well under a unit a second at this size and lives about one, so every one of
// them faded out before it had climbed clear of the car and not a wisp was ever on screen.
const SMOKE_Y = TAXI_DECK_Y + 0.1;
const SMOKE_AHEAD = 1.1;
// How much of the dust pool's backward throw the smoke keeps: a column off a parked car, a trail off
// a moving one. See `drift` on `add` in game/dust.js.
const smokeDrift = (moving) => 0.15 + 0.85 * moving;

// A loose lamp is a pendulum on its wire, swinging fore and aft. Stiffer than a real one on a wire
// this short would be, so it reads as swinging rather than jittering at play zoom — about a swing
// and a half a second — and kicked the same three ways the lids are: the car's own acceleration
// (a car pulling away leaves a hanging lamp behind), the road, and every hit.
const LAMP_G = 30;                // effective gravity over the wire's length, 1/s²
const LAMP_C = 1.6;               // 1/s, damping
const LAMP_ACCEL = 0.9;           // rad/s² per u/s² of the car's acceleration
const LAMP_ROAD_KICK = 3;         // rad/s per road kick at full speed
const LAMP_HIT_KICK = 6;          // rad/s, on every hit
// It swings freely outward, away from the car, and only a little way back in before it clacks off
// the bumper face it hangs in front of. A symmetric limit let it swing clean through the body.
const LAMP_OUT = 1.2;             // rad, away from the car
const LAMP_IN = 0.35;             // rad, toward it
const LAMP_CLACK = 0.45;          // of the swing kept off the bumper

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

export function createTaxiDamage({ damage, group, taxi, maxHp, sparks, dust, roadY, rng = Math.random }) {
  const smokeLight = color('damageSmokeLight');
  const smokeDark = color('damageSmokeDark');
  const smokeTint = new THREE.Color();
  const tip = new THREE.Vector3();

  let hits = 0;
  // Hits per corner, keyed `${end},${side}` — end +1 the nose, side +1 the right. The bumper hangs
  // off the worst one, its free end dragging at that corner, and the list leans that
  // way; a tie goes to the corner hit last.
  const corners = new Map();
  let worst = { end: -1, side: 1 };
  let side = 1;
  let phase = 0;
  let sparkIn = 0;
  let smokeIn = 0;
  let plumeIn = 0;
  // Loose lamps by corner key, each its own pendulum.
  const lamps = new Map();
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
    // The lamp at the struck corner comes loose — and one already loose takes the knock.
    const lamp = lamps.get(key);
    if (lamp) {
      lamp.v += (rng() - 0.5) * 2 * LAMP_HIT_KICK;
    } else {
      // Out of the socket with a fling away from the car, so it swings out, comes back and clacks.
      const [end, s] = key.split(',').map(Number);
      lamps.set(key, { end, side: s, angle: 0, v: end * LAMP_HIT_KICK, roadIn: rng() * 0.3 });
    }
  }

  function stepLamps(dt, moving, accel) {
    for (const lamp of lamps.values()) {
      lamp.roadIn -= dt;
      if (lamp.roadIn <= 0 && moving > 0.05) {
        lamp.roadIn = BOOT_ROAD[0] + (BOOT_ROAD[1] - BOOT_ROAD[0]) * rng();
        lamp.v += (rng() - 0.5) * 2 * LAMP_ROAD_KICK * moving;
      }
      const a = Math.max(-40, Math.min(40, accel));
      lamp.v += (-LAMP_G * Math.sin(lamp.angle) - LAMP_C * lamp.v - a * LAMP_ACCEL * Math.cos(lamp.angle)) * dt;
      lamp.angle += lamp.v * dt;
      // Angles are + toward the nose, so outward is +end.
      const lo = lamp.end > 0 ? -LAMP_IN : -LAMP_OUT;
      const hi = lamp.end > 0 ? LAMP_OUT : LAMP_IN;
      if (lamp.angle < lo) { lamp.angle = lo; lamp.v = -lamp.v * LAMP_CLACK; }
      if (lamp.angle > hi) { lamp.angle = hi; lamp.v = -lamp.v * LAMP_CLACK; }
      damage.setLamp(lamp.end, lamp.side, lamp.angle);
    }
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
    stepLamps(dt, moving, accel);
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
        // Bigger than the old one-size wisp (0.35), which could not be picked out even zoomed in:
        // a puff has to be a few pixels across at play zoom to register as smoke rather than grit.
        dust.add(taxi.x + Math.cos(taxi.yaw) * SMOKE_AHEAD, taxi.z - Math.sin(taxi.yaw) * SMOKE_AHEAD,
          taxi.yaw, 0.9 + 0.5 * worse, 0.25, smokeTint, roadY + SMOKE_Y, smokeDrift(moving));
      }

      if (f <= CRITICAL) {
        plumeIn -= dt;
        if (plumeIn <= 0) {
          plumeIn = PLUME_EVERY;
          dust.add(taxi.x + Math.cos(taxi.yaw) * SMOKE_AHEAD, taxi.z - Math.sin(taxi.yaw) * SMOKE_AHEAD,
            taxi.yaw, PLUME_SIZE, 0.08, smokeDark, roadY + SMOKE_Y, smokeDrift(moving));
        }
      }

      // Low on the damaged side, and rattling. Roll + tips the top toward the car's right (see the
      // lean notes in sim/traffic.js), so the list toward `side` is +side.
      const shake = RATTLE * moving * (Math.sin(phase * 7.3) * 0.6 + Math.sin(phase * 11.1) * 0.4);
      group.rotation.x += side * LEAN + shake;
      group.position.y += -LEAN_SINK + RATTLE_BOB * moving * Math.sin(phase * 9.7);
    }
  }

  function reset() {
    hits = 0;
    lamps.clear();
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
    lampAngle: (end, s) => lamps.get(`${end},${s}`)?.angle ?? null,
  };
}
