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
