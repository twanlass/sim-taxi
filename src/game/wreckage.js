// Wrecked bodywork that stays on the road.
//
// Both cars in a crash — the taxi and the one it hit — are handed here on the impact frame, and
// unlike `game/vanish.js` (which is what the passing lab still uses, and what this replaced in the
// game) **nothing is ever taken away**. Each shell rides the last of its momentum out, crumples,
// scorches and comes to rest, and it is still sitting there when the retry card slides over it.
//
// The reason is a read, not a simulation. The old wreck consumed both cars under their own
// fireballs, which sells the *bang* very well and leaves the player with nothing to look at once
// the fire has gone out — at a fixed 3/4 camera and a 2.6-second hold that is two and a half
// seconds of empty tarmac, and the one question a crash has to answer, *what did I just hit*, is
// only answerable from the half-second of flame that already went past. Two crumpled cars lying
// there answer it for as long as the shot is up, in the paint they were wearing.
//
// It is deliberately not a physics settle. Everything here is the same **closed form** the rest of
// the wreck is built on (util/carry.js): position, spin, crumple and scorch are all evaluated from
// scratch off the entry's age, so a frame under the crash slow-mo is the same shape as a
// full-speed one and a shot-mode frame stepped by hand at 1/60 is the same shape as either.
//
// Three things happen at once, each on its own clock:
//
//   - **The carry.** `drift` and `spin` off `carryTravel`, exactly as `vanish` had them — the taxi
//     hit something and keeps less of its speed, the car it hit is shoved and keeps more.
//   - **The crumple.** A non-uniform scale in the *body* frame: shorter along its own long axis,
//     a little wider and a little lower, plus a lean and a nose-down settle. This is the whole of
//     what says "wrecked" rather than "parked" — see CRUMPLE_LEN.
//   - **The scorch.** A multiply on the material colour rather than a lerp to a soot grey, which
//     is what keeps the answer to *what did I hit* legible: a multiply preserves hue exactly, so a
//     burnt red car is still a red car and a burnt taxi is still yellow.

import * as THREE from 'three';
import { color } from '../palette.js';
import { BODY_EULER_ORDER } from '../util/geo.js';
import { carryTravel } from '../util/carry.js';
import { CAR_LEN, CAR_W } from '../sim/traffic.js';

// How long the deformation takes, in sim seconds. It has to be over before the fireball is —
// PUFF_LIFE is 0.95s in game/blast.js — because the fire is what the crumple is meant to happen
// *inside of*: a car that reshapes itself in clear air afterwards reads as the model popping.
const SETTLE_TIME = 0.7;

// The crumple, as multipliers on the shell's own axes. A car model faces +X (see `yawOf` in
// sim/traffic.js), so x is its length, z its width and y its height.
//
// The length is the one that carries it. A drawn car is 4.01 units long, which at the wreck's zoom
// of 26 (13.6 px/unit against play zoom's 7.7) is 55 pixels — so 0.86 takes nearly 8 pixels out of
// its silhouette, which is a shape that has been hit rather than a shape that has been nudged.
// Width goes the other way, because bodywork has to go somewhere.
//
// The wheels are inside the same group and get squashed with it. That was the argument for
// crumpling only the body meshes, and the arithmetic retired it: a wheel is 0.83 units across, so
// 11 pixels at wreck zoom, and 14% of it is a pixel and a half of ovalisation on a black disc. Not
// worth carrying a list of which children are bodywork through two very different hierarchies.
const CRUMPLE_LEN = 0.86;
const CRUMPLE_WIDE = 1.07;
const CRUMPLE_LOW = 0.9;

// And how it settles on its springs: a lean about its own long axis and a nose-down pitch, both in
// radians, both in the *body* frame — post-multiplied onto the pose rather than written into an
// Euler, for the reason BODY_EULER_ORDER exists at all (util/geo.js). The lean is signed by the
// caller so the two shells tip away from each other rather than in formation.
const CRUMPLE_LEAN = 0.13;    // ~7.5°
const CRUMPLE_NOSE = 0.06;    // ~3.5°, down

// The scorch. `SCORCH_KEEP` is the fraction of each material's own colour that survives, and the
// pull toward `wreckChar` on top of it is what stops it reading as a car merely in shadow — soot
// is slightly grey as well as dark.
//
// Both are deliberately mild, and the reason is the whole reason any of this exists. Measured on
// the red car (`carBody[0]`, L 0.32), these take it to L 0.18 — dark enough to read as burnt
// against `asphalt` at L 0.42, with its hue moved by three thousandths. The first cut at 0.58 keep
// and 0.22 mix landed it at 0.15, which is under half, and at that depth a red car and a slate one
// are both just dark things on the road: the crash stops answering the question it was left on the
// road to answer.
//
// It runs longer than the crumple on purpose. The crumple is the impact and belongs inside the
// fireball; the soot is what the fire *leaves*, so it goes on darkening for a beat after the flame
// has passed rather than arriving fully formed with it.
const SCORCH_TIME = 1.4;
const SCORCH_KEEP = 0.68;
const SCORCH_MIX = 0.18;

// The smoulder: one wisp per wreck every SMOULDER_EVERY seconds for SMOULDER_TIME, off the
// optional `smoke` callback the game wires to the dust pool. Without it a wreck is completely
// static from the moment the fireball dies, and a static object at the middle of a held close-up
// reads as a prop rather than as something that just happened. ~22 puffs per wreck against the
// pool's 140 slots, and the taxi's boost trail — normally the pool's biggest customer — is dead by
// definition here.
const SMOULDER_EVERY = 0.3;
const SMOULDER_TIME = 6.5;
const SMOULDER_Y = 1.1;       // off the bonnet rather than off the road

const UP = new THREE.Vector3(0, 1, 0);

/**
 * @param smoke  optional `(x, y, z) => void`, called once per smoulder wisp with a point above the
 *               wreck. Left out — the headless checks leave it out — the wrecks simply sit there.
 */
export function createWreckage({ smoke = null } = {}) {
  // Scratch. The spin is a **world**-Y rotation premultiplied onto the pose the shell was caught
  // in, and the crumple's lean and nose are a **body**-frame rotation post-multiplied onto it. A
  // shell arrives holding a quaternion decomposed out of a car's body matrix — corner lean, pitch
  // rock and all — so neither can be written as an Euler component without knowing what is already
  // in there. Multiplying on the correct side needs to know nothing about the pose it is turning.
  const spinQuat = new THREE.Quaternion();
  const tiltQuat = new THREE.Quaternion();
  const tiltEuler = new THREE.Euler(0, 0, 0, BODY_EULER_ORDER);
  const soot = color('wreckChar');
  const scorched = new THREE.Color();
  const entries = [];

  /**
   * Take over an object's transform and its materials' colour, for good. Nothing is ever restored:
   * a wreck ends the run, and Retry reloads the page.
   */
  function take(object, options = {}) {
    if (!object) return;
    const {
      driftX = 0,     // u/s along world x, spent against CARRY_DRAG
      driftZ = 0,     // u/s along world z
      spin = 0,       // rad/s about world y, on the same curve
      lean = 1,       // sign of the roll it settles at; 0 leaves it level, still nose-down
      // The body's own footprint in sim units, for the lift below. A truck is not a car and its
      // extra 2.2 of length is 6cm of sagitta at the settle pitch, which is a wheel's worth.
      len = CAR_LEN,
      width = CAR_W,
    } = options;
    // Keyed by material, not a list: a wrecked ambient car's body and both its front wheels share
    // one, and writing the same colour three times a frame is just noise. The value is the colour it
    // arrived wearing, because the scorch is evaluated from that base every frame rather than
    // accumulated onto whatever is there — same rule as everything else here, and the reason a
    // shot-mode frame stepped by hand comes out the same as a live one.
    const materials = new Map();
    object.traverse((node) => {
      const list = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
      for (const material of list) {
        // The taxi's oversized pick volume is already invisible; there is nothing to scorch. The
        // `color` guard is for anything that turns up here without one — a raw ShaderMaterial would
        // otherwise throw on the frame a run ends, which is the worst possible place for it.
        if (!material.visible || !material.color || materials.has(material)) continue;
        materials.set(material, material.color.clone());
      }
    });
    entries.push({
      object,
      materials,
      base: object.scale.clone(),
      // Half-extents as *drawn*: the shell carries its own scale (TAXI_SCALE is 1.18 on the taxi's
      // group, so its body is 4.01 units long where CAR_LEN says 3.4 — see the note in
      // geometry/taxi.js). The lift below is in world units, so it has to be the drawn number.
      halfLen: (len / 2) * Math.abs(object.scale.x),
      halfWidth: (width / 2) * Math.abs(object.scale.z),
      // Where and how it was pointing on the frame it was handed over.
      from: object.position.clone(),
      pose: object.quaternion.clone(),
      driftX,
      driftZ,
      spin,
      lean: Math.sign(lean),
      age: 0,
      nextPuff: SMOULDER_EVERY * 0.4,   // the first one lands while the fire is still up
    });
  }

  function update(dt) {
    for (const entry of entries) {
      entry.age += dt;
      const { object } = entry;

      // Ease on its own clock. Cubic out: most of the deformation is spent in the first fifth of a
      // second, which under the crash slow-mo is a good half-second on screen and lands inside the
      // fireball's opening frames.
      const t = Math.min(1, entry.age / SETTLE_TIME);
      const ease = 1 - (1 - t) ** 3;
      const roll = CRUMPLE_LEAN * entry.lean * ease;
      const nose = -CRUMPLE_NOSE * ease;

      const len = 1 + (CRUMPLE_LEN - 1) * ease;
      const wide = 1 + (CRUMPLE_WIDE - 1) * ease;
      const low = 1 + (CRUMPLE_LOW - 1) * ease;

      // Roll and pitch both pivot on the shell's origin, which is at road level — so a tilt with
      // nothing done about it drives one corner underground, exactly as it does for a car leaning
      // through a bend (see the `lift` beside `taxiGroup.position` in sim/traffic.js, which is the
      // same arithmetic). At the settle angles that is 0.11 of roll plus 0.10 of pitch: a fifth of
      // a unit, three pixels at the wreck's zoom, and a wheel is eleven. Visibly sunk.
      const lift = Math.abs(Math.sin(roll)) * entry.halfWidth * wide
        + Math.abs(Math.sin(nose)) * entry.halfLen * len;

      // Still moving while it comes apart, and still moving after: the drag curve is what brings it
      // to rest rather than a stop condition, so there is no frame on which the slide ends.
      const travel = carryTravel(entry.age);
      object.position.set(
        entry.from.x + entry.driftX * travel,
        entry.from.y + lift,
        entry.from.z + entry.driftZ * travel,
      );

      object.quaternion.copy(entry.pose);
      if (entry.spin) object.quaternion.premultiply(spinQuat.setFromAxisAngle(UP, entry.spin * travel));
      if (roll || nose) {
        // Rx is the roll about the body's own long axis, Rz the pitch — and Rz is positive nose-up
        // for a +X-facing model, so the nose drops on a negative one. Post-multiplied, so both are
        // in the body's frame whatever pose the impact caught it in; the spin above is a world-Y
        // turn and is premultiplied for the same reason in reverse.
        tiltEuler.set(roll, 0, nose);
        object.quaternion.multiply(tiltQuat.setFromEuler(tiltEuler));
      }

      object.scale.set(entry.base.x * len, entry.base.y * low, entry.base.z * wide);

      // The scorch, off each material's own base colour. `propMaterial` is `vertexColors`, so this
      // multiplies the baked paint rather than replacing it — which is exactly the property the
      // whole feature rests on: every part of the car darkens by the same fraction and the car
      // stays the colour it was.
      const burn = Math.min(1, entry.age / SCORCH_TIME);
      const keep = 1 + (SCORCH_KEEP - 1) * burn;
      for (const [material, base] of entry.materials) {
        scorched.copy(base).multiplyScalar(keep).lerp(soot, SCORCH_MIX * burn);
        material.color.copy(scorched);
      }

      if (smoke && entry.age < SMOULDER_TIME) {
        while (entry.age >= entry.nextPuff) {
          entry.nextPuff += SMOULDER_EVERY;
          smoke(object.position.x, object.position.y + SMOULDER_Y, object.position.z);
        }
      }
    }
  }

  /** For the headless checks — how many wrecks are on the road. */
  const pending = () => entries.length;

  return { take, update, pending };
}
