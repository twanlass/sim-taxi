import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID_I, GRID_J, HALF_ROAD, blockBounds, isRiverBlock, lineX, lineZ, segmentKey,
} from './grid.js';
import { arcFromBulge, rightNormal } from './curves.js';

// The central park: the `?city=big` experiment's 2 × 2 green, with a road that curves through it.
//
// A park district elsewhere is two blocks and the straight road between them closed. This is four
// blocks with every road round their shared middle junction closed **in the grid** — so the road
// markings, the junction paint, the depot and drive-through filters and everything else still
// asking `isSegmentClosed` see solid ground — and then one road put back **in the network only**:
// an S of two arcs from the park's west mid-junction, through the middle one, to its east one.
//
// Why the middle junction stays a node instead of one arc spanning the park: the sim still keeps a
// grid view of every car (`car.i`, `car.j`, `car.d`) and names lanes by the junction one grid step
// back (`laneByGrid`). Every lane between grid-adjacent nodes keeps all of that working; a lane
// joining nodes two apart would hand ~20 callers a `null`. The middle node carries two arms meeting
// tangent, so `bakeSignals` reads it as uncontrolled and nobody stops there.
//
// Why the bulge is what it is: the S meets the junctions at either end at an angle of
// `2·atan(bulge)` off the straight road it continues. Under `OPPOSITE_TOLERANCE` (30°) the network
// treats the park road and the street outside as one street — one signal phase, not three — and
// under `STRAIGHT_TOLERANCE` it is a straight-through rather than a turn, so nobody indicates.
// 0.25 is 28°, with the S swinging 2.5 off the line each way.
export const PARKWAY_BULGE = 0.25;

// `&parkway=oneway` makes the park road one-way, in a direction the seed picks: a single lane down
// the middle of a narrower road, 6 across rather than 8, with arrows painted instead of the centre
// line. A shortcut through the park in one direction and a detour round it in the other.
export const PARKWAY_ONEWAY = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('parkway') === 'oneway'
  : globalThis.process?.env?.PARKWAY === 'oneway';
const ONEWAY_HALF = 3;

/**
 * Pick the four blocks. Land on all four (both rows on one bank), and the middle lines not an
 * arterial — closing an arterial would break its green wave and its median for a park. Most central
 * candidate wins, with a draw only to break ties, so the rest of the layout stream barely moves.
 */
export function planCentralPark(rng, { arterialX, arterialZ }) {
  const candidates = [];
  for (let bi = 0; bi + 1 < GRID_I; bi++) {
    for (let bj = 0; bj + 1 < GRID_J; bj++) {
      if ([bj, bj + 1].some((r) => isRiverBlock(0, r))) continue;
      if (arterialZ.has(bi + 1) || arterialX.has(bj + 1)) continue;
      const cx = lineX(bi + 1);
      const cz = lineZ(bj + 1);
      candidates.push({ bi, bj, score: Math.hypot(cx, cz) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates.filter((c) => c.score < candidates[0].score + 1e-6);
  const { bi, bj } = best[rng.int(0, best.length - 1)];
  // +1 carries traffic W → E, -1 E → W. 0 is two-way.
  const oneway = PARKWAY_ONEWAY ? (rng.chance(0.5) ? 1 : -1) : 0;
  const halfWidth = oneway ? ONEWAY_HALF : HALF_ROAD;

  const ci = bi + 1;
  const cj = bj + 1;
  const W = { i: bi, j: cj };
  const C = { i: ci, j: cj };
  const E = { i: bi + 2, j: cj };
  const at = (n) => ({ x: lineX(n.i), z: lineZ(n.j) });
  const arcs = [
    arcFromBulge(at(W), at(C), PARKWAY_BULGE),
    arcFromBulge(at(C), at(E), -PARKWAY_BULGE),
  ];

  const lo = blockBounds(bi, bj);
  const hi = blockBounds(bi + 1, bj + 1);
  const bounds = {
    x0: lo.x0, x1: hi.x1, z0: lo.z0, z1: hi.z1,
    cx: (lo.x0 + hi.x1) / 2, cz: (lo.z0 + hi.z1) / 2,
  };

  // The road's centreline and both kerbs, sampled finely enough that the polygon kerb reads as a
  // curve (a segment every ~0.7 units).
  const centre = [];
  for (const arc of arcs) {
    const n = Math.ceil(arc.length / 0.7);
    for (let k = centre.length ? 1 : 0; k <= n; k++) {
      const s = (k / n) * arc.length;
      const p = arc.at(s);
      const t = arc.tangentAt(s);
      centre.push({ ...p, t });
    }
  }
  // The two lawns either side, as polygons, pulled in by `margin` from the kerb all round. Built
  // by offsetting the centreline further rather than by insetting the kerb polygon: the kerb's
  // clipped ends leave sub-unit edges at a 62° corner, and `insetPolygon` folds those inside out
  // at the walk's 1.15. Travel is +X, so the right normal is +Z: side +1 is the park's +Z lawn.
  const lawnsAt = (margin) => [1, -1].map((side) => {
    const reach = (halfWidth + margin) * side;
    const kerb = clipX(centre.map(({ x, z, t }) => {
      const nrm = rightNormal(t.x, t.z);
      return { x: x + nrm.x * reach, z: z + nrm.z * reach };
    }), bounds.x0 + margin, bounds.x1 - margin);
    const far = side > 0 ? bounds.z1 - margin : bounds.z0 + margin;
    return [...kerb, { x: bounds.x1 - margin, z: far }, { x: bounds.x0 + margin, z: far }];
  });

  // And the rectangle of each lawn that is clear of the road, for the furniture and the trees —
  // those all plan inside axis-aligned bounds.
  const [lawnPos, lawnNeg] = lawnsAt(0);
  const posEdge = Math.max(...lawnPos.slice(0, -2).map((p) => p.z));
  const negEdge = Math.min(...lawnNeg.slice(0, -2).map((p) => p.z));
  const rect = (x0, x1, z0, z1) => ({ x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
  const halves = [
    rect(bounds.x0, bounds.x1, posEdge + 0.5, bounds.z1),
    rect(bounds.x0, bounds.x1, bounds.z0, negEdge - 0.5),
  ];

  return {
    bi, bj, W, C, E, arcs, bounds, centre, lawnsAt, halves, oneway, halfWidth,
    cells: [[bi, bj], [bi + 1, bj], [bi, bj + 1], [bi + 1, bj + 1]],
    // Every road round the middle junction, built over in the grid's eyes.
    closed: [
      segmentKey(W.i, W.j, C.i, C.j), segmentKey(C.i, C.j, E.i, E.j),
      segmentKey(ci, bj, ci, cj), segmentKey(ci, cj, ci, cj + 1),
    ],
  };
}

/** A polyline running +X, cut to the part between x0 and x1, ends interpolated onto the cuts. */
function clipX(points, x0, x1) {
  const out = [];
  for (let n = 0; n < points.length; n++) {
    const p = points[n];
    const q = points[n + 1];
    if (p.x >= x0 && p.x <= x1) out.push(p);
    if (!q) break;
    for (const cut of [x0, x1]) {
      if ((p.x - cut) * (q.x - cut) < 0) {
        const f = (cut - p.x) / (q.x - p.x);
        out.push({ x: cut, z: p.z + (q.z - p.z) * f });
      }
    }
  }
  return out;
}

/** The two network edges, in the shape `bakeNetwork` takes. */
export function centralParkEdges(park, nodeId) {
  return [
    { id: `${nodeId(park.W.i, park.W.j)}~${nodeId(park.C.i, park.C.j)}`,
      a: nodeId(park.W.i, park.W.j), b: nodeId(park.C.i, park.C.j), bulge: PARKWAY_BULGE },
    { id: `${nodeId(park.C.i, park.C.j)}~${nodeId(park.E.i, park.E.j)}`,
      a: nodeId(park.C.i, park.C.j), b: nodeId(park.E.i, park.E.j), bulge: -PARKWAY_BULGE },
  ].map((edge) => ({ ...edge, oneway: park.oneway, halfWidth: park.halfWidth }));
}

// --- Ground -------------------------------------------------------------------

const PAVE_INSET = 0.15;
const PARK_WALK = 1.0;

/** A world-space (x, z) polygon as a THREE.Shape lying flat once rotated (shape y is world -z). */
const shapeOf = (poly) => new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));

function flat(shape, y, col) {
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, col);
}

/**
 * The park's ground: per lawn, a kerb extruded off its polygon, the walk round it and the grass in
 * the middle — the same three layers `parkSurface` lays on a rectangle, at the same heights — then
 * the dashed centre line down the S. The asphalt under the road is the city slab showing through
 * the gap between the two lawns.
 */
export function centralParkGround(park, rng, { kerbH, markY }) {
  const parts = [];
  const walks = park.lawnsAt(PAVE_INSET);
  const greens = park.lawnsAt(PAVE_INSET + PARK_WALK);
  park.lawnsAt(0).forEach((lawn, n) => {
    const kerbGeo = new THREE.ExtrudeGeometry(shapeOf(lawn), { depth: kerbH, bevelEnabled: false });
    kerbGeo.rotateX(-Math.PI / 2);
    parts.push(bakeColor(kerbGeo, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));

    const walk = walks[n];
    const grass = greens[n];
    const walkShape = shapeOf(walk);
    walkShape.holes.push(new THREE.Path(grass.map((p) => new THREE.Vector2(p.x, -p.z))));
    parts.push(flat(walkShape, kerbH + 0.01, jitterColor(PALETTE.sidewalk, rng, { l: 0.03 })));
    parts.push(flat(shapeOf(grass), kerbH + 0.01, jitterColor(PALETTE.park, rng, { l: 0.03 })));
  });

  // Centre-line dashes, laid along the arcs by arc length so they keep their pitch round the bends.
  // Starts and stops a junction's half-width in from each end node; through the middle node it runs
  // on, because nothing crosses there.
  const DASH = 1.6;
  const GAP = 1.4;
  const markColor = color('laneMark');
  const total = park.arcs.reduce((sum, arc) => sum + arc.length, 0);
  const pointAt = (s) => {
    const arc = s < park.arcs[0].length ? park.arcs[0] : park.arcs[1];
    const local = arc === park.arcs[0] ? s : s - park.arcs[0].length;
    return { p: arc.at(local), t: arc.tangentAt(local) };
  };
  if (park.oneway) {
    parts.push(...onewayArrows(pointAt, total, park.oneway, markColor, markY));
    return parts;
  }
  for (let s = HALF_ROAD + 1; s + DASH < total - HALF_ROAD - 1; s += DASH + GAP) {
    const { p, t } = pointAt(s + DASH / 2);
    const geo = new THREE.PlaneGeometry(DASH, 0.16);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(-Math.atan2(t.z, t.x));
    geo.translate(p.x, markY, p.z);
    parts.push(bakeColor(geo, markColor));
  }
  return parts;
}

/**
 * Direction arrows down a one-way park road: a shaft and a head, every `PITCH` along the S, pointing
 * the way traffic runs. Built flat in the arrow's own frame (+X forward) and turned onto the road's
 * tangent; the head is a `ShapeGeometry`, which winds itself to face up whichever way its points go.
 */
function onewayArrows(pointAt, total, dir, col, y) {
  const PITCH = 9;
  const SHAFT = 1.5;
  const HEAD = 0.9;
  const parts = [];
  for (let s = 7; s < total - 7; s += PITCH) {
    const { p, t } = pointAt(s);
    const yaw = -Math.atan2(t.z * dir, t.x * dir);
    const shaft = new THREE.PlaneGeometry(SHAFT, 0.28);
    shaft.rotateX(-Math.PI / 2);
    shaft.translate(-HEAD / 2, 0, 0);
    const head = new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(SHAFT / 2 - HEAD / 2, 0.55), new THREE.Vector2(SHAFT / 2 - HEAD / 2, -0.55),
      new THREE.Vector2(SHAFT / 2 + HEAD / 2, 0),
    ]));
    head.rotateX(-Math.PI / 2);
    for (const geo of [shaft, head]) {
      geo.rotateY(yaw);
      geo.translate(p.x, y, p.z);
      parts.push(bakeColor(geo, col));
    }
  }
  return parts;
}
