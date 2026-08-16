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

export const DIR = { PX: 0, PZ: 1, NX: 2, NZ: 3 };
export const isXAxis = (d) => d === 0 || d === 2;
export const dirSign = (d) => (d === 0 || d === 1 ? 1 : -1);
export const rightOf = (d) => (d + 1) % 4;
export const leftOf = (d) => (d + 3) % 4;
export const opposite = (d) => (d + 2) % 4;

/** Yaw that points a +X-facing model along direction d. */
export const dirYaw = (d) => [0, -Math.PI / 2, Math.PI, Math.PI / 2][d];

/**
 * Lane centre for a car travelling direction d past intersection line (i, j).
 * Right-hand traffic: the lane sits on the right-hand side of the travel direction.
 */
export function laneOffsetCoord(d, i, j) {
  if (isXAxis(d)) return lineCoord(j) + dirSign(d) * LANE; // z of an x-travelling lane
  return lineCoord(i) - dirSign(d) * LANE;                 // x of a z-travelling lane
}

/** Point where a car travelling d enters the intersection box at (i, j). */
export function entryPoint(d, i, j) {
  const cx = lineCoord(i);
  const cz = lineCoord(j);
  if (isXAxis(d)) return { x: cx - dirSign(d) * HALF_ROAD, z: laneOffsetCoord(d, i, j) };
  return { x: laneOffsetCoord(d, i, j), z: cz - dirSign(d) * HALF_ROAD };
}

/** Point where a car travelling d leaves the intersection box at (i, j). */
export function exitPoint(d, i, j) {
  const cx = lineCoord(i);
  const cz = lineCoord(j);
  if (isXAxis(d)) return { x: cx + dirSign(d) * HALF_ROAD, z: laneOffsetCoord(d, i, j) };
  return { x: laneOffsetCoord(d, i, j), z: cz + dirSign(d) * HALF_ROAD };
}

/**
 * Bezier control point for a turn from `dIn` to `dOut`. For a turn this is where the two lane
 * centrelines cross, which produces a clean quarter arc; for straight-through it degenerates to
 * the midpoint, so the same curve code handles both without a special case at the call site.
 */
export function turnControl(dIn, dOut, i, j) {
  const entry = entryPoint(dIn, i, j);
  const exit = exitPoint(dOut, i, j);

  if (isXAxis(dIn) === isXAxis(dOut)) {
    return { x: (entry.x + exit.x) / 2, z: (entry.z + exit.z) / 2 };
  }
  return isXAxis(dIn)
    ? { x: exit.x, z: entry.z }
    : { x: entry.x, z: exit.z };
}

/**
 * Grid intersection nearest a world point, clamped to the map.
 *
 * The inverse of `lineCoord` on both axes. It is what turns a finger on the road into a junction
 * the router can plan through — see `game/pathdrag.js`. Clamped rather than nulled off the edge:
 * a drag that runs past the ring road should pin to the ring, not stop answering.
 */
export function nearestJunction(x, z) {
  const near = (v) => Math.min(GRID, Math.max(0, Math.round((v + HALF_SPAN) / PITCH)));
  return { i: near(x), j: near(z) };
}

/** Intersection reached by leaving (i, j) along d, or null if it would leave the grid. */
export function nextIntersection(d, i, j) {
  const ni = i + (d === DIR.PX ? 1 : d === DIR.NX ? -1 : 0);
  const nj = j + (d === DIR.PZ ? 1 : d === DIR.NZ ? -1 : 0);
  if (ni < 0 || ni > GRID || nj < 0 || nj > GRID) return null;
  return { i: ni, j: nj };
}

// --- Ring road --------------------------------------------------------------
//
// The outermost roads form a signal-free ring: traffic on it never stops. The four corners carry
// no lights either — they have two arms, so every movement through one is a bend, and the two
// bends sweep opposite sides of the corner without meeting. See `bakeSignals` in roadnet.js.

/**
 * 'x' or 'z' if this junction sits on a *single* ring road, null otherwise — an interior
 * junction, or a corner, where both ring roads run through and neither axis is the answer.
 */
export function ringAxisAt(i, j) {
  const onX = j === 0 || j === GRID;   // road running along X
  const onZ = i === 0 || i === GRID;   // road running along Z
  if (onX && onZ) return null;         // a corner: on both, so no one axis has priority
  if (onX) return 'x';
  if (onZ) return 'z';
  return null;
}

/** The four points where the ring meets itself. Two arms apiece, at a right angle. */
export const isRingCorner = (i, j) => (i === 0 || i === GRID) && (j === 0 || j === GRID);

// Both halves of the ring are light-free: the long runs, where cross traffic yields into a gap,
// and the corners, where there is no cross traffic to yield to.
export const isUnsignalised = (i, j) => ringAxisAt(i, j) !== null || isRingCorner(i, j);

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

/** True if the road from (i, j) heading d has been built over. */
export function isSegmentClosed(i, j, d) {
  const next = nextIntersection(d, i, j);
  if (!next) return true;
  return closedSegments.has(segmentKey(i, j, next.i, next.j));
}

// --- Park blocks ------------------------------------------------------------
//
// Which blocks `city/layout.js` turned green, registered here for the same reason the closed
// segments are: the decision is the layout's, but the systems that have to *respect* it are the
// ones that place things on a kerb, and those have no business importing the layout to ask. A
// corner marker is the case — a courier pad on grass is a pad on a block with no address.
//
// Registered as the blocks themselves rather than as intersections: an intersection has four
// corners and only ever uses one of them (`cornerFor` in game/fares.js picks the -X-Z kerb), so
// which junctions this rules out is a question for whoever owns that flip, not for this list.

const parkBlocks = new Set();

export function setParkBlocks(cells) {
  parkBlocks.clear();
  for (const { bi, bj } of cells) parkBlocks.add(`${bi},${bj}`);
}

/**
 * True if block (bi, bj) is green.
 *
 * Empty until a layout has been built, so a headless tool that never called `createLayout` gets
 * "no parks" rather than a throw — the same way `isSegmentClosed` answers before any closure has
 * been registered.
 */
export const isParkBlock = (bi, bj) => parkBlocks.has(`${bi},${bj}`);

/** Directions a car may leave (i, j) on — no U-turn, no leaving the map, no closed roads. */
export function legalExits(dIn, i, j) {
  const out = [];
  for (const d of [dIn, rightOf(dIn), leftOf(dIn)]) {
    if (nextIntersection(d, i, j) && !isSegmentClosed(i, j, d)) out.push(d);
  }
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
  const N = (GRID + 1) * (GRID + 1) * 4;
  const key = (i, j, d) => (i * (GRID + 1) + j) * 4 + d;

  const preds = new Array(N);
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      for (let dIn = 0; dIn < 4; dIn++) {
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
      for (let d = 0; d < 4; d++) {
        const k = key(ti, tj, d);
        seen[k] = 1;
        queue.push(k);
      }
      let reached = 4;
      for (let head = 0; head < queue.length; head++) {
        for (const p of preds[queue[head]] ?? []) {
          if (!seen[p]) { seen[p] = 1; reached += 1; queue.push(p); }
        }
      }
      if (reached !== N) return false;
    }
  }
  return true;
}
