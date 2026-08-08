import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID, ROAD_W, HALF_ROAD, lineCoord, slabOutline,
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

/**
 * The asphalt cap: a triangle fan over the slab outline, lying flat at y = 0.
 *
 * A fan rather than `ShapeGeometry` because the island underneath it has to start from the exact
 * same boundary vertices — see `slabOutline`. The footprint is convex, so a fan triangulates it
 * without the earcut pass buying anything.
 */
function slabCap() {
  const outline = slabOutline();
  const n = outline.length;
  const positions = new Float32Array(n * 9);

  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    // (centre, next, current): the outline winds the other way for an up-facing triangle.
    positions.set([0, 0, 0, b.x, 0, b.z, a.x, 0, a.z], i * 9);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geo;
}

/**
 * Roads, kerbs, sidewalks and paint. All of it merges into a single static mesh — the geometry
 * never changes at runtime, so there's no reason for it to cost more than one draw call.
 */
export function createGround(rng, blocks) {
  const parts = [];

  // Asphalt slab under everything. Its footprint and depth are the island's too — the rock hangs
  // off exactly this outline; see city/island.js.
  parts.push(bakeColor(slabCap(), color('asphalt')));

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
  return mesh;
}

export { KERB_H };
