import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, PARK_EDGE } from './ground.js';
import { STATUE_PLAZA } from './props.js';
import { courtRect } from './blacktop.js';

// A skatepark, in one park, in one city — the basketball court's neighbour, on the court's terms:
// scenery, nothing routes round it, nothing on it can be tapped, the fare loop has never heard of
// it. This is the concrete; the people riding it are game/skaters.js.
//
// What is on the slab: a quarter pipe across each end, so the riders have something to go back
// and forth between — the one loop a skatepark reads as from across a map — and two features down
// the flat between them, one per lane: a grind rail and a funbox.
//
// **The park has its own frame, and unlike the court's it is a rotation.** `u` runs along its
// length and `v` across it. The court maps the pair onto the world by swapping axes, which is a
// reflection and is harmless there only because every surface on a court is a box or a
// `ShapeGeometry`. A quarter pipe is an extruded profile, and a reflected extrusion is an extrusion
// wound inside out — so here a Z-axis park is the X-axis one turned a quarter about Y: (x, z) =
// (−v, u). Everything is built in the park's own frame and turned once (`placeLocal`).
//
// Planned after the court, and **without a draw**: which candidate wins is decided by the plan
// (longest, then furthest from the court) rather than by the props stream, so the only trees it
// moves are the ones its own keep-out turns away.

/** What ground.js lays a park's lawn at. */
const GRASS_Y = KERB_H + 0.01;
/** The floor: a slab 0.05 proud of the lawn, the court's own step. */
export const SKATE_TOP_Y = GRASS_Y + 0.05;
const SLAB_H = 0.06;

/** In from the block's edge: the walk, plus a third of a unit of lawn — the court's setback. */
const PARK_SET = PARK_EDGE + 0.35;

// Slab edge to slab edge. Long enough for two quarter pipes and a run between them with a feature
// in it; the shortest is what fits beside the statue's plaza in half a district.
const LEN = [11, 13];
const WID = [6.4, 7.4];

// --- The quarter pipes ---------------------------------------------------------
//
// A circular transition of radius `TRANS_R`, cut off at `TRANS_TOP` from the floor rather than run
// to vertical — a true vert wall at this size is a cliff, and a rider at the top of it is a figure
// lying flat — then a deck behind the lip to stand on. Heights are against a figure 3.24 tall
// (PERSON_TOP_Y): the lip comes about to their shoulder, which is a mini ramp.
export const TRANS_R = 2.3;
const TRANS_TOP = 1.25;  // radians off the floor at the lip (~72°)
/** The lip's height over the floor, and how far the transition runs along the floor to it. */
export const LIP_H = TRANS_R * (1 - Math.cos(TRANS_TOP));
export const TRANS_RUN = TRANS_R * Math.sin(TRANS_TOP);
const DECK = 1.0;
/** In from the slab's long edges: a strip of floor down each side so the ramp never ties with it. */
const RAMP_SIDE = 0.18;
const TRANS_SEGS = 10;
const COPING_R = 0.08;

// --- The features down the flat --------------------------------------------------
//
// One per lane, so the two riders never share one: the rail on the −v lane, the funbox on the +v.
// The rail is round bar on two posts; the funbox a low flat-topped box with a kicker at each end.
export const RAIL_H = 0.6;
export const RAIL_R = 0.06;
export const RAIL_HALF = 1.2;
export const BOX_H = 0.42;
export const BOX_TOP_HALF = 0.7;
export const BOX_KICK = 0.95;
const BOX_W = 1.9;

/** Room left round the statue's plaza, the pond and the court. */
const STATUE_GAP = 0.5;
const POND_GAP = 0.6;
const COURT_GAP = 1.2;
const SLIDES = 9;

/**
 * Where the skatepark goes, or `null` where no park can hold one beside everything already in it.
 *
 * @param plots   the park plots, as `parkPlots` returns them
 * @param statue  the statue from `planParkFurniture`
 * @param pond    the pond from `planPond`
 * @param court   the court from `planCourt`
 */
export function planSkatepark(plots, statue, pond, court) {
  const candidates = [];
  const courtBox = court ? courtRect(court, COURT_GAP) : null;
  for (const plot of plots) {
    const { x0, x1, z0, z1 } = plot.bounds;
    const pcx = (x0 + x1) / 2;
    const pcz = (z0 + z1) / 2;
    for (const axis of ['x', 'z']) {
      const longRoom = (axis === 'x' ? x1 - x0 : z1 - z0) - 2 * PARK_SET;
      const shortRoom = (axis === 'x' ? z1 - z0 : x1 - x0) - 2 * PARK_SET;
      const wid = Math.min(WID[1], shortRoom);
      if (wid < WID[0]) continue;
      for (let len = Math.min(LEN[1], longRoom); len >= LEN[0]; len -= 1) {
        const slide = longRoom - len;
        const steps = slide > 0.01 ? SLIDES : 1;
        for (let k = 0; k < steps; k++) {
          const along = steps > 1 ? -slide / 2 + (slide * k) / (steps - 1) : 0;
          const park = makeSkatepark({
            plot, axis, len, wid,
            x: axis === 'x' ? pcx + along : pcx,
            z: axis === 'x' ? pcz : pcz + along,
          });
          const r = skateRect(park);
          if (statue && overlapsBox(skateRect(park, STATUE_GAP), statue, STATUE_PLAZA / 2)) continue;
          if (pond && overlapsCircle(skateRect(park, POND_GAP), pond.x, pond.z, pond.r)) continue;
          if (courtBox && overlapsRect(r, courtBox)) continue;
          candidates.push(park);
        }
      }
    }
  }
  if (!candidates.length) return null;

  // A district before a pocket park, the longest that kind can hold, and then as far from the court
  // as it will go: two paved things butted up against each other read as one car park.
  const districts = candidates.filter((c) => c.plot.district);
  const pool = districts.length ? districts : candidates;
  const longest = Math.max(...pool.map((c) => c.len));
  const best = pool.filter((c) => c.len >= longest - 1e-6);
  const away = (c) => (court ? Math.hypot(c.x - court.x, c.z - court.z) : 0);
  return best.reduce((a, b) => (away(b) > away(a) + 1e-6 ? b : a));
}

function makeSkatepark({ plot, axis, len, wid, x, z }) {
  // A rotation, not a swap — see the header.
  const U = axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const V = axis === 'x' ? { x: 0, z: 1 } : { x: -1, z: 0 };
  const toWorld = (u, v) => ({ x: x + U.x * u + V.x * v, z: z + U.z * u + V.z * v });
  const lipU = len / 2 - DECK;
  return {
    plot, axis, len, wid, x, z, U, V, toWorld,
    lipU,
    /** Where each transition leaves the floor. */
    transU: lipU - TRANS_RUN,
    /** The two lanes down the flat: the rail's and the funbox's. */
    lanes: [{ v: -wid / 4, feature: 'rail' }, { v: wid / 4, feature: 'box' }],
  };
}

/** The slab's footprint in world space, grown by `margin` on every side. */
export function skateRect(park, margin = 0) {
  const hx = (park.axis === 'x' ? park.len : park.wid) / 2 + margin;
  const hz = (park.axis === 'x' ? park.wid : park.len) / 2 + margin;
  return { x0: park.x - hx, x1: park.x + hx, z0: park.z - hz, z1: park.z + hz };
}

/** Whether a point is on the slab, grown by `margin`. */
export function onSkatepark(park, x, z, margin = 0) {
  const r = skateRect(park, margin);
  return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
}

const overlapsBox = (r, c, half) => r.x0 < c.x + half && r.x1 > c.x - half
  && r.z0 < c.z + half && r.z1 > c.z - half;
const overlapsRect = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

function overlapsCircle(r, cx, cz, radius) {
  const dx = Math.max(r.x0 - cx, 0, cx - r.x1);
  const dz = Math.max(r.z0 - cz, 0, cz - r.z1);
  return Math.hypot(dx, dz) < radius;
}

/**
 * The surface a wheel rolls on along a lane, over the floor: `{ h, slope }` at `u`, `slope` being
 * dh/du. The quarter pipes on both lanes and the funbox on its own; the rail is not a surface — a
 * grind is a hop onto it, which game/skaters.js draws over the floor rather than rides.
 */
export function surfaceAt(park, feature, u) {
  const a = Math.abs(u);
  const s = Math.sign(u) || 1;
  if (a >= park.lipU) return { h: LIP_H, slope: 0 };
  if (a > park.transU) {
    const d = Math.min(a - park.transU, TRANS_RUN);
    const root = Math.sqrt(Math.max(1e-6, TRANS_R * TRANS_R - d * d));
    return { h: TRANS_R - root, slope: s * (d / root) };
  }
  if (feature === 'box') {
    if (a <= BOX_TOP_HALF) return { h: BOX_H, slope: 0 };
    if (a < BOX_TOP_HALF + BOX_KICK) {
      return { h: BOX_H * (1 - (a - BOX_TOP_HALF) / BOX_KICK), slope: -s * (BOX_H / BOX_KICK) };
    }
  }
  return { h: 0, slope: 0 };
}

/**
 * The park as geometry, in two lots on the court's terms (see `courtParts` in city/blacktop.js).
 * `solid` — the slab, the ramps and the funbox — merges into the props mesh and is an occluder for
 * the fare board's sightline field, which it genuinely is: a quarter pipe stands 1.7 high. `frame`
 * is the thin metal, the coping and the rail, which would stamp into that field as walls it is not.
 */
export function skateparkParts(park, rng) {
  const solid = [];
  const frame = [];
  const { len, wid } = park;

  /** Turn a piece built in the park's own frame (x = u, z = v, y up) into the world, in place. */
  const placeLocal = (geo, col, into) => {
    if (park.axis === 'z') geo.rotateY(-Math.PI / 2);
    geo.translate(park.x, 0, park.z);
    into.push(bakeColor(geo, col));
  };
  const box = (u, v, y, lu, h, lv, col, into) => {
    const geo = new THREE.BoxGeometry(lu, h, lv);
    geo.translate(u, y, v);
    placeLocal(geo, col, into);
  };
  /**
   * A profile in (u, height) extruded across the park from `v0` to `v1`. `ExtrudeGeometry` rewinds
   * a clockwise outline itself, so the profile's direction does not matter — the probe sums each
   * piece's signed volume to hold that to account.
   */
  const extrude = (points, v0, v1, col) => {
    const shape = new THREE.Shape(points.map(([u, h]) => new THREE.Vector2(u, h)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: v1 - v0, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, SKATE_TOP_Y, v0);
    placeLocal(geo, col, solid);
  };

  const floor = jitterColor(PALETTE.skateFloor, rng, { l: 0.02 });
  const ramp = jitterColor(PALETTE.skateRamp, rng, { l: 0.02 });
  const coping = new THREE.Color(PALETTE.skateCoping);
  const paint = new THREE.Color(PALETTE.skatePaint);
  box(0, 0, SKATE_TOP_Y - SLAB_H / 2, len, SLAB_H, wid, floor, solid);

  // The quarter pipes: floor, the arc up to the lip, the deck, down the back.
  const v0 = -wid / 2 + RAMP_SIDE;
  const v1 = wid / 2 - RAMP_SIDE;
  for (const s of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= TRANS_SEGS; k++) {
      const a = (TRANS_TOP * k) / TRANS_SEGS;
      pts.push([s * (park.transU + TRANS_R * Math.sin(a)), TRANS_R * (1 - Math.cos(a))]);
    }
    pts.push([s * (len / 2), LIP_H], [s * (len / 2), 0]);
    extrude(pts, v0, v1, ramp);

    // The coping: a steel pipe along the lip, half sunk into it so it reads as an edge, not a
    // separate bar lying on the deck.
    const pipe = new THREE.CylinderGeometry(COPING_R, COPING_R, v1 - v0, 6);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(s * park.lipU, SKATE_TOP_Y + LIP_H, 0);
    placeLocal(pipe, coping, frame);
    // A painted band across the deck's back edge, so each end has a colour that says *built* from
    // a distance — proud of the deck by a hair so the two never tie.
    box(s * (len / 2 - 0.12), 0, SKATE_TOP_Y + LIP_H + 0.004, 0.24, 0.008, v1 - v0, paint, solid);
  }

  // The funbox on the +v lane: kicker up, flat top, kicker down.
  for (const lane of park.lanes) {
    if (lane.feature === 'box') {
      const a = BOX_TOP_HALF;
      const b = BOX_TOP_HALF + BOX_KICK;
      extrude([[-b, 0], [-a, BOX_H], [a, BOX_H], [b, 0]], lane.v - BOX_W / 2, lane.v + BOX_W / 2, ramp);
      // Painted edges where the kickers meet the top — the funbox's two lines, which are what makes
      // a low concrete lump read as a thing you ride over.
      for (const e of [-a, a]) box(e, lane.v, SKATE_TOP_Y + BOX_H + 0.004, 0.16, 0.008, BOX_W, paint, solid);
    } else {
      // The rail: a round bar on two posts.
      const bar = new THREE.CylinderGeometry(RAIL_R, RAIL_R, 2 * RAIL_HALF + 0.1, 6);
      bar.rotateZ(Math.PI / 2);
      bar.translate(0, SKATE_TOP_Y + RAIL_H, lane.v);
      placeLocal(bar, paint, frame);
      for (const pu of [-RAIL_HALF + 0.25, RAIL_HALF - 0.25]) {
        box(pu, lane.v, SKATE_TOP_Y + RAIL_H / 2, 0.1, RAIL_H, 0.1, paint, frame);
      }
    }
  }

  return { solid, frame };
}
