import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK, TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK } from '../geometry/taxi.js';

// Rubber left on the road when the taxi throws it around a corner in crazy mode.
//
// One geometry, one draw call, used as a ring buffer: marks are stamped in place and fade by
// alpha rather than being created and destroyed, so a long boost costs nothing extra.
//
// Alpha rides in a four-component colour attribute. three.js switches the shader to
// USE_COLOR_ALPHA based on the attribute's itemSize, which is the only way to vary transparency
// per-quad inside a single mesh — instanced colour is RGB only.

// Sized against the actual camera, not against the car. At the play zoom one world unit is
// roughly 7.7 screen pixels, so the first pass — 0.3 wide — was a two-pixel smear of near-black
// on dark tarmac. It was rendering correctly the whole time and was simply too small to see.
const RUBBER_MAX = 320;
const RUBBER_LIFE = 3.6;
const MARK_LENGTH = 1.5;
const RUBBER_WIDTH = 0.58;

// Each mark is a soft-edged patch rather than a hard quad: a 4 × 4 grid of vertices whose alpha
// falls to nothing at the two ends and to a fraction at the two sides, interpolated in between.
// The first cut was one quad at 0.85 alpha, and stamps 0.42 apart left a streak scalloped with a
// hard edge every 0.42 units and a hard rectangle at each end — rubber cut out of paper and laid
// on the road. With the ends feathered, consecutive stamps blend into one even band, and the band
// itself lands soft on the tarmac. Done in vertex alpha rather than a fragment patch so there is
// no shader to keep in step with the look modes or the program cache.
const ALONG = [-1, -0.4, 0.4, 1];       // fraction of the half-length
const ALONG_W = [0, 1, 1, 0];
const ACROSS = [-1, -0.45, 0.45, 1];    // fraction of the half-width
const ACROSS_W = [0.25, 1, 1, 0.25];
const VERTS = ALONG.length * ACROSS.length;

// Per-stamp opacity. Lower than the old 0.85 because stamps now overlap ~2.6 deep at full weight
// (1.5 long, 0.42 apart, 0.7 of it unfeathered), and alpha compounds: 1 − 0.5^2.6 ≈ 0.84 down the
// middle of a streak — the old darkness — while the single stamp at each end is 0.5 at most.
const RUBBER_ALPHA = 0.5;
const STAMP_JITTER = 0.2;               // per-stamp intensity spread, so a streak is not one flat band
const WIDTH_JITTER = 0.08;

// A streak fades in over its first stamps and out over its last, as a tyre takes up and lets go
// of the slide. A stamp joins the streak of a mark stamped recently and close by — no caller has
// to say which wheel it is, so the taxi, the brake and the cops all get it for nothing. CHAIN_REACH
// clears the stamp spacing at the overdrive top (0.42 plus a 0.57-unit frame) and stays well inside
// the gap between a car's left and right tracks (2.08 on the taxi's marks, about 1.7 on a cop).
const CHAIN_WINDOW = 0.3;               // seconds a mark stays open to a successor
const CHAIN_REACH = 1.1;
const HEAD_RAMP = [0.3, 0.55, 0.8];     // the first stamps of a streak; the rest are 1
// The tail can't be known until the streak has stopped, so it is applied after the fact: once the
// last mark has gone CHAIN_WINDOW without a successor, it and the few before it ease down. Eased,
// not set, so the end lightens over a quarter of a second instead of popping.
const TAIL_RAMP = [0.3, 0.55, 0.8];     // the last stamp first
const TAIL_EASE = 4;                    // per second

const RUBBER = color('skidRubber');

/**
 * `opts` makes the same pool a different mark: the squall's wet tyre tracks are this exact streak
 * machinery in another colour, a longer life and a lighter hand (see `wetTracks` in main.js). The
 * defaults are the rubber's.
 */
export function createSkidMarks(scene, {
  tint = RUBBER, max: MAX_MARKS = RUBBER_MAX, life: LIFE = RUBBER_LIFE, alpha: STAMP_ALPHA = RUBBER_ALPHA, width: MARK_WIDTH = RUBBER_WIDTH,
} = {}) {
  const positions = new Float32Array(MAX_MARKS * VERTS * 3);
  const colors = new Float32Array(MAX_MARKS * VERTS * 4);
  const life = new Float32Array(MAX_MARKS);
  const level = new Float32Array(MAX_MARKS);     // eased stamp intensity
  const target = new Float32Array(MAX_MARKS);
  const centre = new Float32Array(MAX_MARKS * 2);
  const chain = new Int32Array(MAX_MARKS);       // stamps before this one in its streak
  const prev = new Int32Array(MAX_MARKS).fill(-1);
  const prevId = new Int32Array(MAX_MARKS);
  const id = new Int32Array(MAX_MARKS);          // stamp serial, so a recycled slot can't be mistaken for a link
  const open = new Uint8Array(MAX_MARKS);        // no successor yet and the tail not yet applied

  const cells = ALONG.length - 1;
  const index = [];
  for (let m = 0; m < MAX_MARKS; m++) {
    const base = m * VERTS;
    for (let a = 0; a < cells; a++) {
      for (let c = 0; c < ACROSS.length - 1; c++) {
        const v0 = base + a * ACROSS.length + c;
        const v1 = v0 + ACROSS.length;
        // Wound to face up (tools/probe.mjs computes it). The single quad this replaced faced
        // down and only showed because the material is DoubleSide.
        index.push(v0, v1 + 1, v1, v0, v0 + 1, v1 + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(index);

  const mesh = new THREE.Mesh(
    geometry,
    unlitMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 2;   // over the tarmac, under the cars and every game marker
  mesh.frustumCulled = false;
  scene.add(mesh);

  for (let v = 0; v < MAX_MARKS * VERTS; v++) {
    colors[v * 4] = tint.r; colors[v * 4 + 1] = tint.g; colors[v * 4 + 2] = tint.b;
  }

  let next = 0;
  let serial = 0;

  /** The open mark this stamp continues, or -1: nearest, still young, within reach. */
  function predecessor(x, z) {
    let best = -1;
    let bestD = CHAIN_REACH * CHAIN_REACH;
    for (let s = 0; s < MAX_MARKS; s++) {
      if (life[s] <= LIFE - CHAIN_WINDOW) continue;
      const dx = centre[s * 2] - x;
      const dz = centre[s * 2 + 1] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  let tinted = false;

  /**
   * Stamp one mark, centred at (x, z) and lying along `yaw`, at `strength` (0..1) of full weight.
   * `colour` repaints this one stamp — a THREE.Color, or null for the pool's own tint.
   */
  function add(x, z, yaw, strength = 1, colour = null) {
    const before = predecessor(x, z);
    const slot = next;
    next = (next + 1) % MAX_MARKS;
    life[slot] = LIFE;
    id[slot] = ++serial;
    centre[slot * 2] = x;
    centre[slot * 2 + 1] = z;
    open[slot] = 1;
    if (before >= 0) {
      open[before] = 0;
      prev[slot] = before;
      prevId[slot] = id[before];
      chain[slot] = chain[before] + 1;
    } else {
      prev[slot] = -1;
      chain[slot] = 0;
    }
    const head = chain[slot] < HEAD_RAMP.length ? HEAD_RAMP[chain[slot]] : 1;
    target[slot] = level[slot] = head * strength * (1 - STAMP_JITTER * Math.random());

    const halfL = MARK_LENGTH / 2;
    const halfW = (MARK_WIDTH / 2) * (1 + WIDTH_JITTER * (Math.random() * 2 - 1));
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    const rx = Math.sin(yaw), rz = Math.cos(yaw);
    let p = slot * VERTS * 3;
    for (const a of ALONG) {
      for (const c of ACROSS) {
        positions[p++] = x + fx * a * halfL + rx * c * halfW;
        positions[p++] = 0.035;   // just clear of the road markings
        positions[p++] = z + fz * a * halfL + rz * c * halfW;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    if (colour || tinted) {
      const c = colour ?? tint;
      for (let v = slot * VERTS; v < (slot + 1) * VERTS; v++) {
        colors[v * 4] = c.r; colors[v * 4 + 1] = c.g; colors[v * 4 + 2] = c.b;
      }
      tinted = true;
    }
  }

  /** Ease the last few marks of a streak that has just ended. */
  function closeTail(slot) {
    let s = slot;
    for (let k = 0; k < TAIL_RAMP.length && s >= 0 && life[s] > 0; k++) {
      target[s] = Math.min(target[s], level[s] * TAIL_RAMP[k]);
      const back = prev[s];
      if (back < 0 || id[back] !== prevId[s]) break;
      s = back;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_MARKS; slot++) {
      if (life[slot] <= 0) continue;
      life[slot] -= dt;
      if (open[slot] && life[slot] <= LIFE - CHAIN_WINDOW) { open[slot] = 0; closeTail(slot); }
      if (level[slot] > target[slot]) level[slot] = Math.max(target[slot], level[slot] - TAIL_EASE * dt);
      // Write one final zero-alpha frame as it expires, or the last visible value sticks forever.
      const alpha = Math.max(0, life[slot] / LIFE) * STAMP_ALPHA * level[slot];
      let c = slot * VERTS * 4 + 3;
      for (const wa of ALONG_W) {
        for (const wc of ACROSS_W) {
          colors[c] = alpha * wa * wc;
          c += 4;
        }
      }
      touched = true;
    }
    if (touched) geometry.attributes.color.needsUpdate = true;
  }

  /** Marks still on the road — for the smoke test, which can't read alpha off a feathered corner. */
  function live() {
    let n = 0;
    for (let slot = 0; slot < MAX_MARKS; slot++) if (life[slot] > 0) n += 1;
    return n;
  }

  return { mesh, add, update, live };
}

/**
 * Rubber laid along each tyre's own path, for the bootleg. Everything else stamps on the car's
 * heading every so far down the road, which is right while the tyres point where they are going —
 * and a spin is the one manoeuvre where they don't: stamped that way it left a ladder of short rungs
 * lying across the slide instead of the curving streaks a handbrake turn actually writes.
 *
 * `tyres` is [along, across, strength] per wheel in the car's own frame (+along forward, +across
 * to its right). `update(car, add)` takes anything with `x`, `z`, `yaw` and calls
 * `add(x, z, yaw, strength)` per stamp; `reset()` ends the trail, so the next update only anchors.
 * Shared with tools/uturnreel.mjs so the New Move card's clip lays exactly what the game does.
 */
export const TYRE_MARK_STEP = 0.4;     // under the 1.5 mark length, so the stamps overlap into a band

/** The taxi's four, for the bootleg. The rears drag harder than the fronts, as a pulled handbrake does. */
export const SPIN_TYRES = [
  [-TAXI_REAR_AXLE_BACK, -TAXI_REAR_TRACK, 1], [-TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK, 1],
  [TAXI_FRONT_AXLE_FWD, -TAXI_FRONT_TRACK, 0.65], [TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK, 0.65],
];

export function createTyreTrail(tyres = SPIN_TYRES) {
  let last = null;
  return {
    get active() { return last !== null; },
    reset() { last = null; },
    update(car, add) {
      const fx = Math.cos(car.yaw), fz = -Math.sin(car.yaw);
      const rx = Math.sin(car.yaw), rz = Math.cos(car.yaw);
      const first = !last;
      last ??= tyres.map(() => ({ x: 0, z: 0 }));
      tyres.forEach(([along, across, strength], k) => {
        const x = car.x + fx * along + rx * across;
        const z = car.z + fz * along + rz * across;
        const at = last[k];
        if (first) { at.x = x; at.z = z; return; }
        const dx = x - at.x, dz = z - at.z;
        const len = Math.hypot(dx, dz);
        if (len < TYRE_MARK_STEP) return;
        // Along the tyre's own motion, evenly spaced however far it went this frame.
        const yaw = Math.atan2(-dz, dx);
        const n = Math.floor(len / TYRE_MARK_STEP);
        for (let i = 1; i <= n; i++) {
          const f = (i * TYRE_MARK_STEP) / len;
          add(at.x + dx * f, at.z + dz * f, yaw, strength);
        }
        at.x += (dx * n * TYRE_MARK_STEP) / len;
        at.z += (dz * n * TYRE_MARK_STEP) / len;
      });
    },
  };
}
