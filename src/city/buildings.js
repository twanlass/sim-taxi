import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, BUILDING_COLORS, color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';

const FLOOR_H = 3;
const MIN_LOT = 4.2;

function box(w, h, d, x, base, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Horizontal window bands inset a hair from each face.
 *
 * This is the cheapest thing that gives a blocky mass a sense of scale: without floor lines a
 * 30-unit box could be a filing cabinet or a skyscraper, and the eye has no way to tell.
 */
function windowBands(w, h, d, x, base, z, windowColor) {
  const bands = [];
  const floors = Math.floor(h / FLOOR_H);
  const bandH = 1.5;
  const eps = 0.03;

  for (let f = 1; f < floors; f++) {
    const y = base + f * FLOOR_H;
    if (y + bandH > base + h - 0.6) break;

    const spanW = w * 0.84;
    const spanD = d * 0.84;

    for (const [pw, ph, rotY, px, pz] of [
      [spanW, bandH, 0, x, z + d / 2 + eps],
      [spanW, bandH, Math.PI, x, z - d / 2 - eps],
      [spanD, bandH, Math.PI / 2, x + w / 2 + eps, z],
      [spanD, bandH, -Math.PI / 2, x - w / 2 - eps, z],
    ]) {
      const plane = new THREE.PlaneGeometry(pw, ph);
      plane.rotateY(rotY);
      plane.translate(px, y + bandH / 2, pz);
      bands.push(bakeColor(plane, windowColor));
    }
  }

  return bands;
}

/** Recursive lot subdivision, so blocks read as several parcels rather than one monolith. */
function splitLot(x0, z0, x1, z1, depth, rng) {
  const w = x1 - x0;
  const d = z1 - z0;

  const canSplit = depth > 0 && Math.max(w, d) > MIN_LOT * 2;
  if (!canSplit || rng.chance(0.26)) return [{ x0, z0, x1, z1 }];

  const ratio = rng.range(0.4, 0.6);
  if (w >= d) {
    const xm = x0 + w * ratio;
    return [
      ...splitLot(x0, z0, xm, z1, depth - 1, rng),
      ...splitLot(xm, z0, x1, z1, depth - 1, rng),
    ];
  }
  const zm = z0 + d * ratio;
  return [
    ...splitLot(x0, z0, x1, zm, depth - 1, rng),
    ...splitLot(x0, zm, x1, z1, depth - 1, rng),
  ];
}

function buildTower(lot, centrality, rng, parts, inset = 0.85) {
  const x0 = lot.x0 + inset;
  const z0 = lot.z0 + inset;
  const x1 = lot.x1 - inset;
  const z1 = lot.z1 - inset;

  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 2 || d < 2) return;

  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;

  // Height is driven by how central the block is — this is what produces a downtown silhouette
  // instead of an evenly tall grid.
  // Capped far lower than the city sim's 43. Downtown towers there were tall enough to hide the
  // taxi behind them, and the player has to be able to see the car they're directing at all times.
  const ceiling = 5 + centrality * 11;
  let height = Math.max(5, rng.range(0.42, 1) * ceiling);

  const base = color(rng.pick(BUILDING_COLORS));
  const body = jitterColor(base, rng, { l: 0.05 });
  const windowColor = color('window');

  let y = KERB_H;
  let cw = w;
  let cd = d;
  let remaining = height;
  let tier = 0;

  // Stack up to three setback tiers, each smaller than the one below.
  while (remaining > 4 && tier < 3) {
    const tierH = tier === 0
      ? Math.min(remaining, remaining * rng.range(0.55, 0.8))
      : remaining;

    parts.push(box(cw, tierH, cd, cx, y, cz, tier === 0 ? body : jitterColor(body, rng, { l: 0.04 })));
    parts.push(...windowBands(cw, tierH, cd, cx, y, cz, windowColor));

    y += tierH;
    remaining -= tierH;
    tier += 1;

    if (remaining <= 4) break;
    const shrink = rng.range(0.62, 0.82);
    cw *= shrink;
    cd *= shrink;
  }

  // Roof clutter — a plant room and the occasional mast.
  const roofW = cw * rng.range(0.28, 0.5);
  const roofD = cd * rng.range(0.28, 0.5);
  parts.push(box(roofW, rng.range(0.6, 1.6), roofD,
    cx + rng.jitter(cw * 0.15), y, cz + rng.jitter(cd * 0.15), color('rooftop')));

  if (height > 22 && rng.chance(0.45)) {
    const mast = new THREE.CylinderGeometry(0.12, 0.16, rng.range(2.5, 6), 5);
    mast.translate(cx, y + 3.5, cz);
    parts.push(bakeColor(mast, color('pole')));
  }
}

/**
 * The largest axis-aligned rectangle that fits inside a convex polygon, found by scanning
 * candidate spans on a coarse grid. Crude, and it only has to be good enough for one building:
 * the avenue's slivers are right triangles with ~6.3-unit legs, where the honest answer is a
 * single small tower tucked into the right angle.
 *
 * The exact-rectangle problem is not worth solving here — a 16×16 scan lands within a few percent
 * of optimal on a triangle and costs nothing at load time.
 */
function largestRect(poly) {
  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);

  const inside = (x, z) => {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      // Consistent winding is not guaranteed, so require the point on one side of every edge by
      // testing against the polygon centroid's side instead.
      const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
      if (k === 0) inside.sign = Math.sign(cross);
      else if (cross !== 0 && Math.sign(cross) !== inside.sign) return false;
    }
    return true;
  };

  const N = 16;
  let best = null;
  let bestArea = 0;
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b <= N; b++) {
      const rx0 = x0 + ((x1 - x0) * a) / N;
      const rx1 = x0 + ((x1 - x0) * b) / N;
      for (let c = 0; c < N; c++) {
        for (let d = c + 1; d <= N; d++) {
          const rz0 = z0 + ((z1 - z0) * c) / N;
          const rz1 = z0 + ((z1 - z0) * d) / N;
          const area = (rx1 - rx0) * (rz1 - rz0);
          if (area <= bestArea) continue;
          if (!inside(rx0, rz0) || !inside(rx1, rz0)
            || !inside(rx1, rz1) || !inside(rx0, rz1)) continue;
          bestArea = area;
          best = { x0: rx0, z0: rz0, x1: rx1, z1: rz1 };
        }
      }
    }
  }
  return best;
}

const isRectangle = (poly) => poly.length === 4
  && Math.abs(poly[0].z - poly[1].z) < 1e-6 && Math.abs(poly[1].x - poly[2].x) < 1e-6;

export function createBuildings(rng, blocks) {
  const parts = [];

  for (const block of blocks) {
    if (block.type !== 'built') continue;

    for (const poly of block.polys) {
      if (isRectangle(poly)) {
        const x0 = Math.min(poly[0].x, poly[2].x);
        const x1 = Math.max(poly[0].x, poly[2].x);
        const z0 = Math.min(poly[0].z, poly[2].z);
        const z1 = Math.max(poly[0].z, poly[2].z);
        for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) {
          buildTower(lot, block.centrality, rng, parts);
        }
        continue;
      }

      // A flatiron sliver off the avenue. One tower, on the largest rectangle that fits, with a
      // tighter kerb inset than a full block gets — at the standard 0.85 the tower that survives
      // is under the 2-unit floor `buildTower` refuses to build below, and the sliver comes out
      // as bare sidewalk.
      const lot = largestRect(poly);
      if (lot) buildTower(lot, block.centrality, rng, parts, 0.45);
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  return { mesh, count: parts.length };
}
