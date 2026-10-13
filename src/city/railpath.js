import { GRID_J, lineZ, isArterialX, harborBasin } from './grid.js';
import { ISLAND, pad, baseLandHeight } from './coast.js';

// Where the L train's track runs on the island (game/ltrain.js builds it; `?island=classic` keeps
// the old straight line off both ends of the slab).
//
// Tyler, 2026-10-13: the train should turn and run along the shore rather than out into the ocean,
// and go into the mountain at **both** ends (his pick on the decision card). So the line is the
// arterial straight through the city, a quarter turn off each end of the pad, and a run north up
// the coast into a tunnel: on the west along the shore and then angled in under the mountain's
// shoulder, on the east up the harbor's waterfront and across to the peak's foot.
//
// A city module rather than a game one because the ground has to know where the track goes: the
// approach to each portal is a cutting (`railCut`), and a cutting is a fact about the height
// field. Pure and rng-free like the coast, and cached on the handful of numbers it depends on.

// The track's level: the L's deck top (game/ltrain.js `DECK_TOP`; the probe asserts they agree).
export const RAIL_DECK_TOP = 6.4;
// A cutting's floor, a little under the deck's girders so the track reads as laid in it.
export const RAIL_CUT_FLOOR = 5.5;
// Half the cutting's floor, and how steeply its sides climb out of it. Shallower than the view's
// own 0.92 rise per unit (CLAUDE.md, the camera's diagonal): a side any steeper stands between the
// camera and the portal at the far end, which is how the first cut hid both of them.
export const CUT_HALF = 3.2;
export const CUT_SLOPE = 0.75;
// The ground a portal is driven into has to stand this high over the cutting's floor: the train's
// roof is 2.3 over the deck and the portal's arch a little over that, with hill above it.
export const PORTAL_GROUND = RAIL_DECK_TOP + 5;
// How deep a portal's headwall is, and how far the cutting runs on behind its face. The terrain is
// a 2.5-unit grid, so a cutting that stopped dead at the face left its last cell rising from the
// floor in front of the wall to the hillside behind it, straight up the face it was meant to show:
// at the east portal the ground crossed the face plane at 12.3, over the wall's top. Carried on a
// cell's width behind the face, that slope happens behind the wall instead.
export const PORTAL_DEPTH = 3.6;
// How far the track carries on into each tunnel: a train's length and a bit, so one leaving the
// city disappears whole before it stops.
const TUNNEL_RUN = 30;
// The radius of every bend. Chicago's own L takes its Loop corners about this tight (around 25 m
// at this scale's three metres a unit), and it has to be tight on the east, where the turn has to
// land between the ring road's kerb and the harbor basin's back wall.
export const RAIL_RADIUS = 7.5;
// How far off the pad's walk the line runs north on the west: out on the shore.
const WEST_OUT = 12;
// Where the west run turns in under the mountain: this far north of the pad.
const WEST_TURN_IN = 10;

// How far the track leans into a bend, in radians, and how far into the bend it takes to get there.
// Six degrees: enough to read as banked on the inside rail from this distance, not so much the
// deck looks like it is sliding off its columns.
const RAIL_BANK = 0.105;
const BANK_EASE = 3;

const smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

let cache = null;
let cacheKey = '';

function arterialZ() {
  for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) return lineZ(j);
  return null;
}

/**
 * The track's path, or null (the classic slab, or a city with no east-west arterial). Pieces from
 * the west tunnel's end to the east's, each a line or an arc, with `length` the total. `portals`
 * are where each tunnel mouth stands: a point and the direction into the hill.
 */
export function railPath() {
  if (!ISLAND) return null;
  const zt = arterialZ();
  if (zt === null) return null;
  const p = pad();
  const basin = harborBasin();
  const key = `${p.x0},${p.x1},${p.z0},${p.z1},${zt},${basin?.x0}`;
  if (key === cacheKey) return cache;
  cacheKey = key;
  cache = buildPath(p, zt, basin);
  return cache;
}

function buildPath(p, zt, basin) {
  const R = RAIL_RADIUS;
  // West: out past the walk, north along the shore, then in under the mountain's shoulder.
  const xw = p.x0 - WEST_OUT;
  const cw = { x: xw, z: p.z0 - WEST_TURN_IN };
  const aimW = norm({ x: 0.55, z: -1 });
  const portalW = findPortal(cw, aimW, p);
  // East: up the waterfront between the kerb and the basin, and straight on north into the peak.
  const xe = basin ? Math.min(p.x1 + 1 + R, basin.x0 - 1.2) : p.x1 + WEST_OUT;
  const startE = { x: xe, z: zt - R };
  const portalE = findPortal(startE, { x: 0, z: -1 }, p);

  const corners = [
    add(portalW, aimW, TUNNEL_RUN),
    cw,
    { x: xw, z: zt },
    { x: xe, z: zt },
    add(portalE, { x: 0, z: -1 }, TUNNEL_RUN),
  ];
  const pieces = fillet(corners, R);
  let s = 0;
  for (const piece of pieces) {
    piece.s0 = s;
    s += piece.len;
  }
  // Each portal's place along the line, so the train can be told where it goes under.
  const sOf = (pt) => {
    let best = { d: Infinity, s: 0 };
    for (const piece of pieces) {
      if (piece.kind !== 'line') continue;
      const t = Math.max(0, Math.min(piece.len, (pt.x - piece.a.x) * piece.d.x + (pt.z - piece.a.z) * piece.d.z));
      const d = Math.hypot(piece.a.x + piece.d.x * t - pt.x, piece.a.z + piece.d.z * t - pt.z);
      if (d < best.d) best = { d, s: piece.s0 + t };
    }
    return best.s;
  };
  const portals = [
    { x: portalW.x, z: portalW.z, dx: aimW.x, dz: aimW.z, s: sOf(portalW), ground: baseLandHeight(portalW.x, portalW.z, p) },
    { x: portalE.x, z: portalE.z, dx: 0, dz: -1, s: sOf(portalE), ground: baseLandHeight(portalE.x, portalE.z, p) },
  ];
  return { pieces, length: s, portals, zt, xw, xe, straight: pieces.find((q) => q.kind === 'line' && q.d.x > 0.99) };
}

/** Walk from `from` along `dir` to the first ground high enough to tunnel into. */
function findPortal(from, dir, p) {
  for (let t = 0; t < 200; t += 0.5) {
    const pt = add(from, dir, t);
    if (baseLandHeight(pt.x, pt.z, p) >= PORTAL_GROUND) return pt;
  }
  return add(from, dir, 200);
}

const add = (a, d, t) => ({ x: a.x + d.x * t, z: a.z + d.z * t });
function norm(v) {
  const l = Math.hypot(v.x, v.z);
  return { x: v.x / l, z: v.z / l };
}

/** A polyline with each interior corner rounded to radius `r`: lines and arcs, in order. */
function fillet(pts, r) {
  const pieces = [];
  let from = pts[0];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = from;
    const b = pts[k];
    const c = pts[k + 1];
    const u = norm({ x: b.x - a.x, z: b.z - a.z });
    const v = norm({ x: c.x - b.x, z: c.z - b.z });
    const cross = u.x * v.z - u.z * v.x;
    const phi = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.z * v.z)));
    if (phi < 1e-6) continue;
    const t = r * Math.tan(phi / 2);
    const e = add(b, u, -t);
    const x = add(b, v, t);
    const sgn = Math.sign(cross);
    // The centre is off to the side the line turns towards: +perp(u) for a turn towards +perp.
    const centre = { x: e.x - u.z * sgn * r, z: e.z + u.x * sgn * r };
    pieces.push(line(a, e));
    pieces.push({
      kind: 'arc', c: centre, r, sgn,
      a0: Math.atan2(e.z - centre.z, e.x - centre.x),
      len: r * phi,
    });
    from = x;
  }
  pieces.push(line(from, pts[pts.length - 1]));
  return pieces.filter((q) => q.len > 1e-6);
}

function line(a, b) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return { kind: 'line', a, len, d: { x: (b.x - a.x) / len, z: (b.z - a.z) / len } };
}

/**
 * The point `s` along the path: `{ x, z, heading, curve }`, heading the angle of travel in the
 * x-z plane (0 runs +x, π/2 runs +z) and `curve` the signed curvature (positive turning towards +z
 * of the direction of travel... that is, towards the travel direction rotated by +90°).
 */
export function railAt(path, s) {
  const pieces = path.pieces;
  let piece = pieces[pieces.length - 1];
  for (const q of pieces) {
    if (s <= q.s0 + q.len) { piece = q; break; }
  }
  const t = Math.max(0, Math.min(piece.len, s - piece.s0));
  if (piece.kind === 'line') {
    return {
      x: piece.a.x + piece.d.x * t,
      z: piece.a.z + piece.d.z * t,
      heading: Math.atan2(piece.d.z, piece.d.x),
      curve: 0,
      bank: 0,
    };
  }
  const ang = piece.a0 + piece.sgn * t / piece.r;
  // Banked into each bend, easing in and out over its first and last few units so neither the
  // deck nor a car rolls over in one step at the tangent point.
  const ease = smooth(t / BANK_EASE) * smooth((piece.len - t) / BANK_EASE);
  return {
    x: piece.c.x + piece.r * Math.cos(ang),
    z: piece.c.z + piece.r * Math.sin(ang),
    heading: ang + piece.sgn * Math.PI / 2,
    curve: piece.sgn / piece.r,
    bank: RAIL_BANK * piece.sgn * ease,
  };
}

/** Distance from (x, z) to the track, out of the tunnels (in them it is under the hill). */
export function railDistance(path, x, z) {
  let best = Infinity;
  const [w, e] = path.portals;
  for (const q of path.pieces) {
    let d;
    if (q.kind === 'line') {
      // Clamp the far ends at the portals: past them the track is in the hill.
      let t0 = 0;
      let t1 = q.len;
      for (const port of [w, e]) {
        if (port.s >= q.s0 && port.s <= q.s0 + q.len) {
          if (port === w) t0 = port.s - q.s0;
          else t1 = port.s - q.s0;
        }
      }
      const t = Math.max(t0, Math.min(t1, (x - q.a.x) * q.d.x + (z - q.a.z) * q.d.z));
      d = Math.hypot(q.a.x + q.d.x * t - x, q.a.z + q.d.z * t - z);
    } else {
      const ang = Math.atan2(z - q.c.z, x - q.c.x);
      let rel = (ang - q.a0) * q.sgn;
      rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (rel <= q.len / q.r) d = Math.abs(Math.hypot(x - q.c.x, z - q.c.z) - q.r);
      else {
        const p0 = railAt({ pieces: [q] }, q.s0);
        const p1 = railAt({ pieces: [q] }, q.s0 + q.len);
        d = Math.min(Math.hypot(x - p0.x, z - p0.z), Math.hypot(x - p1.x, z - p1.z));
      }
    }
    if (d < best) best = d;
  }
  return best;
}

/**
 * The ground under the cutting: `h` lowered to the cutting's floor along the track's approach to
 * each portal, with sides climbing out at `CUT_SLOPE`. Only ever lowers, and only out of the
 * tunnels — past a portal the hill is left alone over the track.
 */
export function railCut(x, z, h) {
  if (h <= RAIL_CUT_FLOOR) return h;
  const path = railPath();
  if (!path) return h;
  for (const port of path.portals) {
    // The run up to this portal: back along the line it is on, as far as the ground needs cutting.
    const along = (port.x - x) * port.dx + (port.z - z) * port.dz;   // > 0 out of the tunnel
    if (along < -PORTAL_DEPTH) continue;
    const lateral = Math.abs((x - port.x) * -port.dz + (z - port.z) * port.dx);
    const floor = RAIL_CUT_FLOOR + Math.max(0, lateral - CUT_HALF) * CUT_SLOPE;
    if (floor >= h) continue;
    // Only as far back as the straight it stands on.
    if (along > approachLength(path, port)) continue;
    h = floor;
  }
  return h;
}

function approachLength(path, port) {
  for (const q of path.pieces) {
    if (q.kind !== 'line' || port.s < q.s0 - 1e-6 || port.s > q.s0 + q.len + 1e-6) continue;
    // The west tunnel is where the path starts, so its approach runs on up the line; the east
    // one is where it ends, and its approach is the line behind it.
    const outward = q.d.x * port.dx + q.d.z * port.dz < 0;
    return (outward ? q.s0 + q.len - port.s : port.s - q.s0) + 0.01;
  }
  return 0;
}

/** Past a portal, under the hill. */
export function railInTunnel(path, x, z) {
  for (const port of path.portals) {
    const along = (x - port.x) * port.dx + (z - port.z) * port.dz;
    const lateral = Math.abs((x - port.x) * -port.dz + (z - port.z) * port.dx);
    if (along > 0 && lateral < 8) return true;
  }
  return false;
}
