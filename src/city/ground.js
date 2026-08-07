import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { ROAD_W, HALF_ROAD, SPAN } from './grid.js';
import { insetPolygon, polygonBounds, rightNormal } from './curves.js';
import { cityNetwork } from './roadnet.js';

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
 * The same quad, laid along a heading rather than along an axis: `len` runs with travel and `wid`
 * across it. On the four grid headings this is exactly `paint` with its arguments swapped, which is
 * what the markings below used to do by hand.
 */
function paintAlong(len, wid, x, z, u, col, y = MARK_Y) {
  const geo = new THREE.PlaneGeometry(len, wid);
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(Math.atan2(-u.z, u.x));
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

/**
 * A block platform, from the polygon the road graph encloses.
 *
 * The fast path is not an optimisation. Every block on a grid-generated city is an axis-aligned
 * rectangle, and `box`/`paint` reproduce those to the last vertex — so taking it keeps the shipped
 * city byte-identical while the general path below handles the shapes an editor can draw and the
 * generator cannot.
 */
function axisAlignedRect(poly) {
  if (poly.length !== 4) return null;
  for (let n = 0; n < 4; n++) {
    const a = poly[n];
    const b = poly[(n + 1) % 4];
    if (Math.abs(a.x - b.x) > 1e-9 && Math.abs(a.z - b.z) > 1e-9) return null;
  }
  return polygonBounds(poly);
}

/** A Shape in the XY plane that becomes the given XZ polygon once laid flat. */
const shapeOf = (poly) => new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));

/**
 * `ExtrudeGeometry` comes back non-indexed and `mergeGeometries` requires every part to agree.
 * A sequential index converts it without welding, so the kerb keeps its hard edges.
 */
function ensureIndexed(geo) {
  if (geo.index) return geo;
  const n = geo.attributes.position.count;
  geo.setIndex(Array.from({ length: n }, (_, k) => k));
  return geo;
}

function platform(poly, kerbCol, surfaceCol, parts) {
  const rect = axisAlignedRect(poly);
  if (rect) {
    const w = rect.x1 - rect.x0;
    const d = rect.z1 - rect.z0;
    parts.push(box(w, KERB_H, d, rect.cx, 0, rect.cz, kerbCol));
    parts.push(paint(w - 0.3, d - 0.3, rect.cx, rect.cz, surfaceCol, KERB_H + 0.01));
    return;
  }

  const kerb = ensureIndexed(
    new THREE.ExtrudeGeometry(shapeOf(poly), { depth: KERB_H, bevelEnabled: false }),
  );
  kerb.rotateX(-Math.PI / 2);
  parts.push(bakeColor(kerb, kerbCol));

  // The same 0.15 inset the rectangle path gets by shrinking w and d by 0.3.
  const top = insetPolygon(poly, 0.15);
  if (!top) return;
  const surface = new THREE.ShapeGeometry(shapeOf(top));
  surface.rotateX(-Math.PI / 2);
  surface.translate(0, KERB_H + 0.01, 0);
  parts.push(bakeColor(surface, surfaceCol));
}

const SLAB = SPAN + ROAD_W * 3;

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

  // --- Block platforms: raised kerb + sidewalk surface, or grass for parks.
  //
  // One loop, where there used to be two. A park district was a hand-merged pair of cells drawn
  // ahead of the rest so its green read as one mass; now closing the road between them merges the
  // *face*, so a district simply is one block and needs no special case. `layout.js` keeps them at
  // the head of the array so the colour jitter draws in the same order it always did.
  for (const block of blocks) {
    const surface = block.type === 'park' ? PALETTE.park : PALETTE.sidewalk;
    platform(
      block.polygon,
      jitterColor(PALETTE.kerb, rng, { l: 0.02 }),
      jitterColor(surface, rng, { l: 0.03 }),
      parts,
    );
  }

  // --- Centre lines, one run per road.
  //
  // Walked per *edge* rather than per grid line, so a road gets its markings wherever it happens to
  // run. On the shipped city the two produce the same quads: an edge spans exactly one gap between
  // intersections, trimmed at each end by the junction it meets.
  const DASH = 1.6;
  const GAP = 1.4;
  const markColor = color('laneMark');
  const net = cityNetwork();

  for (const edge of net.edges) {
    const from = net.nodeById.get(edge.a).radius;
    const to = edge.length - net.nodeById.get(edge.b).radius;
    if (to <= from) continue;

    // A main street reads as one at a glance: solid double centre line rather than dashes.
    if (edge.klass === 'arterial') {
      const mid = edge.curve.at((from + to) / 2);
      const u = edge.curve.tangentAt((from + to) / 2);
      const n = rightNormal(u.x, u.z);
      for (const off of [-0.45, 0.45]) {
        // A straight road takes one quad, exactly as it always did. A bend cannot, so it is drawn
        // as a run of short ones that follow the curve.
        if (edge.curve.kind === 'line') {
          parts.push(paintAlong(to - from, 0.16, mid.x + n.x * off, mid.z + n.z * off, u, markColor));
          continue;
        }
        for (let s = from; s < to; s += DASH) {
          const len = Math.min(DASH, to - s);
          const p = edge.curve.at(s + len / 2);
          const t = edge.curve.tangentAt(s + len / 2);
          const m = rightNormal(t.x, t.z);
          parts.push(paintAlong(len, 0.16, p.x + m.x * off, p.z + m.z * off, t, markColor));
        }
      }
      continue;
    }

    for (let s = from + GAP; s + DASH < to; s += DASH + GAP) {
      const p = edge.curve.at(s + DASH / 2);
      parts.push(paintAlong(DASH, 0.18, p.x, p.z, edge.curve.tangentAt(s + DASH / 2), markColor));
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

  // One crossing per arm of a signalised junction. `node.signal` is the same test the stop bars
  // use, so a junction the network left unsignalised has neither — and an arm only exists where a
  // road does, which is what the map-edge and closed-segment guards here used to stand in for.
  for (const node of net.nodes) {
    if (!node.signal) continue;
    const offset = node.radius + BAR_LEN / 2 + 0.15;

    for (const arm of node.arms) {
      // A main road doesn't get halted for a pedestrian, so it carries no crossing.
      if (arm.edge.klass === 'arterial') continue;

      const u = { x: Math.cos(arm.bearing), z: Math.sin(arm.bearing) };
      const n = rightNormal(u.x, u.z);
      const cx = node.x + u.x * offset;
      const cz = node.z + u.z * offset;

      for (let b = 0; b < BARS; b++) {
        // Spread the bars across the road width, centred on the centreline.
        const t = (b - (BARS - 1) / 2) * (ROAD_W / (BARS + 0.6));
        parts.push(paintAlong(BAR_LEN, BAR_W, cx + n.x * t, cz + n.z * t, u, crossColor));
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
