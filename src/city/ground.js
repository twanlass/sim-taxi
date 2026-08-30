import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID_I, GRID_J, ROAD_W, SPAN_X, SPAN_Z, lineX, lineZ,
  isUnsignalised, isSegmentClosed, halfRoadX, halfRoadZ, isArterialX, isArterialZ,
  isRiverGap, riverBanks, medianRuns, MEDIAN_W,
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

// The island is a **rectangle**, not a square: the two axes carry different numbers of blocks
// since the city grew a row for the river. Same margin off the outer roads on both, which is what
// keeps the apron reading as one border rather than two.
const SLAB_MARGIN = ROAD_W * 3;
export const SLAB_X = SPAN_X + SLAB_MARGIN;
export const SLAB_Z = SPAN_Z + SLAB_MARGIN;

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
// Exported: the river's own strip fades on this band and this ring count too, and the whole point
// of the mouth is that the two agree exactly.
export const EDGE_FADE = 16;
export const FADE_RINGS = 4;

/**
 * A rectangle with rounded corners, as a Shape — the outline both the slab and its fade are cut
 * from. Shape-space y maps to world **−z** under the `rotateX(-π/2)` every flat surface here is
 * laid with, and the outline is symmetric in both axes, so `d` can be passed straight in.
 */
function slabShape(w, d, radius) {
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

/**
 * The same outline cut straight across at a world z, keeping the side `keep` names.
 *
 * **The river splits the island in two.** The slab is a flat opaque surface at y = 0 and the water
 * is two units under it, so leaving the asphalt whole would simply hide the river; a `Shape.hole`
 * cannot help either, since the channel runs off both ends of the map and a hole has to be
 * interior. Two shapes it is.
 *
 * Authored directly rather than clipped, because the cut is always in the **straight** part of the
 * outline and is known to be: the channel sits at |z| <= 36 on any river row, and the corner arcs
 * only start past |z| = `d/2 - radius` = 50. So each piece is two rounded corners and two square
 * ones, and there is no general polygon clip to get wrong.
 *
 * `rotateX(-PI/2)` maps shape-space y onto world **-z**, which is why the cut goes in negated.
 */
function slabPieceShape(w, d, radius, cutZ, keep) {
  const hw = w / 2;
  const hd = d / 2;
  const cut = -cutZ;
  const shape = new THREE.Shape();

  // Both pieces are wound the same way round as the whole slab is — anticlockwise in shape space,
  // starting from the corner nearest shape -x-y. Matching it is not cosmetic: `asphaltFade` walks
  // this outline to build its skirt, and a piece wound the other way would send every one of its
  // outward normals inward.
  if (keep === 'north') {
    // World z above the cut is shape-y *below* it, so the northern piece is the lower region.
    shape.moveTo(-hw + radius, -hd);
    shape.lineTo(hw - radius, -hd);
    shape.absarc(hw - radius, -hd + radius, radius, -Math.PI / 2, 0, false);
    shape.lineTo(hw, cut);
    shape.lineTo(-hw, cut);
    shape.lineTo(-hw, -hd + radius);
    shape.absarc(-hw + radius, -hd + radius, radius, Math.PI, Math.PI * 1.5, false);
  } else {
    shape.moveTo(-hw, cut);
    shape.lineTo(hw, cut);
    shape.lineTo(hw, hd - radius);
    shape.absarc(hw - radius, hd - radius, radius, 0, Math.PI / 2, false);
    shape.lineTo(-hw + radius, hd);
    shape.absarc(-hw + radius, hd - radius, radius, Math.PI / 2, Math.PI, false);
    shape.lineTo(-hw, cut);
  }
  return shape;
}

/** The island's outlines: one shape, or two with the river between them. */
function slabShapes(w, d, radius) {
  const banks = riverBanks();
  if (!banks) return [slabShape(w, d, radius)];
  return [
    slabPieceShape(w, d, radius, banks.z1, 'north'),
    slabPieceShape(w, d, radius, banks.z0, 'south'),
  ];
}

/** A shape, lying flat on the ground plane. */
function roundedSlab(shape) {
  const geo = new THREE.ShapeGeometry(shape, SLAB_SEGMENTS);
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
function asphaltFade(shape, w, d, radius) {
  const outline = shape.extractPoints(SLAB_SEGMENTS).shape;
  // The path closes on its start point, which would otherwise give the wrap-around a zero-width quad.
  if (outline[outline.length - 1].distanceTo(outline[0]) < 1e-9) outline.pop();

  // **The river bank is not an edge of the island.** Where the slab has been cut in two, the two
  // straight cuts are the *inside* of the map — asphalt stopping at a wall two units above the
  // water — and feathering them would hang a translucent shelf out over the channel. Every other
  // segment of the outline is a real coast and keeps its skirt.
  //
  // Detected by height rather than by being handed the cut: `extractPoints` re-samples the shape
  // and hands back a plain point list with no idea which segment came from where, so the geometry
  // is the only thing left to ask.
  const banks = riverBanks();
  const onCut = banks
    ? outline.map((p) => Math.abs(-p.y - banks.z0) < 1e-6 || Math.abs(-p.y - banks.z1) < 1e-6)
    : outline.map(() => false);

  // Outward normal of a rounded rectangle in one expression: clamp the point into the box the
  // corner arcs are centred on, and the direction back out to it is the edge normal along a
  // straight and the arc's own radius around a corner. (The two are never equal — every outline
  // point sits exactly `radius` from that box — so there is no zero-length case to guard.)
  const insetX = w / 2 - radius;
  const insetY = d / 2 - radius;
  const normals = outline.map((p) => new THREE.Vector2(
    p.x - THREE.MathUtils.clamp(p.x, -insetX, insetX),
    p.y - THREE.MathUtils.clamp(p.y, -insetY, insetY),
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
      if (onCut[i] && onCut[j]) continue;                 // the river bank, not the coast
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
  const outlines = slabShapes(SLAB_X, SLAB_Z, SLAB_RADIUS);
  for (const outline of outlines) {
    parts.push(bakeColor(roundedSlab(outline), color('asphalt')));
  }

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
    // The river row has no platform at all: no kerb, no pavement, nothing to stand on. What edges
    // it is the channel wall and the parapet on each bank, and those are `city/river.js`'s.
    if (block.type === 'river') continue;
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

  // The two axes are walked separately. The road running along Z at x = c is bounded in z by the
  // *X* roads at each end of the gap, and the road running along X at z = c by the Z roads — the
  // same number until an arterial made one of them 5.33.
  const markRoad = (axis, line) => {
    // A road running along Z sits at an *x* of `lineX(line)` and its gaps are indexed by j; one
    // running along X sits at a *z* and its gaps are indexed by i. Both halves of that were one
    // expression while the axes shared a count and an origin.
    const c = axis === 'z' ? lineX(line) : lineZ(line);
    const arterial = axis === 'z' ? isArterialZ(line) : isArterialX(line);
    const along = axis === 'z' ? lineZ : lineX;
    const gaps = axis === 'z' ? GRID_J : GRID_I;

    for (let k = 0; k < gaps; k++) {
      // **A gap with no road under it gets no paint.** Over a park district that never mattered,
      // because the district's platform sits at KERB_H and covers the dashes; over the river there
      // is nothing to cover them and they would float above open water. A bridged crossing is
      // skipped too — an arched deck is not at y = 0 and a flat quad laid at 0.02 would sink into
      // it, so the span paints its own (`geometry/bridge.js`).
      if (axis === 'z' && (isRiverGap(k) || isSegmentClosed(line, k, 1))) continue;
      const from = along(k) + (axis === 'z' ? halfRoadX(k) : halfRoadZ(k));
      const to = along(k + 1) - (axis === 'z' ? halfRoadX(k + 1) : halfRoadZ(k + 1));

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
  };

  for (let i = 0; i <= GRID_I; i++) markRoad('z', i);
  for (let j = 0; j <= GRID_J; j++) markRoad('x', j);

  // --- Crosswalks.
  //
  // Only where there is a signal to stop traffic for the person crossing. That rules out the ring
  // junctions, which are yield-controlled and carry no lights, and it rules out crossing an
  // arterial — a main road doesn't get halted for a pedestrian. Painting them everywhere implied
  // a right of way the simulation never grants.
  const BARS = 4;
  const BAR_W = 0.72;
  const BAR_LEN = 1.5;
  const crossColor = color('crosswalk');

  for (let i = 0; i <= GRID_I; i++) {
    for (let j = 0; j <= GRID_J; j++) {
      if (isUnsignalised(i, j)) continue;

      const cx = lineX(i);
      const cz = lineZ(j);
      // Clear of the junction box on the axis it is laid off, which is the *crossing* road's
      // half-width — so a crossing beside a divided arterial is set back the extra 1.33 rather
      // than being painted inside the box.
      const offX = halfRoadZ(i) + BAR_LEN / 2 + 0.15;
      const offZ = halfRoadX(j) + BAR_LEN / 2 + 0.15;

      // A crossing laid west or east of the junction is walked *across* the road running along X;
      // one laid north or south is walked across the road running along Z.
      const acrossX = !isArterialX(j);
      const acrossZ = !isArterialZ(i);

      // No crossing onto a road that no longer exists — and none laid out over the river. A
      // crossing is painted `halfRoad + 0.9` clear of the junction centre, which on a riverside
      // street is 0.9 units past the kerb: over the parapet and out above the water. (The bar is
      // laid across the *crossing* road, so what rules it out is the gap it sits in, not the road
      // it belongs to.)
      const west = acrossX && i > 0 && !isSegmentClosed(i, j, 2);
      const east = acrossX && i < GRID_I && !isSegmentClosed(i, j, 0);
      const south = acrossZ && j > 0 && !isSegmentClosed(i, j, 3) && !isRiverGap(j - 1);
      const north = acrossZ && j < GRID_J && !isSegmentClosed(i, j, 1) && !isRiverGap(j);

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

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  for (const outline of outlines) mesh.add(asphaltFade(outline, SLAB_X, SLAB_Z, SLAB_RADIUS));
  return mesh;
}

export { KERB_H, SLAB_RADIUS, roundedRectShape };
