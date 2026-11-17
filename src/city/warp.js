// The warped city: the grid's wiring with its junctions pushed off the grid lines.
//
// Tyler (2026-11-17), after the turbine square and one curved street: "I really want a radical
// re-layout. The ref image I shared has a very different layout (diagonal streets, curves, etc)."
// The reference is a medieval town plan: streets that wander, converge on a market square, and
// leave wedge-shaped blocks between them.
//
// What this does and does not change. Every junction keeps its (i, j) and its four grid
// neighbours, so cars still carry `car.i/j/d`, the router still plans in grid steps and every
// system that asks "the junction east of this one" still gets an answer. What moves is *where*
// each junction stands, and each street between two of them becomes an arc bent so that the street
// runs smoothly through its junctions instead of kinking at them. A true diagonal — a street that
// cuts a block in two and meets five-way junctions — would break that wiring, and every caller of
// `laneByGrid` with it; this is the layout you can get without paying for that.
//
// The displacement is three things added together, all smooth over the map so neighbouring streets
// bend together rather than jittering apart:
//
//   * a **pinch** toward the market square — junctions near it are pulled in, so the streets round
//     it converge on it the way medieval streets converge on a market, and the blocks between them
//     come out as wedges;
//   * a **meander** — each street running north-south swings east and west along its length (and
//     each east-west street north and south), with a phase that changes from one street to the
//     next, so no two run parallel;
//   * a little per-junction **jitter**, so nothing reads as a pattern.
//
// What stays put, because something drawn or driven depends on it being straight:
//   * the **ring** — junctions on it slide along it but not off it, so the island's edge and its
//     feathered fade still line up;
//   * both **river banks** — the channel is drawn between `lineZ(row)` and `lineZ(row + 1)`, so
//     junctions on the banks slide east-west only, and a **bridged** crossing's two bank junctions
//     do not move at all (the decks are drawn on `lineX`);
//
// The north-south arterial bends with everything else, so the L train that runs down it on the grid
// city is not built here (main.js).
//
// `?layout=classic` is the plain grid; `?layout=square` is the turbine square and curved street that
// came before this (city/square.js, city/curvedstreet.js).

import {
  GRID_I, GRID_J, PITCH, lineX, lineZ, isSegmentClosed, isRiverGap, segmentKey, setClosedSegments,
  isCityConnected, isArterialX,
} from './grid.js';
import { bearingOf, wrapAngle } from './curves.js';

/** How far the pinch pulls the junction nearest the square, in world units. */
const PINCH = 8;
/** ...and how far out (in pitches) it reaches before it fades to nothing. */
const PINCH_REACH = 1.7;
/** Peak sideways swing of a meandering street. */
const MEANDER = 5.5;
/** Wavelength of the swing, in pitches: a street bends one way and back over about three blocks. */
const MEANDER_WAVE = 3.1;
/** Per-junction jitter, each axis. */
const JITTER = 1.8;
/** The narrowest fork two streets may leave a junction at. */
const MIN_ANGLE = (70 * Math.PI) / 180;
/** At most this many avenues per city. */
const MAX_AVENUES = 2;
/** No street may come out shorter than this between two junction centres (two kerbs and a block). */
export const MIN_STREET = 16;

/**
 * Plans the warp for a city. Draws from `rng` (callers draw it last in `createLayout`, so it
 * reshuffles nothing above it).
 *
 * @returns {{ at: Map<string, {x, z}>, square: {i, j}, centre: {x, z} }}
 */
export function planWarp(rng, { riverRow, crossings, closed: baseClosed }) {
  const pins = new Map();   // "i,j" → which axes are pinned: { x: bool, z: bool }
  const pin = (i, j, axis) => {
    const key = `${i},${j}`;
    const p = pins.get(key) ?? { x: false, z: false };
    p[axis] = true;
    pins.set(key, p);
  };
  for (let i = 0; i <= GRID_I; i++) {
    for (let j = 0; j <= GRID_J; j++) {
      if (i === 0 || i === GRID_I) pin(i, j, 'x');
      if (j === 0 || j === GRID_J) pin(i, j, 'z');
      if (riverRow !== null && (j === riverRow || j === riverRow + 1)) {
        pin(i, j, 'z');
        if (crossings?.get(i) && crossings.get(i) !== 'water') pin(i, j, 'x');
      }
    }
  }

  // The main street: one interior east-west side street left dead straight, end to end. Everything
  // else may wander, but the move cards film the taxi down a straight two-way street three blocks
  // long and clear of the river (game/uturnclip.js `pickStreet`), and with every street bent there
  // was none: the overtake and U-turn cards came up empty on every warped city. It also gives the
  // eye one line to read the rest against. Pinned on z, so its junctions slide along it and never
  // off it, and an avenue can never bend on it (a pinned junction is not free).
  const mainRows = [];
  for (let j = 1; j < GRID_J; j++) {
    if (isArterialX(j)) continue;
    if (riverRow !== null && j >= riverRow - 1 && j <= riverRow + 2) continue;
    mainRows.push(j);
  }
  const mainJ = mainRows.length ? rng.pick(mainRows) : null;
  if (mainJ !== null) for (let i = 0; i <= GRID_I; i++) pin(i, mainJ, 'z');

  // The square: the interior block centre furthest from the river and the coast on the bigger bank,
  // so the streets converging on it have room on every side. Its four corners are where the pinch
  // centres — the block between them stays open as the market.
  const bankRows = [];
  for (let bj = 1; bj < GRID_J - 1; bj++) if (riverRow === null || (bj !== riverRow && bj !== riverRow - 1 && bj !== riverRow + 1)) bankRows.push(bj);
  const candidates = [];
  for (let bi = 1; bi < GRID_I - 1; bi++) for (const bj of bankRows) candidates.push({ bi, bj });
  const square = candidates.length ? rng.pick(candidates) : { bi: 1, bj: 1 };
  const centre = {
    x: (lineX(square.bi) + lineX(square.bi + 1)) / 2,
    z: (lineZ(square.bj) + lineZ(square.bj + 1)) / 2,
  };

  // --- The avenues -------------------------------------------------------------------------------
  //
  // The diagonals. A street can only run between grid neighbours, but a *staircase* of them — south,
  // east, south, east — becomes one straight diagonal once every other junction on it (the bends) is
  // moved onto the line between the two either side of it. The junctions in between are already on
  // that line, at their own grid points. Each bend still has its other two streets, which now leave
  // it at an angle, and the blocks the avenue cuts across come out as wedges.
  //
  // Searched from every junction in all four diagonal directions, longest first, for as long as
  // each next bend is free to move on both axes and no step is a closed road or the river. Two
  // avenues may cross at a junction neither moves, but never share a bend or put bends side by side
  // (two neighbouring bends pulled opposite ways crush the block between them).
  const free = (i, j) => i > 0 && i < GRID_I && j > 0 && j < GRID_J && !pins.get(`${i},${j}`);
  const segOpen = (a, b) => {
    const axis = a.j === b.j ? 0 : 1;
    const i = Math.min(a.i, b.i);
    const j = Math.min(a.j, b.j);
    if (axis === 1 && isRiverGap(j)) return false;
    return !isSegmentClosed(i, j, axis);
  };
  const trace = (i, j, si, sj, zFirst) => {
    const path = [{ i, j }];
    for (let k = 0; k < 12; k++) {
      const last = path[path.length - 1];
      const stepZ = (k % 2 === 0) === zFirst;
      const next = stepZ ? { i: last.i, j: last.j + sj } : { i: last.i + si, j: last.j };
      if (next.i < 0 || next.j < 0 || next.i > GRID_I || next.j > GRID_J) break;
      if (!segOpen(last, next)) break;
      if (path.length % 2 === 1 && !free(next.i, next.j)) break;   // odd positions are the bends
      path.push(next);
    }
    if (path.length % 2 === 0) path.pop();   // a bend is only a diagonal with a junction after it
    return path;
  };
  const options = [];
  for (let i = 0; i <= GRID_I; i++) {
    for (let j = 0; j <= GRID_J; j++) {
      for (const [si, sj] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        for (const zFirst of [true, false]) {
          const path = trace(i, j, si, sj, zFirst);
          if (path.length >= 3) options.push({ path, tie: rng.next() });
        }
      }
    }
  }
  // Longest first, then nearest the middle of the map: an avenue tucked against the ring cuts one
  // corner block into a sliver and a triangle and reads as nothing at all (the first build put both
  // of seed 71624's there, on a random tie-break), while one through the middle of a bank splits
  // the blocks people actually drive past into wedges.
  const offCentre = (path) => {
    const mid = path[(path.length - 1) / 2];
    return Math.hypot(lineX(mid.i), lineZ(mid.j));
  };
  options.sort((p, q) => q.path.length - p.path.length || offCentre(p.path) - offCentre(q.path) + (p.tie - q.tie) * 4);
  const bends = new Set();
  const fixed = new Set();
  const avenues = [];
  const banks = new Set();
  const near = (n) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => bends.has(`${n.i + a},${n.j + b}`));
  // A bend is not a junction any more: its two other streets are closed, so it is a vertex on a
  // straight road. Left open they met the avenue at 45° a car's length from the next junction, and
  // the network's boxes ate the whole street between them (measured: lanes of 0 to 3 units on 60
  // of 60 seeds). Closing them is also what turns the cells the avenue cuts across into wedges.
  const closed = [];
  const bendClosures = (path) => {
    const out = [];
    path.forEach((n, k) => {
      if (k % 2 === 0) return;
      const keep = [path[k - 1], path[k + 1]].map((m) => `${m.i},${m.j}`);
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const m = { i: n.i + a, j: n.j + b };
        if (m.i < 0 || m.j < 0 || m.i > GRID_I || m.j > GRID_J || keep.includes(`${m.i},${m.j}`)) continue;
        out.push(segmentKey(Math.min(n.i, m.i), Math.min(n.j, m.j), Math.max(n.i, m.i), Math.max(n.j, m.j)));
      }
    });
    return out;
  };
  // A junction left with one street is a dead end the traffic model has no answer for (and its
  // stub pokes into the block beside it).
  const hasDeadEnd = () => {
    for (let i = 0; i <= GRID_I; i++) {
      for (let j = 0; j <= GRID_J; j++) {
        let arms = 0;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const m = { i: i + a, j: j + b };
          if (m.i < 0 || m.j < 0 || m.i > GRID_I || m.j > GRID_J) continue;
          const axis = b === 0 ? 0 : 1;
          const lo = { i: Math.min(i, m.i), j: Math.min(j, m.j) };
          if (axis === 1 && isRiverGap(lo.j) && !(crossings?.get(i) && crossings.get(i) !== 'water')) continue;
          if (!isSegmentClosed(lo.i, lo.j, axis)) arms++;
        }
        if (arms === 1) return true;
      }
    }
    return false;
  };
  for (const { path } of options) {
    if (avenues.length >= MAX_AVENUES) break;
    // One per bank: each closes four streets, and two on one bank merged most of it into one block.
    const bank = riverRow === null ? 0 : (path[1].j <= riverRow ? -1 : 1);
    if (banks.has(bank)) continue;
    const ok = path.every((n, k) => (k % 2 === 1 ? !near(n) && !fixed.has(`${n.i},${n.j}`) : !bends.has(`${n.i},${n.j}`)));
    if (!ok) continue;
    // ...and only if every junction can still reach every other with the bend's streets gone.
    const more = bendClosures(path);
    setClosedSegments([...baseClosed, ...closed, ...more]);
    if (!isCityConnected() || hasDeadEnd()) continue;
    closed.push(...more);
    banks.add(bank);
    path.forEach((n, k) => (k % 2 === 1 ? bends : fixed).add(`${n.i},${n.j}`));
    avenues.push(path);
  }
  setClosedSegments([...baseClosed, ...closed]);
  const placed = new Map();   // junctions an avenue has fixed
  const straight = new Set(); // its streets, which stay straight
  for (const path of avenues) {
    for (let k = 0; k < path.length; k++) {
      const n = path[k];
      if (k % 2 === 0) {
        placed.set(`${n.i},${n.j}`, { x: lineX(n.i), z: lineZ(n.j) });
      } else {
        const a = path[k - 1];
        const b = path[k + 1];
        const mx = (lineX(a.i) + lineX(b.i)) / 2;
        const mz = (lineZ(a.j) + lineZ(b.j)) / 2;
        placed.set(`${n.i},${n.j}`, { x: mx, z: mz });
      }
      if (k > 0) {
        const a = path[k - 1];
        straight.add(edgeKey(a.i, a.j, n.i, n.j));
      }
    }
  }

  // Meander phases: one per street, so neighbouring streets bend out of step.
  const phaseZ = [...Array(GRID_I + 1)].map(() => rng.range(0, Math.PI * 2));   // N-S street at line i
  const phaseX = [...Array(GRID_J + 1)].map(() => rng.range(0, Math.PI * 2));   // E-W street at line j
  const wave = (Math.PI * 2) / (MEANDER_WAVE * PITCH);

  const at = new Map();
  for (let i = 0; i <= GRID_I; i++) {
    for (let j = 0; j <= GRID_J; j++) {
      const x0 = lineX(i);
      const z0 = lineZ(j);
      let dx = MEANDER * Math.sin(z0 * wave + phaseZ[i]) + rng.range(-JITTER, JITTER);
      let dz = MEANDER * Math.sin(x0 * wave + phaseX[j]) + rng.range(-JITTER, JITTER);

      // The pinch, toward the square's middle; the square's own corners are pushed *out* a little
      // instead, so the market stays a market rather than closing up.
      const rx = centre.x - x0;
      const rz = centre.z - z0;
      const r = Math.hypot(rx, rz);
      const corner = (i === square.bi || i === square.bi + 1) && (j === square.bj || j === square.bj + 1);
      if (r > 1e-6) {
        const fall = Math.exp(-((r / (PINCH_REACH * PITCH)) ** 2));
        const pull = corner ? -1.5 : PINCH * fall;
        dx += (rx / r) * pull;
        dz += (rz / r) * pull;
      }

      const p = pins.get(`${i},${j}`);
      if (p?.x) dx = 0;
      if (p?.z) dz = 0;
      at.set(`${i},${j}`, placed.get(`${i},${j}`) ?? { x: x0 + dx, z: z0 + dz });
    }
  }

  // Relax anything that came out too close to a neighbour: pull both back toward their grid points
  // until every street is at least MIN_STREET long. The fields above are tuned to need this rarely.
  for (let pass = 0; pass < 20; pass++) {
    let ok = true;
    for (let i = 0; i <= GRID_I; i++) {
      for (let j = 0; j <= GRID_J; j++) {
        for (const [ni, nj] of [[i + 1, j], [i, j + 1]]) {
          if (ni > GRID_I || nj > GRID_J) continue;
          const a = at.get(`${i},${j}`);
          const b = at.get(`${ni},${nj}`);
          if (Math.hypot(b.x - a.x, b.z - a.z) >= MIN_STREET) continue;
          ok = false;
          for (const [ki, kj, q] of [[i, j, a], [ni, nj, b]]) {
            if (placed.has(`${ki},${kj}`)) continue;
            const gx = lineX(ki);
            const gz = lineZ(kj);
            q.x = gx + (q.x - gx) * 0.8;
            q.z = gz + (q.z - gz) * 0.8;
          }
        }
      }
    }
    if (ok) break;
  }

  // ...and anything where two streets leave a junction too close together: a 25° fork puts the two
  // kerbs on top of each other and the junction box swallows both streets (the network reaches
  // `halfWidth / sin θ` down each arm). Pull the junction and its two neighbours back toward the
  // grid until every gap is at least MIN_ANGLE. Bearings are taken off the chords — the arcs leave
  // within a few degrees of them, and this only has to find the bad forks, not measure them.
  const open = (a, b) => {
    const axis = a.j === b.j ? 0 : 1;
    if (axis === 1 && isRiverGap(Math.min(a.j, b.j))) {
      return crossings?.get(a.i) && crossings.get(a.i) !== 'water';
    }
    return !isSegmentClosed(Math.min(a.i, b.i), Math.min(a.j, b.j), axis);
  };
  const relax = (ki, kj) => {
    const key = `${ki},${kj}`;
    if (placed.has(key)) return;
    const q = at.get(key);
    const gx = lineX(ki);
    const gz = lineZ(kj);
    q.x = gx + (q.x - gx) * 0.75;
    q.z = gz + (q.z - gz) * 0.75;
  };
  for (let pass = 0; pass < 30; pass++) {
    let ok = true;
    for (let i = 0; i <= GRID_I; i++) {
      for (let j = 0; j <= GRID_J; j++) {
        const n = at.get(`${i},${j}`);
        const arms = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([a, b]) => ({ i: i + a, j: j + b }))
          .filter((m) => m.i >= 0 && m.j >= 0 && m.i <= GRID_I && m.j <= GRID_J && open({ i, j }, m))
          .map((m) => {
            const p = at.get(`${m.i},${m.j}`);
            return { ...m, bearing: Math.atan2(p.z - n.z, p.x - n.x) };
          })
          .sort((p, q) => p.bearing - q.bearing);
        for (let k = 0; k < arms.length && arms.length > 1; k++) {
          const p = arms[k];
          const q = arms[(k + 1) % arms.length];
          let gap = q.bearing - p.bearing;
          if (gap <= 0) gap += Math.PI * 2;
          if (gap >= MIN_ANGLE) continue;
          ok = false;
          relax(i, j);
          relax(p.i, p.j);
          relax(q.i, q.j);
        }
      }
    }
    if (ok) break;
  }

  const level = new Set();   // the main street's edges, held straight but at their own width
  if (mainJ !== null) for (let i = 0; i < GRID_I; i++) level.add(edgeKey(i, mainJ, i + 1, mainJ));
  return { at, square, centre, avenues, straight, level, mainJ, closed, bends };
}

/**
 * The bulge for the street from junction `a` to junction `b` (in the +X or +Z direction), so it
 * leaves and arrives along the street's own line through each junction rather than kinking there.
 *
 * At each end the target heading is the bisector of the two chords meeting there (or the chord
 * itself where the street ends or is closed). An arc's two end headings differ by its sweep, so
 * the sweep is the turn between those two targets — which splits each junction's bend evenly
 * between the streets either side of it.
 *
 * @param prev the junction before `a` along the same street, or null
 * @param next the junction after `b`, or null
 * @param stiff `stiffPrev` / `stiffNext`: that neighbouring street is held straight
 */
export function smoothBulge(prev, a, b, next, { stiffPrev = false, stiffNext = false } = {}) {
  const chord = bearingOf(b.x - a.x, b.z - a.z);
  const into = prev ? bearingOf(a.x - prev.x, a.z - prev.z) : chord;
  const outOf = next ? bearingOf(next.x - b.x, next.z - b.z) : chord;
  // A stiff neighbour is a street that is not allowed to bend (a bridge), so this one has to meet
  // it on its heading rather than halfway.
  // A street that turns hard at a junction (an avenue's bend leaves its cross streets doing that) is
  // a corner, not a curve: smoothing it would swing a wide arc into the block. Past SMOOTH_MAX it
  // arrives on its own chord.
  const half = (turn) => (Math.abs(turn) > SMOOTH_MAX ? 0 : turn / 2);
  const headA = stiffPrev ? into : chord + half(wrapAngle(into - chord));
  const headB = stiffNext ? outOf : chord + half(wrapAngle(outOf - chord));
  const sweep = wrapAngle(headB - headA);
  if (Math.abs(sweep) < 1e-3) return 0;
  return Math.tan(sweep / 4) * BULGE_SIGN;
}

// Which way `arcFromBulge` turns for a positive bulge relative to `bearingOf`'s sense of rotation,
// fixed once and asserted in tools/roadnet.mjs rather than reasoned about here.
const BULGE_SIGN = 1;
/** The sharpest bend at a junction that is still smoothed into a curve (radians). */
const SMOOTH_MAX = (40 * Math.PI) / 180;

/** One key per street between grid neighbours, whichever end is named first. */
export const edgeKey = (i, j, ni, nj) => (i < ni || j < nj ? `${i},${j}-${ni},${nj}` : `${ni},${nj}-${i},${j}`);
