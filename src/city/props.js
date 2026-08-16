import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, jitterVertices, propMaterial, stampEntry } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';

/**
 * Park tree — same construction as the terrain prototype's broadleaf, scaled for a city block.
 *
 * Exported because `city/buildings.js` plants the same tree in a courtyard, and a courtyard tree
 * that came out of a second generator would be a different tree: the whole point of it is that the
 * green rising out of a hollow block is the same green as the park two streets over. It takes a
 * height range rather than a scale because the courtyard has a hard floor on it — a tree that
 * doesn't clear the wings around it is a tree nobody ever sees.
 */
export function treeParts(x, z, rng, { low = 3.4, high = 5.6 } = {}) {
  const parts = [];
  const height = rng.range(low, high);
  const trunkH = height * 0.42;

  const trunk = new THREE.CylinderGeometry(height * 0.035, height * 0.055, trunkH, 6);
  trunk.translate(x, KERB_H + trunkH / 2, z);
  parts.push(bakeColor(trunk, jitterColor(PALETTE.trunk, rng, { l: 0.05 })));

  // Canopy: a main blob plus a couple of smaller ones pushed into it. Overlapping solids read as
  // a fuller crown than a single sphere and hide the seams where they meet.
  const r = height * 0.32;
  const base = KERB_H + trunkH + r * 0.75;

  // Per-tree canopy tint, wider than the per-blob jitter below so the variation reads
  // tree-to-tree while the blobs of one crown stay siblings. Hashed from the trunk position
  // rather than drawn, same reason as the entry stamp (util/geo.js hash01): spending a draw
  // here would reshuffle every tree planted after this one.
  const canopy = new THREE.Color(PALETTE.foliage);
  const hsl = { h: 0, s: 0, l: 0 };
  canopy.getHSL(hsl);
  canopy.setHSL(
    (hsl.h + (hash01(x, z) - 0.5) * 0.07 + 1) % 1,
    THREE.MathUtils.clamp(hsl.s + (hash01(z, x) - 0.5) * 0.14, 0, 1),
    THREE.MathUtils.clamp(hsl.l + (hash01(x + z, x - z) - 0.5) * 0.10, 0.05, 0.95),
  );

  const blob = (radius, ox, oy, oz, detail) => {
    const geo = new THREE.IcosahedronGeometry(radius, detail);
    jitterVertices(geo, rng, radius * 0.1);
    geo.scale(1.05, 0.9, 1.05);
    geo.translate(x + ox, base + oy, z + oz);
    parts.push(bakeColor(geo, jitterColor(canopy, rng, { h: 0.02, l: 0.07 })));
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

export function createProps(rng, blocks) {
  const parts = [];

  // Every tree stamped with its own trunk position, so the entrance animation (game/cityentry.js)
  // can pop each one individually out of the merged mesh. The x/z draws stay in the same order the
  // bare `treeParts` calls made them, and the jitter is a hash rather than a draw — see the note
  // in createBuildings — so the planting a seed produces is untouched.
  const plant = (x, z) => {
    const tree = treeParts(x, z, rng);
    const rand = hash01(x, z);
    for (const part of tree) stampEntry(part, x, z, rand);
    parts.push(...tree);
  };

  // Districts are planted as one area so trees fall across the old road line too — nothing
  // gives away a merged park faster than a treeless stripe down the middle of it.
  for (const district of blocks.districts ?? []) {
    const { x0, z0, x1, z1 } = district.bounds;
    const count = rng.int(11, 16);
    for (let i = 0; i < count; i++) {
      plant(rng.range(x0 + 1.8, x1 - 1.8), rng.range(z0 + 1.8, z1 - 1.8));
    }
  }

  for (const block of blocks) {
    if (block.districtId !== null && block.districtId !== undefined) continue;
    const { x0, z0, x1, z1 } = block.bounds;

    if (block.type === 'park') {
      const count = rng.int(5, 9);
      for (let i = 0; i < count; i++) {
        plant(rng.range(x0 + 1.6, x1 - 1.6), rng.range(z0 + 1.6, z1 - 1.6));
      }
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
