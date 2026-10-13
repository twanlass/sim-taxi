import { SPAN_Z, SLAB_MARGIN, harborBasin, riverBanks, coastEast } from './grid.js';

// The shape of the land and the sea around the harbor (city/harbor.js).
//
// East of the ring road the island is no longer one slab with a dock cut into it. It is a strip of
// waterfront along the ring road, two piers either side of the dock, and **sea** everywhere else,
// out to where the island's rim used to be. Tyler, 2026-10-13, circling the bare asphalt past the
// yards: "Can we fill these with water? And make the waterfront edge more organic".
//
// So the slab's outline (ground.js), the walls standing on its edge (harbor.js) and the sea under
// it (river.js) all read the one outline built here, and nothing has to agree with anything by
// matching numbers in three files.
//
// Pure functions of the grid and the river row: no rng, so the shoreline is the same shape for a
// given city and moving it cannot reshuffle any other generator's stream.

// How deep each pier reaches from its quay, along z. Room for the crane strip (about 11 units of
// legs and backreach) and a container block behind it.
const PIER_DEPTH = 30;
// How far east the piers run, short of the sea's outer edge, so they end in open water rather than
// in the band where the sea is already dissolving into the sky.
const PIER_SHORT = 14;
// The rounded corner where the island's north (and south) coast turns into the seawall.
export const SEA_CORNER = 10;
// The seawall's mean line, off the ring road's kerb. Its wobble (`SEAWALL_WOBBLE`) has to stay
// clear of the yards' platforms, which start 1.4 off the kerb.
const SEAWALL_SET = 3.6;
const SEAWALL_WOBBLE = [1.1, 0.55];
// Spacing of the seawall's vertices along z. Under ~2 units the wobble's finer term is resolved
// rather than aliased into straight runs.
const SEAWALL_STEP = 1.5;

/** Half the island's depth in z: where the north and south coasts are. */
export const coastZ = () => (SPAN_Z + SLAB_MARGIN) / 2;

/**
 * The seawall's x at a given z: a wobbling line rather than a ruled one. Two sines at unrelated
 * frequencies, so it never visibly repeats over the length of a coast.
 */
export function seawallX(kerbX, z) {
  return kerbX + SEAWALL_SET
    + SEAWALL_WOBBLE[0] * Math.sin(0.43 * z + 0.4)
    + SEAWALL_WOBBLE[1] * Math.sin(1.31 * z + 2.1);
}

/**
 * The two piers and the waterfront, or null without a harbor.
 *
 * `near` is the +z pier and `far` the -z one; each has its `quay` (the basin's wall) and its `out`
 * edge (the open sea's side). `end` is where both piers stop to the east.
 */
export function harborPiers() {
  const basin = harborBasin();
  if (!basin) return null;
  const hd = coastZ();
  // Clear of the corner arc, with a few units of seawall left between the two.
  const reach = hd - SEA_CORNER - 4;
  return {
    basin,
    end: coastEast() - PIER_SHORT,
    near: { quay: basin.z1, out: Math.min(basin.z1 + PIER_DEPTH, reach) },
    far: { quay: basin.z0, out: Math.max(basin.z0 - PIER_DEPTH, -reach) },
  };
}

/**
 * One half of the island as a world-space (x, z) polygon, with the harbor's waterfront on its east
 * side: `side` +1 for the half north of the river (z above the channel), -1 for the other.
 *
 * Starts at the west end of the channel cut and runs round the west corner, along the coast, round
 * the corner into the seawall, down the seawall to the pier, round the pier to the quay, and back
 * along the basin's back wall to the cut. The caller fixes the winding.
 */
export function islandHalf(side, x0, radius) {
  const piers = harborPiers();
  const banks = riverBanks();
  const { basin } = piers;
  const pier = side > 0 ? piers.near : piers.far;
  const cut = side > 0 ? banks.z1 : banks.z0;
  const hd = coastZ();
  const pts = [];
  const push = (x, z) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - z) < 1e-9) return;
    pts.push([x, z]);
  };
  const arc = (cx, cz, r, from, to, n) => {
    for (let k = 0; k <= n; k++) {
      const t = from + (to - from) * (k / n);
      push(cx + r * Math.cos(t), cz + side * r * Math.sin(t));
    }
  };

  push(x0, cut);
  // The west corner, as the whole island's was (ground.js `slabShape`).
  arc(x0 + radius, side * (hd - radius), radius, Math.PI, Math.PI / 2, 14);
  // Along the coast and round into the seawall.
  const topZ = side * (hd - SEA_CORNER);
  const wallTop = seawallX(basin.kerbX, topZ);
  arc(wallTop - SEA_CORNER, topZ, SEA_CORNER, Math.PI / 2, 0, 8);
  // Down the seawall to the pier.
  const steps = Math.max(1, Math.round(Math.abs(topZ - pier.out) / SEAWALL_STEP));
  for (let k = 1; k <= steps; k++) {
    const z = topZ + (pier.out - topZ) * (k / steps);
    push(seawallX(basin.kerbX, z), z);
  }
  // Round the pier and back along the quay.
  push(piers.end, pier.out);
  push(piers.end, pier.quay);
  push(basin.x0, pier.quay);
  push(basin.x0, cut);
  return pts;
}

/** Where the island's coast stops being a coast and becomes the seawall: the corner arc's start. */
export function seaStartX() {
  const piers = harborPiers();
  if (!piers) return Infinity;
  const hd = coastZ();
  return Math.min(coastArcStart(1), coastArcStart(-1));
}

// **Where the island's rim hands over to the sea's.** Out past the north and south coasts both
// fade into the sky, the rim dark and the sea blue. Cutting from one to the other on a line drew a
// hard seam with a sliver of open sky beside it: the sea sits two units lower, so under this camera
// it lands 2.17 units further +x and +z than the rim it is meant to butt against. So the rim does
// not stop where the coast turns into the seawall. It carries on round the corner arc over the
// water, tapering out over `SEA_BLEND`, and the sea fades in underneath it (ground.js
// `seaCornerFade`).
export const SEA_BLEND = SEA_CORNER;

/** Where the coast on one side (`side` +1 north of the river, -1 south) turns into the seawall. */
export function coastArcStart(side) {
  const piers = harborPiers();
  if (!piers) return Infinity;
  return seawallX(piers.basin.kerbX, side * (coastZ() - SEA_CORNER)) - SEA_CORNER;
}

/** The corner arc's |z| at a world x past `coastArcStart(side)`: the coast curving into the seawall. */
export function coastArcZ(side, x) {
  const dx = Math.min(SEA_CORNER, Math.max(0, x - coastArcStart(side)));
  return coastZ() - (SEA_CORNER - Math.sqrt(SEA_CORNER * SEA_CORNER - dx * dx));
}

// The sea's own outer edge: a rectangle out to the east coast, rounded at its two east corners on
// the island's own radius so the rim reads as one shape.
const SEA_RADIUS = 22;

/**
 * How far inside the sea's outer edge a point is: positive in the open water, 0 on the line where
 * the island's rim would be, negative out in the fade. Measured the way the asphalt's skirt is, so
 * the sea's shoal and fade run on the rim's own band.
 */
export function seaInset(x, z) {
  const hd = coastZ();
  const qx = x - (coastEast() - SEA_RADIUS);
  const qz = Math.abs(z) - (hd - SEA_RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
  return SEA_RADIUS - outside;
}

/** Even-odd point-in-polygon over world (x, z) pairs. */
export function insidePolygon(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether a point east of the city stands on the waterfront (ring road strip, piers, aprons) rather
 * than in the sea. For things that need footing out there — the L train's columns. Always true
 * without a harbor, and west of where the sea starts, where everything is island.
 */
export function harborLandAt(x, z) {
  if (!harborPiers() || x < seaStartX()) return true;
  const banks = riverBanks();
  if (z > banks.z0 && z < banks.z1) return false;   // the channel and the basin
  // The west end of the outline does not matter out here, so any x0 and radius will do.
  return insidePolygon(islandHalf(z > 0 ? 1 : -1, -1e3, 1), x, z);
}
