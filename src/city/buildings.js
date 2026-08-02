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

function buildTower(lot, centrality, rng, parts) {
  const inset = 0.85;
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

export function createBuildings(rng, blocks) {
  const parts = [];

  for (const block of blocks) {
    if (block.type !== 'built') continue;
    const { x0, z0, x1, z1 } = block.bounds;

    for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) {
      buildTower(lot, block.centrality, rng, parts);
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
