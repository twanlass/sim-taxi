import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, jitterVertices, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';

/** Park tree — same construction as the terrain prototype's broadleaf, scaled for a city block. */
function tree(x, z, rng) {
  const parts = [];
  const height = rng.range(3.4, 5.6);
  const trunkH = height * 0.42;

  const trunk = new THREE.CylinderGeometry(height * 0.035, height * 0.055, trunkH, 6);
  trunk.translate(x, KERB_H + trunkH / 2, z);
  parts.push(bakeColor(trunk, jitterColor(PALETTE.trunk, rng, { l: 0.05 })));

  // Canopy: a main blob plus a couple of smaller ones pushed into it. Overlapping solids read as
  // a fuller crown than a single sphere and hide the seams where they meet.
  const r = height * 0.32;
  const base = KERB_H + trunkH + r * 0.75;

  const blob = (radius, ox, oy, oz, detail) => {
    const geo = new THREE.IcosahedronGeometry(radius, detail);
    jitterVertices(geo, rng, radius * 0.1);
    geo.scale(1.05, 0.9, 1.05);
    geo.translate(x + ox, base + oy, z + oz);
    parts.push(bakeColor(geo, jitterColor(PALETTE.foliage, rng, { h: 0.02, l: 0.07 })));
  };

  blob(r, 0, 0, 0, 1);
  const lobes = rng.int(1, 2);
  for (let n = 0; n < lobes; n++) {
    const angle = rng.range(0, Math.PI * 2);
    const reach = r * rng.range(0.32, 0.5);   // less than r, so they always intersect the core
    blob(r * rng.range(0.55, 0.72), Math.cos(angle) * reach, rng.range(-0.1, 0.45) * r,
      Math.sin(angle) * reach, 0);
  }

  return parts;
}

/** Street lamp: pole, arm, head. */
function lamp(x, z, rng) {
  const parts = [];
  const h = 4.2;

  const pole = new THREE.CylinderGeometry(0.08, 0.11, h, 5);
  pole.translate(x, KERB_H + h / 2, z);
  parts.push(bakeColor(pole, color('pole')));

  const head = new THREE.BoxGeometry(0.55, 0.18, 0.3);
  head.translate(x, KERB_H + h, z);
  parts.push(bakeColor(head, color('rooftop')));

  return parts;
}

export function createProps(rng, blocks) {
  const parts = [];

  // Districts are planted as one area so trees fall across the old road line too — nothing
  // gives away a merged park faster than a treeless stripe down the middle of it.
  for (const district of blocks.districts ?? []) {
    const { x0, z0, x1, z1 } = district.bounds;
    const count = rng.int(11, 16);
    for (let i = 0; i < count; i++) {
      parts.push(...tree(rng.range(x0 + 1.8, x1 - 1.8), rng.range(z0 + 1.8, z1 - 1.8), rng));
    }
    const inset = 0.75;
    for (const [lx, lz] of [
      [x0 + inset, z0 + inset], [x1 - inset, z0 + inset],
      [x0 + inset, z1 - inset], [x1 - inset, z1 - inset],
    ]) parts.push(...lamp(lx, lz, rng));
  }

  for (const block of blocks) {
    if (block.districtId !== null && block.districtId !== undefined) continue;
    const { x0, z0, x1, z1, cx, cz } = block.bounds;

    if (block.type === 'park') {
      const count = rng.int(5, 9);
      for (let i = 0; i < count; i++) {
        parts.push(...tree(
          rng.range(x0 + 1.6, x1 - 1.6),
          rng.range(z0 + 1.6, z1 - 1.6),
          rng,
        ));
      }
    }

    // A lamp at each block corner, set in from the kerb.
    const inset = 0.75;
    for (const [lx, lz] of [
      [x0 + inset, z0 + inset], [x1 - inset, z0 + inset],
      [x0 + inset, z1 - inset], [x1 - inset, z1 - inset],
    ]) {
      parts.push(...lamp(lx, lz, rng));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'props';
  return mesh;
}
