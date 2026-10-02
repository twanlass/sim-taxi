import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, PARK_EDGE } from './ground.js';
import { STATUE_PLAZA } from './props.js';

// A basketball court, in one park, in one city.
//
// Scenery on the pond's terms: nothing routes round it, nothing can be tapped on it, and the fare
// loop has never heard of it. What it buys is a park with *people* in it — the players shooting
// around on it are game/hoopers.js; this is the blacktop, the lines and the two hoops.
//
// Split into a plan and a build the way `planPond` is, and for the same reason: where it goes is
// the part with rules in it — on the lawn, clear of the statue's plaza and the pond — and
// `tools/probe.mjs` sweeps those over seeds rather than looking at them on one city.
//
// **The court has its own frame.** `u` runs along its length and `v` across it, and `toWorld` maps
// the pair onto whichever world axis the court was laid along. Along X that is (x, z) = (u, v);
// along Z it is (x, z) = (v, u) — a reflection rather than a rotation, which is harmless here
// because nothing below is built by rotating a mesh: every box is axis-aligned and sized through
// `boxAt`, and every flat surface goes through `ShapeGeometry`, which winds itself to face +Z
// whichever way round its outline arrives.
//
// **No fence.** The first build ran chain link down the court's far side and across its far end,
// as a translucent panel between posts. It came out: the court reads better open to the lawn.

/** What ground.js lays a park's lawn at — the number `pond.js` names `GRASS_Y`. */
const GRASS_Y = KERB_H + 0.01;
/**
 * The blacktop is a slab rather than a decal: 0.05 proud of the lawn, which is a visible step at
 * the court's edge from this camera and puts it clear of the grass plane rather than on it. Its
 * underside sits 0.01 *below* the lawn so no sliver of sky can show under the edge.
 */
export const COURT_TOP_Y = GRASS_Y + 0.05;
const SLAB_H = 0.06;
// Three flat layers on the slab, each named off the one beneath it — two surfaces at one height is
// a shimmer (see CLAUDE.md on the burger joint's apron). The playing surface, the keys painted on
// it, and the lines over both.
const PAINT_Y = COURT_TOP_Y + 0.006;
const KEY_Y = PAINT_Y + 0.006;
const LINE_Y = KEY_Y + 0.006;

// How far the slab stays inside the block's bounds: the walk, and a third of a unit of lawn so the
// blacktop reads as laid *in* the park rather than butted up against its paving. Benches the
// furniture plan put inside that are struck out (`clearBenches`) — the ones left on the court's
// open sides face it, which is what a bench beside a court is for.
const COURT_SET = PARK_EDGE + 0.35;

// The size range, slab edge to slab edge. A real court is 28 by 15 metres; the people in this game
// are drawn at roughly two and a half times life size (see geometry/person.js), so a court to the
// same scale would be a whole district long. This is a *little* blacktop — the brief — and the
// floor is set so a lone pocket park can still hold one: a 12-unit block less the setbacks is 9.
const LEN = [9, 13];
const WID = [6.2, 7.6];
/**
 * And never squarer than this: a court as wide as it is long stops reading as having two ends. A
 * short court gives up width to hold it, which is what lets a 12-unit pocket park take a 9 by 6.9.
 */
const MIN_ASPECT = 1.3;

/** Lines in from the slab's edge — the apron of bare blacktop round the playing surface. */
const INSET = 0.45;
/** 0.13 is a pixel at play zoom; any thinner and the lines flicker in and out as the camera pans. */
const LINE_W = 0.13;
const KEY_W = 2.3;
const CIRCLE_R = 0.9;

// The hoops. Heights are against a figure whose head tops out at 3.24 (PERSON_TOP_Y): a real rim
// is 1.7 heights of a person up, and so is this one, near enough. A rim any lower and a player
// standing under it looks like they could put their chin on it.
export const RIM_Y = COURT_TOP_Y + 4.6;
export const RIM_R = 0.42;
/** Baseline to the backboard's face, and to the rim's centre. */
const BOARD_IN = 0.25;
const RIM_IN = BOARD_IN + 0.06 + 0.1 + RIM_R;
const BOARD_W = 1.9;
const BOARD_H = 1.25;
const BOARD_T = 0.08;
const POLE_W = 0.18;
const ARM_Y = RIM_Y + 0.55;
const NET_H = 0.5;

/** Room left round the statue's plaza and the pond's circle. */
const STATUE_GAP = 0.5;
const POND_GAP = 0.6;

/** Slide positions tried along a plot's long axis. */
const SLIDES = 9;

/**
 * Where the court goes. `null` on a city with no park that can hold one, which the chain handles
 * rather than guards against: no court, no players.
 *
 * @param plots   the park plots, as `parkPlots` returns them
 * @param statue  the statue from `planParkFurniture`
 * @param pond    the pond from `planPond`
 */
export function planCourt(rng, plots, statue, pond) {
  const candidates = [];
  for (const plot of plots) {
    const { x0, x1, z0, z1 } = plot.bounds;
    const pcx = (x0 + x1) / 2;
    const pcz = (z0 + z1) / 2;
    for (const axis of ['x', 'z']) {
      const longRoom = (axis === 'x' ? x1 - x0 : z1 - z0) - 2 * COURT_SET;
      const shortRoom = (axis === 'x' ? z1 - z0 : x1 - x0) - 2 * COURT_SET;
      // Every length from the longest the plot holds down to the floor, a unit at a time. The full
      // 13 cannot share a district with the statue — it stands on the closed road down the middle,
      // and a 13-unit slab cannot clear its plaza from either half — but 12 can, and a city whose
      // other district has the pond in it would otherwise have no court at all.
      for (let len = Math.min(LEN[1], longRoom); len >= LEN[0]; len -= 1) {
        const wid = Math.min(WID[1], shortRoom, len / MIN_ASPECT);
        if (wid < WID[0]) continue;

        // Every position along the long axis that holds the whole slab, at an even step.
        const slide = longRoom - len;
        const steps = slide > 0.01 ? SLIDES : 1;
        for (let k = 0; k < steps; k++) {
          const along = steps > 1 ? -slide / 2 + (slide * k) / (steps - 1) : 0;
          const court = makeCourt({
            plot, axis, len, wid,
            x: axis === 'x' ? pcx + along : pcx,
            z: axis === 'x' ? pcz : pcz + along,
          });
          if (statue && overlapsBox(courtRect(court, STATUE_GAP), statue, STATUE_PLAZA / 2)) continue;
          if (pond && overlapsCircle(courtRect(court, POND_GAP), pond.x, pond.z, pond.r)) continue;
          candidates.push(court);
        }
      }
    }
  }
  if (!candidates.length) return null;

  // A district where one can take it: its court gets the full length, and a pocket park's is the
  // shortest one the range allows. Then the longest the chosen kind can hold, so a district never
  // loses its full-size court to a slide position that happened to be cramped by the pond.
  const districts = candidates.filter((c) => c.plot.district);
  const pool = districts.length ? districts : candidates;
  const longest = Math.max(...pool.map((c) => c.len));
  return rng.pick(pool.filter((c) => c.len >= longest - 1e-6));
}

function makeCourt({ plot, axis, len, wid, x, z }) {
  const toWorld = (u, v) => (axis === 'x' ? { x: x + u, z: z + v } : { x: x + v, z: z + u });
  const lineU = len / 2 - INSET;
  const rimU = lineU - RIM_IN;
  return {
    plot, axis, len, wid, x, z, toWorld,
    // The two rims, in world space. `s` is which end: the player shooting at a hoop stands on that
    // side of the halfway line.
    hoops: [-1, 1].map((s) => ({ s, ...toWorld(s * rimU, 0), y: RIM_Y })),
    /** Half the playing surface, inside the lines — where the players keep themselves. */
    halfU: lineU,
    halfV: wid / 2 - INSET,
    rimU,
  };
}

/** The slab's footprint in world space, grown by `margin` on every side. */
export function courtRect(court, margin = 0) {
  const hx = (court.axis === 'x' ? court.len : court.wid) / 2 + margin;
  const hz = (court.axis === 'x' ? court.wid : court.len) / 2 + margin;
  return { x0: court.x - hx, x1: court.x + hx, z0: court.z - hz, z1: court.z + hz };
}

/** Whether a point is on the slab, grown by `margin`. */
export function onCourt(court, x, z, margin = 0) {
  const r = courtRect(court, margin);
  return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
}

const overlapsBox = (r, c, half) => r.x0 < c.x + half && r.x1 > c.x - half
  && r.z0 < c.z + half && r.z1 > c.z - half;

function overlapsCircle(r, cx, cz, radius) {
  const dx = Math.max(r.x0 - cx, 0, cx - r.x1);
  const dz = Math.max(r.z0 - cz, 0, cz - r.z1);
  return Math.hypot(dx, dz) < radius;
}

/**
 * The benches the court leaves standing. A bench is struck out if any part of it would stand on
 * the slab or within a pace of it — measured in its own frame, the way `createProps` keeps trunks
 * off them, because a bench is 1.9 by 0.65 and a radius round its centre answers for neither.
 */
export function clearBenches(court, benches, benchLen) {
  if (!court) return benches;
  const r = courtRect(court, 0.4);
  return benches.filter((bench) => {
    const along = Math.abs(Math.cos(bench.yaw)) > 0.5;
    const hx = along ? benchLen / 2 : 0.34;
    const hz = along ? 0.34 : benchLen / 2;
    return !(bench.x + hx > r.x0 && bench.x - hx < r.x1 && bench.z + hz > r.z0 && bench.z - hz < r.z1);
  });
}

/**
 * The court as geometry, in two lots.
 *
 * `solid` is the slab and its paint, which merges into the props mesh like the pond does. `frame`
 * is the hoops standing up off it.
 *
 * **The frame is kept out of the props mesh for the fare board's sake.** `game/sightline.js` turns
 * every triangle of what it is handed into a height field, stamping each one's peak across its
 * whole footprint — rounding up, deliberately — so a pole a fifth of a unit thick stamps as a solid
 * column 5.3 high, and a backboard as a wall, with no gap round either for the sightlines that
 * actually pass there. The fence this court used to have showed what that costs: its top rail
 * stamped as a 3.1-high wall and threw away a kerb corner a real ray could see 85% of. Thin
 * furniture hides almost nothing, so it is not an occluder: `createProps` gives it a mesh of its
 * own that the field is never handed.
 */
export function courtParts(court, rng) {
  const solid = [];
  const frame = [];
  const { toWorld, len, wid } = court;

  // An axis-aligned box given in court terms: `lu`/`lv` are its extents along the court's length
  // and across it, mapped onto world x/z by whichever way the court lies.
  const boxAt = (u, v, y, lu, h, lv, col, into = frame) => {
    const p = toWorld(u, v);
    const geo = court.axis === 'x' ? new THREE.BoxGeometry(lu, h, lv) : new THREE.BoxGeometry(lv, h, lu);
    geo.translate(p.x, y, p.z);
    into.push(bakeColor(geo, col));
  };

  // A flat outline in court terms, laid face-up at `y`. Same construction the pond's shore uses:
  // drawn as a Shape in XY and laid down with `rotateX(-π/2)`, which maps shape-space y onto world
  // −z — so z goes in negated. `ShapeGeometry` reverses a clockwise outline before it triangulates,
  // so the reflection `toWorld` applies on a Z-axis court cannot turn one of these upside down;
  // `tools/probe.mjs` computes every triangle's normal from its winding to hold that to account.
  const flat = (points, y, col, holes = []) => {
    const toShape = (path, pts) => pts.forEach(([u, v], i) => {
      const p = toWorld(u, v);
      if (i) path.lineTo(p.x, -p.z);
      else path.moveTo(p.x, -p.z);
    });
    const shape = new THREE.Shape();
    toShape(shape, points);
    for (const hole of holes) {
      const path = new THREE.Path();
      toShape(path, hole);
      shape.holes.push(path);
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, y, 0);
    solid.push(bakeColor(geo, col));
  };
  const rect = (u0, v0, u1, v1, y, col) => flat([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], y, col);
  const arc = (cu, cv, r, a0, a1, n) => {
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      pts.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]);
    }
    return pts;
  };
  /** A painted line from (u0,v0) to (u1,v1). */
  const line = (u0, v0, u1, v1) => {
    const du = u1 - u0;
    const dv = v1 - v0;
    const l = Math.hypot(du, dv) || 1;
    const nu = (-dv / l) * (LINE_W / 2);
    const nv = (du / l) * (LINE_W / 2);
    flat([[u0 - nu, v0 - nv], [u1 - nu, v1 - nv], [u1 + nu, v1 + nv], [u0 + nu, v0 + nv]], LINE_Y, lineCol);
  };
  /** A painted arc: the band between two concentric arcs, outer one way and inner back. */
  const arcLine = (cu, cv, r, a0, a1, n) => {
    const outer = arc(cu, cv, r + LINE_W / 2, a0, a1, n);
    const inner = arc(cu, cv, r - LINE_W / 2, a0, a1, n).reverse();
    flat([...outer, ...inner], LINE_Y, lineCol);
  };

  // --- The slab and its paint ----------------------------------------------
  const top = jitterColor(PALETTE.courtTop, rng, { l: 0.02 });
  const paint = jitterColor(PALETTE.courtPaint, rng, { l: 0.03 });
  const keyCol = jitterColor(PALETTE.courtKey, rng, { l: 0.03 });
  const lineCol = new THREE.Color(PALETTE.courtLine);
  boxAt(0, 0, COURT_TOP_Y - SLAB_H / 2, len, SLAB_H, wid, top, solid);

  const hu = court.halfU;
  const hv = court.halfV;
  rect(-hu, -hv, hu, hv, PAINT_Y, paint);

  // The boundary, the halfway line and the centre circle.
  line(-hu, -hv, hu, -hv);
  line(-hu, hv, hu, hv);
  line(-hu, -hv - LINE_W / 2, -hu, hv + LINE_W / 2);
  line(hu, -hv - LINE_W / 2, hu, hv + LINE_W / 2);
  line(0, -hv, 0, hv);
  {
    const outer = arc(0, 0, CIRCLE_R + LINE_W / 2, 0, Math.PI * 2, 24).slice(0, -1);
    const inner = arc(0, 0, CIRCLE_R - LINE_W / 2, 0, Math.PI * 2, 24).slice(0, -1);
    flat(outer, LINE_Y, lineCol, [inner]);
  }

  // Each end: the key, its free-throw circle, and the three-point line.
  const keyD = Math.min(2.6, hu * 0.42);
  // The arc is held clear of the halfway line by a player's width and of the sidelines by a line's,
  // which on the shortest court brings it in to 2.4 — and on a full district court it is 3.
  const r3 = Math.min(3.0, court.rimU - 0.8);
  for (const s of [-1, 1]) {
    const base = s * hu;
    const ft = s * (hu - keyD);
    rect(base, -KEY_W / 2, ft, KEY_W / 2, KEY_Y, keyCol);
    line(base, -KEY_W / 2, ft, -KEY_W / 2);
    line(base, KEY_W / 2, ft, KEY_W / 2);
    line(ft, -KEY_W / 2 - LINE_W / 2, ft, KEY_W / 2 + LINE_W / 2);
    // The free-throw half circle, bulging toward the middle of the court.
    arcLine(ft, 0, KEY_W / 2, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? Math.PI * 1.5 : Math.PI / 2, 10);

    // The three-point line: an arc round the rim, clipped where it would cross the sideline, and
    // straight runs from there back to the baseline — the corner three.
    const rimU = s * court.rimU;
    const clip = Math.asin(Math.min(1, (hv - 0.35) / r3));
    const a0 = s > 0 ? Math.PI - clip : -clip;
    const a1 = s > 0 ? Math.PI + clip : clip;
    arcLine(rimU, 0, r3, a0, a1, 14);
    const endU = rimU - s * r3 * Math.cos(clip);
    const endV = r3 * Math.sin(clip);
    if (s * (base - endU) > 0.05) {
      line(base, -endV, endU, -endV);
      line(base, endV, endU, endV);
    }
  }

  // --- The hoops ----------------------------------------------------------
  const poleCol = new THREE.Color(PALETTE.hoopPole);
  const boardCol = new THREE.Color(PALETTE.backboard);
  const markCol = new THREE.Color(PALETTE.backboardMark);
  const rimCol = new THREE.Color(PALETTE.rim);
  const netCol = new THREE.Color(PALETTE.net);
  for (const s of [-1, 1]) {
    // The pole stands on the apron behind the baseline, an arm reaches out over the line to the
    // board, and the rim hangs off the board's face on a short bracket.
    const poleU = s * (len / 2 - 0.25);
    const boardU = s * (hu - BOARD_IN + BOARD_T / 2);
    boxAt(poleU, 0, COURT_TOP_Y + (ARM_Y + 0.1 - COURT_TOP_Y) / 2, POLE_W, ARM_Y + 0.1 - COURT_TOP_Y, POLE_W, poleCol);
    boxAt((poleU + boardU) / 2, 0, ARM_Y, Math.abs(poleU - boardU), 0.12, 0.12, poleCol);
    const boardY = RIM_Y - 0.2 + BOARD_H / 2;
    boxAt(boardU, 0, boardY, BOARD_T, BOARD_H, BOARD_W, boardCol);
    // The shooter's square on the board's face, proud of it so it never ties with the board: a red
    // frame and the white inside it, each a hair further out than the last.
    const face = boardU - s * (BOARD_T / 2);
    boxAt(face - s * 0.012, 0, RIM_Y + 0.27, 0.024, 0.5, 0.66, markCol);
    boxAt(face - s * 0.024, 0, RIM_Y + 0.29, 0.024, 0.36, 0.5, boardCol);
    boxAt(face - s * 0.08, 0, RIM_Y - 0.02, 0.16, 0.08, 0.2, rimCol);

    const at = toWorld(s * court.rimU, 0);
    const rim = new THREE.TorusGeometry(RIM_R, 0.045, 4, 14);
    rim.rotateX(Math.PI / 2);
    rim.translate(at.x, RIM_Y, at.z);
    frame.push(bakeColor(rim, rimCol));
    // The net: a short tapered tube, open at both ends. Only its near half draws — the far half
    // faces away and is culled — which at a net 0.8 across is exactly what a net looks like.
    const net = new THREE.CylinderGeometry(RIM_R * 0.95, RIM_R * 0.6, NET_H, 8, 1, true);
    net.translate(at.x, RIM_Y - NET_H / 2 - 0.03, at.z);
    frame.push(bakeColor(net, netCol));
  }

  return { solid, frame };
}

