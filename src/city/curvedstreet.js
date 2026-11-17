import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID_I, HALF_ROAD, blockBounds, halfRoadX, isRiverBlock, lineX, lineZ, segmentKey,
} from './grid.js';
import { arcFromBulge, rightNormal } from './curves.js';

// The curved street: one north-south side street bent into a long C across two blocks, so the two
// blocks either side of it take their shape from the road rather than from the grid — one a fat D
// bowing into the street, the other a crescent with a concave front. Tyler's reference plan (the
// medieval town in "The evolution of city layouts") is all curved streets and wedge blocks; this is
// the first real slice of that, and it is built on the central park's machinery (centralpark.js).
//
// **Why one C over two blocks and not every street bent a little.** An arc between two adjacent
// junctions spends almost all of its bend inside the junction boxes: the blocks hold only the middle
// 12 of the 21 units between centrelines, and a circular arc's sagitta over its middle 57% is a
// third of the whole. At the 28° the network tolerates as "straight on" (see `PARKWAY_BULGE`) the
// kerb along a block moves by 0.86 units — a road that looks shifted and kinked, not curved. Run
// across two blocks with the junction between them closed, the same 27° at each end buys a bow of
// 5 units along 33 units of kerb, which reads as a curve from across the map.
//
// **How it is built.** The grid closes the two north-south segments and the two east-west stubs
// meeting at the middle junction, so everything grid-shaped (paint, fares, the depot filters) sees
// two merged blocks with no street between them. The network then gets the road back as two arcs
// of one circle through the middle junction's node — which is *moved* off its grid line by the
// sagitta, to the apex of the curve. The node stays: every lane joins grid-adjacent nodes, so
// `laneByGrid` and the cars' `(i, j, d)` keep working, the same reason the park road keeps its middle
// node. Its arms meet tangent, so the signal bake reads it as uncontrolled and nobody stops there.
//
// **Where.** Beside the turbine square, along the north-south line between one of its column
// dominoes and the outer column. The domino is already the merged near side, its X blade already
// one of the two stubs closed at the middle junction, so the curve costs one more closure and one
// more merge — and the street hugging the square's flank is what the reference plan does. Not on the
// two-row bank: every north-south street there crosses its middle east-west line, the city's one
// long straight side street (layout.js, `keepStraight`), which the U-turn and overtake clips need
// five segments of (measured: the overtake's run is 84 units, three segments are 63). Never on an
// arterial (its median and its wave), never on the drawbridge's line (its Mega Air wants a straight
// run-up). Lines 1 and 4 carry the two fixed bridges (river.js), so a curve ending at the river
// meets its bridge at the same 27° it leaves every junction at, which the network reads as
// straight on.

/** How far the middle of the curve stands off the grid line, in world units. */
export const CURVE_SAG = 5;

/**
 * Plan the curve, or `null` where it does not fit. `taken` is the set of `"bi,bj"` cells already
 * spoken for.
 */
export function planCurvedStreet({ square, arterialX, arterialZ, drawLine, taken, key }) {
  if (!square) return null;
  // Every domino the square stood up beside itself in a column (an X blade merges the two blocks of
  // the column next to the plaza), with the column beyond it — the outer one — free to merge too.
  const candidates = [];
  for (const [[col, r0], [col2, r1]] of square.merges) {
    if (col !== col2 || r1 !== r0 + 1) continue;
    const left = col < square.plaza.bi;
    const I = left ? col : col + 1;
    const outer = left ? col - 1 : col + 1;
    if (outer < 0 || outer >= GRID_I) continue;
    if (arterialZ.has(I) || I === drawLine || arterialX.has(r0 + 1)) continue;
    if ([r0, r0 + 1].some((bj) => isRiverBlock(outer, bj) || taken.has(`${outer},${bj}`))) continue;
    candidates.push({ I, r0 });
  }
  // **Without a draw**, from `key` — facts about this city already decided — for the pocket park's
  // reason (layout.js): two draws here moved every park district after it, and with them a dozen
  // probe fixtures that had nothing to do with the curve.
  const hash = (n) => Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;
  const pick = hash(key) < 0.5 ? 0 : 1;
  const side = hash(key + 0.5) < 0.5 ? 1 : -1;   // +1 bows toward +X
  if (!candidates.length) return null;
  const { I, r0 } = candidates[pick % candidates.length];
  const cells = [[I - 1, r0], [I - 1, r0 + 1], [I, r0], [I, r0 + 1]];

  const X = lineX(I);
  const A = { x: X, z: lineZ(r0) };
  const B = { x: X, z: lineZ(r0 + 2) };
  const half = (B.z - A.z) / 2;
  const M = { x: X + side * CURVE_SAG, z: lineZ(r0 + 1) };
  // Two halves of one circle through A, M and B, so the road runs through M without a kink. A
  // positive bulge bends right of travel; travelling +Z that bows the road toward +X.
  const bulge = side * Math.tan(Math.atan(CURVE_SAG / half) / 2);
  const arcs = [arcFromBulge(A, M, bulge), arcFromBulge(M, B, bulge)];
  const halfWidth = HALF_ROAD;

  // The centreline, a sample every ~0.7 units, as the park road samples its own.
  const centre = [];
  for (const arc of arcs) {
    const n = Math.ceil(arc.length / 0.7);
    for (let k = centre.length ? 1 : 0; k <= n; k++) {
      const s = (k / n) * arc.length;
      centre.push({ ...arc.at(s), t: arc.tangentAt(s) });
    }
  }

  const merged = (bi) => {
    const lo = blockBounds(bi, r0);
    const hi = blockBounds(bi, r0 + 1);
    return {
      x0: lo.x0, x1: lo.x1, z0: lo.z0, z1: hi.z1, cx: (lo.x0 + lo.x1) / 2, cz: (lo.z0 + hi.z1) / 2,
    };
  };
  // West is the right of travel (+Z travel, right normal −X): `sideOf` +1 there, −1 east.
  const blocksOf = [
    { bi: I - 1, bounds: merged(I - 1), sideOf: 1 },
    { bi: I, bounds: merged(I), sideOf: -1 },
  ];

  /** One block's kerb along the curve, pulled `margin` in, clipped to the block's z range. */
  const kerbOf = (which, margin = 0) => {
    const { bounds, sideOf } = blocksOf[which];
    const reach = (halfWidth + margin) * sideOf;
    const line = centre.map(({ x, z, t }) => {
      const nrm = rightNormal(t.x, t.z);
      return { x: x + nrm.x * reach, z: z + nrm.z * reach };
    });
    return clipZ(line, bounds.z0 + margin, bounds.z1 - margin);
  };

  /** The block's outline as a world (x, z) polygon, `margin` in from the kerb all round. */
  const polygonOf = (which, margin = 0) => {
    const { bounds, sideOf } = blocksOf[which];
    const kerb = kerbOf(which, margin);
    const far = sideOf > 0 ? bounds.x0 + margin : bounds.x1 - margin;
    return [...kerb, { x: far, z: bounds.z1 - margin }, { x: far, z: bounds.z0 + margin }];
  };

  /**
   * Where the curved kerb stands across the stretch z0..z1, as the extreme a building has to keep
   * behind: the smallest x for the west block, the largest for the east one.
   */
  const kerbLimit = (which, z0, z1) => {
    const kerb = kerbOf(which);
    const xs = [];
    for (let n = 0; n + 1 < kerb.length; n++) {
      const p = kerb[n];
      const q = kerb[n + 1];
      if (p.z >= z0 && p.z <= z1) xs.push(p.x);
      for (const cut of [z0, z1]) {
        if ((p.z - cut) * (q.z - cut) <= 0 && q.z !== p.z) xs.push(p.x + (q.x - p.x) * (cut - p.z) / (q.z - p.z));
      }
    }
    const last = kerb[kerb.length - 1];
    if (last.z >= z0 && last.z <= z1) xs.push(last.x);
    return blocksOf[which].sideOf > 0 ? Math.min(...xs) : Math.max(...xs);
  };

  return {
    I, r0, side, A, M, B, arcs, bulge, halfWidth, centre, blocks: blocksOf, kerbOf, polygonOf, kerbLimit,
    cells,
    mid: { i: I, j: r0 + 1 },
    // The road along the line, closed in the grid and put back curved in the network; and the two
    // stubs into the middle junction, closed outright — the two blocks either side are one lot now.
    curved: [segmentKey(I, r0, I, r0 + 1), segmentKey(I, r0 + 1, I, r0 + 2)],
    closed: [
      segmentKey(I, r0, I, r0 + 1), segmentKey(I, r0 + 1, I, r0 + 2),
      segmentKey(I - 1, r0 + 1, I, r0 + 1), segmentKey(I, r0 + 1, I + 1, r0 + 1),
    ],
  };
}

/** A polyline running +Z, cut to the part between z0 and z1, ends interpolated onto the cuts. */
function clipZ(points, z0, z1) {
  const out = [];
  for (let n = 0; n < points.length; n++) {
    const p = points[n];
    const q = points[n + 1];
    if (p.z >= z0 && p.z <= z1) out.push(p);
    if (!q) break;
    for (const cut of [z0, z1]) {
      if ((p.z - cut) * (q.z - cut) < 0) {
        const f = (cut - p.z) / (q.z - p.z);
        out.push({ x: p.x + (q.x - p.x) * f, z: cut });
      }
    }
  }
  return out;
}

/** Where the middle junction's node actually stands: off its grid line by the sagitta. */
export function curvedNodeAt(plan, i, j) {
  if (!plan || i !== plan.mid.i || j !== plan.mid.j) return null;
  return plan.M;
}

/** The two network edges, in the shape `bakeNetwork` takes. Both run +Z, a→b. */
export function curvedStreetEdges(plan, nodeId) {
  const { I, r0, bulge, halfWidth } = plan;
  return [[r0, r0 + 1], [r0 + 1, r0 + 2]].map(([ja, jb]) => ({
    id: `${nodeId(I, ja)}~${nodeId(I, jb)}`, a: nodeId(I, ja), b: nodeId(I, jb), bulge, halfWidth,
  }));
}

// --- Ground -------------------------------------------------------------------

/** A world-space (x, z) polygon as a THREE.Shape lying flat once rotated (shape y is world −z). */
const shapeOf = (poly) => new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));

function flat(shape, y, col) {
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, col);
}

/**
 * The two blocks' platforms — a kerb extruded off each polygon and the pavement on top, the same
 * two layers and heights an ordinary block gets — and the dashed centre line along the curve.
 */
export function curvedStreetGround(plan, rng, { kerbH, markY, paveInset, dash, gap }) {
  const parts = [];
  for (let which = 0; which < 2; which++) {
    const kerbGeo = new THREE.ExtrudeGeometry(shapeOf(plan.polygonOf(which)), { depth: kerbH, bevelEnabled: false });
    kerbGeo.rotateX(-Math.PI / 2);
    parts.push(bakeColor(kerbGeo, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    parts.push(flat(shapeOf(plan.polygonOf(which, paveInset)), kerbH + 0.01,
      jitterColor(PALETTE.sidewalk, rng, { l: 0.03 })));
  }

  // Dashes laid along the arc by arc length, each one turned to the road's heading where it lies,
  // and kept out of the junction box at either end the way the straight runs are.
  const markColor = color('laneMark');
  const { A, B, r0 } = plan;
  const from = A.z + halfRoadX(r0);
  const to = B.z - halfRoadX(r0 + 2);
  let s = 0;
  const total = plan.arcs[0].length + plan.arcs[1].length;
  const at = (u) => (u <= plan.arcs[0].length
    ? { p: plan.arcs[0].at(u), t: plan.arcs[0].tangentAt(u) }
    : { p: plan.arcs[1].at(u - plan.arcs[0].length), t: plan.arcs[1].tangentAt(u - plan.arcs[0].length) });
  for (s = gap; s + dash < total; s += dash + gap) {
    const { p, t } = at(s + dash / 2);
    if (p.z - dash / 2 < from + gap * 0.5 || p.z + dash / 2 > to - gap * 0.5) continue;
    const geo = new THREE.PlaneGeometry(0.18, dash);
    geo.rotateX(-Math.PI / 2);
    // The plane's long side runs along z; turn it onto the tangent.
    geo.rotateY(Math.atan2(t.x, t.z));
    geo.translate(p.x, markY, p.z);
    parts.push(bakeColor(geo, markColor));
  }
  return parts;
}

/**
 * The two merged blocks, in the shape the square's dominoes take (`bakeMerges` in square.js), so
 * the ground, the buildings and the bank all skip the second block of each pair by the rule they
 * already have. `curve` and `which` are what tells the ground and the tower generator that one side
 * of the lot is the curve's kerb rather than `bounds`.
 */
export function bakeCurvedMerges(plan, blocks) {
  return plan.blocks.flatMap(({ bi, bounds }, which) => {
    const pair = [plan.r0, plan.r0 + 1].map((bj) => blocks.find((b) => b.bi === bi && b.bj === bj));
    // The square's own domino on the near side: already one lot, so it only learns which kerb is
    // curved (and is already in `blocks.merges`).
    if (pair[0].merge && pair[0].merge === pair[1].merge) {
      Object.assign(pair[0].merge, { curve: plan, which });
      return [];
    }
    const merge = { blocks: pair, bounds, build: bounds, builder: pair[0], hall: false, curve: plan, which };
    for (const block of pair) block.merge = merge;
    return merge;
  });
}
