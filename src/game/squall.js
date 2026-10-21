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

/**
 * Seconds: a crossing, then the quiet spell after it. The first cell waits `FIRST` to arrive, and
 * that wait is counted on the crossing clock (`state.clock`), which only runs once the taxi is the
 * player's to drive — `begin()`, called by main.js on the frame the pedals arrive. Counted from boot
 * (12s, as it first was), the title menu and the garage vignette spent it, so a player who read the
 * menu for a while drove out of the door into a cell already overhead.
 */
export const CROSS = 75;
export const GAP = 25;
const FIRST = 20;

/**
 * The cell's size: radius at its core, and the soft edge outside that. 30 and 14 first, and with
 * the shade reaching 3.2 edges past the core that was a dark patch ~150 units across over an island
 * 105 by 129 — less a cell crossing the city than the city under a cloud. 20 and 10 put the shade's
 * edge 52 units out rather than 75, so the sunny streets either side of it stay in the frame.
 */
export const CELL_R = 20;
export const CELL_EDGE = 10;

/**
 * The front: how the cell's shade, its rain and the city's lights fall off past the ragged edge of
 * its core, in multiples of `CELL_EDGE`. The cell crosses at ~3.6 u/s, so one edge is ~3s at a point.
 *
 * The first front (`RAMP_CLASSIC`, `?squallramp=classic`) put all three on the same stretch of
 * ground: the shade over 0–1.6 edges, the lights reading that same shade, and the rain over 0–1. At
 * any one point the sun went, every window came on and the rain started inside the same ~6s, which
 * read as a switch rather than weather. The graded one pulls them apart in space, so at a point they
 * arrive in order:
 *
 * - **Shade first**, from 3.2 edges out to full at 0.6, so the sky has darkened most of the way
 *   (half at 1.9 edges) before anything falls.
 * - **The lights through the shade**, a light's threshold read against the shade from 0.15 to 0.95
 *   of it, so they come on across ~8s of darkening rather than ~6s of everything at once.
 * - **A drizzle**, a quarter of the rain from 1.6 edges in, ahead of the downpour's own 0–1 edge.
 *   In the streaks it is a quarter of the *drops* rather than every drop at a quarter of its alpha
 *   (`density`), because a faint full curtain reads as haze and a sparse one as drizzle.
 *
 * Then the same thing backwards on the trailing side. `fade` is the share of a crossing the cell
 * takes to come up to strength and to die away again: it starts and ends far enough out that its
 * core is off the map, but its shade does not.
 */
export const RAMP = {
  drizzleReach: 1.6, drizzle: 0.25, shadeIn: 0.6, shadeOut: 3.2,
  lightLo: 0.15, lightSpan: 0.8, density: 1, fade: 0.1,
};
export const RAMP_CLASSIC = {
  drizzleReach: 1, drizzle: 0, shadeIn: 0, shadeOut: 1.6,
  lightLo: 0, lightSpan: 1, density: 0, fade: 0,
};

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

/** How far past the ragged edge of the cell's core a point is — negative inside it. */
function cellFront(cell, x, z, t) {
  const d = Math.hypot(x - cell.x, z - cell.z);
  return d - cell.r * (0.82 + 0.36 * noise(x / 16 + t * 0.04, z / 16 - t * 0.03));
}

/**
 * How hard it is raining at a point: 1 at the core, the drizzle's share out across its band, 0
 * outside. `cellRain` in util/geo.js is the same thing on the GPU; keep the two in step.
 */
export function cellMask(cell, x, z, t, ramp = RAMP) {
  if (!cell.on) return 0;
  const f = cellFront(cell, x, z, t);
  const heavy = 1 - smooth(0, CELL_EDGE, f);
  const drizzle = ramp.drizzle * (1 - smooth(0, CELL_EDGE * ramp.drizzleReach, f));
  return (cell.strength ?? 1) * Math.max(heavy, drizzle);
}

/** How far a point is into the cell's shade, 0..1 — `cellShade` in util/geo.js. */
export function cellShade(cell, x, z, t, ramp = RAMP) {
  if (!cell.on) return 0;
  const f = cellFront(cell, x, z, t);
  return (cell.strength ?? 1) * (1 - smooth(CELL_EDGE * ramp.shadeIn, CELL_EDGE * ramp.shadeOut, f));
}

/** The four corners, as unit directions out from the middle of the city. */
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

export function createSquall({ pin = null, rng = Math.random, ramp = RAMP } = {}) {
  const cell = { x: 0, z: 0, r: CELL_R, on: false, dirX: 1, dirZ: 0, strength: 1 };
  const mask = (c, x, z, t) => cellMask(c, x, z, t, ramp);
  // `t` is the weather's own time (the ragged edge's noise), always running; `clock` is the
  // crossings', held at zero until `begin()`.
  const state = { t: 0, clock: 0, running: false, crossing: -1, progress: 0, pinned: pin, maxWet: 0 };

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
    // Up to strength over the first `fade` of the crossing and down over the last, so a cell
    // switching on outside a corner does not snap its shade on over the corner it is beside.
    const p = state.progress;
    cell.strength = ramp.fade > 0 ? smooth(0, ramp.fade, p) * (1 - smooth(1 - ramp.fade, 1, p)) : 1;
    if (state.pinned !== null) cell.strength = 1;
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
        const target = mask(cell, x, z, state.t);
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
    if (state.running) state.clock += dt;
    place(state.clock);
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
      place(state.clock);
      soak(0.5);
    }
    state.pinned = target;
    place(state.clock);
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
   * path swept forward in steps of a few seconds (~10 units at its ~3.3 u/s, inside its 10-unit
   * soft edge). Only the crossing already under way: the next one starts outside a corner after a
   * `GAP` of 25s, and is a long way from anything when it does.
   */
  function rainSoon(x, z, ahead) {
    let most = mask(cell, x, z, state.t);
    if (!cell.on || state.pinned !== null) return most;
    const probe = { x: 0, z: 0, r: cell.r, on: true, strength: 1 };
    for (let dt = 3; dt <= ahead + 1e-9; dt += 3) {
      const p = state.progress + dt / CROSS;
      if (p > 1) break;
      probe.x = from[0] + (to[0] - from[0]) * p;
      probe.z = from[1] + (to[1] - from[1]) * p;
      most = Math.max(most, mask(probe, x, z, state.t + dt));
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
    /** How the front falls off — `RAMP`, or `RAMP_CLASSIC` under `?squallramp=classic`. */
    ramp,
    /** How hard it is raining at a point, 0..1. */
    rainAt: (x, z) => mask(cell, x, z, state.t),
    /** `rainAt` for a cell grown by `reach` units — the same ragged edge, just further out. */
    rainNear: (x, z, reach) => mask({ ...cell, r: cell.r + reach }, x, z, state.t),
    /** How far the city's lights are on at a point, 0..1 — `litLevelAt` in game/citylights.js. */
    lightAt: (x, z) => Math.min(1, Math.max(0,
      (cellShade(cell, x, z, state.t, ramp) - ramp.lightLo) / ramp.lightSpan)),
    rainSoon,
    /** Pin the cell part-way along a crossing (0..1), or null to let the clock run. */
    pin: (v) => { state.pinned = v; settle(); },
    /** Jump the crossing clock — `?squall` takes a while to arrive, and this is for looking at it. */
    seek: (t) => { state.clock = t; state.running = true; },
    /** Start the crossing clock: the taxi is on the road. Idempotent. */
    begin: () => { state.running = true; },
  };
}
