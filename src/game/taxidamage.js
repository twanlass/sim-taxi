import * as THREE from 'three';
import { color } from '../palette.js';
import { TAXI_DECK_Y, TAXI_SCALE } from '../geometry/taxi.js';
import { CAR_LEN, CAR_W } from '../sim/traffic.js';

// The drawn taxi's half-extents, for telling a hit on the flank from one on an end.
const TAXI_HALF_LEN = (CAR_LEN / 2) * TAXI_SCALE;
const TAXI_HALF_W = (CAR_W / 2) * TAXI_SCALE;

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
// Exported as SMOKE_FRACTION: the depot's tip card (REPAIR in game/newmove.js) goes up a beat after
// the car starts smoking, so the card and the car say it together.
const LOW = 0.34;
export { LOW as SMOKE_FRACTION, MID as BOOT_FRACTION };
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

// **The louder ladder** (the default; `?damage=classic` for the one above on its own). The tiers
// above all wait for a threshold, so the commonest first hit — a 24-HP tailgate from full — showed
// a lamp a few pixels across swinging on its wire and nothing else, and a player could take two
// hits without knowing the car had been touched. So three things start at the *first* hit and
// grow with every one after it:
//
//   flash   the body flashes red twice as the hit lands — the moment itself
//   chips   the paint chips to the metal at the struck corner — a few big marks at the first hit,
//           spreading inward and to the other corners as the HP runs down (see `wear` below)
//   steam   thin white wisps off the bonnet from the first hit, faster as the HP drops, which hands
//           over to the grey smoke at red rather than the smoke appearing out of nothing
//
// And the rattle starts at amber instead of red, so a car with its boot up also *drives* broken.
const FLASH_TIME = 0.3;           // s, both pulses
const FLASH_PEAK = 0.55;          // emissive at the top of a pulse
const GRIME_FIRST = 0.4;          // grime after any hit at all... (`?taxidamage=classic`)
const GRIME_EASE = 4;             // 1/s — it soaks in over a quarter second rather than snapping
// **The chipped paint** (the default; `?taxidamage=classic` for the grime). Tyler, 2026-10-21: the
// paint changing colour was not reading — a dulled yellow is still a yellow car — so the paint keeps
// its colour and comes off instead, in voxel chips of bare metal ringed with primer
// (geometry/taxiscratches.js). Wear runs off the HP the way the grime did, so the same glance says
// the same thing; it is the corner that took the hit that wears it in full, and the other three
// catch up on a square, so a car hit once at the nose is chipped at the nose, and a car near the end
// is chipped all over. Instant rather than eased: the chips open under the flash, which is the
// moment of the hit.
const WEAR_FIRST = 0.3;           // of the struck corner's marks after any hit at all...
const WEAR_SPREAD = 0.6;          // ...and the share an unstruck corner reaches at empty, on wear²
const CORNER_KEYS = ['1,1', '1,-1', '-1,1', '-1,-1'];
const STEAM_SLOW = 0.26;          // s between wisps just after the first hit
const STEAM_FAST = 0.14;          // ... and at the red line, where the smoke takes over
const STEAM_SIZE = 0.8;
const STEAM_BURST = 5;            // wisps thrown off the bonnet by each hit

// A loose lamp is a pendulum on its wire, swinging fore and aft. Stiffer than a real one on a wire
// this short would be, so it reads as swinging rather than jittering at play zoom — about a swing
// and a half a second — and kicked the same three ways the lids are: the car's own acceleration
// (a car pulling away leaves a hanging lamp behind), the road, and every hit.
const LAMP_G = 30;                // effective gravity over the wire's length, 1/s²
const LAMP_C = 1.6;               // 1/s, damping
const LAMP_ACCEL = 0.9;           // rad/s² per u/s² of the car's acceleration
const LAMP_ROAD_KICK = 3;         // rad/s per road kick at full speed
export const LAMP_HIT_KICK = 6;          // rad/s, on every hit
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
export const BOOT_REST = 0.6;            // rad, where the lid hangs when nothing is moving it
const BOOT_MAX = 1.35;            // rad, about as far as the hinge goes
const BOOT_K = 55;                // 1/s², spring toward rest
const BOOT_C = 3;                 // 1/s, damping
const BOOT_SLAM = 0.55;           // of the swing kept when it hits the body and bounces
const BOOT_ROAD = [0.12, 0.35];   // s between road kicks at speed
const BOOT_ROAD_KICK = 7;         // rad/s per kick at full speed
const BOOT_ACCEL = 1.2;           // rad/s² on the lid per u/s² of the car's own acceleration
export const BOOT_HIT_KICK = 14;         // rad/s, on every bump — it slams shut and flies open
// The bonnet rides the same spring. It rests a little lower — a raised bonnet is in front of the
// windscreen, and a lid that stood as high as the boot's hid the cabin at this camera — and its first
// kick is *up*: the catch lets go and it flies open off the body, where the boot's is a slam.
export const HOOD_REST = 0.45;
export const HOOD_POP = 11;              // rad/s, the burst catch
export const SPARK_EVERY = 0.045;        // s between bursts off the bumper while it is dragging
export const SPARK_MIN_V = 2.5;          // u/s — a bumper at walking pace scrapes, it does not spark

const SMOKE_SLOW = 0.2;           // s between puffs at the top of the red
const SMOKE_FAST = 0.06;          // ... and at the bottom
const LEAN = 0.07;                // rad of list toward the damaged side
const LEAN_SINK = 0.05;           // units the body drops on that side
const RATTLE = 0.035;             // rad of shake at speed
const RATTLE_BOB = 0.03;          // units

/**
 * One step of a lid's spring — the boot's or the bonnet's, on the taxi or on a car it has hit
 * (game/cardamage.js). `moving` is 0..1 of the way to full speed; `accel` the car's own, in u/s².
 */
export function stepLid(lid, dt, moving, accel, rng = Math.random) {
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

/** One step of a loose lamp's pendulum — see `stepLid` for who shares it. */
export function stepLamp(lamp, dt, moving, accel, rng = Math.random) {
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
}

/** A lamp freshly out of its socket at corner (end, side): flung away from the car. */
export const looseLamp = (end, side, rng = Math.random) =>
  ({ end, side, angle: 0, v: end * LAMP_HIT_KICK, roadIn: rng() * 0.3 });

export function createTaxiDamage({
  damage, group, taxi, maxHp, sparks, dust, roadY, rng = Math.random, classic = false, tint = false,
}) {
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
  // The sides whose wing mirror has been knocked off, +1 the right.
  const mirrorsOff = new Set();
  // One spring per lid. Separate road-kick clocks, so the two do not flap in step.
  const boot = { angle: BOOT_REST, v: 0, roadIn: 0, rest: BOOT_REST };
  const hood = { angle: 0, v: 0, roadIn: 0.1, rest: HOOD_REST, open: false };
  let lastV = 0;
  let flashT = Infinity;
  let grime = 0;
  let steamIn = 0;

  const fraction = () => (taxi.hp ?? maxHp) / maxHp;
  const wearLevels = new Map();
  let wornAt = 1;
  /** Push the chipped paint for the hits so far and `hp` (0..1 of maxHp); see WEAR_FIRST. */
  function wear(f = fraction()) {
    if (classic || tint) return;
    const w = hits ? Math.min(1, WEAR_FIRST + (1 - WEAR_FIRST) * (1 - f)) : 0;
    for (const key of CORNER_KEYS) wearLevels.set(key, corners.has(key) ? w : WEAR_SPREAD * w * w);
    damage.setWear?.(wearLevels);
  }
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
    wear();
    if (!classic) {
      flashT = 0;
      // A burst of steam off the bonnet, so even the first hit leaves the car visibly hurt.
      const ax = taxi.x + Math.cos(taxi.yaw) * SMOKE_AHEAD;
      const az = taxi.z - Math.sin(taxi.yaw) * SMOKE_AHEAD;
      for (let n = 0; n < STEAM_BURST; n++) {
        dust.add(ax, az, taxi.yaw + (rng() - 0.5) * 2, STEAM_SIZE + 0.3 * rng(), 0.5, smokeLight,
          roadY + SMOKE_Y, 0.4);
      }
    }
    // Down hard, so the slam and the bounce off it are the first thing the lid does.
    boot.v -= BOOT_HIT_KICK;
    if (hood.open) {
      hood.v -= BOOT_HIT_KICK;
    } else if (rearEnd) {
      hood.open = true;
      hood.angle = 0;
      hood.v = HOOD_POP;
    }
    // A hit on the flank rather than an end snaps that side's wing mirror off, with a few sparks
    // where it was. "Flank" is the hit landing nearer the side than the end, in proportion to the
    // car's own half-length and half-width, so a corner clip takes the mirror no more than half the
    // time it is struck and a nose-to-tail never does.
    const flank = Math.abs(lz) / (TAXI_HALF_W) > Math.abs(lx) / TAXI_HALF_LEN;
    const mirrorSide = lz >= 0 ? 1 : -1;
    if (flank && !mirrorsOff.has(mirrorSide)) {
      mirrorsOff.add(mirrorSide);
      damage.setMirror?.(mirrorSide, false);
      sparks?.burst(taxi.x + Math.sin(taxi.yaw) * mirrorSide * TAXI_HALF_W,
        roadY + TAXI_DECK_Y, taxi.z + Math.cos(taxi.yaw) * mirrorSide * TAXI_HALF_W,
        taxi.yaw + mirrorSide * Math.PI / 2, 4, 3);
    }
    // The lamp at the struck corner comes loose — and one already loose takes the knock.
    const lamp = lamps.get(key);
    if (lamp) {
      lamp.v += (rng() - 0.5) * 2 * LAMP_HIT_KICK;
    } else {
      // Out of the socket with a fling away from the car, so it swings out, comes back and clacks.
      const [end, s] = key.split(',').map(Number);
      lamps.set(key, looseLamp(end, s, rng));
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

    // HP can move without a hit through here (a repair, the dev panel), so the chips follow it.
    if (fraction() !== wornAt) { wornAt = fraction(); wear(); }
    const accel = dt > 1e-6 ? (v - lastV) / dt : 0;
    lastV = v;

    if (!classic) {
      // Two red pulses, sin² over two half-cycles of FLASH_TIME.
      if (flashT < FLASH_TIME) {
        flashT += dt;
        const s = Math.sin(Math.PI * 2 * Math.min(1, flashT / FLASH_TIME));
        damage.setFlash?.(flashT < FLASH_TIME ? FLASH_PEAK * s * s : 0);
      }
      if (tint) {
        const want = hits ? GRIME_FIRST + (1 - GRIME_FIRST) * (1 - fraction()) : 0;
        grime += (want - grime) * Math.min(1, dt * GRIME_EASE);
        damage.setGrime?.(grime);
      }
      // Steam from the first hit down to the red line, where the smoke below takes over.
      if (t === 1 || t === 2) {
        const worse = Math.min(1, Math.max(0, (1 - fraction()) / (1 - LOW)));
        steamIn -= dt;
        if (steamIn <= 0) {
          steamIn = STEAM_SLOW + (STEAM_FAST - STEAM_SLOW) * worse;
          dust.add(taxi.x + Math.cos(taxi.yaw) * SMOKE_AHEAD, taxi.z - Math.sin(taxi.yaw) * SMOKE_AHEAD,
            taxi.yaw, STEAM_SIZE + 0.3 * worse, 0.2, smokeLight, roadY + SMOKE_Y, smokeDrift(moving));
        }
      }
    }
    for (const lamp of lamps.values()) {
      stepLamp(lamp, dt, moving, accel, rng);
      damage.setLamp(lamp.end, lamp.side, lamp.angle);
    }
    if (hood.open) {
      stepLid(hood, dt, moving, accel, rng);
      damage.setHood(hood.angle);
    } else {
      damage.setHood(null);
    }
    if (t >= 2) {
      stepLid(boot, dt, moving, accel, rng);
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

      // Low on the damaged side. Roll + tips the top toward the car's right (see the lean notes
      // in sim/traffic.js), so the list toward `side` is +side.
      group.rotation.x += side * LEAN;
      group.position.y += -LEAN_SINK;
    }
    // And rattling — from red on the classic ladder, from amber on the louder one.
    if (t >= 3 || (!classic && t >= 2)) {
      const shake = RATTLE * moving * (Math.sin(phase * 7.3) * 0.6 + Math.sin(phase * 11.1) * 0.4);
      group.rotation.x += shake;
      group.position.y += RATTLE_BOB * moving * Math.sin(phase * 9.7);
    }
  }

  /**
   * The wreck: the hit that ends the run never comes through `hit` (sim/collisions.js turns it into
   * the crash), so the shell left lying in the road would wear the chips of the hit *before*. This
   * marks the struck corner and wears the paint as at empty, and nothing else — the lids and lamps
   * are frozen with the wreck, and a flash or a burst of steam would land on a car already on fire.
   */
  function scuff(x, z) {
    const dx = x - taxi.x;
    const dz = z - taxi.z;
    const lx = dx * Math.cos(taxi.yaw) - dz * Math.sin(taxi.yaw);
    const lz = dx * Math.sin(taxi.yaw) + dz * Math.cos(taxi.yaw);
    const key = `${lx >= 0 ? 1 : -1},${lz >= 0 ? 1 : -1}`;
    corners.set(key, (corners.get(key) ?? 0) + 1);
    hits += 1;
    wear(0);
  }

  function reset() {
    hits = 0;
    lamps.clear();
    mirrorsOff.clear();
    boot.angle = BOOT_REST;
    boot.v = 0;
    hood.open = false;
    hood.angle = 0;
    hood.v = 0;
    corners.clear();
    worst = { end: -1, side: 1 };
    side = 1;
    flashT = Infinity;
    grime = 0;
    steamIn = 0;
    damage.reset();
  }

  return {
    hit, scuff, update, reset, tier,
    bootAngle: () => boot.angle,
    hoodAngle: () => (hood.open ? hood.angle : null),
    lampAngle: (end, s) => lamps.get(`${end},${s}`)?.angle ?? null,
    grime: () => grime,
  };
}
