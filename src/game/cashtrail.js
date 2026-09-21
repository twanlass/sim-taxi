import * as THREE from 'three';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { carrySpeed } from '../util/carry.js';
import { TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';

// Banknotes fluttering out of the back of the taxi while it boosts with a robber aboard — see
// [the bank robbery](../../docs/gameplay.md#the-bank-robbery).
//
// **It is the one thing in the event that rewards the player for the risk in the moment.** The
// bonus a getaway pays is real (`ROBBER_BONUS` in game/fares.js) and the player does not see a
// penny of it until the drop-off resolves; everything in between is a tight clock and four cop
// cars to hit. A stream of cash off the back while the pill is held is the payoff arriving at the
// time it is being earned, which is the whole of what it is for.
//
// It is a **flutter** pool, and that is what separates it from the three particle pools already
// here (game/dust.js's puffs, game/sparks.js's streaks, game/blast.js's shards):
//
//   - **Paper, so it is light.** Low gravity, heavy drag on *both* axes — a note thrown back at 9
//     u/s is doing 2 by the time it has left the bumper — and it never bounces. What that buys is
//     the read: dust billows, sparks skitter, shards fly, and money *hangs* in the air behind you.
//   - **It tumbles.** A per-note spin about a fixed random axis, slowing with the same drag, so
//     the note flashes between its face and its edge as it falls. That is the whole reason it is a
//     thin **box** rather than a plane: a plane is one-sided, and half of every tumble would be a
//     note that is simply not drawn (the trap the boats' wake sat in for weeks).
//   - **Unlit, and not bloomed.** Money is not a light source — it is paper reflecting one — so it
//     takes `unlitMaterial` for the night read that dust.js takes it for, and stays out of the
//     bloom's draw list entirely. A glowing banknote is a firefly.
//
// One InstancedMesh, one draw call, a ring buffer of slots, and the same per-instance alpha patch
// dust.js, sparks.js and flames.js use, because `instanceColor` is RGB only.

/**
 * The pool.
 *
 * `RATE` notes a second over a `LIFE` of 1.6s is 22 live at the top of a sustained hold, and a
 * hold is the longest thing that feeds this — there is no burst. 48 leaves room for the frame a
 * second robbery's first notes overlap the tail of the last one's, and a wrapped slot silently
 * truncates the stream rather than failing.
 */
const MAX_NOTES = 48;

/**
 * Notes per second while the pill is held.
 *
 * Sized against the tank rather than against the look: a full tank is 15 seconds of boost
 * (game/boost.js) and a getaway spends a fraction of one, so at 14/s a typical two-second burst
 * throws about 28 notes. Enough to read as a stream from the first frame, few enough that the road
 * behind the taxi is still a road.
 */
const RATE = 14;

/** Seconds a note is in the air. Long: the point is that it hangs. */
const LIFE = 1.6;
/** The last fraction of that spent fading, so a note thins out rather than blinking off. */
const FADE_FROM = 0.55;

// Paper physics. Gravity well under the sparks' exaggerated 26 and under a real 9.8, drag well
// over: a note launched at 9 u/s covers 9/3.4 = 2.6 units before it stops, which is most of a car
// length behind the bumper and no further.
const GRAVITY = 7.0;
const DRAG = 3.4;
// ...and the same drag on the fall, which is what makes it flutter instead of drop. Without it the
// notes reached terminal speed and rained; with it they sink about a unit a second.
const FALL_DRAG = 2.6;

/** Tumble, in rad/s, and how fast it winds down. */
const SPIN = 7.5;
const SPIN_DRAG = 1.9;

// How the note is thrown: back out of the tailpipe, a little sideways, a little up. Up *least*,
// for the reason the sparks are: thrown up as hard as they go back, the shower arcs over the roof
// and reads as confetti being fired rather than cash being lost.
const BACK = [5.5, 10.5];
const SIDE = 2.4;
const UP = [1.6, 4.4];

/**
 * How much of the taxi's own speed a note keeps.
 *
 * Under the sparks' 0.45, and for the same reason turned up a notch: a note is separating from the
 * car, and the whole effect is the car driving out from under what it is dropping. At 0.3 a note
 * drifts forward for about a tenth of a second and is then left behind, which at boost speed puts
 * the whole stream visibly *trailing*.
 */
const NOTE_CARRY = 0.3;

/** A note, in world units. At 7.7px per unit that is a 4.8 x 2.6px rectangle. */
const NOTE_L = 0.62;
const NOTE_W = 0.34;
const NOTE_T = 0.02;

/**
 * How far toward the pale back a note's colour is allowed to roll.
 *
 * Not the full [0, 1] it started as. An even lerp between the two put half the shower nearer the
 * back than the face, and a road behind the taxi strewn with pale flecks reads as litter rather
 * than as money — the green is the only thing saying what these are. Capped here, the stream is
 * mostly banknote with a scattering of notes caught edge-on, which is what a tumble looks like.
 */
const BACK_MIX = 0.55;

/** How far above the tailpipe the stream starts, so it leaves the boot rather than the road. */
const LIFT = 0.15;

/**
 * How far behind the car's own origin a note appears.
 *
 * `TAXI_TAILPIPE_BACK` is the **drawn** half-length — `createTaxiMesh` puts `TAXI_SCALE` = 1.18 on
 * the group, so the body on screen is 4.01 units where the simulation's `CAR_LEN` says 3.4, and
 * anything placing an effect against the bodywork has to use the drawn one. Emitted at the origin
 * instead, a note starts inside the car and is only carried clear by its own velocity: fine at the
 * Loco top, and at the bottom of a hold it pops out through the roof. game/locoflame.js hangs its
 * plume off the same constant for the same reason.
 */
const TAIL_BACK = TAXI_TAILPIPE_BACK;

export function createCashTrail(scene, rng) {
  // A unit box scaled per instance, the same shape trick sparks.js uses: one geometry, and the
  // note's proportions live entirely in the instance matrix, so nothing touches a buffer.
  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const alphas = new Float32Array(MAX_NOTES);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // White, so `instanceColor` multiplies cleanly onto it — the same identity dust.js and sparks.js
  // rely on. **Not** additive: additive blending is for things that emit, and a banknote reflects.
  // Over dark asphalt an additive note came out as a glowing sliver.
  const material = unlitMaterial({
    color: '#FFFFFF',
    transparent: true,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTES);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Under the flames and sparks (6) and over the road: a note passes *through* the Loco plume it is
  // being thrown out beside, and the plume is the brighter thing.
  mesh.renderOrder = 5;
  // The pool moves, and three latches an InstancedMesh's bounding sphere on the first frame it
  // culls one — from the matrices as they stood then. A pool that is empty at that moment (which
  // this one always is at boot: no robbery has happened) latches a radius of -1 at the origin and
  // never draws again.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_NOTES);
  const px = new Float32Array(MAX_NOTES);
  const py = new Float32Array(MAX_NOTES);
  const pz = new Float32Array(MAX_NOTES);
  const vx = new Float32Array(MAX_NOTES);
  const vy = new Float32Array(MAX_NOTES);
  const vz = new Float32Array(MAX_NOTES);
  // Tumble: an axis per note and a rate that winds down, integrated onto a quaternion so a note
  // can spin about any axis rather than about one of the three the Euler angles name.
  const ax = new Float32Array(MAX_NOTES);
  const ay = new Float32Array(MAX_NOTES);
  const az = new Float32Array(MAX_NOTES);
  const spin = new Float32Array(MAX_NOTES);
  const quats = Array.from({ length: MAX_NOTES }, () => new THREE.Quaternion());
  // The surface this note settles onto, so a getaway over a bridge lands on the deck rather than
  // on the road two units under it. Same reason sparks.js carries one.
  const floor = new Float32Array(MAX_NOTES);

  const dummy = new THREE.Object3D();
  const axis = new THREE.Vector3();
  const step = new THREE.Quaternion();
  const tint = new THREE.Color();
  const FACE = color('cashNote');
  const BACK_COL = color('cashBack');

  // Collapsed and painted up front: `setColorAt` allocates `instanceColor` on its first call and
  // recompiles the material, and doing that lazily would put a shader compile on the first frame
  // of a getaway — which is the one frame in this event that cannot afford one.
  for (let slot = 0; slot < MAX_NOTES; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, FACE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  let next = 0;
  let pending = 0;      // fractional notes owed, so the rate survives a variable frame length

  /** One note, thrown out of the back of a car at (x, y, z) heading `yaw` at `speed` u/s. */
  function emit(x, y, z, yaw, speed) {
    const slot = next;
    next = (next + 1) % MAX_NOTES;

    // `yaw` is a sim heading, so forward is (cos yaw, -sin yaw) and right is (sin yaw, cos yaw).
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const rx = Math.sin(yaw);
    const rz = Math.cos(yaw);
    const carry = carrySpeed(speed) * NOTE_CARRY;

    const back = rng.range(BACK[0], BACK[1]);
    const side = rng.jitter(SIDE);
    const up = rng.range(UP[0], UP[1]);

    life[slot] = LIFE * rng.range(0.8, 1.2);
    px[slot] = x - fx * TAIL_BACK + rng.jitter(0.18);
    py[slot] = y + LIFT;
    pz[slot] = z - fz * TAIL_BACK + rng.jitter(0.18);
    vx[slot] = -fx * back + rx * side + fx * carry;
    vy[slot] = up;
    vz[slot] = -fz * back + rz * side + fz * carry;
    floor[slot] = y - LIFT;

    // A random unit axis, so no two notes tumble about the same line. Normalised rather than
    // drawn on a sphere: the bias toward the cube's corners is invisible on a 4px rectangle.
    axis.set(rng.jitter(1), rng.jitter(1), rng.jitter(1));
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axis.normalize();
    ax[slot] = axis.x;
    ay[slot] = axis.y;
    az[slot] = axis.z;
    spin[slot] = SPIN * rng.range(0.6, 1.4) * (rng.chance(0.5) ? 1 : -1);
    quats[slot].identity();

    mesh.setColorAt(slot, tint.copy(FACE).lerp(BACK_COL, rng.next() * BACK_MIX));
    alphas[slot] = 1;
  }

  /**
   * Feed the stream for one frame.
   *
   * `on` is the whole gate — the caller decides what it means, and `main.js` reads it as "the pill
   * is held and there is a robber in the back". Rate-limited on a fractional accumulator rather
   * than a per-frame count, so the stream is the same density at 30fps as at 120.
   *
   * @param car the taxi, for `x`/`z`/`yaw`/`v`
   * @param y   the surface it is driving on — the note settles onto this
   */
  function feed(dt, on, car, y) {
    if (!on || !car || car.crashed) { pending = 0; return; }
    // Note the order this is called in relative to `update`: **feed first**. A note's instance
    // matrix is only written by the update pass, so a stream fed after it would put every note on
    // screen one frame late — which at the Loco top is 0.57 units of road, and reads as the trail
    // starting a car length back from the bumper.
    pending += RATE * dt;
    // Capped at the pool, so a long stalled frame cannot spend every slot on one tick and leave
    // the stream empty for the whole of the next second.
    const count = Math.min(MAX_NOTES, Math.floor(pending));
    pending -= count;
    for (let k = 0; k < count; k++) emit(car.x, y, car.z, car.yaw, car.v);
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_NOTES; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const age = 1 - Math.max(0, life[slot]) / LIFE;    // 0 fresh, 1 spent

      // Exponential rather than subtractive on both axes, so a long frame cannot push a note
      // backwards through zero — and on the vertical too, which is what makes this a flutter
      // rather than a fall.
      const keep = Math.exp(-DRAG * dt);
      vx[slot] *= keep;
      vz[slot] *= keep;
      vy[slot] = (vy[slot] - GRAVITY * dt) * Math.exp(-FALL_DRAG * dt);

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;

      // Settles rather than bounces. A banknote that hit the road and came back up would be the
      // one thing in this pool that reads as rubber.
      const rest = floor[slot] + NOTE_T;
      if (py[slot] <= rest) {
        py[slot] = rest;
        vx[slot] = 0;
        vy[slot] = 0;
        vz[slot] = 0;
        spin[slot] = 0;
      }

      if (spin[slot] !== 0) {
        spin[slot] *= Math.exp(-SPIN_DRAG * dt);
        axis.set(ax[slot], ay[slot], az[slot]);
        step.setFromAxisAngle(axis, spin[slot] * dt);
        quats[slot].premultiply(step);
      }

      // Held at full until FADE_FROM, so a note is solid for most of its flight and only thins as
      // it reaches the ground. Fading from birth makes the whole stream look like smoke.
      alphas[slot] = age < FADE_FROM ? 1 : 1 - (age - FADE_FROM) / (1 - FADE_FROM);
      if (life[slot] <= 0) alphas[slot] = 0;

      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.quaternion.copy(quats[slot]);
      dummy.scale.set(NOTE_L, NOTE_T, NOTE_W);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
      }
    }

    if (touched) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      geometry.getAttribute('aAlpha').needsUpdate = true;
    }
  }

  /** How many notes are in the air, for the tools. */
  const live = () => {
    let n = 0;
    for (let slot = 0; slot < MAX_NOTES; slot++) if (life[slot] > 0) n += 1;
    return n;
  };

  return { mesh, feed, update, live };
}
