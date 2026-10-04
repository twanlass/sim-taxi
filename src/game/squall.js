import * as THREE from 'three';
import { HALF_SPAN_X, HALF_SPAN_Z } from '../city/grid.js';

/**
 * A squall — `?squall`. One rain cell crossing the city while the rest of it stays in the sun: it
 * comes in over one corner, drags a curtain of rain and a patch of cloud shade across the streets,
 * goes out over the opposite corner, and leaves a wet trail behind it that dries off in the sun.
 * Then a quiet spell, and another one from a different corner.
 *
 * Two things live here, and both are positions rather than levels:
 *
 * - **The cell**: centre, radius, and whether it is on. `cellAt(x, z)` is the same soft, ragged
 *   footprint the shaders draw (`CELL_GLSL` in util/geo.js), so anything on the CPU that asks "is it
 *   raining here" — the grip under the taxi, a car's headlights — agrees with what is on screen.
 * - **The wet map**: a `WET_RES`² grid over the island, soaked up quickly under the cell and dried
 *   slowly after it, handed to the ground shader as a texture. It is what makes the trail: the cell
 *   is a circle, the wet ground is everywhere it has been.
 */

/** Seconds: a crossing, then the quiet spell after it. The first cell waits `FIRST` to arrive. */
export const CROSS = 75;
export const GAP = 25;
const FIRST = 12;

/** The cell's size: radius at its core, and the soft edge outside that. */
export const CELL_R = 30;
export const CELL_EDGE = 14;

/** Where the cell starts and ends: this far outside the city's corners, so it arrives whole. */
const OVERSHOOT = 30;

/** The wet map: resolution, and the square of ground it covers (centred on the origin). */
export const WET_RES = 96;
export const WET_EXTENT = 170;

/** Time constants for the ground, seconds: soaking up under the cell, drying off after it. */
const WET_UP = 3;
// 30 first, and the trail was half gone by the time the cell was halfway across the city — at a
// glance the rain looked like it was drying the ground behind itself. 45 keeps the line it took
// readable for most of a crossing.
const DRY = 45;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The same value noise as `cloudNoise` in util/geo.js, so the ragged edge on the CPU matches the
// one the shaders draw. `fract(sin(...))` is not bit-identical between a GPU and float64, but the
// edge only has to agree to within its own softness.
const fract = (v) => v - Math.floor(v);
const hash = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * fx;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}

/** How far into the cell a point is: 1 at the core, 0 outside, ragged at the edge. */
export function cellMask(cell, x, z, t) {
  if (!cell.on) return 0;
  const d = Math.hypot(x - cell.x, z - cell.z);
  const r = cell.r * (0.82 + 0.36 * noise(x / 16 + t * 0.04, z / 16 - t * 0.03));
  return 1 - smooth(r, r + CELL_EDGE, d);
}

/** The four corners, as unit directions out from the middle of the city. */
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

export function createSquall({ pin = null, rng = Math.random } = {}) {
  const cell = { x: 0, z: 0, r: CELL_R, on: false, dirX: 1, dirZ: 0 };
  const state = { t: 0, crossing: -1, progress: 0, pinned: pin, maxWet: 0 };

  // The grid, and the texture the ground reads it from. One channel, linear filtered, so the
  // trail's edge is smooth at ~1.8 units a texel.
  const wet = new Float32Array(WET_RES * WET_RES);
  const texData = new Uint8Array(WET_RES * WET_RES);
  const texture = new THREE.DataTexture(texData, WET_RES, WET_RES, THREE.RedFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  // One crossing: from outside a corner to outside the one opposite. Each new one starts at a
  // different corner from the last.
  let from = [0, 0];
  let to = [0, 0];
  let corner = Math.floor(rng() * 4);
  function newCrossing() {
    corner = (corner + 1 + Math.floor(rng() * 3)) % 4;
    const [sx, sz] = CORNERS[corner];
    // Not dead through the middle: a little sideways slip, so successive crossings take different
    // lines across the blocks.
    const slip = (rng() - 0.5) * 40;
    from = [sx * (HALF_SPAN_X + OVERSHOOT) - sz * slip, sz * (HALF_SPAN_Z + OVERSHOOT) + sx * slip];
    to = [-sx * (HALF_SPAN_X + OVERSHOOT) - sz * slip, -sz * (HALF_SPAN_Z + OVERSHOOT) + sx * slip];
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    cell.dirX = (to[0] - from[0]) / len;
    cell.dirZ = (to[1] - from[1]) / len;
  }

  /** Where the cell is at time `t`: on a crossing, or off between them. */
  function place(t) {
    if (state.pinned !== null) {
      state.progress = state.pinned;
      cell.on = true;
    } else {
      const u = t - FIRST;
      const n = Math.floor(u / (CROSS + GAP));
      const into = u - n * (CROSS + GAP);
      if (u < 0 || into > CROSS) {
        cell.on = false;
        return;
      }
      if (n !== state.crossing) {
        state.crossing = n;
        newCrossing();
      }
      state.progress = into / CROSS;
      cell.on = true;
    }
    cell.x = from[0] + (to[0] - from[0]) * state.progress;
    cell.z = from[1] + (to[1] - from[1]) * state.progress;
  }

  const upK = (dt) => 1 - Math.exp(-dt / WET_UP);
  const dryK = (dt) => 1 - Math.exp(-dt / DRY);

  function soak(dt) {
    const ku = upK(dt);
    const kd = dryK(dt);
    const step = WET_EXTENT / WET_RES;
    let max = 0;
    for (let j = 0; j < WET_RES; j++) {
      const z = (j + 0.5) * step - WET_EXTENT / 2;
      for (let i = 0; i < WET_RES; i++) {
        const k = j * WET_RES + i;
        const x = (i + 0.5) * step - WET_EXTENT / 2;
        const target = cellMask(cell, x, z, state.t);
        const w = wet[k];
        const next = target > w ? w + (target - w) * ku : w - w * kd;
        wet[k] = next;
        texData[k] = Math.round(next * 255);
        if (next > max) max = next;
      }
    }
    state.maxWet = max;
    texture.needsUpdate = true;
  }

  function update(dt) {
    state.t += dt;
    place(state.t);
    soak(dt);
    return state;
  }

  /**
   * Fast-forward a pinned squall from the start of its crossing to where it is pinned, so a still
   * frame shows the trail it would have left — the one thing a pin cannot get from the clock alone.
   */
  function settle() {
    if (state.pinned === null) return;
    const target = state.pinned;
    wet.fill(0);
    for (let p = 0; p <= target; p += 0.5 / CROSS) {
      state.pinned = p;
      place(state.t);
      soak(0.5);
    }
    state.pinned = target;
    place(state.t);
  }

  newCrossing();
  if (state.pinned !== null) settle();

  /** The wet map, sampled bilinearly — the grip under a car. */
  function wetAt(x, z) {
    const fx = ((x + WET_EXTENT / 2) / WET_EXTENT) * WET_RES - 0.5;
    const fz = ((z + WET_EXTENT / 2) / WET_EXTENT) * WET_RES - 0.5;
    const i = Math.max(0, Math.min(WET_RES - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(WET_RES - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));
    const k = j * WET_RES + i;
    const a = wet[k] + (wet[k + 1] - wet[k]) * u;
    const b = wet[k + WET_RES] + (wet[k + WET_RES + 1] - wet[k + WET_RES]) * u;
    return a + (b - a) * v;
  }

  /**
   * The most it will rain at a point over the next `ahead` seconds of this crossing — the cell's
   * path swept forward in steps of a few seconds (~11 units at its ~3.2 u/s, well inside its 14-unit
   * soft edge). Only the crossing already under way: the next one starts outside a corner after a
   * `GAP` of 25s, and is a long way from anything when it does.
   */
  function rainSoon(x, z, ahead) {
    let most = cellMask(cell, x, z, state.t);
    if (!cell.on || state.pinned !== null) return most;
    const probe = { x: 0, z: 0, r: cell.r, on: true };
    for (let dt = 3.5; dt <= ahead + 1e-9; dt += 3.5) {
      const p = state.progress + dt / CROSS;
      if (p > 1) break;
      probe.x = from[0] + (to[0] - from[0]) * p;
      probe.z = from[1] + (to[1] - from[1]) * p;
      most = Math.max(most, cellMask(probe, x, z, state.t + dt));
    }
    return most;
  }

  return {
    state,
    cell,
    /** The cell's soft edge, for the shaders' copy of its footprint. */
    edge: CELL_EDGE,
    texture,
    update,
    wetAt,
    /** How hard it is raining at a point, 0..1. */
    rainAt: (x, z) => cellMask(cell, x, z, state.t),
    rainSoon,
    /** Pin the cell part-way along a crossing (0..1), or null to let the clock run. */
    pin: (v) => { state.pinned = v; settle(); },
    /** Jump the clock — `?squall` takes a while to arrive, and this is for looking at it. */
    seek: (t) => { state.t = t; },
  };
}
