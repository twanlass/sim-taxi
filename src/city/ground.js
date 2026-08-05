import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  GRID, PITCH, ROAD_W, HALF_ROAD, SPAN, HALF_SPAN, lineCoord,
  isUnsignalised, isSegmentClosed, ROUNDABOUT_ISLAND_R,
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

/** Shrink a convex polygon by `d` on every edge, by offsetting each edge inward and re-crossing. */
function insetPolygon(poly, d) {
  // Winding sign, so "inward" is the same side for a rectangle and for a clipped sliver.
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  const wind = area >= 0 ? 1 : -1;

  const lines = poly.map((a, k) => {
    const b = poly[(k + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = (wind * (b.z - a.z)) / len;      // inward normal
    const nz = (-wind * (b.x - a.x)) / len;
    return { px: a.x - nx * d, pz: a.z - nz * d, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
  });

  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const p = lines[(k - 1 + lines.length) % lines.length];
    const q = lines[k];
    const denom = p.dx * q.dz - p.dz * q.dx;
    if (Math.abs(denom) < 1e-6) return poly;   // degenerate; better un-inset than inside out
    const t = ((q.px - p.px) * q.dz - (q.pz - p.pz) * q.dx) / denom;
    out.push({ x: p.px + p.dx * t, z: p.pz + p.dz * t });
  }
  return out;
}

// A Shape lives in XY and is laid flat with rotateX(-90°), which maps shape-Y to world −Z and
// shape-Z (the extrusion) to world +Y. So the polygon goes in with its z negated — otherwise the
// block comes out mirrored about the road — and the extrusion then rises out of the ground
// instead of being buried under it. Getting the sign wrong here costs every kerb and every
// sidewalk in the city, silently, because the faces end up pointing down and are culled.
const toShape = (poly) => {
  const shape = new THREE.Shape();
  shape.moveTo(poly[0].x, -poly[0].z);
  for (let k = 1; k < poly.length; k++) shape.lineTo(poly[k].x, -poly[k].z);
  shape.closePath();
  return shape;
};

/**
 * A block platform of any shape: kerb wall plus the surface laid on top of it.
 *
 * Blocks used to be boxes, because every block was a rectangle. The avenue cuts three of them
 * into flatiron slivers, and a triangle is not a box — so both halves are built from the block's
 * polygon instead, which leaves the rectangular case pixel-identical (an extruded rectangle is
 * the box it replaced) while the slivers come out with the same kerb and the same sidewalk.
 */
function platform(poly, height, surfaceColor, kerbColor) {
  const parts = [];
  const wall = new THREE.ExtrudeGeometry(toShape(poly), { depth: height, bevelEnabled: false });
  wall.rotateX(-Math.PI / 2);
  parts.push(bakeColor(wall, kerbColor));

  const top = new THREE.ShapeGeometry(toShape(insetPolygon(poly, 0.15)));
  top.rotateX(-Math.PI / 2);
  top.translate(0, height + 0.01, 0);
  parts.push(bakeColor(top, surfaceColor));
  return parts;
}

// Rounded corners, so the city reads as an island rather than a sheet cut out with scissors.
//
// The ceiling is ~27: any larger and the arc eats into the corner where the two outermost roads
// meet, leaving the ring road hanging over nothing. 22 is clearly round with room to spare.
const SLAB_RADIUS = 22;

/** A square with rounded corners, lying flat on the ground plane. */
function roundedSlab(size, radius) {
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

  const geo = new THREE.ShapeGeometry(shape, 14);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * Roads, kerbs, sidewalks and paint. All of it merges into a single static mesh — the geometry
 * never changes at runtime, so there's no reason for it to cost more than one draw call.
 */
export function createGround(rng, blocks) {
  const parts = [];

  // Asphalt slab under everything. Kept tight to the outer roads — a wide apron reads as a
  // grey void around the city once there's no fog to hide where it ends.
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
  //
  // Driven off `block.polys` rather than `block.bounds`, so the three blocks the avenue cuts come
  // out as the two slivers they actually are. Everywhere else that array holds the one rectangle
  // the block has always been.
  for (const block of blocks) {
    if (block.districtId !== null && block.districtId !== undefined) continue;
    const surface = block.type === 'park' ? PALETTE.park : PALETTE.sidewalk;
    for (const poly of block.polys) {
      parts.push(...platform(poly, KERB_H,
        jitterColor(surface, rng, { l: 0.03 }), jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    }
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

  // --- The avenue's centre line.
  //
  // The road surface itself needs nothing built: the slab under the whole city is already asphalt,
  // so cutting the block platforms out of its path *is* the road. What it does need is paint —
  // without a centre line the gap between the slivers reads as a plaza rather than a street.
  //
  // Drawn as a solid double line, the same mark an arterial wears. That is not decoration: the
  // avenue is the fastest way across town for any trip running its way, and the double line is the
  // established "this is a main road" tell the player has already learned from the arterials.
  if (blocks.avenue) {
    const av = blocks.avenue;
    // One run per segment, stopping clear of each junction box — the same way the grid's dashes
    // run kerb to kerb rather than straight through the intersections they cross. Drawn as one
    // long stripe end to end it painted a double line over every junction it met, which read as
    // the avenue having right of way it does not actually have.
    const HALF_BOX = HALF_ROAD * Math.SQRT2;   // the junction box, measured along the diagonal
    for (let k = 0; k < av.junctions.length - 1; k++) {
      const a = av.junctions[k];
      const b = av.junctions[k + 1];
      const ax = lineCoord(a.i);
      const az = lineCoord(a.j);
      const span = Math.hypot(lineCoord(b.i) - ax, lineCoord(b.j) - az);
      const ux = (lineCoord(b.i) - ax) / span;
      const uz = (lineCoord(b.j) - az) / span;
      const angle = Math.atan2(uz, ux);
      const len = span - HALF_BOX * 2;
      const mx = ax + ux * (span / 2);
      const mz = az + uz * (span / 2);

      for (const off of [-0.45, 0.45]) {
        const stripe = new THREE.PlaneGeometry(len, 0.16);
        stripe.rotateX(-Math.PI / 2);
        stripe.rotateY(-angle);
        // Offset perpendicular to the run, which is the travel vector turned a quarter turn.
        stripe.translate(mx - uz * off, MARK_Y, mz + ux * off);
        parts.push(bakeColor(stripe, markColor));
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

  // --- Roundabout island.
  //
  // A kerbed grass disc in the middle of the junction, in the same kerb-plus-green construction
  // as every block platform so it reads as city furniture rather than an effect. The thin painted
  // ring outside the kerb marks the circulating lane's inner edge — without it the island floats
  // on blank asphalt and the junction reads as broken rather than as a roundabout.
  if (blocks.roundabout) {
    const cx = lineCoord(blocks.roundabout.i);
    const cz = lineCoord(blocks.roundabout.j);

    const kerb = new THREE.CylinderGeometry(ROUNDABOUT_ISLAND_R, ROUNDABOUT_ISLAND_R, KERB_H, 20);
    kerb.translate(cx, KERB_H / 2, cz);
    parts.push(bakeColor(kerb, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));

    const grass = new THREE.CircleGeometry(ROUNDABOUT_ISLAND_R - 0.12, 20);
    grass.rotateX(-Math.PI / 2);
    grass.translate(cx, KERB_H + 0.01, cz);
    parts.push(bakeColor(grass, jitterColor(PALETTE.park, rng, { l: 0.03 })));

    const ring = new THREE.RingGeometry(ROUNDABOUT_ISLAND_R + 0.18, ROUNDABOUT_ISLAND_R + 0.36, 28);
    ring.rotateX(-Math.PI / 2);
    ring.translate(cx, MARK_Y, cz);
    parts.push(bakeColor(ring, color('laneMark')));
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

export { KERB_H };
