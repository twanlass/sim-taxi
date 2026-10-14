import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  WEST_EDGE, WEST_COLUMNS, GRID_J, HALF_ROAD, lineX, lineZ, halfRoadX, halfRoadZ,
  isArterialX, isRiverBlock, isRiverGap, MEDIAN_W,
} from './grid.js';
import { KERB_H, PAVE_INSET, curbBox, roundedPaint, paint } from './ground.js';
import { buildHighRise, splitLot } from './buildings.js';
import { barricadeParts, coneGeometry } from '../geometry/roadworks.js';

// The high rises past the west ring road (`?westedge=classic` leaves the old apron).
//
// Tyler, 2026-10-14, circling the empty fog off the west of the map: "for our west edge I'm thinking
// we start some high rises and sky scrapers. Have through streets visually continue but block them
// off from the game grid with construction barriers". So the island carries on west for two more
// columns of blocks on the grid's own pitch (`WEST_REACH`, grid.js), every street running along X
// carries on out to the coast, and where each one leaves the ring road it is shut with a trestle and
// a row of cones. A town that keeps going past the edge of the map, rather than a map with an edge.
//
// Scenery only, the harbor's and the north park's terms: nothing routes into it, no fare stands in
// it, no car drives it, and the road network never hears of it. Its own rng stream.
//
// **Why the towers can be tall here and nowhere else.** The camera looks down the -x-z diagonal, so
// the sightline off any point in the city leaves it toward +x+z — away from the west edge. Nothing
// standing west of the ring road's kerb can come between the camera and anything east of it, however
// tall: a tower out here is drawn up-screen *behind* the streets, never over them. `tools/probe.mjs`
// fires real rays from the ring road and the taxi's height to say so. What a tall tower *can* reach
// is the sky the aircraft use, which is what `WEST_SKYLINE` is for.

/**
 * Nothing out here reaches past this, masts included. The aeroplane cruises over it with four units
 * to spare under its belly (`CRUISE_ALT` in game/flyover.js reads this), and the two helicopters,
 * which transit at 22, are kept out of the tall column entirely (`WEST_CLEAR_X`).
 */
export const WEST_SKYLINE = 38;

// The heights, by column out from the ring road. The near column stays under the city's own ceiling
// (`SKYLINE_CEILING`, 20.5) so it is the same city carrying on, and so the helicopters can cross it;
// the far one is the skyline. Stepping up away from the edge is also what keeps the near column
// from walling off the far one: a 34-unit tower behind a 19-unit one still shows 12 storeys over it.
const NEAR_H = [9, 18.5];
const FAR_H = [22, 33];
// The mast on top of some of the far towers: the thing that says *skyscraper* at a distance.
const MAST_CHANCE = 0.4;
const MAST_H = [2.5, 5];
// The far column leans to glass: a skyline of brick is a tall walk-up, not a downtown.
const FAR_FAMILIES = ['glass', 'glass', 'slate', 'slate', 'concrete', 'pale'];

// The closure at the mouth of each street: a trestle just past the ring road's kerb line, and cones
// behind it. Set back far enough that its splayed legs stay clear of the kerb line itself, which is
// where a car pulled over on the ring road has its outer wheels.
const BARRIER_BACK = 1.1;
const CONE_BACK = 2.6;
const CONE_PITCH = 1.7;

// Heights, named off the block platform's own (CLAUDE.md: two flat surfaces at one height shimmer).
const PAVE_Y = KERB_H + 0.01;

/** The x of the ring road's west kerb: the line nothing out here may cross. */
export const westKerbX = () => lineX(0) - halfRoadZ(0);

/**
 * The x east of which nothing taller than the city's own ceiling stands: the far column's east kerb.
 * The helicopters, which fly at 22, keep their whole flight east of this.
 */
export const WEST_CLEAR_X = WEST_EDGE ? lineX(-1) - HALF_ROAD : -Infinity;

/** The blocks out here, near column first: bounds, and which column. */
export function westBlocks() {
  const out = [];
  for (let c = 1; c <= WEST_COLUMNS; c++) {
    const bi = -c;
    const x0 = lineX(bi) + HALF_ROAD;
    const x1 = bi === -1 ? westKerbX() : lineX(bi + 1) - HALF_ROAD;
    for (let bj = 0; bj < GRID_J; bj++) {
      if (isRiverBlock(-1, bj)) continue;
      const z0 = lineZ(bj) + halfRoadX(bj);
      const z1 = lineZ(bj + 1) - halfRoadX(bj + 1);
      out.push({ column: c, bi, bj, bounds: { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 } });
    }
  }
  return out;
}

/** The barricaded mouths: one per street along X, at the ring road's west kerb. */
export function westClosures() {
  if (!WEST_EDGE) return [];
  const out = [];
  for (let j = 0; j <= GRID_J; j++) {
    out.push({ j, x: westKerbX() - BARRIER_BACK, z: lineZ(j), half: halfRoadX(j) });
  }
  return out;
}

export function createWestEdge(rng) {
  if (!WEST_EDGE) return null;
  const ground = [];
  const towers = [];
  const blocks = westBlocks();
  const kerbCol = () => jitterColor(PALETTE.kerb, rng, { l: 0.02 });
  const walkCol = () => jitterColor(PALETTE.sidewalk, rng, { l: 0.03 });

  // --- The blocks: a kerb box and a pavement on top, exactly the way createGround lays the city's.
  for (const block of blocks) {
    const { x0, x1, z0, z1, cx, cz } = block.bounds;
    ground.push(curbBox(x1 - x0, KERB_H, z1 - z0, cx, 0, cz, kerbCol()));
    ground.push(roundedPaint(x1 - x0 - PAVE_INSET * 2, z1 - z0 - PAVE_INSET * 2, cx, cz, walkCol(), PAVE_Y));
  }

  // --- The paint: the streets out here are streets, so they carry the city's centre lines. Dashes
  // on a side street, the arterial's double line on an arterial, junction boxes left bare.
  const DASH = 1.6;
  const GAP = 1.4;
  const mark = color('laneMark');
  const run = (axis, c, from, to, double) => {
    if (to - from < 0.5) return;
    if (double) {
      const off = MEDIAN_W / 2 - 0.3;
      for (const o of [-off, off]) {
        if (axis === 'x') ground.push(paint(to - from, 0.16, (from + to) / 2, c + o, mark));
        else ground.push(paint(0.16, to - from, c + o, (from + to) / 2, mark));
      }
      return;
    }
    for (let s = from + GAP; s + DASH < to; s += DASH + GAP) {
      if (axis === 'x') ground.push(paint(DASH, 0.18, s + DASH / 2, c, mark));
      else ground.push(paint(0.18, DASH, c, s + DASH / 2, mark));
    }
  };
  // Along X: from the closure out to the far street, junction by junction.
  for (let j = 0; j <= GRID_J; j++) {
    const z = lineZ(j);
    let east = westKerbX() - CONE_BACK - 1;
    for (let c = 1; c <= WEST_COLUMNS; c++) {
      const west = lineX(-c) + HALF_ROAD;
      run('x', z, west, east, isArterialX(j));
      east = lineX(-c) - HALF_ROAD;
    }
  }
  // Along Z, down each of the new streets between the rows (the river row has no road to paint).
  for (let c = 1; c <= WEST_COLUMNS; c++) {
    for (let bj = 0; bj < GRID_J; bj++) {
      if (isRiverGap(bj)) continue;
      run('z', lineX(-c), lineZ(bj) + halfRoadX(bj), lineZ(bj + 1) - halfRoadX(bj + 1), false);
    }
  }

  // --- The closures: the roadworks' own trestle, turned across the street, and cones behind it.
  const cone = coneGeometry();
  for (const { x, z, half } of westClosures()) {
    const { trestle } = barricadeParts({ width: half * 2 - 0.4 });
    for (const part of trestle) {
      // The trestle's frame has its span along local x; a street along X wants it along z.
      part.rotateY(Math.PI / 2);
      part.translate(x, 0, z);
      ground.push(part);
    }
    const count = Math.max(2, Math.floor((half * 2 - 1.2) / CONE_PITCH));
    for (let k = 0; k < count; k++) {
      // Staggered, the way cones go down by hand rather than by ruler.
      const u = (k + 0.5) / count - 0.5;
      const g = cone.clone();
      g.rotateY(rng.range(0, Math.PI));
      g.translate(x - (CONE_BACK - BARRIER_BACK) - (k % 2) * 0.5, 0, z + u * (half * 2 - 1.2));
      ground.push(g);
    }
  }
  cone.dispose();

  // --- The towers. One per lot, the lots cut the city's own way but coarser in the far column, so
  // the skyline is a few broad towers rather than a crowd of narrow ones.
  const sites = [];
  for (const block of blocks) {
    const { x0, x1, z0, z1 } = block.bounds;
    const far = block.column > 1;
    const lots = splitLot(x0, z0, x1, z1, far ? 1 : 2, rng);
    for (const lot of lots) {
      const [lo, hi] = far ? FAR_H : NEAR_H;
      // Bigger lots go taller: a slender 40-storey tower on a corner plot reads as a chimney.
      const area = (lot.x1 - lot.x0) * (lot.z1 - lot.z0);
      const bulk = Math.min(1, area / 120);
      const height = lo + (hi - lo) * Math.min(1, rng.range(0.25, 0.85) + bulk * 0.25);
      const range = buildHighRise(towers, lot, block.bounds, rng, height, far ? FAR_FAMILIES : undefined);
      const cx = (lot.x0 + lot.x1) / 2;
      const cz = (lot.z0 + lot.z1) / 2;
      const top = topOf(towers, range);
      if (far && rng.chance(MAST_CHANCE)) {
        const h = Math.min(rng.range(MAST_H[0], MAST_H[1]), WEST_SKYLINE - top);
        if (h > 1) {
          const mast = new THREE.CylinderGeometry(0.1, 0.18, h, 5);
          mast.translate(cx, top + h / 2, cz);
          towers.push(bakeColor(mast, color('pole')));
          range.to = towers.length;
        }
      }
      for (let i = range.from; i < range.to; i++) stampEntry(towers[i], cx, cz, hash01(cx, cz));
      sites.push({ cx, cz, top: topOf(towers, range), column: block.column });
    }
  }

  const groundMesh = new THREE.Mesh(mergeGeometries(ground, false), propMaterial());
  ground.forEach((p) => p.dispose());
  groundMesh.castShadow = true;
  groundMesh.receiveShadow = true;
  groundMesh.name = 'west-edge-ground';

  const towerMesh = new THREE.Mesh(mergeGeometries(towers, false), propMaterial({ smooth: true }));
  towers.forEach((p) => p.dispose());
  towerMesh.castShadow = true;
  towerMesh.receiveShadow = true;
  towerMesh.name = 'west-edge-towers';

  return { ground: groundMesh, towers: towerMesh, sites, blocks, closures: westClosures() };
}

/** The highest point of the parts in `range`. */
function topOf(parts, { from, to }) {
  let top = 0;
  for (let i = from; i < to; i++) {
    const pos = parts[i].attributes.position;
    for (let k = 0; k < pos.count; k++) top = Math.max(top, pos.getY(k));
  }
  return top;
}
