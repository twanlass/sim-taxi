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

// --- The slab ---------------------------------------------------------------
//
// The footprint the whole city stands on. Kept tight to the outer roads — a wide apron reads as
// a grey void around the city once there's no fog to hide where it ends.
export const SLAB = SPAN + ROAD_W * 3;

// Rounded corners, so the city reads as an island rather than a sheet cut out with scissors.
//
// The ceiling is ~27: any larger and the arc eats into the corner where the two outermost roads
// meet, leaving the ring road hanging over nothing. 22 is clearly round with room to spare.
export const SLAB_RADIUS = 22;

/**
 * The slab footprint as a closed polygon in world XZ — a rounded square, `arcSegments` per corner.
 *
 * One outline, two consumers: the asphalt cap in `city/ground.js` and every stratum ring of the
 * floating rock in `city/island.js`. They have to agree exactly along the top edge or the rock
 * shows daylight under the tarmac, so the polygon lives here rather than being described twice.
 *
 * Wound counter-clockwise in (x, z), which is *clockwise* seen from the camera looking down: a
 * triangle fan built in this order faces down, so the up-facing cap emits (centre, p[i+1], p[i]).
 */
export function slabOutline(arcSegments = 14) {
  const h = SLAB / 2;
  const c = h - SLAB_RADIUS;
  const corners = [[c, c], [-c, c], [-c, -c], [c, -c]];
  const points = [];

  for (let k = 0; k < 4; k++) {
    const [cx, cz] = corners[k];
    const start = (k * Math.PI) / 2;
    // Inclusive of both arc ends: the gap between one corner's last point and the next corner's
    // first is the straight run of kerb between them, drawn by the polygon closing over it.
    for (let s = 0; s <= arcSegments; s++) {
      const a = start + (s / arcSegments) * (Math.PI / 2);
      points.push({ x: cx + Math.cos(a) * SLAB_RADIUS, z: cz + Math.sin(a) * SLAB_RADIUS });
    }
  }
  return points;
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

/** Intersection reached by leaving (i, j) along d, or null if it would leave the grid. */
export function nextIntersection(d, i, j) {
  const ni = i + (d === DIR.PX ? 1 : d === DIR.NX ? -1 : 0);
  const nj = j + (d === DIR.PZ ? 1 : d === DIR.NZ ? -1 : 0);
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

export const isUnsignalised = (i, j) => ringAxisAt(i, j) !== null;

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
