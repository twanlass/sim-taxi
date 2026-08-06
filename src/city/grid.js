// The city's coordinate system. Everything else — road meshes, block footprints, traffic
// routing — derives from these numbers, so the layout stays consistent by construction rather
// than by matching magic constants in three different files.

// Five blocks a side: the whole city fits on screen at once, which is what lets the game use a
// fixed camera and unambiguous tap-to-select.
export const GRID = 5;               // blocks per side
export const PITCH = 20;             // distance between road centrelines
export const ROAD_W = 8;             // full road width (two lanes)
export const BLOCK = PITCH - ROAD_W; // buildable block footprint
export const LANE = 2;               // lane centre offset from the road centreline
export const HALF_ROAD = ROAD_W / 2;
export const SPAN = GRID * PITCH;
export const HALF_SPAN = SPAN / 2;

/** World coordinate of road centreline i (0..GRID). */
export const lineCoord = (i) => i * PITCH - HALF_SPAN;

/** Bounds of block (bi, bj), the buildable area between four roads. */
export function blockBounds(bi, bj) {
  const x0 = lineCoord(bi) + HALF_ROAD;
  const z0 = lineCoord(bj) + HALF_ROAD;
  return { x0, z0, x1: x0 + BLOCK, z1: z0 + BLOCK, cx: x0 + BLOCK / 2, cz: z0 + BLOCK / 2 };
}

// --- Directions -------------------------------------------------------------
// Encoded 0..3 as +X, +Z, -X, -Z. The ordering is deliberate: turning right is (d + 1) % 4 and
// turning left is (d + 3) % 4, which removes every lookup table this would otherwise need.
//
// 4..7 are the diagonals, added for the avenue (see "Diagonal avenue" below). They are a strict
// extension: every orthogonal direction keeps its number, its sign and its yaw, so the mod-4
// arithmetic above still holds for the 0..3 that use it. What the diagonals cannot do is share
// that arithmetic — `rightOf(4)` is meaningless — so anything that has to classify a turn in the
// presence of a diagonal goes through `turnKind()` instead, which measures the actual heading
// change and reduces to exactly straight/right/left on an orthogonal pair.

export const DIR = { PX: 0, PZ: 1, NX: 2, NZ: 3, NE: 4, NW: 5, SW: 6, SE: 7 };

// Grid step per direction, in (i, j). The diagonals move on both axes at once, which is the
// entire difference — one avenue segment covers √2 blocks of Manhattan distance.
const STEP = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [-1, -1], [1, -1],
];

export const isDiagonal = (d) => d >= 4;
export const isXAxis = (d) => d === 0 || d === 2;

// Which pair of directions share a travel axis, and which way along it each one runs. `s` in the
// traffic model is a *signed axis coordinate*, not a forward projection, which is why +X and −X
// can share one number line — and why NE/SW and NW/SE each need to as well.
const AXIS = ['x', 'z', 'x', 'z', 'ne', 'nw', 'ne', 'nw'];
const R2 = Math.SQRT1_2;
const AXIS_VEC = {
  x: { x: 1, z: 0 },
  z: { x: 0, z: 1 },
  ne: { x: R2, z: R2 },      // the (i+1, j+1) diagonal
  nw: { x: -R2, z: R2 },     // the (i−1, j+1) diagonal
};

export const axisOf = (d) => AXIS[d];
export const axisVec = (d) => AXIS_VEC[AXIS[d]];
export const dirSign = (d) => (d === 0 || d === 1 || d === 4 || d === 5 ? 1 : -1);
export const rightOf = (d) => (d + 1) % 4;
export const leftOf = (d) => (d + 3) % 4;
export const opposite = (d) => (d < 4 ? (d + 2) % 4 : ((d - 4 + 2) % 4) + 4);

/** Yaw that points a +X-facing model along direction d. */
export const dirYaw = (d) => -Math.atan2(STEP[d][1], STEP[d][0]);

/** Unit vector one lane to the *right* of travel — right-hand traffic sits on it. */
function rightVec(d) {
  const [sx, sz] = STEP[d];
  const len = Math.hypot(sx, sz);
  return { x: -sz / len, z: sx / len };   // (1,0) → (0,1): right of +X is +Z
}

/** Signed coordinate of a point along direction d's travel axis. */
export const alongAxis = (d, p) => {
  const a = AXIS_VEC[AXIS[d]];
  return p.x * a.x + p.z * a.z;
};

/**
 * Identity of the road d runs on through (i, j) — the value that is constant all the way down
 * it. For the grid that is the line index; for a diagonal it is which diagonal of the lattice
 * the junction sits on. Lane bookkeeping keys off this, so cars on the same stretch of road
 * queue behind each other and cars on a parallel one never do.
 */
export const roadLineId = (d, i, j) => {
  const axis = AXIS[d];
  if (axis === 'x') return j;
  if (axis === 'z') return i;
  return axis === 'ne' ? j - i : i + j;
};

/**
 * Lane centre for a car travelling direction d past intersection line (i, j).
 * Right-hand traffic: the lane sits on the right-hand side of the travel direction.
 *
 * Orthogonal only — it returns a bare coordinate on the cross axis, which a diagonal lane has no
 * equivalent of. `lanePoint()` is the general form; this stays because the grid-only callers read
 * far better with it.
 */
export function laneOffsetCoord(d, i, j) {
  if (isXAxis(d)) return lineCoord(j) + dirSign(d) * LANE; // z of an x-travelling lane
  return lineCoord(i) - dirSign(d) * LANE;                 // x of a z-travelling lane
}

/**
 * World point on d's lane at axis coordinate s, past intersection (i, j).
 *
 * The road centreline runs through the junction centre along d's axis, so the point is that
 * centre slid to the requested axis coordinate and stepped one LANE to the right of travel. For
 * an orthogonal d this is algebraically identical to the coordinate pair `laneOffsetCoord` builds.
 */
export function lanePoint(d, i, j, s) {
  const a = axisVec(d);
  const r = rightVec(d);
  const cx = lineCoord(i);
  const cz = lineCoord(j);
  const slide = s - (cx * a.x + cz * a.z);
  return { x: cx + a.x * slide + r.x * LANE, z: cz + a.z * slide + r.z * LANE };
}

/** Point where a car travelling d enters the intersection box at (i, j). */
export function entryPoint(d, i, j) {
  const c = { x: lineCoord(i), z: lineCoord(j) };
  return lanePoint(d, i, j, alongAxis(d, c) - dirSign(d) * HALF_ROAD);
}

/** Point where a car travelling d leaves the intersection box at (i, j). */
export function exitPoint(d, i, j) {
  const c = { x: lineCoord(i), z: lineCoord(j) };
  return lanePoint(d, i, j, alongAxis(d, c) + dirSign(d) * HALF_ROAD);
}

/** Unit vector in the direction of travel (not the canonical axis). */
const travelVec = (d) => {
  const a = axisVec(d);
  const s = dirSign(d);
  return { x: a.x * s, z: a.z * s };
};

/**
 * Bezier control point for a turn from `dIn` to `dOut`: where the two lane centrelines cross,
 * which produces an arc leaving and rejoining each lane exactly tangent to it. Parallel lines
 * (straight through) have no crossing, so it degenerates to the midpoint and the same curve code
 * handles both without a special case at the call site.
 *
 * Written as a line intersection rather than the old axis-swap because a 45° turn on or off the
 * avenue has no axis to swap — the swap was the two-perpendicular-axes case of exactly this.
 */
export function turnControl(dIn, dOut, i, j) {
  const entry = entryPoint(dIn, i, j);
  const exit = exitPoint(dOut, i, j);
  const u = travelVec(dIn);
  const v = travelVec(dOut);

  const denom = u.x * v.z - u.z * v.x;
  if (Math.abs(denom) < 1e-9) {
    return { x: (entry.x + exit.x) / 2, z: (entry.z + exit.z) / 2 };
  }
  const t = ((exit.x - entry.x) * v.z - (exit.z - entry.z) * v.x) / denom;
  return { x: entry.x + u.x * t, z: entry.z + u.z * t };
}

/**
 * How a car turns going from dIn to dOut: 0 straight, 1 right, 2 left — the same three buckets
 * the turn weights have always used, measured off the heading change so a 45° swing onto the
 * avenue lands in the right one. Reduces exactly to `d === dIn` / `rightOf` / `leftOf` when both
 * directions are orthogonal.
 */
export function turnKind(dIn, dOut) {
  if (dIn === dOut) return 0;
  const delta = ((dirYaw(dOut) - dirYaw(dIn) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return delta < 0 ? 1 : 2;   // negative yaw change is a right turn — see dirYaw
}

/** Absolute heading change of a turn, in radians. */
export const turnAngle = (dIn, dOut) =>
  Math.abs(((dirYaw(dOut) - dirYaw(dIn) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

/** Intersection reached by leaving (i, j) along d, or null if it would leave the grid. */
export function nextIntersection(d, i, j) {
  const ni = i + STEP[d][0];
  const nj = j + STEP[d][1];
  if (ni < 0 || ni > GRID || nj < 0 || nj > GRID) return null;
  return { i: ni, j: nj };
}

// --- Ring road --------------------------------------------------------------
//
// The outermost roads form a signal-free ring: traffic on it never stops, and only the four
// corners — where the ring meets itself — carry lights.

/** 'x' or 'z' if this junction sits on the ring, null if it is an interior junction. */
export function ringAxisAt(i, j) {
  const onX = j === 0 || j === GRID;   // road running along X
  const onZ = i === 0 || i === GRID;   // road running along Z
  if (onX && onZ) return null;         // a corner: signalised like any other junction
  if (onX) return 'x';
  if (onZ) return 'z';
  return null;
}

export const isUnsignalised = (i, j) => ringAxisAt(i, j) !== null || isRoundabout(i, j);

// --- Roundabout --------------------------------------------------------------
//
// One interior junction per city trades its signal for a circulating island: traffic yields on
// entry and orbits a kerbed island instead of waiting on a phase. It exists to break the grid's
// rhythm the way park districts do — every other junction in the city works identically, so one
// that visibly doesn't is a landmark.
//
// The geometry falls out of the lane offsets. Every entry and exit point sits at
// √(HALF_ROAD² + LANE²) ≈ 4.47 from the junction centre, so a single circulating circle serves
// all four approaches. R is the circulating lane's radius: 2.6 keeps a car (half-width 0.85)
// clear of a 1.3 island kerb by 0.45, and stays inside the probe's junction-box bound.
export const ROUNDABOUT_R = 2.6;
export const ROUNDABOUT_ISLAND_R = 1.3;

let roundabout = null;   // { i, j } — set by layout.js alongside the closed segments

export function setRoundabout(next) {
  roundabout = next;
}

export const getRoundabout = () => roundabout;

export const isRoundabout = (i, j) =>
  Boolean(roundabout) && roundabout.i === i && roundabout.j === j;

// Entry blend radius: the arc that carries a car from its (straight) entry lane onto the
// circulating circle, tangent to both. Solving |E + r·right| = r + R for the entry point
// E = (−HALF_ROAD, LANE) gives r ≈ 11 at R = 2.6 — a gentle swing, which is what makes the
// deflection read as steering around the island rather than a kink.
const RAB_BLEND_R = (LANE * LANE + HALF_ROAD * HALF_ROAD - ROUNDABOUT_R * ROUNDABOUT_R)
  / (2 * (ROUNDABOUT_R - LANE));
// Where the blend meets the circle, as an angle back from the entry point's own angle. Derived
// once from the tangency construction; the exit blend is its mirror image.
const RAB_MERGE = (() => {
  const centre = { x: -HALF_ROAD, z: LANE + RAB_BLEND_R };
  const scale = ROUNDABOUT_R / (RAB_BLEND_R + ROUNDABOUT_R);
  const t = { x: centre.x * scale, z: centre.z * scale };   // tangency point on the circle
  return Math.atan2(t.z, t.x);   // ≈ 107° for the canonical +X entry at (−4, 2), θE ≈ 153°
})();

/** Rotate a canonical-frame (dIn = +X) point into direction d's frame. */
function rotToDir(d, p) {
  if (d === DIR.PX) return { x: p.x, z: p.z };
  if (d === DIR.PZ) return { x: -p.z, z: p.x };
  if (d === DIR.NX) return { x: -p.x, z: -p.z };
  return { x: p.z, z: -p.x };
}

/**
 * The path a car drives through the roundabout at (i, j), entering along dIn and leaving along
 * dOut, as a sampled polyline: entry blend → circulating arc → exit blend, tangent at every join.
 *
 * Returns null for a right turn — the near-corner Bézier every junction already drives never
 * reaches the circulating circle, so it *is* the roundabout right turn. Circulation runs in
 * decreasing atan2 angle, which keeps the island on the driver's left (right-hand traffic).
 *
 * Shared by the traffic model (the car drives it) and the route band (the player sees it), so
 * the two can never disagree about where the taxi will go.
 */
export function roundaboutPath(dIn, dOut, i, j) {
  const turn = (dOut - dIn + 4) % 4;
  if (turn === 1) return null;   // right turn: the ordinary corner arc, see above

  const cx = lineCoord(i);
  const cz = lineCoord(j);
  const points = [];
  const push = (p) => points.push({ x: cx + p.x, z: cz + p.z });

  // Entry blend, in dIn's canonical frame: sweep around the blend-arc centre from the entry
  // point (angle −90° from that centre) to the tangency with the circle.
  const blendCentre = { x: -HALF_ROAD, z: LANE + RAB_BLEND_R };
  const entryFrom = -Math.PI / 2;
  const tangency = {
    x: blendCentre.x * (ROUNDABOUT_R / (RAB_BLEND_R + ROUNDABOUT_R)),
    z: blendCentre.z * (ROUNDABOUT_R / (RAB_BLEND_R + ROUNDABOUT_R)),
  };
  const entryEnd = Math.atan2(tangency.z - blendCentre.z, tangency.x - blendCentre.x);
  const ENTRY_STEPS = 7;
  for (let s = 0; s <= ENTRY_STEPS; s++) {
    const a = entryFrom + (entryEnd - entryFrom) * (s / ENTRY_STEPS);
    push(rotToDir(dIn, {
      x: blendCentre.x + Math.cos(a) * RAB_BLEND_R,
      z: blendCentre.z + Math.sin(a) * RAB_BLEND_R,
    }));
  }

  // Circulating arc: from the entry tangency (RAB_MERGE, in dIn's frame) clockwise-in-angle down
  // to the exit tangency, which by mirror symmetry sits at (π − RAB_MERGE) in dOut's frame.
  // Express both in dIn's frame: each step of `turn` rotates the frame by −90° of angle.
  const frameShift = { 0: 0, 3: -Math.PI / 2, 2: -Math.PI }[turn] ?? 0;
  const exitAngle = (Math.PI - RAB_MERGE) + frameShift;
  let sweep = RAB_MERGE - exitAngle;
  while (sweep <= 0) sweep += Math.PI * 2;
  const CIRC_STEP = 0.14;   // radians per sample ≈ 0.36 units of arc
  const circSteps = Math.max(2, Math.ceil(sweep / CIRC_STEP));
  for (let s = 1; s <= circSteps; s++) {
    const a = RAB_MERGE - sweep * (s / circSteps);
    push(rotToDir(dIn, { x: Math.cos(a) * ROUNDABOUT_R, z: Math.sin(a) * ROUNDABOUT_R }));
  }

  // Exit blend: the entry blend mirrored (x → −x in dOut's canonical frame), walked outward.
  const exitCentre = { x: HALF_ROAD, z: LANE + RAB_BLEND_R };
  const exitStart = Math.atan2(tangency.z - blendCentre.z, -(tangency.x - blendCentre.x));
  for (let s = 1; s <= ENTRY_STEPS; s++) {
    const a = exitStart + (-Math.PI / 2 - exitStart) * (s / ENTRY_STEPS);
    push(rotToDir(dOut, {
      x: exitCentre.x + Math.cos(a) * RAB_BLEND_R,
      z: exitCentre.z + Math.sin(a) * RAB_BLEND_R,
    }));
  }

  const cum = [0];
  for (let k = 1; k < points.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z));
  }
  return { points, cum, length: cum[cum.length - 1] };
}

// --- Closed segments --------------------------------------------------------
//
// A park district merges two blocks into one, which means the road that used to run between them
// no longer exists. Closing it here — rather than only hiding it in the ground mesh — is what
// stops traffic driving through a park, and makes the router plan around it for free.

const closedSegments = new Set();

export const segmentKey = (i1, j1, i2, j2) => {
  const a = `${i1},${j1}`;
  const b = `${i2},${j2}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

export function setClosedSegments(keys) {
  closedSegments.clear();
  for (const key of keys) closedSegments.add(key);
}

// --- Diagonal avenue ---------------------------------------------------------
//
// One street that ignores the grid: a 45° avenue running junction-to-junction across the middle
// of the city, cutting the blocks it crosses into flatiron slivers. It is a real road — traffic
// drives it, the router prefers it (one segment covers √2 blocks of Manhattan distance for √2
// the cost, so it strictly wins on any trip along its line), and the ground mesh opens up for it.
//
// The avenue is stored as the set of junctions on it, in order. Diagonal segments exist *only*
// between consecutive members, so `isSegmentClosed` returns true for every other diagonal on the
// lattice and no other system has to know the avenue exists.
let avenue = null;   // { axis: 'ne' | 'nw', junctions: [{i, j}], keys: Set }

export function setAvenue(next) {
  if (!next) { avenue = null; return; }
  const keys = new Set();
  for (let k = 0; k < next.junctions.length - 1; k++) {
    const a = next.junctions[k];
    const b = next.junctions[k + 1];
    keys.add(segmentKey(a.i, a.j, b.i, b.j));
  }
  avenue = { ...next, keys };
}

export const getAvenue = () => avenue;

/** Is (i, j) one of the junctions the avenue passes through? */
export const onAvenue = (i, j) =>
  Boolean(avenue) && avenue.junctions.some((p) => p.i === i && p.j === j);

/** True if the road from (i, j) heading d has been built over — or never existed. */
export function isSegmentClosed(i, j, d) {
  const next = nextIntersection(d, i, j);
  if (!next) return true;
  // A diagonal is road only where the avenue put one. Every other diagonal of the lattice is
  // block, so the default answer for 4..7 is "there is nothing there".
  if (isDiagonal(d)) {
    return !avenue || !avenue.keys.has(segmentKey(i, j, next.i, next.j));
  }
  return closedSegments.has(segmentKey(i, j, next.i, next.j));
}

// Sharpest turn a car will take at a junction. 90° is the grid's right and left; the avenue adds
// 45° swings on and off it. What this excludes is the 135° hairpin — the two *backward* orthogonal
// exits from a diagonal approach, which are geometrically legal and read as a car changing its
// mind at speed. Every avenue junction still has three exits without them (straight on, and a 45°
// either side), so nothing is ever cornered by the rule. The U-turn is 180° and excluded already.
const MAX_TURN = Math.PI / 2 + 1e-6;

/**
 * Directions a car may leave (i, j) on — no U-turn, no hairpin, no leaving the map, no closed
 * roads. Ordered straight, right, left, shallowest first, which is the order the grid-only
 * version returned and the order the turn weights are rolled against.
 */
export function legalExits(dIn, i, j) {
  const out = [];
  for (let d = 0; d < 8; d++) {
    if (turnAngle(dIn, d) > MAX_TURN) continue;
    if (!nextIntersection(d, i, j) || isSegmentClosed(i, j, d)) continue;
    out.push(d);
  }
  out.sort((a, b) => {
    const ka = turnKind(dIn, a);
    const kb = turnKind(dIn, b);
    if (ka !== kb) return ka - kb;
    return turnAngle(dIn, a) - turnAngle(dIn, b);
  });
  return out;
}

/**
 * Can every possible taxi state route to every intersection? This is the property `findRoute`
 * must never violate — a null return would leave the player unable to dispatch a fare.
 *
 * Strong connectivity of the directed state graph would be too strict: states like (0, 0, d=+X)
 * are graph-legal but unreachable in play (a car would have had to arrive from off-map), so
 * they have no predecessors and any backward BFS from them collapses. What actually matters is
 * *forward* reachability from every state to every target intersection.
 *
 * Checked via one reverse BFS per target intersection, seeded with all four directed arrivals
 * at that target. Every directed state must be visited by every one of those searches, since
 * "state X can reach some (T, d')" is the same thing as "the reverse graph from (T, *) visits X".
 * (GRID+1)² BFS runs of ~144 nodes each — under a millisecond at 5×5.
 *
 * Called from main.js so a bad park-closure combination on a random seed rerolls before the
 * meshers spend time on it. Never skip: a silent unroutable seed strands fares.
 */
export function isCityConnected() {
  // Eight directions since the avenue: a state is (junction, heading), and a heading can now be
  // diagonal. Counting only four left every diagonal arrival unvisited and the check always red.
  const N = (GRID + 1) * (GRID + 1) * 8;
  const key = (i, j, d) => (i * (GRID + 1) + j) * 8 + d;

  // Only states a car can actually be *in*. Arriving at (i, j) heading d means having driven the
  // segment behind you, so that segment has to exist. This mattered the moment diagonals arrived:
  // "at the map corner, heading south-west" is a graph-legal state with no road in and — because
  // both 45° exits also leave the map — no road out either, so it fails a forward-reachability
  // test it was never meant to be part of. The orthogonal version of the same state (corner,
  // heading +X) happened to have an exit, which is why the old count of four never tripped on it.
  const arrivable = (i, j, d) => Boolean(nextIntersection(opposite(d), i, j))
    && !isSegmentClosed(i, j, opposite(d));

  const live = [];
  const preds = new Array(N);
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      for (let dIn = 0; dIn < 8; dIn++) {
        if (!arrivable(i, j, dIn)) continue;
        live.push(key(i, j, dIn));
        for (const dOut of legalExits(dIn, i, j)) {
          const n = nextIntersection(dOut, i, j);
          if (!n) continue;
          const to = key(n.i, n.j, dOut);
          (preds[to] ??= []).push(key(i, j, dIn));
        }
      }
    }
  }

  for (let ti = 0; ti <= GRID; ti++) {
    for (let tj = 0; tj <= GRID; tj++) {
      const seen = new Uint8Array(N);
      const queue = [];
      for (let d = 0; d < 8; d++) {
        if (!arrivable(ti, tj, d)) continue;
        const k = key(ti, tj, d);
        seen[k] = 1;
        queue.push(k);
      }
      for (let head = 0; head < queue.length; head++) {
        for (const p of preds[queue[head]] ?? []) {
          if (!seen[p]) { seen[p] = 1; queue.push(p); }
        }
      }
      if (live.some((k) => !seen[k])) return false;
    }
  }
  return true;
}
