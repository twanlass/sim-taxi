// The city's coordinate system. Everything else — road meshes, block footprints, traffic
// routing — derives from these numbers, so the layout stays consistent by construction rather
// than by matching magic constants in three different files.

// Five blocks a side: the whole city fits on screen at once, which is what lets the game use a
// fixed camera and unambiguous tap-to-select.
export const GRID = 5;               // blocks per side
export const PITCH = 20;             // distance between road centrelines
export const ROAD_W = 8;             // full road width (two lanes)
export const BLOCK = PITCH - ROAD_W; // buildable footprint between two ordinary streets
export const LANE = 2;               // lane centre offset from the road centreline
export const HALF_ROAD = ROAD_W / 2;
export const SPAN = GRID * PITCH;
export const HALF_SPAN = SPAN / 2;

/** World coordinate of road centreline i (0..GRID). */
export const lineCoord = (i) => i * PITCH - HALF_SPAN;

// --- Divided arterials ------------------------------------------------------
//
// An arterial is a **third wider** than an ordinary street, and every bit of the extra width goes
// into the middle. That is the whole trick: the two carriageways stay exactly where they would be
// on an 8-unit street relative to their own kerb, and what opens up between them is a 2.67-unit
// centre strip with nothing driving on it — a median, planted mid-block (`medianRuns` below).
//
// Measuring from the kerb rather than from the centreline is what makes this cheap. Every tuned
// number in the sim that involves the edge of the road — the pull-over that rides a car up onto
// the kerb at 1.15 off its lane centre, the 2 units of weave room, the façade line a panicking
// car must not reach — is a distance from the lane centre *outward*, and all of them survive
// untouched. The numbers that had to move are the ones measured across the middle: the overtake
// (`PASS_LATERAL` in sim/traffic.js) and the police dodge, both of which now scale with the road
// they are on rather than with a global `LANE`.
//
// It also gives the map a hierarchy you can read at a glance from a fixed camera, which is what
// the arterials were always for and which a 64% green share alone could never show.
export const ARTERIAL_SCALE = 4 / 3;
export const ARTERIAL_ROAD_W = ROAD_W * ARTERIAL_SCALE;     // 10.667
export const HALF_ARTERIAL = ARTERIAL_ROAD_W / 2;           // 5.333
/** Lane centre to its own kerb. Held constant across both road widths — see above. */
export const LANE_TO_KERB = HALF_ROAD - LANE;               // 2

// Which lines are arterials, registered the same way the closed segments and the park blocks are
// (and for the same reason): the decision belongs to `city/layout.js`, but the systems that have
// to *respect* it — the block footprints, the road network's junction radii, the ground mesh —
// have no business importing the layout to ask. Empty until a layout has been built, so a
// headless tool that never called `createLayout` measures a city of uniform 8-unit streets.
const arterialX = new Set();   // j values: roads running along X
const arterialZ = new Set();   // i values: roads running along Z

export function setArterialLines({ x = [], z = [] } = {}) {
  arterialX.clear();
  arterialZ.clear();
  for (const j of x) arterialX.add(j);
  for (const i of z) arterialZ.add(i);
}

/** Is the road running along X at line j — or along Z at line i — a main street? */
export const isArterialX = (j) => arterialX.has(j);
export const isArterialZ = (i) => arterialZ.has(i);

/** Half-width of the road running along X at line j (i.e. its extent in z). */
export const halfRoadX = (j) => (arterialX.has(j) ? HALF_ARTERIAL : HALF_ROAD);
/** Half-width of the road running along Z at line i (i.e. its extent in x). */
export const halfRoadZ = (i) => (arterialZ.has(i) ? HALF_ARTERIAL : HALF_ROAD);

/** Lane centre offset from the centreline, for those same two roads. */
export const laneOffX = (j) => halfRoadX(j) - LANE_TO_KERB;
export const laneOffZ = (i) => halfRoadZ(i) - LANE_TO_KERB;

/**
 * Lane centre offset for a car travelling direction d past intersection (i, j) — the magnitude of
 * what `laneOffsetCoord` applies. Exported because the overtake and the police rail both have to
 * size a manoeuvre across the road they are actually on, and both used the `LANE` constant.
 */
export const laneOffsetFor = (d, i, j) => (isXAxis(d) ? laneOffX(j) : laneOffZ(i));

/**
 * How far the junction box at (i, j) reaches along direction d.
 *
 * Not this road's own half-width: the *crossing* road's. A car travelling along X enters the box
 * when it reaches the near kerb line of the road running along Z, so a wide arterial makes every
 * side street that crosses it hold its cars further back — which is exactly right, and is the
 * same rule `roadnet.js` derives per-arm from the arms around a node.
 *
 * Where nothing crosses — a park closure can leave a junction with only the road you are on — the
 * box is this road's own half-width, because there is no carriageway to clear. That case used to
 * be invisible: with every street 8 units wide the two answers were the same number. They are not
 * any more, and `roadnet.js` reaches the identical conclusion from the arms it can see, which is
 * what keeps the two models equal at 1e-9 rather than adding a third documented difference.
 */
export function junctionReach(d, i, j) {
  const alongX = isXAxis(d);
  const crossOpen = alongX
    ? !(isSegmentClosed(i, j, DIR.PZ) && isSegmentClosed(i, j, DIR.NZ))
    : !(isSegmentClosed(i, j, DIR.PX) && isSegmentClosed(i, j, DIR.NX));
  if (crossOpen) return alongX ? halfRoadZ(i) : halfRoadX(j);
  return alongX ? halfRoadX(j) : halfRoadZ(i);
}

/** Bounds of block (bi, bj), the buildable area between four roads. */
export function blockBounds(bi, bj) {
  const x0 = lineCoord(bi) + halfRoadZ(bi);
  const x1 = lineCoord(bi + 1) - halfRoadZ(bi + 1);
  const z0 = lineCoord(bj) + halfRoadX(bj);
  const z1 = lineCoord(bj + 1) - halfRoadX(bj + 1);
  return { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
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
  if (isXAxis(d)) return lineCoord(j) + dirSign(d) * laneOffX(j); // z of an x-travelling lane
  return lineCoord(i) - dirSign(d) * laneOffZ(i);                 // x of a z-travelling lane
}

/** Point where a car travelling d enters the intersection box at (i, j). */
export function entryPoint(d, i, j) {
  const cx = lineCoord(i);
  const cz = lineCoord(j);
  const reach = junctionReach(d, i, j);
  if (isXAxis(d)) return { x: cx - dirSign(d) * reach, z: laneOffsetCoord(d, i, j) };
  return { x: laneOffsetCoord(d, i, j), z: cz - dirSign(d) * reach };
}

/** Point where a car travelling d leaves the intersection box at (i, j). */
export function exitPoint(d, i, j) {
  const cx = lineCoord(i);
  const cz = lineCoord(j);
  const reach = junctionReach(d, i, j);
  if (isXAxis(d)) return { x: cx + dirSign(d) * reach, z: laneOffsetCoord(d, i, j) };
  return { x: laneOffsetCoord(d, i, j), z: cz + dirSign(d) * reach };
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

// --- The planted median -----------------------------------------------------
//
// What the extra third of an arterial's width is *for*. Between two junctions the centre strip is
// a kerbed island with grass and two or three flower beds on it; at a junction it stops, because
// that is where the turning movements cross and where the double-line paint takes over.
//
// Sized off what has to stay clear rather than off the 2.67 the widening opens up. A car in its
// lane has its inner flank at `laneOff - CAR_W/2` = 2.48 from the centreline, so 2.4 of island
// (±1.2) leaves 1.28 of asphalt shoulder either side — wide enough that the strip reads as an
// island *in* a road rather than as two roads with a gap.
export const MEDIAN_W = 2.4;
// How far short of the junction box the island stops. It has to clear the turn arcs of everything
// crossing, and leave room for the double line that stands in for the median across the junction.
const MEDIAN_END_GAP = 1.8;
// Below this a run is a stub rather than a planter, and it reads as debris dropped in the road.
const MEDIAN_MIN_LEN = 4;

/**
 * Every stretch of planted median in the city: one per gap between junctions on every arterial,
 * skipping the roads a park district built over.
 *
 * Lives here rather than in `ground.js` because two systems have to agree on it exactly — the
 * ground mesh lays the island and `props.js` plants the trees standing on it — and because it is
 * derived from the arterial lines and the closures, both of which this module already owns.
 */
export function medianRuns() {
  const runs = [];

  const add = (axis, line, k) => {
    // `k` names the gap: between crossing lines k and k + 1.
    const i = axis === 'x' ? k : line;
    const j = axis === 'x' ? line : k;
    if (isSegmentClosed(i, j, axis === 'x' ? DIR.PX : DIR.PZ)) return;

    const nearHalf = axis === 'x' ? halfRoadZ(k) : halfRoadX(k);
    const farHalf = axis === 'x' ? halfRoadZ(k + 1) : halfRoadX(k + 1);
    const from = lineCoord(k) + nearHalf + MEDIAN_END_GAP;
    const to = lineCoord(k + 1) - farHalf - MEDIAN_END_GAP;
    if (to - from < MEDIAN_MIN_LEN) return;

    const c = lineCoord(line);
    runs.push(axis === 'x'
      ? { axis, line, k, from, to, x0: from, x1: to, z0: c - MEDIAN_W / 2, z1: c + MEDIAN_W / 2 }
      : { axis, line, k, from, to, x0: c - MEDIAN_W / 2, x1: c + MEDIAN_W / 2, z0: from, z1: to });
  };

  for (const line of arterialX) for (let k = 0; k < GRID; k++) add('x', line, k);
  for (const line of arterialZ) for (let k = 0; k < GRID; k++) add('z', line, k);
  return runs;
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
