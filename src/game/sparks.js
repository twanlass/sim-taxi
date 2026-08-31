import * as THREE from 'three';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { markEmissive } from './bloom.js';
import { carrySpeed } from '../util/carry.js';

// Sparks off the underside of the taxi when it lands a jump — the barricade's ramp, and the crest
// of an arched bridge under Loco Mode.
//
// The landing already threw dust (game/dust.js) and rocked the suspension (`landingBounce` in
// sim/traffic.js), and both of those say *weight*. Neither says the car hit hard enough to drag
// metal along the tarmac, which is the thing a stunt landing is actually being praised for. Dust
// alone reads as a car arriving on a dirt road.
//
// It is a **streak** pool rather than a puff pool, and that is the whole difference from dust.js:
//
//   - **Thin boxes aligned to their own velocity.** A spark is seen as the line it draws, not as
//     the point it is, so each instance is stretched along the direction it is travelling and
//     shortens as it slows — see `SPARK_LEN`. A round mote at this size is a dot of grit.
//   - **Additive and unlit**, like the tailpipe flame: a spark is a light source, so it has to
//     brighten the road under it rather than sit on it as an opaque fleck. That is also what keeps
//     a night landing as bright as a golden-hour one.
//   - **They bounce.** One skitter off the tarmac is what separates hot metal from thrown debris,
//     and it costs a sign flip — see `SPARK_RESTITUTION`.
//
// One InstancedMesh, one draw call, a ring buffer of slots, and the same per-instance alpha patch
// dust.js and flames.js use because `instanceColor` is RGB only.

// A landing spends four to six per wheel off all four wheels — 16 at cruise, 24 at the Loco top —
// and a second landing can start while the first is still fading: the life is 0.55s, and a bridge
// and a barricade can be a second apart. 64 covers two full-strength landings overlapping with
// room to spare, and a wrapped slot silently truncates a burst.
const MAX_SPARKS = 64;

const LIFE = 0.55;
const SPARK_GRAVITY = 26;     // exaggerated, as game/blast.js's shards are: a real 9.8 arc floats
const SPARK_DRAG = 2.2;       // 1/s on the horizontal, so the spray has a finite reach
const SPARK_RESTITUTION = 0.32;
const SPARK_FRICTION = 0.65;  // horizontal kept through a bounce — a skitter, not a rebound

// The streak. `SPARK_LEN` is units of length per u/s of speed, clamped: at play zoom 1 unit is
// 7.7px, so the band below draws a 2.7px dash on a spark that is nearly spent and a 9px one on a
// spark that has just left the wheel. Anything shorter than about 2px stops reading as a line at
// all and the whole effect turns into a scatter of dots.
const SPARK_LEN = 0.055;
const SPARK_LEN_MIN = 0.35;
const SPARK_LEN_MAX = 1.15;
const SPARK_THICK = 0.13;     // ~1px. The bloom is what gives it its apparent width

// How much of the car's own speed a spark keeps. Well under a shard's 0.70 in game/blast.js and
// for the opposite reason: a shard is a piece of the car and carries on with it, a spark is
// separating *from* it. At 0.45 an overdrive landing throws sparks that still creep forward for a
// tenth of a second and are then left behind as the taxi drives out from under them, which is what
// the effect is for — a mark on the road the car has moved on from.
const SPARK_CARRY = 0.45;

// Where a spark starts above the surface it comes off. It is scraping that surface, so this is
// only enough to keep the streak out of the tarmac when it lies flat.
const SPARK_LIFT = 0.06;

export function createSparks(scene, rng) {
  // A unit box stretched per instance. One geometry, and the aspect lives entirely in the instance
  // matrix, so a spark can change length as it slows without touching a buffer.
  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const alphas = new Float32Array(MAX_SPARKS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // White, as dust.js is and for the same reason: the hue rides `instanceColor`, and white is the
  // multiply identity under it.
  const material = unlitMaterial({
    color: '#FFFFFF',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_SPARKS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 6;      // with the flames: the brightest thing on the road
  // The pool moves and three latches an InstancedMesh's bounding sphere on the first frame it
  // culls one, from the matrices as they stood then. A pool that is empty at that moment latches a
  // radius of −1 at the origin and never draws again.
  mesh.frustumCulled = false;
  scene.add(mesh);
  // Hot metal, so it blooms — on the flame's own intensity rather than a kind of its own. A spark
  // and the tailpipe burst are the same class of thing to this pass: small, hot, and on screen for
  // half a second. See BLOOM_INTENSITY in game/bloom.js.
  markEmissive(mesh, 'flame');

  const life = new Float32Array(MAX_SPARKS);
  const life0 = new Float32Array(MAX_SPARKS);
  const px = new Float32Array(MAX_SPARKS);
  const py = new Float32Array(MAX_SPARKS);
  const pz = new Float32Array(MAX_SPARKS);
  const vx = new Float32Array(MAX_SPARKS);
  const vy = new Float32Array(MAX_SPARKS);
  const vz = new Float32Array(MAX_SPARKS);
  // The surface this spark is skittering along, so a landing on a bridge deck bounces off the deck
  // rather than off the road two units under it.
  const floor = new Float32Array(MAX_SPARKS);

  const dummy = new THREE.Object3D();
  const dir = new THREE.Vector3();
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const quat = new THREE.Quaternion();
  const tint = new THREE.Color();
  const HOT = color('sparkHot');
  const COOL = color('sparkTail');

  // Collapsed and white to begin with — `setColorAt` allocates `instanceColor` on its first call
  // and recompiles the material, and doing that lazily would put a shader compile on the frame of
  // a landing.
  for (let slot = 0; slot < MAX_SPARKS; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, HOT);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  let next = 0;
  let tinted = false;

  /**
   * A spray of sparks off one contact patch at (x, y, z), thrown backwards and outwards from a car
   * heading `yaw`. `y` is the surface being scraped — the road, or a bridge deck — and is what the
   * sparks bounce off.
   *
   * `speed` is how fast the car was going, in u/s: it sets how far forward the spray is carried
   * before it is left behind, and nothing else. Left at 0 the sparks fly off a stationary point,
   * which is what a headless check wants.
   */
  function burst(x, y, z, yaw, count = 5, speed = 0) {
    // `yaw` is a sim heading, so forward is (cos yaw, −sin yaw) and right is (sin yaw, cos yaw).
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const rx = Math.sin(yaw);
    const rz = Math.cos(yaw);
    const carry = carrySpeed(speed) * SPARK_CARRY;

    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % MAX_SPARKS;

      // Back hard, out a little, up least of all. Sparks off a car that has just bottomed out come
      // off along the road rather than up off it — thrown up as hard as they go back, they arc over
      // the roof and read as a firework going off under the car.
      const back = rng.range(3.5, 9.5);
      const side = rng.jitter(3.2);
      const up = rng.range(1.2, 4.2);

      life[slot] = LIFE * rng.range(0.65, 1.15);
      life0[slot] = life[slot];
      px[slot] = x + rng.jitter(0.12);
      py[slot] = y + SPARK_LIFT;
      pz[slot] = z + rng.jitter(0.12);
      vx[slot] = -fx * back + rx * side + fx * carry;
      vy[slot] = up;
      vz[slot] = -fz * back + rz * side + fz * carry;
      floor[slot] = y;

      // Hue is rolled once and kept. A spark is on screen for half a second and is fading the whole
      // time, so walking a ramp over its life — which is what the fireball does — buys nothing the
      // alpha is not already saying; what the spread across the *shower* buys is a spray that looks
      // like metal at several temperatures rather than a stencil.
      mesh.setColorAt(slot, tint.copy(HOT).lerp(COOL, rng.next()));
      tinted = true;
      alphas[slot] = 1;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_SPARKS; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / life0[slot];   // 0 fresh, 1 spent

      vy[slot] -= SPARK_GRAVITY * dt;
      // Exponential rather than subtractive, so it is frame-rate independent and cannot push a
      // spark backwards through zero on a long frame.
      const keep = Math.exp(-SPARK_DRAG * dt);
      vx[slot] *= keep;
      vz[slot] *= keep;

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;

      // Skitter. Clamped to the surface rather than reflected about it: a spark that dips below the
      // deck for a frame and is then mirrored back up comes out at the wrong height by however far
      // the frame carried it, which at 26 u/s² of gravity is visible as a hop that starts underground.
      if (py[slot] < floor[slot]) {
        py[slot] = floor[slot];
        vy[slot] = Math.abs(vy[slot]) * SPARK_RESTITUTION;
        vx[slot] *= SPARK_FRICTION;
        vz[slot] *= SPARK_FRICTION;
      }

      const speed = Math.hypot(vx[slot], vy[slot], vz[slot]);
      const len = Math.min(SPARK_LEN_MAX, Math.max(SPARK_LEN_MIN, speed * SPARK_LEN));

      dummy.position.set(px[slot], py[slot], pz[slot]);
      // Aligned to its own travel. Below a whisker of speed the direction is noise, so the streak
      // keeps whatever rotation it had rather than snapping to an arbitrary axis.
      if (speed > 0.05) {
        dir.set(vx[slot], vy[slot], vz[slot]).divideScalar(speed);
        dummy.quaternion.copy(quat.setFromUnitVectors(X_AXIS, dir));
      }
      dummy.scale.set(len, SPARK_THICK, SPARK_THICK);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      // Held bright and then snuffed, rather than a linear fade: a spark cools fast at the end of
      // its life and is at full brightness for most of it. Linear, the shower spends its middle
      // half at a wash that reads as smoke.
      alphas[slot] = Math.max(0, 1 - t ** 2.4);

      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        alphas[slot] = 0;
      }
    }

    if (!touched) return;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    if (tinted) {
      mesh.instanceColor.needsUpdate = true;
      tinted = false;
    }
  }

  /** How many sparks are still alive — for tools/probe.mjs. */
  const live = () => {
    let n = 0;
    for (let slot = 0; slot < MAX_SPARKS; slot++) if (life[slot] > 0) n += 1;
    return n;
  };

  return { mesh, burst, update, live };
}
