import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID, PITCH, ROAD_W, HALF_ROAD, SPAN, HALF_SPAN, lineCoord,
  isUnsignalised, isSegmentClosed,
} from './grid.js';

const KERB_H = 0.35;
const MARK_Y = 0.02;

function box(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  return bakeColor(geo, col);
}

/** Flat quad lying on the road surface — cheaper than a box for paint markings. */
function paint(w, d, x, z, col, y = MARK_Y) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
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

  // Asphalt slab under everything. Kept tight to the outer roads — a wide apron reads as a
  // grey void around the city once there's no fog to hide where it ends. The edge itself is
  // feathered rather than cut: see `asphaltFade`.
  parts.push(bakeColor(roundedSlab(SLAB, SLAB_RADIUS), color('asphalt')));

  // --- Park districts first: a single platform spanning both blocks and the road that used to
  // run between them, so the green reads as one continuous mass.
  for (const district of blocks.districts ?? []) {
    const { x0, x1, z0, z1, cx, cz } = district.bounds;
    const w = x1 - x0;
    const d = z1 - z0;
    parts.push(box(w, KERB_H, d, cx, 0, cz, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    parts.push(paint(w - 0.3, d - 0.3, cx, cz, jitterColor(PALETTE.park, rng, { l: 0.03 }), KERB_H + 0.01));
  }

  // --- Block platforms: raised kerb + sidewalk surface, or grass for parks.
  for (const block of blocks) {
    if (block.districtId !== null && block.districtId !== undefined) continue;
    const { x0, z0, cx, cz } = block.bounds;
    const w = block.bounds.x1 - x0;
    const d = block.bounds.z1 - z0;

    parts.push(box(w, KERB_H, d, cx, 0, cz, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));

    const surface = block.type === 'park' ? PALETTE.park : PALETTE.sidewalk;
    parts.push(paint(w - 0.3, d - 0.3, cx, cz, jitterColor(surface, rng, { l: 0.03 }), KERB_H + 0.01));
  }

  // --- Dashed centre lines, one run per gap between intersections.
  const DASH = 1.6;
  const GAP = 1.4;
  const markColor = color('laneMark');
  const arterialX = blocks.arterials?.x ?? new Set();
  const arterialZ = blocks.arterials?.z ?? new Set();

  // A main street reads as one at a glance: solid double centre line rather than dashes.
  const doubleLine = (axis, c, from, to) => {
    for (const off of [-0.45, 0.45]) {
      if (axis === 'x') parts.push(paint(to - from, 0.16, (from + to) / 2, c + off, markColor));
      else parts.push(paint(0.16, to - from, c + off, (from + to) / 2, markColor));
    }
  };

  for (let i = 0; i <= GRID; i++) {
    const c = lineCoord(i);

    for (let j = 0; j < GRID; j++) {
      const from = lineCoord(j) + HALF_ROAD;
      const to = lineCoord(j + 1) - HALF_ROAD;

      // Index i names two roads: the one running along Z at x = c, and the one running along X
      // at z = c. Each is independently an arterial or not.
      if (arterialZ.has(i)) doubleLine('z', c, from, to);
      if (arterialX.has(i)) doubleLine('x', c, from, to);

      for (let s = from + GAP; s + DASH < to; s += DASH + GAP) {
        if (!arterialZ.has(i)) parts.push(paint(0.18, DASH, c, s + DASH / 2, markColor));
        if (!arterialX.has(i)) parts.push(paint(DASH, 0.18, s + DASH / 2, c, markColor));
      }
    }
  }

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

  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (isUnsignalised(i, j)) continue;

      const cx = lineCoord(i);
      const cz = lineCoord(j);
      const offset = HALF_ROAD + BAR_LEN / 2 + 0.15;

      // A crossing laid west or east of the junction is walked *across* the road running along X;
      // one laid north or south is walked across the road running along Z.
      const acrossX = !arterialX.has(j);
      const acrossZ = !arterialZ.has(i);

      // No crossing onto a road that no longer exists.
      const west = acrossX && i > 0 && !isSegmentClosed(i, j, 2);
      const east = acrossX && i < GRID && !isSegmentClosed(i, j, 0);
      const south = acrossZ && j > 0 && !isSegmentClosed(i, j, 3);
      const north = acrossZ && j < GRID && !isSegmentClosed(i, j, 1);

      for (let b = 0; b < BARS; b++) {
        // Spread the bars across the road width, centred on the centreline.
        const t = (b - (BARS - 1) / 2) * (ROAD_W / (BARS + 0.6));

        if (west) parts.push(paint(BAR_LEN, BAR_W, cx - offset, cz + t, crossColor));
        if (east) parts.push(paint(BAR_LEN, BAR_W, cx + offset, cz + t, crossColor));
        if (south) parts.push(paint(BAR_W, BAR_LEN, cx + t, cz - offset, crossColor));
        if (north) parts.push(paint(BAR_W, BAR_LEN, cx + t, cz + offset, crossColor));
      }
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  mesh.add(asphaltFade(SLAB, SLAB_RADIUS));
  return mesh;
}

export { KERB_H, SLAB, SLAB_RADIUS, EDGE_FADE };
