import {
  GRID, HALF_ROAD, blockBounds, HALF_SPAN, lineCoord, segmentKey,
  setClosedSegments, setRoundabout, setAvenue,
} from './grid.js';
import { configureSignals } from '../sim/traffic.js';

// --- The diagonal avenue ------------------------------------------------------
//
// Two candidate routes, both three segments long and both straight through the middle of the
// city. Deliberately stopping one junction short of the ring corners: arriving at a corner on a
// diagonal, *both* remaining exits are 135° hairpins, which `legalExits` refuses — the avenue
// would dead-end and strand every car that drove it.
const AVENUES = [
  { axis: 'ne', junctions: [{ i: 1, j: 1 }, { i: 2, j: 2 }, { i: 3, j: 3 }, { i: 4, j: 4 }] },
  { axis: 'nw', junctions: [{ i: 1, j: 4 }, { i: 2, j: 3 }, { i: 3, j: 2 }, { i: 4, j: 1 }] },
];

/**
 * Signed distance-ish of a point from the avenue's centreline: zero on it, and ±ROAD_W·√2/2 at
 * the kerbs. Left unnormalised (the true perpendicular distance is this over √2) because every
 * use compares it against a constant, and the constant is cheaper to scale than the field.
 */
function avenueField(av, p) {
  const a = av.junctions[0];
  const k = av.axis === 'ne'
    ? lineCoord(a.j) - lineCoord(a.i)
    : lineCoord(a.j) + lineCoord(a.i);
  return av.axis === 'ne' ? p.z - p.x - k : p.z + p.x - k;
}

/** Sutherland–Hodgman clip of a convex polygon to the half-plane `field(p) >= limit`. */
function clipHalfPlane(poly, field, limit) {
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const fa = field(a) - limit;
    const fb = field(b) - limit;
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.length >= 3 ? out : null;
}

/** Area of a polygon, used to throw away slivers too small to build or plant on. */
function polyArea(poly) {
  let sum = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

// Decides what each block *is* before anything is built. Ground, buildings and props all read
// this, so a park is a park in every system rather than three subsystems each rolling their own
// dice and disagreeing.

/**
 * Density falls off from the centre, which is what gives a generated city a downtown instead of
 * a uniform mat of identical towers. Parks are more likely out in the cheaper suburbs.
 */
export function createLayout(rng) {
  // The avenue is chosen first, because everything else has to work around it: parks may not
  // claim a block it cuts, the roundabout may not sit on a junction it passes through, and the
  // blocks themselves come out as flatiron slivers rather than rectangles.
  //
  // Warm the stream before taking that first bit. mulberry32's opening draw is barely mixed —
  // measured over twelve ordinary seeds it came back above 0.5 ten times — so a coin flip read
  // from it is not a coin flip, and every city was getting the same avenue. Nothing else in the
  // project noticed because nothing else made a one-bit decision on the very first pull.
  for (let warm = 0; warm < 4; warm++) rng.next();
  const avenue = AVENUES[rng.int(0, AVENUES.length - 1)];
  setAvenue(avenue);

  // The one block each avenue segment passes through — the block whose two opposite corners are
  // the segment's endpoints.
  const cutBlocks = new Map();   // "bi,bj" -> [poly, poly]
  const BAND = HALF_ROAD * Math.SQRT2;   // avenueField value at the kerb
  for (let k = 0; k < avenue.junctions.length - 1; k++) {
    const a = avenue.junctions[k];
    const b = avenue.junctions[k + 1];
    const bi = Math.min(a.i, b.i);
    const bj = Math.min(a.j, b.j);
    const { x0, z0, x1, z1 } = blockBounds(bi, bj);
    const rect = [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const field = (p) => avenueField(avenue, p);
    // The two corners left standing either side of the road, as separate polygons — the avenue
    // takes the middle of the block, so what remains is genuinely two lots, not one with a notch.
    const polys = [
      clipHalfPlane(rect, field, BAND),
      clipHalfPlane(rect, (p) => -field(p), BAND),
    ].filter((p) => p && polyArea(p) > 4);
    cutBlocks.set(`${bi},${bj}`, polys);
  }

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
      // A district merges two blocks and the road between them into one rectangle of green. The
      // avenue has already taken the middle out of the blocks it crosses, so a district over one
      // would paint grass straight back across the road.
      if (cutBlocks.has(`${a[0]},${a[1]}`) || cutBlocks.has(`${b[0]},${b[1]}`)) continue;

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

  setClosedSegments(closed);

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

  configureSignals({ arterialX, arterialZ, dirX, dirZ });

  const blocks = [];

  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const { cx, cz } = blockBounds(bi, bj);
      const distance = Math.hypot(cx, cz) / (HALF_SPAN * Math.SQRT2);

      // 1 at the core, ~0 at the corners.
      const centrality = Math.max(0, 1 - distance * 1.55);

      // A district claim wins; otherwise the occasional lone pocket park out in the suburbs.
      const districtId = parkCells.get(`${bi},${bj}`);
      const inDistrict = districtId !== undefined;
      const isPark = inDistrict || rng.chance(0.02 + (1 - centrality) * 0.03);

      const bounds = blockBounds(bi, bj);
      const cut = cutBlocks.get(`${bi},${bj}`) ?? null;

      blocks.push({
        bi,
        bj,
        bounds,
        // What the block actually *is*, as polygons. Almost always the one rectangle it has
        // always been; on the three blocks the avenue crosses, the two flatiron slivers left
        // either side of it. Ground, buildings and props all read this rather than `bounds`, so
        // none of them has to know the avenue exists — they just lay out a shape.
        polys: cut ?? [[
          { x: bounds.x0, z: bounds.z0 }, { x: bounds.x1, z: bounds.z0 },
          { x: bounds.x1, z: bounds.z1 }, { x: bounds.x0, z: bounds.z1 },
        ]],
        cutByAvenue: Boolean(cut),
        type: isPark ? 'park' : 'built',
        districtId: inDistrict ? districtId : null,
        districtBounds: inDistrict ? districts[districtId].bounds : null,
        centrality,
      });
    }
  }

  blocks.districts = districts;
  // Handed to the ground mesh so the arterials are actually visible: a main street the player
  // can't identify is just an invisible timing tweak.
  blocks.arterials = { x: arterialX, z: arterialZ };

  // --- Roundabout ------------------------------------------------------------
  // One interior junction gives up its signal for a circulating island — the same job as a park
  // district, breaking the grid's rhythm, but done to a junction instead of a block. Interior
  // only (the ring is already unsignalised), and never on an arterial: through traffic yields
  // almost to a stop here, which would undo the fast grain the arterial exists to provide.
  //
  // Drawn *after* every other layout decision on purpose: appending to the rng stream keeps the
  // parks and arterials a given seed already produces exactly where they were.
  const candidates = [];
  for (let i = 1; i < GRID; i++) {
    for (let j = 1; j < GRID; j++) {
      if (arterialZ.has(i) || arterialX.has(j)) continue;
      // Its circulating path is built from the four orthogonal approaches; an avenue junction has
      // six, and two of them arrive at 45° to the circle.
      if (avenue.junctions.some((p) => p.i === i && p.j === j)) continue;
      candidates.push({ i, j });
    }
  }
  const roundabout = candidates.length ? rng.pick(candidates) : null;
  setRoundabout(roundabout);
  blocks.roundabout = roundabout;
  blocks.avenue = avenue;

  return blocks;
}
