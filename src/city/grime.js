import * as THREE from 'three';
import { bakeColors } from '../util/geo.js';
import { PALETTE } from '../palette.js';
// Read only inside functions: river.js imports this module, so a top-level use would be a cycle.
import { WATER_Y } from './river.js';

// The tide mark on every wall that stands in water: the channel's two walls, the harbor's quays,
// piers and seawall, and the south shore's. Darkest where the concrete is always wet, fading out
// as it climbs, the way river walls really weather — silt and algae at the line, rain-washed above.
//
// **A vertex colour, not a shader.** Every mesh in this project is flat shaded, but `vColor` is an
// ordinary interpolated varying (see `bakeColors`), so a wall cut into a few horizontal bands
// carries the gradient for nothing — on both renderers, through the AO and shadow passes, with no
// patch to keep in step. The bands are a handful of triangles on a wall that was two.
//
// The water mirrors the far wall, so the same curve is evaluated in its reflection
// (`waterReflect` in city/riverwater.js and its twin in city/gpuwater.js), off these constants.

/** How far up the wall, above the waterline, the grime has faded out. Of the 2.0 that show. */
export const GRIME_RISE = 1.3;
/** How far toward `PALETTE.riverGrime` the wall goes at the waterline itself. */
export const GRIME_DEPTH = 0.85;

// Heights above the waterline that get a row of vertices. Packed toward the bottom, where the
// curve below bends hardest; between rows the colour is linear, so these are the knots of a
// piecewise-linear `grimeAt`. The shader's reflection evaluates the curve exactly; at the 2 to 3
// screen pixels a reflected band spans the difference is not visible.
const ROWS = [0, 0.12, 0.3, 0.55, 0.85, GRIME_RISE];

/** Weight toward the grime colour at height `h` above the waterline: (1 − h/rise)², × depth. */
export function grimeAt(h) {
  if (h <= 0) return GRIME_DEPTH;
  if (h >= GRIME_RISE) return 0;
  const t = 1 - h / GRIME_RISE;
  return GRIME_DEPTH * t * t;
}

/**
 * A vertical wall from (ax, az) to (bx, bz), `bottom` to `top`, facing (nx, nz), in `col` with the
 * tide mark baked in. Wound from its own normal, asserted per band (a wall wound into the land is a
 * wall that does not draw).
 */
export function grimeWall(ax, az, bx, bz, nx, nz, top, bottom, col) {
  const base = col instanceof THREE.Color ? col : new THREE.Color(col);
  const grime = new THREE.Color(PALETTE.riverGrime);
  const ys = [bottom, top];
  for (const r of ROWS) {
    const y = WATER_Y + r;
    if (y > bottom + 1e-6 && y < top - 1e-6) ys.push(y);
  }
  ys.sort((a, b) => a - b);

  // Which of the two windings faces (nx, nz): (C − A) × (B − A) for A, B on top and C under B.
  const fx = (bottom - top) * (bz - az);
  const fz = -(bottom - top) * (bx - ax);
  const flip = fx * nx + fz * nz < 0;

  const pos = [];
  const cols = [];
  const tint = (y) => base.clone().lerp(grime, grimeAt(y - WATER_Y));
  for (let k = 0; k + 1 < ys.length; k++) {
    const lo = ys[k];
    const hi = ys[k + 1];
    const A = [ax, hi, az]; const B = [bx, hi, bz]; const C = [bx, lo, bz]; const D = [ax, lo, az];
    const tris = flip ? [A, B, C, A, C, D] : [A, C, B, A, D, C];
    for (const v of tris) {
      pos.push(...v);
      const c = tint(v[1]);
      cols.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  return bakeColors(g, new Float32Array(cols));
}
