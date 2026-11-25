import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import {
  BIG_CITY, GRID_I, GRID_J, lineX, lineZ, halfRoadX, halfRoadZ, riverBanks,
} from './grid.js';

// --- The pavement round the island's edge ----------------------------------------------------------
//
// Every block presents a kerb and a pale sidewalk to the street, and until this the ring road was
// the one street in the city with nothing on its outer side: the asphalt simply carried on past the
// last lane into the fog, so the city's edge read as a road that had been cut off rather than as a
// street running round a town. Tyler, 2026-11-25: "add a sidewalk around the edges of the map ...
// would partially fade into our cloud edges".
//
// **It is a block's kerb and pavement, bent into a ring.** The same `kerb` box at `KERB_H` with the
// same `sidewalk` surface inset `PAVE_INSET` on top of it, at the same `KERB_H + 0.01`, so where the
// ring meets a block across the road the two read as one material. It follows the ring road's outer
// kerb all the way round, with its corners concentric about the junction's own `CURB_RADIUS`.
//
// **The fade is the fog's, not its own.** The bank starts a unit inside the outer kerb and is opaque
// seven units past it (`FOG_START`/`FOG_END` in game/edgefog.js), with billows pushing it further out
// in places. `EDGE_WALK_W` puts the pavement's outer edge most of the way up that ramp, so it is clear
// at the kerb, mostly lost at its far side, and the billows decide where along the coast it shows whole
// — which is the "partially fades" of the brief with no second fade to keep in step with the first.
// A pavement of its own alpha would also have to sort against the skirt and every decal on the road.
//
// **It stops at the river.** The channel cuts the ring's east and west sides, and the embankment walk
// (city/river.js) already runs along each bank out to the coast, at the same height and in the same
// materials. The two halves of the ring end on that walk's kerb line and butt into it.
//
// Island only: `?city=big` keeps its harbor, shores and high rises out past the ring road, and they
// meet the street on terms of their own. `?edgewalk=classic` (`EDGEWALK=classic` headless) is the bare
// asphalt it replaced.

const PARAM = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('edgewalk')
  : globalThis.process?.env?.EDGEWALK;

export const EDGE_WALK = !BIG_CITY && PARAM !== 'classic';

/**
 * How far the pavement reaches past the ring road's outer kerb. 6 puts its far edge most of the way
 * up the fog's ramp. The first cut was 3.5, a block's worth of pavement, and it read worse: its far
 * edge sat half fogged with a band of dark asphalt beyond it before the bank, so the pale walk ended
 * on a hard tan-to-grey line instead of melting into the white. Pale into pale is what fades.
 */
export const EDGE_WALK_W = 6;

/** Points per corner arc. The arc is 4.1 units round at the outside: eight is smooth at play zoom. */
const ARC_STEPS = 8;

/** The ring road's outer kerb lines, one per side, and the radius its outside corners round to. */
export function edgeWalkKerbs() {
  return {
    west: lineX(0) - halfRoadZ(0),
    east: lineX(GRID_I) + halfRoadZ(GRID_I),
    north: lineZ(0) - halfRoadX(0),
    south: lineZ(GRID_J) + halfRoadX(GRID_J),
  };
}

/**
 * The runs of the ring, each a polyline along the outer kerb pushed `off` units outward, from one
 * river bank round to the other. Two U shapes on the island — the north half and the south half — or
 * one closed loop when there is no river to cut it.
 */
function runPoints(off, r, ends) {
  const k = edgeWalkKerbs();
  const R = r + off;
  const arc = (cx, cz, a0, a1, out) => {
    for (let s = 0; s <= ARC_STEPS; s++) {
      const a = a0 + (a1 - a0) * (s / ARC_STEPS);
      out.push([cx + Math.cos(a) * R, cz + Math.sin(a) * R]);
    }
  };
  const north = [];
  north.push([k.east + off, ends.north]);
  arc(k.east - r, k.north + r, 0, -Math.PI / 2, north);
  arc(k.west + r, k.north + r, -Math.PI / 2, -Math.PI, north);
  north.push([k.west - off, ends.north]);

  const south = [];
  south.push([k.west - off, ends.south]);
  arc(k.west + r, k.south - r, Math.PI, Math.PI / 2, south);
  arc(k.east - r, k.south - r, Math.PI / 2, 0, south);
  south.push([k.east + off, ends.south]);
  return [north, south];
}

/** A run as a Shape: the inner line out, the outer line back. Shape y is world −z (see ground.js). */
function bandShape(inner, outer) {
  const pts = [...inner, ...outer.slice().reverse()].map(([x, z]) => new THREE.Vector2(x, -z));
  return new THREE.Shape(pts);
}

/**
 * The kerb boxes and pavement surfaces, for `createGround` to merge into the ground mesh. Empty when
 * the feature is off. `kerbCol` and `walkCol` are the colours a block would get.
 */
export function edgeWalkParts({ kerbH, paveInset, kerbRadius, kerbCol, walkCol }) {
  if (!EDGE_WALK) return [];
  const banks = riverBanks();
  const k = edgeWalkKerbs();
  // With no river the two U shapes meet half way down each side, and the seam is a joint in the
  // paving like any other: the 0.3 of kerb showing between two inset surfaces.
  const ends = banks ? { north: banks.z0, south: banks.z1 } : { north: (k.north + k.south) / 2, south: (k.north + k.south) / 2 };

  const parts = [];
  const kerbInner = runPoints(0, kerbRadius, ends);
  const kerbOuter = runPoints(EDGE_WALK_W, kerbRadius, ends);
  // The pavement surface is inset from the kerb on all four edges, the ends included — the embankment
  // walk it butts into is inset the same way, so the joint reads as kerb between two surfaces.
  const paveEnds = { north: ends.north - paveInset, south: ends.south + paveInset };
  const paveInner = runPoints(paveInset, kerbRadius, paveEnds);
  const paveOuter = runPoints(EDGE_WALK_W - paveInset, kerbRadius, paveEnds);

  for (let n = 0; n < kerbInner.length; n++) {
    const kerb = new THREE.ExtrudeGeometry(bandShape(kerbInner[n], kerbOuter[n]), {
      depth: kerbH, bevelEnabled: false,
    });
    kerb.rotateX(-Math.PI / 2);
    parts.push(bakeColor(kerb, kerbCol));

    const pave = new THREE.ShapeGeometry(bandShape(paveInner[n], paveOuter[n]));
    pave.rotateX(-Math.PI / 2);
    pave.translate(0, kerbH + 0.01, 0);
    parts.push(bakeColor(pave, walkCol));
  }
  return parts;
}
