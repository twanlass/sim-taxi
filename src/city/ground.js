import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  DIR, GRID, PITCH, ROAD_W, SPAN, HALF_SPAN, LANE_TO_KERB, lineCoord,
  isUnsignalised, isSegmentClosed, halfRoadX, halfRoadZ, isArterialX, isArterialZ,
  medianRuns, MEDIAN_W,
} from './grid.js';

const KERB_H = 0.35;
const MARK_Y = 0.02;

/** Flat quad lying on the road surface — cheaper than a box for paint markings. */
function paint(w, d, x, z, col, y = MARK_Y) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

// Kerb corners round off rather than meeting at a sharp right angle. The radius stays small: a
// building's footprint sets back only 0.85 units from the block edge (`INSET` in buildings.js),
// so anything larger would round the sidewalk straight into a building corner.
const CURB_RADIUS = 0.6;
const CURB_SEGMENTS = 8;

/** A rectangle with rounded corners, centred on the origin. */
function roundedRectShape(w, d, radius) {
  const hw = w / 2;
  const hd = d / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw + radius, -hd);
  shape.lineTo(hw - radius, -hd);
  shape.absarc(hw - radius, -hd + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(hw, hd - radius);
  shape.absarc(hw - radius, hd - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(-hw + radius, hd);
  shape.absarc(-hw + radius, hd - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(-hw, -hd + radius);
  shape.absarc(-hw + radius, -hd + radius, radius, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** A kerb block: a rounded-corner rectangle in plan, extruded up to height h. */
function curbBox(w, h, d, x, y, z, col, radius = CURB_RADIUS) {
  const geo = new THREE.ExtrudeGeometry(roundedRectShape(w, d, radius), {
    depth: h, bevelEnabled: false, curveSegments: CURB_SEGMENTS,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

// The sidewalk surface sits 0.15 in from the kerb's own edge (see the `- 0.3` below), so its
// corners are rounded to a slightly tighter radius to stay concentric with the kerb beneath it.
//
// Exported for the same reason `PARK_EDGE` and `MEDIAN_EDGE` below are: it is where the *walking*
// surface starts, and `props.js` now stands a fire hydrant on that band as well as a bench on the
// grass. A margin copied by hand is a margin that drifts.
export const PAVE_INSET = 0.15;
const PAVE_RADIUS = CURB_RADIUS - PAVE_INSET;

/** The flat sidewalk surface on top of a kerb block, rounded to match its corners. */
function roundedPaint(w, d, x, z, col, y, radius = PAVE_RADIUS) {
  const geo = new THREE.ShapeGeometry(roundedRectShape(w, d, radius), CURB_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

// --- The walk round a park -------------------------------------------------
//
// A park's green does not run to the street. Every built block presents a pale sidewalk to the
// road, and a park laid as bare grass to the kerb line was the one block in the city with no
// frontage at all: the 0.15 of kerb the block's own platform leaves showing is ~1px at play zoom
// (1 world unit ≈ 7.7px), so against grass the edge simply vanished and the green read as a rug
// dropped on the asphalt rather than as a block with a kerb like its neighbours.
//
// 1.0 unit ≈ 8px at play zoom, which is a band you can see. It is also a shade wider than the 0.7
// a built block shows between its kerb and its building line (`INSET` 0.85 in buildings.js): a
// park's frontage has no wall standing on it to widen it, so matched exactly it read as a hairline.
const PARK_WALK = 1.0;

// How far the grass sits inside the block's own bounds — the kerb's 0.15 plus the walk. Exported
// because the flock walks on the grass and the trees are planted in it, and both used to derive
// their margin from the bare 0.15.
export const PARK_EDGE = PAVE_INSET + PARK_WALK;

// The lawn's own corner radius. Not the walk's radius minus the band: offsetting a rounded
// rectangle inward by more than its corner radius can't stay concentric, so the width of the band
// at the diagonal is whatever the two radii and the corner offset make it. Measured across the
// candidates — 0.9 → 0.70 units at the corner, 1.4 → 0.91, 1.6 → 0.99 — and 1.4 is the roundest
// lawn that still reads as a lawn while holding the band within a tenth of its 1.0 on the straights.
const GRASS_RADIUS = 1.4;

/**
 * A park's ground: the paved walk and the grass inside it, as two flat surfaces at one height.
 *
 * The walk is the sidewalk shape with the lawn **cut out of it** rather than the lawn laid on top:
 * two coplanar opaque surfaces would need separating in y and would pay for the overlap twice, and
 * every block in the city is one merged mesh precisely so that none of it costs more than it must.
 */
function parkSurface(w, d, x, z, walkCol, grassCol, y) {
  const walk = roundedRectShape(w, d, PAVE_RADIUS);
  walk.holes.push(roundedRectShape(w - PARK_WALK * 2, d - PARK_WALK * 2, GRASS_RADIUS));

  const paved = new THREE.ShapeGeometry(walk, CURB_SEGMENTS);
  paved.rotateX(-Math.PI / 2);
  paved.translate(x, y, z);

  const grass = new THREE.ShapeGeometry(
    roundedRectShape(w - PARK_WALK * 2, d - PARK_WALK * 2, GRASS_RADIUS), CURB_SEGMENTS,
  );
  grass.rotateX(-Math.PI / 2);
  grass.translate(x, y, z);

  return [bakeColor(paved, walkCol), bakeColor(grass, grassCol)];
}

// How much of the median island's kerb shows around its grass — the same 0.15 every block platform
// leaves. Exported for the same reason `PARK_EDGE` is: `props.js` stands flower beds on that grass
// and has to know where it stops, and a margin copied by hand is a margin that drifts.
export const MEDIAN_EDGE = PAVE_INSET;

// --- Crosswalk bars ---------------------------------------------------------
// Hoisted out of `createGround` because the road wear below has to keep off them: a manhole cover
// under a zebra shows through the gaps between its bars, which reads as a hole in the paint.
const BARS = 4;
const BAR_W = 0.72;
const BAR_LEN = 1.5;

// --- Where a road actually starts and stops ---------------------------------
//
// One stretch of carriageway between two junction boxes. Both the centre-line paint and the wear
// below scatter along these, and the arithmetic that finds the ends is the part with the arterials
// in it: the road running along Z at x = c is bounded in z by the **X** roads at each end of the
// gap, which is the same number as its own half-width right up until one of them is a main street.
// One owner for that, rather than two loops that agree today.
//
// Closed segments are skipped. A park district builds a platform over the road it took, so paint
// laid there is under 0.35 of kerb and grass — geometry nobody will ever see.
function roadSegments() {
  const runs = [];
  for (let line = 0; line <= GRID; line++) {
    for (const axis of ['z', 'x']) {
      const c = lineCoord(line);
      for (let k = 0; k < GRID; k++) {
        // The gap between crossing lines k and k + 1, named by the junction at its low end.
        const i = axis === 'z' ? line : k;
        const j = axis === 'z' ? k : line;
        if (isSegmentClosed(i, j, axis === 'z' ? DIR.PZ : DIR.PX)) continue;
        runs.push({
          axis,
          line,
          k,
          c,
          half: axis === 'z' ? halfRoadZ(line) : halfRoadX(line),
          arterial: axis === 'z' ? isArterialZ(line) : isArterialX(line),
          from: lineCoord(k) + (axis === 'z' ? halfRoadX(k) : halfRoadZ(k)),
          to: lineCoord(k + 1) - (axis === 'z' ? halfRoadX(k + 1) : halfRoadZ(k + 1)),
        });
      }
    }
  }
  return runs;
}

// --- The main streets are concrete -------------------------------------------
//
// An arterial is already three things the simulation knows and the player mostly cannot see: a
// coordinated green wave, a planted median, and a third more width. Paving it in a **different
// material** is what makes the hierarchy legible from across the map — the two main streets read
// as a pale cross through a dark grid, before anything about signal timing has to be worked out.
//
// It also gives the wear below something to sit on. A dark patch on dark tarmac is a subtlety; the
// same patch on concrete is an asphalt repair in a concrete road, which is what those actually look
// like and the strongest contrast anywhere on the carriageway.
const ARTERIAL_Y = 0.004;

/**
 * Every rectangle of concrete carriageway: a strip down each arterial, kerb to kerb, running the
 * width of the city.
 *
 * **Non-overlapping by construction rather than separated in y.** Two coplanar quads z-fight, and
 * the obvious fix — a hair of height between the axes — spends one of the six gaps in a stack that
 * already has to fit four kinds of wear under `MARK_Y`. So the roads running along Z are *split
 * around* the bands the roads running along X occupy: one extra rectangle per crossing, and no
 * extra height at all. Exported because that non-overlap is the whole design and is invisible once
 * the ground is one merged mesh — tools/probe.mjs asserts it.
 *
 * The ends are the outer ring road's far kerb, which is where the built city stops. Running out to
 * the slab's own edge would put a hard concrete line on the apron the fade skirt is there to
 * dissolve. Closed segments are *not* skipped, and needn't be: a park district's platform covers
 * the road it took end to end, so the concrete under one is as invisible as the paint already is.
 */
export function arterialPaving() {
  const strips = [];

  // A road running along X is bounded in x by the *Z* roads at each end, and vice versa — the same
  // number in practice, since the ring road is never an arterial, but written off the road anyway.
  const from = (axis) => lineCoord(0) - (axis === 'x' ? halfRoadZ(0) : halfRoadX(0));
  const to = (axis) => lineCoord(GRID) + (axis === 'x' ? halfRoadZ(GRID) : halfRoadX(GRID));

  // The bands the east-west arterials occupy, in z. Laid first and whole; everything else works
  // around them.
  const bands = [];
  for (let j = 0; j <= GRID; j++) {
    if (!isArterialX(j)) continue;
    const c = lineCoord(j);
    const h = halfRoadX(j);
    bands.push([c - h, c + h]);
    strips.push({ x0: from('x'), x1: to('x'), z0: c - h, z1: c + h });
  }
  bands.sort((a, b) => a[0] - b[0]);

  for (let i = 0; i <= GRID; i++) {
    if (!isArterialZ(i)) continue;
    const c = lineCoord(i);
    const h = halfRoadZ(i);
    let z = from('z');
    for (const [b0, b1] of bands) {
      if (b0 > z) strips.push({ x0: c - h, x1: c + h, z0: z, z1: b0 });
      z = Math.max(z, b1);
    }
    if (to('z') > z) strips.push({ x0: c - h, x1: c + h, z0: z, z1: to('z') });
  }

  return strips;
}

// --- Wear on the road surface -----------------------------------------------
//
// A 5×5 grid of streets is 60 stretches of identical grey, and the asphalt is the single largest
// surface in the frame — bigger than the sky at play zoom. Three marks break it up, and all three
// are things a real street has rather than noise sprinkled on one:
//
//   - **resurfacing**, a stretch repaved at a different time from its neighbours, in a tone a few
//     points off the road's own. This is the one that does the actual work: it is the only mark
//     large enough to change what a whole street looks like from across the map.
//   - **patches**, the irregular scab a dug-up trench leaves. Small, dark or bleached, plausible.
//   - **manhole covers**, in the lane, which are the only mark with a hard edge and the only one
//     that reads as an *object* rather than as a stain.
//
// The whole layer sits **under the paint**. `MARK_Y` is 0.02 and the lane markings, the crosswalks
// and the double lines all live there; a patch drawn over a dashed line is a patch nobody has
// repainted, which is a different and much scruffier city than the one this is.
//
// The heights are 0.002-0.004 apart, which is worth stating because it looks like z-fighting
// waiting to happen and is not. This camera is orthographic with near 1 and far 1400, so depth is
// **linear** across the range: a 24-bit buffer resolves 8.3e-5 units, and only the 0.525 of a
// world-Y offset that survives projection down `VIEW_DIR` counts — so the tightest gap here is
// still about 13 depth units. (Compare the pavement, which takes 0.01 over its own kerb.)
//
// Six layers now share the 0.02 under the paint — `ARTERIAL_Y` above is the sixth — which is why
// the concrete goes to the trouble of not overlapping itself rather than buying another one.
const RESURFACE_Y = 0.008;
const PATCH_Y = 0.012;
const COVER_RIM_Y = 0.015;
const COVER_Y = 0.017;

// A manhole cover is drawn about twice life size, and that is deliberate. This city's scale is a
// 4.5m car drawn 3.4 units long, so 1 unit ≈ 1.3m and a real 0.6m cover is 0.45 units — three
// pixels at play zoom, which is not an object, it is a smudge. At 1.04 across it is eight pixels
// and it reads. Sized against the lane rather than against the metre: it takes a quarter of the
// 4-unit lane it sits in, where a real one takes about a sixth.
const COVER_R = 0.52;
// The collar of tar round the cover. 0.16 shows as a bit over a pixel of dark ring, which is what
// stops the disc reading as a flat blob — an eight-pixel circle needs an edge more than it needs
// detail inside it.
const COVER_LIP = 0.16;
const COVER_SIDES = 12;

// How often a stretch gets each mark. Swept by eye against the whole-city framing (shot 0) rather
// than tuned per street: what matters is the *count across the map*, since the failure at both ends
// is legible from up there — too few and the resurfacing reads as three odd rectangles, too many
// and the grid stops reading as a road network at all. Over 60 stretches these come to roughly 27
// resurfaced, 25 patches and 13 covers.
const RESURFACE_CHANCE = 0.45;
const PATCH_CHANCE = 0.34;
const PATCH_SECOND = 0.28;
const COVER_CHANCE = 0.22;

// The outline of a patch: points round an ellipse, each pulled *inward* by its own draw. Inward
// rather than either way, so the half-extents the plan carries are a genuine bound on the reach
// and tools/probe.mjs can hold the placement to them — the check that matters is that no patch
// laps over a kerb or onto a planted median, and it is unanswerable once the mesh is merged.
const BLOTCH_POINTS = 9;
const BLOTCH_PULL = 0.66;

/**
 * Where the road wears: resurfaced stretches, patches, and manhole covers.
 *
 * Split out and exported for the reason `planMedianBeds` in props.js is. The placement is the part
 * with rules in it, every one of those rules is about staying inside a carriageway that is **not
 * always the same width**, and once these are merged into the ground mesh there is no way left to
 * ask where any of them went.
 */
export function planRoadWear(rng) {
  const strips = [];
  const patches = [];
  const covers = [];

  for (const seg of roadSegments()) {
    const { axis, line, c, half, arterial, from, to } = seg;

    // The inner edge of a carriageway: the centreline on an ordinary street, the island's kerb on
    // an arterial. A mark that crosses it on a main street is a mark laid through a flower bed.
    const inner = arterial ? MEDIAN_W / 2 : 0;

    // Road-local (along, across) to world. `across` is signed off the road's own centreline.
    // `arterial` rides along because it decides what the mark is *made of* as well as where it
    // goes: an arterial is concrete now, and a repair in concrete is a different colour from a
    // repair in tarmac.
    const strip = (along, across, lenAlong, lenAcross) => (axis === 'z'
      ? { axis, line, arterial, x: c + across, z: along, w: lenAcross, d: lenAlong }
      : { axis, line, arterial, x: along, z: c + across, w: lenAlong, d: lenAcross });
    const blotch = (along, across, rAlong, rAcross) => (axis === 'z'
      ? { axis, line, arterial, x: c + across, z: along, rx: rAcross, rz: rAlong }
      : { axis, line, arterial, x: along, z: c + across, rx: rAlong, rz: rAcross });

    // --- Resurfacing. Ends on the junction boxes rather than running through them, because that
    // is where a paving job actually stops: an intersection is resurfaced with whichever street
    // the crew was sent to, and the seam it leaves is the thing being drawn.
    if (rng.chance(RESURFACE_CHANCE)) {
      // Kerb to kerb, or one carriageway. A main street never gets the full width — the island is
      // in the way, and half an arterial is 5.33 across, which is a wide enough band on its own.
      const whole = !arterial && rng.chance(0.45);
      const width = whole ? half * 2 : half - inner;
      const across = whole ? 0 : (rng.chance(0.5) ? 1 : -1) * (inner + width / 2);
      strips.push(strip((from + to) / 2, across, to - from, width));
    }

    // --- Patches. Longer down the road than across it: a repair follows the trench that caused it.
    const count = rng.chance(PATCH_CHANCE) ? (rng.chance(PATCH_SECOND) ? 2 : 1) : 0;
    for (let n = 0; n < count; n++) {
      const rAlong = rng.range(0.55, 1.35);
      const rAcross = rng.range(0.35, 0.80);
      const reach = half - rAcross;
      if (reach <= inner + rAcross) continue;
      const across = arterial
        // One carriageway or the other, never across the island.
        ? (rng.chance(0.5) ? 1 : -1) * rng.range(inner + rAcross, reach)
        // An ordinary street has nothing down the middle, so a patch may straddle the centreline.
        : rng.range(-reach, reach);
      patches.push(blotch(rng.range(from + rAlong + 0.3, to - rAlong - 0.3), across, rAlong, rAcross));
    }

    // --- Manhole covers, on the lane centre. Which is 2 units off its own kerb on every road in
    // the city (`LANE_TO_KERB`), so on an arterial it lands 3.33 from the centreline and the island
    // — 1.2 out — never comes into it. See the divided-arterial note in grid.js: this is the
    // constant that survived the widening precisely because it is measured from the kerb.
    //
    // Kept clear of the crosswalks at both ends: the bars are painted out to `BAR_LEN + 0.15` past
    // the junction box, and a cover under one shows through the gaps between them.
    const end = BAR_LEN + 0.15 + COVER_R + 0.25;
    if (rng.chance(COVER_CHANCE) && to - from > end * 2) {
      const lane = (rng.chance(0.5) ? 1 : -1) * (half - LANE_TO_KERB);
      const along = rng.range(from + end, to - end);
      covers.push(axis === 'z'
        ? { axis, line, arterial, x: c + lane, z: along, r: COVER_R }
        : { axis, line, arterial, x: along, z: c + lane, r: COVER_R });
    }
  }

  return { strips, patches, covers };
}

/** One patch, as a flat irregular polygon lying on the tarmac. */
function patchGeometry({ x, z, rx, rz }, rng, col) {
  const shape = new THREE.Shape();
  for (let n = 0; n < BLOTCH_POINTS; n++) {
    const angle = (n / BLOTCH_POINTS) * Math.PI * 2;
    const pull = rng.range(BLOTCH_PULL, 1);
    const px = Math.cos(angle) * rx * pull;
    const py = Math.sin(angle) * rz * pull;
    if (n === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  }
  // Wound counter-clockwise like every other Shape in this file, so it comes out of the same
  // rotateX facing +Y rather than into the road.
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, PATCH_Y, z);
  return bakeColor(geo, col);
}

/** One manhole: the collar, and the cover sitting in it. */
function manholeParts({ x, z, r }, rng) {
  const disc = (radius, col, y) => {
    const geo = new THREE.CircleGeometry(radius, COVER_SIDES);
    geo.rotateX(-Math.PI / 2);
    geo.translate(x, y, z);
    return bakeColor(geo, col);
  };
  // Sized per cover, because a row of identical circles down a street reads as a repeat rather
  // than as ironwork.
  const size = r * rng.range(0.90, 1.06);
  return [
    disc(size, jitterColor(PALETTE.manholeRim, rng, { l: 0.03 }), COVER_RIM_Y),
    // Hue and saturation jitter as well as lightness, so one cover is rustier than the next rather
    // than the whole city wearing the same brown.
    disc(size - COVER_LIP, jitterColor(PALETTE.manhole, rng, { h: 0.02, s: 0.14, l: 0.045 }),
      COVER_Y),
  ];
}

const SLAB = SPAN + ROAD_W * 3;

// Rounded corners, so the city reads as an island rather than a sheet cut out with scissors.
//
// The ceiling is ~27: any larger and the arc eats into the corner where the two outermost roads
// meet, leaving the ring road hanging over nothing. 22 is clearly round with room to spare.
const SLAB_RADIUS = 22;
const SLAB_SEGMENTS = 14;

// The feather beyond that edge: a skirt of asphalt fading to nothing, so the island dissolves
// into the sky instead of ending on a hard line.
//
// It is added *outside* the slab rather than eaten out of it. Fading inward would need the solid
// part to shrink, and there is only 2.2 units of clearance at the corners before the arc bites
// into the ring road junction at (±54, ±54) — see the SLAB_RADIUS ceiling above.
//
// 16 units is ~15% of the frustum height (2 × zoom = 104), which is what makes it read as a
// gradient rather than as a slightly blurry edge.
const EDGE_FADE = 16;
const FADE_RINGS = 4;

/** A square with rounded corners, as a Shape — the outline both the slab and its fade are cut from. */
function slabShape(size, radius) {
  const h = size / 2;
  const shape = new THREE.Shape();

  shape.moveTo(-h + radius, -h);
  shape.lineTo(h - radius, -h);
  shape.absarc(h - radius, -h + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(h, h - radius);
  shape.absarc(h - radius, h - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(-h + radius, h);
  shape.absarc(-h + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(-h, -h + radius);
  shape.absarc(-h + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);

  return shape;
}

/** That shape, lying flat on the ground plane. */
function roundedSlab(size, radius) {
  const geo = new THREE.ShapeGeometry(slabShape(size, radius), SLAB_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * The fade skirt: rings of asphalt stepping outward from the slab's own edge, alpha 1 → 0.
 *
 * Alpha rides in a **4-component vertex colour**, the same trick the skid marks use, so the skirt
 * needs no shader of its own — and it wears `propMaterial`'s recipe (Lambert + flatShading) so a
 * flat plane at the same height with the same normal and the same colour is lit *identically* to
 * the slab it continues. Anything cheaper (an unlit fill, a baked sky-coloured gradient) would
 * hold at golden hour and then part company with the asphalt the moment the day cycle moved.
 *
 * The inner ring is not an approximation of the slab's outline, it **is** the slab's outline:
 * both come from `extractPoints` on the same Shape, so there is no seam to leak sky through at
 * the corner arcs — where a hand-sampled ring would drift from Three's own tessellation.
 */
function asphaltFade(size, radius) {
  const outline = slabShape(size, radius).extractPoints(SLAB_SEGMENTS).shape;
  // The path closes on its start point, which would otherwise give the wrap-around a zero-width quad.
  if (outline[outline.length - 1].distanceTo(outline[0]) < 1e-9) outline.pop();

  // Outward normal of a rounded rectangle in one expression: clamp the point into the box the
  // corner arcs are centred on, and the direction back out to it is the edge normal along a
  // straight and the arc's own radius around a corner. (The two are never equal — every outline
  // point sits exactly `radius` from that box — so there is no zero-length case to guard.)
  const inset = size / 2 - radius;
  const normals = outline.map((p) => new THREE.Vector2(
    p.x - THREE.MathUtils.clamp(p.x, -inset, inset),
    p.y - THREE.MathUtils.clamp(p.y, -inset, inset),
  ).divideScalar(radius));

  // Smoothstep, not linear. A linear ramp leaves a kink in the falloff exactly where it meets the
  // solid slab, and against a flat sky that kink reads as the hard edge this is here to remove.
  const alphaAt = (t) => 1 - t * t * (3 - 2 * t);

  const c = new THREE.Color(color('asphalt'));
  const pos = [];
  const col = [];

  const vertex = (i, ring) => {
    const t = ring / FADE_RINGS;
    pos.push(outline[i].x + normals[i].x * EDGE_FADE * t, outline[i].y + normals[i].y * EDGE_FADE * t, 0);
    col.push(c.r, c.g, c.b, alphaAt(t));
  };

  for (let ring = 0; ring < FADE_RINGS; ring++) {
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      // Wound to match ShapeGeometry's own front face, so both survive the same rotateX below.
      vertex(i, ring); vertex(i, ring + 1); vertex(j, ring + 1);
      vertex(i, ring); vertex(j, ring + 1); vertex(j, ring);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();

  const material = propMaterial();
  material.transparent = true;
  // A surface you can see through has no business hiding what is drawn behind it later — the same
  // rule every other bit of translucent paint in the game follows.
  material.depthWrite = false;

  const mesh = new THREE.Mesh(geo, material);
  // Shadows have to run out through the fade rather than stopping dead on the slab edge: a low sun
  // throws them well past the outer road.
  mesh.receiveShadow = true;
  // First in the transparent queue. Everything else translucent in this game is *on* the road —
  // route band, discs, skid marks, dust — and centroid sorting would otherwise let a mark at the
  // far corner of the city draw before the plane it is painted on.
  mesh.renderOrder = -1;
  mesh.name = 'asphalt-fade';
  return mesh;
}

/**
 * Roads, kerbs, sidewalks and paint. All of it merges into a single static mesh — the geometry
 * never changes at runtime, so there's no reason for it to cost more than one draw call. (The
 * edge fade is the one exception, and only because alpha cannot ride in the merged mesh's
 * 3-component colour attribute; it hangs off this mesh as a child.)
 */
export function createGround(rng, blocks) {
  const parts = [];

  // Asphalt slab under everything. Kept tight to the outer roads — a wide apron reads as a grey
  // void around the city, and nothing hides where it ends. (The scene does carry a haze now, but
  // it is a gradient over the whole frame rather than an edge fade: at the map's corners it is
  // 0.17 of the way to the sky, which is a long way short of hiding an apron.) The edge itself is
  // feathered rather than cut: see `asphaltFade`.
  parts.push(bakeColor(roundedSlab(SLAB, SLAB_RADIUS), color('asphalt')));

  // --- Park districts first: a single platform spanning both blocks and the road that used to
  // run between them, so the green reads as one continuous mass.
  for (const district of blocks.districts ?? []) {
    const { x0, x1, z0, z1, cx, cz } = district.bounds;
    const w = x1 - x0;
    const d = z1 - z0;
    parts.push(curbBox(w, KERB_H, d, cx, 0, cz, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    parts.push(...parkSurface(
      w - PAVE_INSET * 2, d - PAVE_INSET * 2, cx, cz,
      jitterColor(PALETTE.sidewalk, rng, { l: 0.03 }),
      jitterColor(PALETTE.park, rng, { l: 0.03 }),
      KERB_H + 0.01,
    ));
  }

  // --- Block platforms: raised kerb + sidewalk surface, or grass for parks.
  for (const block of blocks) {
    if (block.districtId !== null && block.districtId !== undefined) continue;
    const { x0, z0, cx, cz } = block.bounds;
    const w = block.bounds.x1 - x0;
    const d = block.bounds.z1 - z0;

    parts.push(curbBox(w, KERB_H, d, cx, 0, cz, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));

    // A pocket park gets the same walk round it as a district, for the same reason: it is a block
    // on a street, and the thing that says so is the pavement it presents to the street.
    if (block.type === 'park') {
      parts.push(...parkSurface(
        w - PAVE_INSET * 2, d - PAVE_INSET * 2, cx, cz,
        jitterColor(PALETTE.sidewalk, rng, { l: 0.03 }),
        jitterColor(PALETTE.park, rng, { l: 0.03 }),
        KERB_H + 0.01,
      ));
    } else {
      parts.push(roundedPaint(w - PAVE_INSET * 2, d - PAVE_INSET * 2, cx, cz,
        jitterColor(PALETTE.sidewalk, rng, { l: 0.03 }), KERB_H + 0.01));
    }
  }

  // --- The planted median ----------------------------------------------------
  //
  // What the extra third of an arterial's width buys. A kerbed island down the middle of every
  // main street, between junctions but not through them — built exactly like a block platform,
  // because that is what it is: a raised kerb with something green on top. `grid.js` owns where
  // the runs are, so the flower beds `props.js` plants stand on the same rectangles.
  //
  // Stadium ends rather than square corners. At 2.4 across and eight or nine long, a square-ended
  // planter reads as a kerbstone dropped in the road; the cap is what makes it a traffic island.
  const islands = new Map();
  for (const run of medianRuns()) {
    islands.set(`${run.axis}|${run.line}|${run.k}`, run);

    const w = run.x1 - run.x0;
    const d = run.z1 - run.z0;
    const cx = (run.x0 + run.x1) / 2;
    const cz = (run.z0 + run.z1) / 2;
    const radius = MEDIAN_W / 2;

    parts.push(curbBox(w, KERB_H, d, cx, 0, cz,
      jitterColor(PALETTE.kerb, rng, { l: 0.02 }), radius));
    parts.push(roundedPaint(w - PAVE_INSET * 2, d - PAVE_INSET * 2, cx, cz,
      jitterColor(PALETTE.park, rng, { l: 0.03 }), KERB_H + 0.01, radius - PAVE_INSET));
  }

  // --- Dashed centre lines, one run per gap between intersections.
  const DASH = 1.6;
  const GAP = 1.4;
  const markColor = color('laneMark');

  // Where an arterial has no island — the stretch either side of each junction — the median is
  // painted instead. Set at the island's own half-width rather than the 0.45 of an ordinary double
  // line, so the paint reads as the same divider opening out to let the turns across.
  const DOUBLE_OFF = MEDIAN_W / 2 - 0.3;
  const doubleLine = (axis, c, from, to) => {
    if (to - from < 0.05) return;
    for (const off of [-DOUBLE_OFF, DOUBLE_OFF]) {
      if (axis === 'x') parts.push(paint(to - from, 0.16, (from + to) / 2, c + off, markColor));
      else parts.push(paint(0.16, to - from, c + off, (from + to) / 2, markColor));
    }
  };

  // Where the road stops and the junction box starts is `roadSegments`' job, not this loop's — the
  // two axes measure it against *each other's* half-widths, which is the same number until an
  // arterial made one of them 5.33.
  for (const { axis, line, k, c, arterial, from, to } of roadSegments()) {
    if (arterial) {
      const island = islands.get(`${axis}|${line}|${k}`);
      if (island) {
        doubleLine(axis, c, from, island.from);
        doubleLine(axis, c, island.to, to);
      } else {
        doubleLine(axis, c, from, to);
      }
      continue;
    }

    for (let s = from + GAP; s + DASH < to; s += DASH + GAP) {
      if (axis === 'z') parts.push(paint(0.18, DASH, c, s + DASH / 2, markColor));
      else parts.push(paint(DASH, 0.18, s + DASH / 2, c, markColor));
    }
  }

  // --- Crosswalks.
  //
  // Only where there is a signal to stop traffic for the person crossing. That rules out the ring
  // junctions, which are yield-controlled and carry no lights, and it rules out crossing an
  // arterial — a main road doesn't get halted for a pedestrian. Painting them everywhere implied
  // a right of way the simulation never grants.
  const crossColor = color('crosswalk');

  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (isUnsignalised(i, j)) continue;

      const cx = lineCoord(i);
      const cz = lineCoord(j);
      // Clear of the junction box on the axis it is laid off, which is the *crossing* road's
      // half-width — so a crossing beside a divided arterial is set back the extra 1.33 rather
      // than being painted inside the box.
      const offX = halfRoadZ(i) + BAR_LEN / 2 + 0.15;
      const offZ = halfRoadX(j) + BAR_LEN / 2 + 0.15;

      // A crossing laid west or east of the junction is walked *across* the road running along X;
      // one laid north or south is walked across the road running along Z.
      const acrossX = !isArterialX(j);
      const acrossZ = !isArterialZ(i);

      // No crossing onto a road that no longer exists.
      const west = acrossX && i > 0 && !isSegmentClosed(i, j, 2);
      const east = acrossX && i < GRID && !isSegmentClosed(i, j, 0);
      const south = acrossZ && j > 0 && !isSegmentClosed(i, j, 3);
      const north = acrossZ && j < GRID && !isSegmentClosed(i, j, 1);

      for (let b = 0; b < BARS; b++) {
        // Spread the bars across the width of the road being *crossed*, centred on its centreline.
        // Always 8 in practice — a crossing is never laid across an arterial, see above — but
        // written off the road rather than off ROAD_W so it stays true if that rule ever changes.
        const spread = (b - (BARS - 1) / 2) / (BARS + 0.6);
        const tx = spread * 2 * halfRoadX(j);   // along z, across the road running along X
        const tz = spread * 2 * halfRoadZ(i);   // along x, across the road running along Z

        if (west) parts.push(paint(BAR_LEN, BAR_W, cx - offX, cz + tx, crossColor));
        if (east) parts.push(paint(BAR_LEN, BAR_W, cx + offX, cz + tx, crossColor));
        if (south) parts.push(paint(BAR_W, BAR_LEN, cx + tz, cz - offZ, crossColor));
        if (north) parts.push(paint(BAR_W, BAR_LEN, cx + tz, cz + offZ, crossColor));
      }
    }
  }

  // --- The main streets, in concrete.
  //
  // Laid before the wear, because the wear is laid *on* it: every mark below asks which material
  // its road is made of before it picks a colour.
  for (const slab of arterialPaving()) {
    parts.push(paint(slab.x1 - slab.x0, slab.z1 - slab.z0,
      (slab.x0 + slab.x1) / 2, (slab.z0 + slab.z1) / 2,
      jitterColor(PALETTE.concreteRoad, rng, { l: 0.015 }), ARTERIAL_Y));
  }

  // --- Wear on the carriageway.
  //
  // Last, after every other draw in this function, so that adding it left a seed's kerbs, its
  // pavements and its parks exactly where they already were — the same courtesy `props.js` pays
  // its median beds. See `planRoadWear` for what the three marks are and why they sit where
  // they do.
  const wear = planRoadWear(rng);

  // A resurfaced stretch is the road's own colour and a couple of points off it, never a colour of
  // its own: what is being drawn is one paving job against the next, not asphalt against tar.
  // The lightness spread is the one number here that had to be measured on screen rather than
  // picked in the palette: at ±0.028 — which is a visible step on a swatch — the whole layer came
  // out of the renderer indistinguishable from bare road, because the parked hour's light lands at
  // a bit over half and takes most of the separation with it. ±0.055 is about eight levels of grey
  // between one paving job and the next, which is what "slightly different" actually looks like.
  for (const s of wear.strips) {
    parts.push(paint(s.w, s.d, s.x, s.z,
      jitterColor(s.arterial ? PALETTE.concreteRoad : PALETTE.asphalt, rng,
        { h: 0.008, s: 0.06, l: 0.055 }), RESURFACE_Y));
  }
  // On tarmac: mostly fresh tar, occasionally a repair old enough to have bleached past the road
  // around it, and neither of them ever more than a shade off the surface it is cut into.
  //
  // On concrete there is no such constraint, because a patch in a concrete road **is asphalt** —
  // which is both what those actually look like and, at 49 points of luma against the arterial's
  // 126, the one mark on the whole carriageway that reads without being looked for. The dark end
  // only: a bleached patch on concrete would be a patch the colour of the road.
  for (const patch of wear.patches) {
    const base = patch.arterial || rng.chance(0.72) ? PALETTE.asphaltPatch : PALETTE.asphaltScar;
    parts.push(patchGeometry(patch, rng, jitterColor(base, rng, { l: 0.035 })));
  }
  for (const cover of wear.covers) parts.push(...manholeParts(cover, rng));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  mesh.add(asphaltFade(SLAB, SLAB_RADIUS));
  return mesh;
}

export { KERB_H, SLAB, SLAB_RADIUS, EDGE_FADE, roundedRectShape };
