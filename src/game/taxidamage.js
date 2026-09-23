import * as THREE from 'three';
import { color } from '../palette.js';

// The taxi wearing its damage — three tiers, each keyed to the HP bar's own colour steps so the car
// itself doubles as the gauge. See buildDamage() in geometry/taxi.js for the parts and why they are
// what they are (silhouette, because at ~30px long nothing finer reads).
//
//   1  any hit      the corner that was struck is crushed, and the roof sign is knocked crooked
//   2  ≤ 67% (amber) the boot lid is up and bouncing, and a bumper hangs off the back dragging sparks
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

const BOOT_OPEN = 0.55;           // rad, where the lid rides
const BOOT_BOUNCE = 0.2;          // rad of flap at speed
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
  let side = 1;                   // the side that has taken the worst of it: +1 right, −1 left
  let sideScore = 0;
  let phase = 0;
  let sparkIn = 0;
  let smokeIn = 0;
  let flickerIn = FLICKER_MEAN;
  let flickerOut = 0;

  const fraction = () => (taxi.hp ?? maxHp) / maxHp;
  const tier = () => {
    if (!hits) return 0;
    const f = fraction();
    return f <= LOW ? 3 : f <= MID ? 2 : 1;
  };

  /** A bump landed at world (x, z). */
  function hit(x, z) {
    // Into the car's own frame: +lx toward the nose, +lz toward its right. The same basis the sim
    // uses, (cos yaw, −sin yaw) forward and (sin yaw, cos yaw) right.
    const dx = x - taxi.x;
    const dz = z - taxi.z;
    const lx = dx * Math.cos(taxi.yaw) - dz * Math.sin(taxi.yaw);
    const lz = dx * Math.sin(taxi.yaw) + dz * Math.cos(taxi.yaw);
    damage.dent(lx >= 0 ? 1 : -1, lz >= 0 ? 1 : -1);
    sideScore += lz >= 0 ? 1 : -1;
    if (sideScore) side = Math.sign(sideScore);
    hits += 1;
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

    if (t >= 2) {
      damage.setBoot(BOOT_OPEN + BOOT_BOUNCE * moving * (0.6 * Math.sin(phase) + 0.4 * Math.sin(phase * 2.3)));
      // The bumper bounces clear of the road now and then and comes back down on it.
      const lift = 0.06 * moving * Math.max(0, Math.sin(phase * 1.7));
      damage.setBumper(-side, lift);
      sparkIn -= dt;
      const airborne = taxi.hopFrom != null;
      if (v > SPARK_MIN_V && !airborne && lift < 0.02 && sparkIn <= 0) {
        sparkIn = SPARK_EVERY;
        group.updateMatrixWorld(true);
        damage.bumperTip(tip);
        sparks.burst(tip.x, roadY, tip.z, taxi.yaw + Math.PI, 2, v * 0.4);
      }
    } else {
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
    sideScore = 0;
    side = 1;
    damage.reset();
  }

  return { hit, update, reset, tier };
}
