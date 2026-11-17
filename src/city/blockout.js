// The warped city's blockout: block platforms and plain massing laid off the road network's own
// faces, with no grid rectangle anywhere.
//
// Tyler (2026-11-17): "just block it out (don't worry about real buildings but focus on the street
// so we can test gameplay etc)". The ground, building and landmark generators all lay their work on
// grid rectangles (`blockBounds`), which on the warped city (city/warp.js) are not where the blocks
// are. So this reads the blocks the network derived — the faces of the street graph — samples their
// curved sides, pulls each in to its kerb, and stands simple extruded pieces on what is left.
//
// What a block becomes:
//   * `water`  — nothing (the river is city/river.js's);
//   * the market square — paved in plaza stone, with one civic mass on its up-screen side;
//   * a park — a kerb and a lawn;
//   * anything else — a kerb, a pavement and the block cut into strips of plain massing, taller
//     toward the middle of the map.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { signedArea2, polygonBounds } from './curves.js';
import { cityNetwork } from './roadnet.js';
import { junctionAt, isRiverGap, MAX_SPAN } from './grid.js';

/** Spacing of the points laid down a curved block side. */
const SAMPLE = 1;
/** How far the massing stands back from the kerb: the pavement a pedestrian would walk on. */
const SETBACK = 1.6;
/** A strip of massing is about this wide along the block's long side... */
const STRIP = 8.5;
/** ...and a block deeper than this is split into a front row and a back row. */
const DEEP = 15;
/** The lowest and tallest a piece of massing stands. */
const MIN_H = 2.4;
const MAX_H = 9.5;
/** Pieces smaller than this (in plan) are left as pavement. */
const MIN_PIECE = 5;
/** The largest block (kerb area) that can be a park. A warped grid cell is 100 to 250. */
const PARK_MAX = 300;

const key = (x, z) => `${x.toFixed(4)},${z.toFixed(4)}`;

/**
 * Every block the network encloses. `face` is the ring of road centrelines round it, following the
 * curved sides; `ring(extra)` is that ring pulled in to `halfWidth + extra` off each street, so
 * `ring(0)` is the kerb line and `ring(SETBACK)` the building line.
 */
export function blockoutFaces(net = cityNetwork()) {
  const nodeAt = new Map(net.nodes.map((n) => [key(n.x, n.z), n]));
  const out = [];
  for (const block of net.blocks) {
    const sides = [];
    const face = [];
    let ok = true;
    for (let k = 0; k < block.face.length; k++) {
      const p = block.face[k];
      const q = block.face[(k + 1) % block.face.length];
      const u = nodeAt.get(key(p.x, p.z));
      const v = nodeAt.get(key(q.x, q.z));
      const arm = u?.arms.find((a) => a.toward === v);
      if (!arm) { ok = false; break; }
      const side = { edge: arm.edge, forward: arm.edge.a === u.id };
      sides.push(side);
      face.push(...sample(side, 0, 0).slice(0, -1));
    }
    if (!ok || sides.length < 3) continue;
    const sense = signedArea2(face) > 0 ? 1 : -1;
    const ring = (extra) => insetSides(sides, sense, extra);
    const kerb = ring(0);
    // Down to a kerbed island: the triangle an avenue leaves at a corner is small, and left out it
    // read as a hole in the city rather than as a wide junction.
    if (!kerb || Math.abs(signedArea2(kerb)) / 2 < 1) continue;
    out.push({ block, face, kerb, ring, area: Math.abs(signedArea2(kerb)) / 2 });
  }
  return out;
}

/** Points down one side of a face, in the face's direction, `inward` units to the side `sense` names. */
function sample(side, sense, inward) {
  const { edge, forward } = side;
  const length = edge.curve.length;
  const n = edge.curve.kind === 'line' ? 1 : Math.max(2, Math.ceil(length / SAMPLE));
  const pts = [];
  for (let s = 0; s <= n; s++) {
    const at = forward ? (length * s) / n : length * (1 - s / n);
    const p = edge.curve.at(at);
    const t = edge.curve.tangentAt(at);
    const tx = forward ? t.x : -t.x;
    const tz = forward ? t.z : -t.z;
    // (-tz, tx) is `rightNormal`, which points into a counter-clockwise ring.
    pts.push({ x: p.x - tz * inward * sense, z: p.z + tx * inward * sense });
  }
  return pts;
}

function segHit(a, b, c, d) {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a.x + rx * t, z: a.z + rz * t };
}

/**
 * The face's sides, each offset inward by its own street's half-width plus `extra`, and each pair
 * of neighbours trimmed where they cross. Where they do not cross (a reflex corner, the stem side
 * of a T) the two ends are simply joined. Null if what is left has folded through itself.
 */
function insetSides(sides, sense, extra) {
  const lines = sides.map((side) => sample(side, sense, side.edge.halfWidth + extra));
  const n = lines.length;
  // cut[k] = { end: index/param where line k stops, start: where line k+1 begins }
  const starts = new Array(n).fill(null);
  const ends = new Array(n).fill(null);
  for (let k = 0; k < n; k++) {
    const A = lines[k];
    const B = lines[(k + 1) % n];
    let found = null;
    // Search A from its end backwards and B from its start forwards; the crossing is near the node.
    for (let i = A.length - 2; i >= 0 && !found; i--) {
      for (let j = 0; j < B.length - 1 && !found; j++) {
        const h = segHit(A[i], A[i + 1], B[j], B[j + 1]);
        if (h) found = { i, j, p: { x: h.x, z: h.z } };
      }
    }
    ends[k] = found ? { i: found.i, p: found.p } : { i: A.length - 1, p: A[A.length - 1] };
    starts[(k + 1) % n] = found ? { j: found.j, p: found.p } : { j: 0, p: B[0] };
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const L = lines[k];
    const st = starts[k];
    const en = ends[k];
    // A side squeezed out entirely by its neighbours (its two cut points cross over) is dropped.
    if (st.j > en.i) continue;
    out.push(st.p);
    for (let i = st.j + 1; i <= en.i; i++) out.push(L[i]);
    out.push(en.p);
  }
  const clean = out.filter((p, k) => {
    const q = out[(k + 1) % out.length];
    return Math.hypot(q.x - p.x, q.z - p.z) > 1e-4;
  });
  if (clean.length < 3) return null;
  const area = signedArea2(clean);
  if (Math.sign(area) !== sense || Math.abs(area) < 1) return null;
  return clean;
}

const shapeOf = (poly) => new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));

function slab(poly, y0, h, col) {
  const geo = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0, 0);
  return bakeColor(geo, col);
}

function flat(poly, y, col) {
  const geo = new THREE.ShapeGeometry(shapeOf(poly), 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, col);
}

/** Which kind of block a face is: 'water', 'plaza', 'park' or 'built'. */
function kindOf(face, layout) {
  if (face.block.type === 'water') return 'water';
  const warp = layout.warp;
  const inside = (x, z) => pointInRing(x, z, face.kerb);
  if (warp) {
    const { bi, bj } = warp.square;
    const c = cellCentre(bi, bj);
    if (inside(c.x, c.z)) return 'plaza';
  }
  // A park is one cell's worth of green; a face an avenue merged out of several is built on even
  // if a park cell landed inside it.
  if (face.area > PARK_MAX) return 'built';
  for (const block of layout) {
    if (block.type !== 'park') continue;
    const c = cellCentre(block.bi, block.bj);
    if (inside(c.x, c.z)) return 'park';
  }
  return 'built';
}

/** The middle of grid cell (bi, bj) as the warp left it: the mean of its four junctions. */
function cellCentre(bi, bj) {
  const pts = [junctionAt(bi, bj), junctionAt(bi + 1, bj), junctionAt(bi, bj + 1), junctionAt(bi + 1, bj + 1)];
  return { x: pts.reduce((s, p) => s + p.x, 0) / 4, z: pts.reduce((s, p) => s + p.z, 0) / 4 };
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
    const a = ring[k];
    const b = ring[m];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The block platforms and the street paint, as geometry parts for `createGround` to merge with its
 * slab. Kerb, then pavement (or lawn, or plaza stone) on top, then a centre line down every street.
 */
export function blockoutGround(rng, layout, { kerbH, markY, paveInset }) {
  const parts = [];
  for (const face of blockoutFaces()) {
    const kind = kindOf(face, layout);
    if (kind === 'water') continue;
    parts.push(slab(face.kerb, 0, kerbH, jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    const top = face.ring(paveInset) ?? face.kerb;
    const surface = kind === 'park' ? PALETTE.park : kind === 'plaza' ? PALETTE.plazaStone : PALETTE.sidewalk;
    parts.push(flat(top, kerbH + 0.01, jitterColor(surface, rng, { l: 0.03 })));
  }

  // Centre lines: dashed down a side street, a solid double line down an arterial, none on a bridge
  // (its deck carries its own) and none inside a junction box.
  const markColor = color('laneMark');
  const DASH = 1.6;
  const GAP = 1.4;
  const net = cityNetwork();
  for (const edge of net.edges) {
    const a = net.nodeById.get(edge.a);
    const b = net.nodeById.get(edge.b);
    if (a.gj !== undefined && a.gi === b.gi && Math.abs(a.gj - b.gj) === 1 && isRiverGap(Math.min(a.gj, b.gj))) continue;
    const armA = a.arms.find((arm) => arm.edge === edge);
    const armB = b.arms.find((arm) => arm.edge === edge);
    const s0 = (armA?.radius ?? 4.5) + 0.6;
    const s1 = edge.curve.length - (armB?.radius ?? 4.5) - 0.6;
    if (s1 - s0 < DASH) continue;
    const dash = (s, len, off) => {
      const p = edge.curve.at(s + len / 2);
      const t = edge.curve.tangentAt(s + len / 2);
      const geo = new THREE.PlaneGeometry(0.16, len);
      geo.rotateX(-Math.PI / 2);
      geo.rotateY(Math.atan2(t.x, t.z));
      geo.translate(p.x - t.z * off, markY, p.z + t.x * off);
      parts.push(bakeColor(geo, markColor));
    };
    if (edge.klass === 'arterial') {
      for (let s = s0; s < s1 - 1e-6; s += 2) {
        const len = Math.min(2, s1 - s);
        dash(s, len, -0.35);
        dash(s, len, 0.35);
      }
    } else {
      for (let s = s0; s + DASH <= s1; s += DASH + GAP) dash(s, DASH, 0);
    }
  }
  return parts;
}

/**
 * Cuts a polygon by the half-plane `dot(p - o, n) >= 0` (Sutherland–Hodgman, one plane).
 * Works on a concave polygon too, at the cost of a zero-width bridge where it splits in two — fine
 * for massing, which only ever extrudes the result.
 */
function clip(poly, o, n) {
  const out = [];
  const side = (p) => (p.x - o.x) * n.x + (p.z - o.z) * n.z;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const da = side(a);
    const db = side(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/**
 * The massing: each built block cut into strips along its longest side and, if it is deep, into a
 * front and a back row, every piece its own height. Returns the mesh and the pieces (for the
 * helipad and the entrance wave's dust).
 */
export function blockoutMasses(rng, layout, { kerbH }) {
  const parts = [];
  const pieces = [];
  for (const face of blockoutFaces()) {
    const kind = kindOf(face, layout);
    if (kind === 'water' || kind === 'park') continue;
    const footprint = face.ring(SETBACK);
    if (!footprint) continue;

    if (kind === 'plaza') {
      // The civic building on the square's up-screen side (−X −Z is up-screen), so it stands behind
      // the open plaza rather than in front of it.
      const b = polygonBounds(footprint);
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.z0 + b.z1) / 2;
      const hall = clip(clip(footprint, { x: cx - (b.x1 - b.x0) * 0.1, z: 0 }, { x: -1, z: 0 }),
        { x: 0, z: cz - (b.z1 - b.z0) * 0.1 }, { x: 0, z: -1 });
      if (hall.length >= 3 && Math.abs(signedArea2(hall)) / 2 > MIN_PIECE) {
        pieces.push({ poly: hall, h: 8.5, col: jitterColor(PALETTE.blockoutHall, rng, { l: 0.02 }) });
      }
      continue;
    }

    // The block's long axis: the direction of its longest kerb side.
    let best = 0;
    let axis = { x: 1, z: 0 };
    for (let k = 0; k < footprint.length; k++) {
      const a = footprint[k];
      const b = footprint[(k + 1) % footprint.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len > best) { best = len; axis = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }; }
    }
    const across = { x: -axis.z, z: axis.x };
    const proj = (p, d) => p.x * d.x + p.z * d.z;
    const along = footprint.map((p) => proj(p, axis));
    const deep = footprint.map((p) => proj(p, across));
    const a0 = Math.min(...along);
    const a1 = Math.max(...along);
    const d0 = Math.min(...deep);
    const d1 = Math.max(...deep);
    const strips = Math.max(1, Math.round((a1 - a0) / STRIP));
    const rows = d1 - d0 > DEEP ? 2 : 1;

    const centre = polygonBounds(footprint);
    const off = Math.hypot((centre.x0 + centre.x1) / 2, (centre.z0 + centre.z1) / 2) / (MAX_SPAN / 2);
    const tall = Math.max(0, 1 - off);   // 1 in the middle of the map, 0 at the edge

    for (let s = 0; s < strips; s++) {
      for (let r = 0; r < rows; r++) {
        let poly = footprint;
        const lo = a0 + ((a1 - a0) * s) / strips;
        const hi = a0 + ((a1 - a0) * (s + 1)) / strips;
        const dlo = d0 + ((d1 - d0) * r) / rows;
        const dhi = d0 + ((d1 - d0) * (r + 1)) / rows;
        // A sliver of gap between pieces so neighbouring heights read as separate buildings.
        poly = clip(poly, { x: axis.x * (lo + 0.15), z: axis.z * (lo + 0.15) }, axis);
        poly = clip(poly, { x: axis.x * (hi - 0.15), z: axis.z * (hi - 0.15) }, { x: -axis.x, z: -axis.z });
        poly = clip(poly, { x: across.x * (dlo + 0.15), z: across.z * (dlo + 0.15) }, across);
        poly = clip(poly, { x: across.x * (dhi - 0.15), z: across.z * (dhi - 0.15) }, { x: -across.x, z: -across.z });
        if (poly.length < 3 || Math.abs(signedArea2(poly)) / 2 < MIN_PIECE) continue;
        const h = MIN_H + (MAX_H - MIN_H) * (0.25 * rng.next() + 0.75 * tall * rng.next());
        const tone = rng.chance(0.5) ? PALETTE.blockoutA : PALETTE.blockoutB;
        pieces.push({ poly, h, col: jitterColor(tone, rng, { l: 0.04 }) });
      }
    }
  }

  const base = kerbH + 0.01;
  const entrySites = [];
  for (const piece of pieces) {
    const b = polygonBounds(piece.poly);
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const geo = slab(piece.poly, base, piece.h, piece.col);
    stampEntry(geo, cx, cz, hash01(cx, cz));
    parts.push(geo);
    entrySites.push({ x: cx, z: cz, r: Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2, rand: hash01(cx, cz) });
    Object.assign(piece, { cx, cz, top: base + piece.h, w: b.x1 - b.x0, d: b.z1 - b.z0 });
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'blockout';
  return { mesh, pieces, entrySites };
}

/**
 * The kerb corner of junction (i, j) in the quadrant `(sx, sz)` points into, `extra` past the kerb —
 * the warped city's answer to `cornerFor`'s grid arithmetic (game/fares.js), which puts the corner
 * at `lineX(i) ± halfRoad` and so, on a junction the warp has moved and turned, in the road.
 *
 * The two streets either side of that direction each have a kerb line `halfWidth` off their
 * centre; the corner is where those two lines cross. Where the two streets are nearly in line (the
 * flat side of a T) there is no corner to speak of, and the pin goes on the kerb straight out from
 * the junction instead.
 */
export function warpedCorner(i, j, sx, sz, extra = 0.5) {
  const node = cityNetwork()?.nodeByGrid(i, j);
  if (!node || node.arms.length === 0) return null;
  const want = Math.atan2(sz, sx);
  const arms = node.arms;
  const TAU = Math.PI * 2;
  const ccw = (from, to) => ((to - from) % TAU + TAU) % TAU;
  let k = 0;
  if (arms.length > 1) {
    for (let m = 0; m < arms.length; m++) {
      const a = arms[m];
      const b = arms[(m + 1) % arms.length];
      if (ccw(a.bearing, want) <= ccw(a.bearing, b.bearing)) { k = m; break; }
    }
  }
  const a1 = arms[k];
  const a2 = arms[(k + 1) % arms.length];
  const h1 = a1.edge.halfWidth + extra;
  const h2 = a2.edge.halfWidth + extra;
  const gap = arms.length > 1 ? ccw(a1.bearing, a2.bearing) || TAU : TAU;
  if (gap > (160 * Math.PI) / 180) {
    const mid = a1.bearing + Math.min(gap / 2, Math.PI / 2);
    return { x: node.x + Math.cos(mid) * h1, z: node.z + Math.sin(mid) * h1 };
  }
  const u1 = { x: Math.cos(a1.bearing), z: Math.sin(a1.bearing) };
  const u2 = { x: Math.cos(a2.bearing), z: Math.sin(a2.bearing) };
  const n1 = { x: -u1.z, z: u1.x };   // off arm 1, toward arm 2
  const n2 = { x: u2.z, z: -u2.x };   // off arm 2, toward arm 1
  const det = n1.x * n2.z - n1.z * n2.x;
  const px = (h1 * n2.z - h2 * n1.z) / det;
  const pz = (n1.x * h2 - n2.x * h1) / det;
  return { x: node.x + px, z: node.z + pz };
}
