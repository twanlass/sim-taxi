import { GRID, blockBounds, HALF_SPAN, segmentKey, setClosedSegments } from './grid.js';
import { configureSignals } from '../sim/traffic.js';

// Decides what each block *is* before anything is built. Ground, buildings and props all read
// this, so a park is a park in every system rather than three subsystems each rolling their own
// dice and disagreeing.
//
// Two entry points: the procedural generator (a seed → a whole map) and a level loader (a hand-
// authored JSON → the same shape). Both emit the same block array with a `districts` and
// `arterials` tail, so nothing downstream cares which one produced it.

/**
 * Density falls off from the centre, which is what gives a generated city a downtown instead of
 * a uniform mat of identical towers. Parks are more likely out in the cheaper suburbs.
 */
export function proceduralLayout(rng) {
  // A park district is two adjacent blocks *plus the road that used to separate them*, merged
  // into one solid green mass. Leaving the road in place produced two parks either side of a
  // street, which still reads as the same repeating grid. Closing the segment is what actually
  // breaks the rhythm — and it means the road genuinely isn't there, so traffic routes around it
  // rather than driving through a park.
  const parkCells = new Map();   // "bi,bj" -> district id
  const districts = [];
  const closed = [];
  const DISTRICT_COUNT = 2;

  for (let n = 0; n < DISTRICT_COUNT; n++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const horizontal = rng.chance(0.5);
      const bi = rng.int(0, horizontal ? GRID - 2 : GRID - 1);
      const bj = rng.int(0, horizontal ? GRID - 1 : GRID - 2);
      const a = [bi, bj];
      const b = horizontal ? [bi + 1, bj] : [bi, bj + 1];
      if (parkCells.has(`${a[0]},${a[1]}`) || parkCells.has(`${b[0]},${b[1]}`)) continue;

      const id = districts.length;
      parkCells.set(`${a[0]},${a[1]}`, id);
      parkCells.set(`${b[0]},${b[1]}`, id);

      // The road between the pair, named by the two intersections at its ends.
      closed.push(horizontal
        ? segmentKey(bi + 1, bj, bi + 1, bj + 1)
        : segmentKey(bi, bj + 1, bi + 1, bj + 1));

      const ba = blockBounds(a[0], a[1]);
      const bb = blockBounds(b[0], b[1]);
      districts.push({
        id,
        bounds: {
          x0: Math.min(ba.x0, bb.x0), x1: Math.max(ba.x1, bb.x1),
          z0: Math.min(ba.z0, bb.z0), z1: Math.max(ba.z1, bb.z1),
          cx: (Math.min(ba.x0, bb.x0) + Math.max(ba.x1, bb.x1)) / 2,
          cz: (Math.min(ba.z0, bb.z0) + Math.max(ba.z1, bb.z1)) / 2,
        },
      });
      break;
    }
  }

  // --- Arterials -------------------------------------------------------------
  // Road hierarchy is a property of the city, so it is decided here alongside the blocks and
  // handed to the signal model. Two roads per axis, never adjacent, each with a coordinated
  // direction of travel — so the map has a grain: some streets simply move better than others,
  // and in one direction more than the other.
  // Two main streets, one per axis, drawn from the middle lines so they genuinely run *through*
  // the city rather than skirting an edge. Four arterials (the previous count) meant most
  // junctions had an arterial on at least one axis, which flattened the hierarchy back out.
  const middle = () => (rng.chance(0.5) ? 2 : 3);

  const arterialX = new Set([middle()]);   // runs east-west
  const arterialZ = new Set([middle()]);   // runs north-south
  const dirX = new Map([...arterialX].map((j) => [j, rng.chance(0.5) ? 1 : -1]));
  const dirZ = new Map([...arterialZ].map((i) => [i, rng.chance(0.5) ? 1 : -1]));

  const cellTypes = new Map();
  for (const [key, id] of parkCells) cellTypes.set(key, 'park');
  // Procedural layout has no plazas and no lone parks, but the shape of the finaliser is shared
  // with the level loader that does.

  return finaliseLayout({ cellTypes, parkCells, districts, closed, arterialX, arterialZ, dirX, dirZ });
}

/**
 * Build the same shape proceduralLayout emits, but from a hand-authored JSON level rather than
 * a seed. Trusts the level: validation happens in src/city/level.js before we get here.
 */
export function layoutFromLevel(level) {
  const parkCells = new Map();
  const cellTypes = new Map();
  const districts = [];

  // Any block type declared by the level, keyed by cell.
  for (const b of level.blocks ?? []) {
    if (b.type && b.type !== 'built') cellTypes.set(`${b.bi},${b.bj}`, b.type);
  }

  // Regroup park blocks by explicit districtId — a district is two adjacent parks plus the road
  // between them, and the editor writes both members with the same id. Ids may have holes if the
  // author deleted an intermediate district; we compact them here.
  const byDistrict = new Map();
  for (const b of level.blocks ?? []) {
    if (b.type === 'park' && b.districtId !== undefined && b.districtId !== null) {
      if (!byDistrict.has(b.districtId)) byDistrict.set(b.districtId, []);
      byDistrict.get(b.districtId).push(b);
    }
  }
  const sortedIds = [...byDistrict.keys()].sort((a, b) => a - b);
  for (const oldId of sortedIds) {
    const newId = districts.length;
    const members = byDistrict.get(oldId);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of members) {
      parkCells.set(`${m.bi},${m.bj}`, newId);
      const bnds = blockBounds(m.bi, m.bj);
      x0 = Math.min(x0, bnds.x0); x1 = Math.max(x1, bnds.x1);
      z0 = Math.min(z0, bnds.z0); z1 = Math.max(z1, bnds.z1);
    }
    districts.push({
      id: newId,
      bounds: { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 },
    });
  }

  const closed = level.closed ?? [];
  const arterialX = new Set(level.arterials?.x ?? []);
  const arterialZ = new Set(level.arterials?.z ?? []);
  const dirX = new Map(Object.entries(level.arterials?.dirX ?? {}).map(([k, v]) => [Number(k), v]));
  const dirZ = new Map(Object.entries(level.arterials?.dirZ ?? {}).map(([k, v]) => [Number(k), v]));
  // A brand-new arterial without an explicit direction defaults to +1, matching what a bare
  // "toggle this line into an arterial" click in the editor implies.
  for (const j of arterialX) if (!dirX.has(j)) dirX.set(j, 1);
  for (const i of arterialZ) if (!dirZ.has(i)) dirZ.set(i, 1);

  return finaliseLayout({ cellTypes, parkCells, districts, closed, arterialX, arterialZ, dirX, dirZ });
}

/**
 * Common tail: given the decisions a layout has to make (block types, park districts, closures,
 * arterials, their coordinated directions), configure the sim's signal state and emit the block
 * array in the shape ground/buildings/props all expect.
 */
function finaliseLayout({ cellTypes, parkCells, districts, closed, arterialX, arterialZ, dirX, dirZ }) {
  setClosedSegments(closed);
  configureSignals({ arterialX, arterialZ, dirX, dirZ });

  const blocks = [];
  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const key = `${bi},${bj}`;
      const { cx, cz } = blockBounds(bi, bj);
      const distance = Math.hypot(cx, cz) / (HALF_SPAN * Math.SQRT2);

      // 1 at the core, ~0 at the corners.
      const centrality = Math.max(0, 1 - distance * 1.55);

      const districtId = parkCells.get(key);
      const inDistrict = districtId !== undefined;
      const type = cellTypes.get(key) ?? 'built';

      blocks.push({
        bi,
        bj,
        bounds: blockBounds(bi, bj),
        type,
        districtId: inDistrict ? districtId : null,
        districtBounds: inDistrict ? districts[districtId].bounds : null,
        centrality,
      });
    }
  }

  blocks.districts = districts;
  blocks.arterials = { x: arterialX, z: arterialZ, dirX, dirZ };
  blocks.closed = closed;
  return blocks;
}

/** Backwards-compatible facade for main.js — same signature as before. */
export function createLayout(rng) {
  return proceduralLayout(rng);
}
