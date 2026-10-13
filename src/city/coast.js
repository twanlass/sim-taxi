import { GRID_I, GRID_J, lineX, lineZ, halfRoadX, halfRoadZ, riverBanks, ISLAND } from './grid.js';
import { harborPiers } from './harborplan.js';

// The island the city stands on (`?island=classic` keeps the old floating slab).
//
// Tyler, 2026-10-13, with a painted reference: "this is a island or peninsula surrounded by ocean
// on 3 sides". So the city no longer ends in an asphalt apron dissolving into the sky. Past the
// ring road there is a sidewalk, a grassy verge, and then the coast — beaches and rocky stretches
// on the west and south, the harbor's seawall on the east — with ocean out to the horizon. North of
// the city the land keeps going, up into a mountain (`mountainLift`).
//
// **One height field, not a set of polygons.** Everything outside the city's pad is `landHeight`,
// and the coast is simply where that field crosses sea level: the terrain mesh draws what is above
// it, the ocean draws what is below, and the shoreline falls out of the two meeting. An organic
// outline drawn as a polygon would need the terrain, the ocean, the beach colours and the foam each
// to agree with it; a contour of one function cannot disagree with itself.
//
// Pure functions of the grid, the river and the harbor: no rng, so the island is the same shape
// for every city with the same roads, and moving the coast cannot reshuffle any generator's stream.
// The organic part is sums of sines at unrelated frequencies and a hashed value noise.
//
// Shared with river.js and ground.js, which this module also reads constants from at call time —
// so nothing here may touch them while the modules are still loading.

export { ISLAND };

// The sea's own level. The same number as `WATER_Y` in river.js (the probe asserts it): the river
// runs out into this sea, so the two have to be one surface. Not imported, because river.js imports
// this module and a value read during the cycle would be undefined.
export const SEA_Y = -2;
// The kerb's height, for the same reason (`KERB_H` in ground.js).
const KERB = 0.35;

// The sidewalk round the outside of the ring road, before the grass starts. Every block in the city
// presents a pavement to the street, and the ring road's outer side used to present eight units of
// bare asphalt apron; with a verge out there it wants the same kerb and walk as everything else.
export const WALK = 2;

// --- The city's pad --------------------------------------------------------------------------

/**
 * The flat, paved part of the island: the city out to the far side of the walk round the ring
 * road. Square-cornered, so the terrain's grid can be cut to it exactly — a rounded corner would
 * leave a sawtooth of grid cells half under the pavement.
 *
 * `kW`..`kS` are the ring road's own outer kerbs. With a harbor the east edge stops **at** the kerb:
 * past it is the waterfront, which `city/harborplan.js` owns.
 */
export function pad() {
  const kW = lineX(0) - halfRoadZ(0);
  const kE = lineX(GRID_I) + halfRoadZ(GRID_I);
  const kN = lineZ(0) - halfRoadX(0);
  const kS = lineZ(GRID_J) + halfRoadX(GRID_J);
  return {
    kW, kE, kN, kS,
    x0: kW - WALK,
    x1: harborPiers() ? kE : kE + WALK,
    z0: kN - WALK,
    z1: kS + WALK,
  };
}

/** How far outside the pad a point is (Chebyshev, so the corners stay square). Negative inside. */
export function padDistance(x, z, p = pad()) {
  return Math.max(p.x0 - x, x - p.x1, p.z0 - z, z - p.z1);
}

// --- Noise -----------------------------------------------------------------------------------

const smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const smoothstep = (a, b, t) => smooth((t - a) / (b - a));

/** A wobble in [-1, 1] along a coast: three sines at unrelated frequencies, so it never repeats. */
function wave(s, k) {
  return 0.55 * Math.sin(0.083 * s + 1.3 + k * 2.1)
    + 0.3 * Math.sin(0.21 * s + 0.4 + k * 4.7)
    + 0.15 * Math.sin(0.53 * s + 2.2 + k * 1.3);
}

function hash(ix, iz) {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in [0, 1] on a lattice of `cell` units. */
function valueNoise(x, z, cell) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smooth(fx - ix);
  const tz = smooth(fz - iz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Polynomial smooth minimum: `min` with the corner rounded over `k` units. */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

// --- The coast -------------------------------------------------------------------------------

// How far out past the pad each coast runs, and how far it wanders either side of that. The floor
// (`COAST_OUT - COAST_WANDER` = 8) is wider than the widest beach's drop (`BEACH_RUN`), so the land
// is always back up at kerb height by the time it reaches the walk.
const COAST_OUT = 14;
const COAST_WANDER = 6;
// North of the harbor the mountain comes down to the water close in, between the far pier and the
// first slopes.
const HARBOR_NORTH_OUT = 4;
const HARBOR_NORTH_WANDER = 2.5;
// And the mountain's land does not run on east for ever: past the harbor it turns north at about
// this far beyond the pad, so there is open sea beyond the docks rather than a mainland.
const MAINLAND_EAST = 62;
// How round the island's two outer corners are.
const CORNER = 14;
// How far the land takes to drop from the verge to the waterline: a cliff, or a beach.
const CLIFF_RUN = 1.8;
const BEACH_RUN = 7;
// The seabed falls away this steeply past the waterline, and no deeper than `SEABED_FLOOR`.
// Gentle, so the shallows run a good way out and the sea is turquoise there before it goes blue.
const SEABED_SLOPE = 0.28;
const SEABED_FLOOR = 14;
// Where the river runs out through the verge it flares this much per unit, so it reaches the sea
// as a mouth rather than as a ditch.
const MOUTH_FLARE = 0.3;

/**
 * Signed distance to the coast, in world units: positive on land, negative at sea. Approximate —
 * each coast is an offset of the pad's edge rather than a true distance — but continuous, and
 * exact enough to shape a slope with.
 */
export function coastDistance(x, z, p = pad()) {
  const harbor = harborPiers();
  const gW = x - (p.x0 - (COAST_OUT + COAST_WANDER * wave(z, 0)));
  const gS = (p.z1 + COAST_OUT + COAST_WANDER * wave(x, 1)) - z;
  // East: a coast like the west's, or — with the harbor — the waterfront's own edge, with the
  // mountain's foot coming down to the sea north of it.
  const gE = harbor
    ? Math.max(p.x1 - x, (p.z0 - (HARBOR_NORTH_OUT + HARBOR_NORTH_WANDER * wave(x, 3))) - z)
    : (p.x1 + COAST_OUT + COAST_WANDER * wave(z, 2)) - x;
  // No north coast at all: the land runs on into the mountain.
  let g = smin(smin(gW, gS, CORNER), gE, CORNER);
  if (harbor) g = smin(g, (p.x1 + MAINLAND_EAST + COAST_WANDER * wave(z, 4)) - x, CORNER);

  // The river's mouths, cut through the verge to the sea.
  const banks = riverBanks();
  if (banks) {
    const mid = (banks.z0 + banks.z1) / 2;
    // The water's half-width (the channel less its two walks — `waterEdges` in river.js).
    const half = (banks.z1 - banks.z0) / 2 - 1.4;
    for (const side of harbor ? [-1] : [-1, 1]) {
      const past = side < 0 ? p.x0 - x : x - p.x1;
      if (past < -1) continue;
      g = Math.min(g, Math.abs(z - mid) - (half + Math.max(0, past) * MOUTH_FLARE));
    }
  }
  return g;
}

/** How much of a beach the coast nearest (x, z) is: 0 a rocky drop, 1 sand. */
export function beachiness(x, z) {
  // Its own wobble, slower than the coast's, so beaches and rocks come in stretches.
  const s = 0.6 * Math.sin(0.047 * (x - z) + 0.9) + 0.4 * Math.sin(0.113 * (x + z) + 2.6);
  return smoothstep(0.15, 0.55, s);
}

// --- The mountain ----------------------------------------------------------------------------

// The main peak, placed off the pad's north-east: behind the bank's side of town and clear of the
// harbor, the way the reference has it. Heights and spreads in world units.
const PEAK = { dx: -34, dz: 48, h: 58, sx: 34, sz: 26 };
// A lower shoulder to the west, so the range reads as a range and the top corner is not bare hills.
const SHOULDER = { x: -40, dz: 58, h: 30, sx: 30, sz: 24 };
// The foothills, rising off the north walk.
const FOOT_H = 9;
const FOOT_RUN = 28;

/** How far the mountain lifts the land at (x, z), before the coast is taken into account. */
export function mountainLift(x, z, p = pad()) {
  const dn = p.z0 - z;
  if (dn <= 0) return 0;
  const bump = (cx, cz, h, sx, sz) => h * Math.exp(-0.5 * (((x - cx) / sx) ** 2 + ((z - cz) / sz) ** 2));
  const foot = FOOT_H * smoothstep(1, FOOT_RUN, dn);
  const peak = bump(p.x1 + PEAK.dx, p.z0 - PEAK.dz, PEAK.h, PEAK.sx, PEAK.sz);
  const shoulder = bump(SHOULDER.x, p.z0 - SHOULDER.dz, SHOULDER.h, SHOULDER.sx, SHOULDER.sz);
  // Ridged noise: what turns two smooth humps into rock and gullies.
  const r = 1 - Math.abs(valueNoise(x, z, 14) * 2 - 1);
  const ridges = 7 * r * r * smoothstep(4, 30, dn);
  // The two humps are Gaussians, so they still have height at the walk; this lays them down to
  // nothing there, or the land would step up along the line the pad's edge runs on.
  return foot + (peak + shoulder) * smoothstep(0, 14, dn) + ridges;
}

// --- Height ----------------------------------------------------------------------------------

/**
 * The ground's height at (x, z), anywhere outside the pad: the verge at kerb height with a gentle
 * roll in it, dropping at the coast to the waterline over a cliff's run or a beach's, and on down
 * to the seabed — plus the mountain wherever the land has room for it.
 */
export function landHeight(x, z, p = pad()) {
  const g = coastDistance(x, z, p);
  const beach = beachiness(x, z);
  const run = CLIFF_RUN + (BEACH_RUN - CLIFF_RUN) * beach;
  if (g < 0) return SEA_Y - Math.min(-g * SEABED_SLOPE + 0.15, SEABED_FLOOR);

  // The verge: flat at the walk, rolling a little further out. A cliff stands a little proud of it,
  // which is what makes a rocky coast read as rock from above rather than as a steep lawn.
  const out = Math.max(0, padDistance(x, z, p));
  const roll = 0.7 * valueNoise(x, z, 9) * smoothstep(0, 6, out);
  const rim = 1.1 * (1 - beach) * smoothstep(run + 6, run, g) * smoothstep(0, 4, out);
  const verge = KERB + roll + rim;
  const lift = mountainLift(x, z, p) * smoothstep(2, 16, g);
  if (g >= run) return verge + lift;
  // The drop. A beach comes down on a smoothstep so the sand shelves out flat at the waterline; a
  // cliff on a steeper curve that keeps its edge.
  const t = g / run;
  const shape = beach > 0.5 ? smooth(t) : Math.sqrt(t);
  return SEA_Y + (verge - SEA_Y) * shape + lift;
}

/** How deep the sea is at (x, z): 0 on land. */
export function seaDepth(x, z, p = pad()) {
  return Math.max(0, SEA_Y - landHeight(x, z, p));
}
