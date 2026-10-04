import * as THREE from 'three';
import { hash01, propMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { jitterColor } from '../palette.js';
import { cutoutAtlas, TO_CAMERA, VIEW_RIGHT, VIEW_UP } from '../util/cutout.js';

// Leaf fuzz on the tree crowns: alpha-cut cards of leaf clusters scattered over each canopy lobe,
// the grass's technique (city/grass.js) turned on the trees.
//
// A crown is two or three jittered icosahedra, which is the low-poly look and is staying: the fuzz
// sits *on* the facets rather than replacing them, half of each card sunk into the lobe, so what
// it changes is the edge. A faceted crown has a polygon for a silhouette; with cards breaking it,
// the outline goes ragged the way foliage does, and the facets still read through the middle.
//
// **Lit as the crown.** Every card carries the lobe's own outward normal at the point it stands
// on, smooth-shaded, so a card on the sunlit shoulder lights as that shoulder and one on the shade
// side goes dark with it. Lit as its own camera-facing face, every card came out one flat value
// and the crown lost its light direction under a pale crust.
//
// **Receives, casts nothing, not an occluder** — the grass's three reasons, unchanged: a card in
// the shadow map is a thin shell, the AO prepass would draw it solid, and what it samples AO from
// is the crown behind it. The shadow on the ground stays the lobes' polygon, which at the size a
// shadow is drawn here nobody can tell.
//
// **Only the half the camera can see.** The view never turns, so a card on the far side of a crown
// is a card that is never drawn; a lobe's directions are drawn over the whole sphere and the ones
// pointing away are dropped *after* the draw, so the cull can change without moving any card.

// Cards per unit² of lobe radius, before the back half is dropped.
const PER_R2 = 18;
const MIN_CARDS = 12;
// Card size against its lobe's radius: big enough that a card is a cluster rather than a leaf.
const CARD = [0.5, 0.85];
// Where a card's centre sits, as a fraction of the lobe's radius: inside the surface, so the card
// straddles it — half fringe, half buried.
const SINK = [0.84, 0.98];
// How far round the back a card may stand and still be kept. Slightly past the silhouette, because
// a card there is what pokes out of the outline.
const BACK = -0.22;

// `blob` in props.js scales every lobe by this before placing it.
const LOBE_SCALE = new THREE.Vector3(1.05, 0.9, 1.05);

const VARIANTS = 4;
const CELL_PX = 64;

/**
 * Coverage of one leaf-cluster drawing: rotated ellipses, never thinner than `minHalf` (see
 * `cutoutAtlas`).
 */
function leafCoverage(leaves, u, v, minHalf) {
  for (const leaf of leaves) {
    const dx = u - leaf.x;
    const dy = v - leaf.y;
    const a = dx * leaf.cos + dy * leaf.sin;
    const b = -dx * leaf.sin + dy * leaf.cos;
    const rx = Math.max(leaf.rx, minHalf);
    const ry = Math.max(leaf.ry, minHalf);
    if ((a * a) / (rx * rx) + (b * b) / (ry * ry) < 1) return 1;
  }
  return 0;
}

/** The leaf atlas. Fixed-seed for the reason the tuft atlas is: it is the art, not the city. */
export function leafAtlas() {
  const rng = makeRng(0x1eaf);
  const drawings = [];
  for (let k = 0; k < VARIANTS; k++) {
    const leaves = [];
    const count = rng.int(9, 14);
    for (let n = 0; n < count; n++) {
      // Denser in the middle, ragged at the edge — and kept off the cell's own edge, so a mip
      // level cannot bleed one drawing into the next.
      const angle = rng.range(0, Math.PI * 2);
      const dist = 0.3 * Math.sqrt(rng.next());
      const turn = rng.range(0, Math.PI);
      leaves.push({
        x: 0.5 + Math.cos(angle) * dist,
        y: 0.5 + Math.sin(angle) * dist,
        rx: rng.range(0.1, 0.16),
        ry: rng.range(0.05, 0.09),
        cos: Math.cos(turn),
        sin: Math.sin(turn),
      });
    }
    drawings.push(leaves);
  }
  return cutoutAtlas({
    variants: VARIANTS,
    cellPx: CELL_PX,
    coverage: (k, u, v, minHalf) => leafCoverage(drawings[k], u, v, minHalf),
  });
}

/**
 * Where the cards go: `{ x, y, z, nx, ny, nz, size, roll, variant, color, tx, tz }` per card.
 *
 * @param crowns  the lobes `treeParts` recorded, `{ x, y, z, r, color, tx, tz }`
 */
export function planCanopyFuzz(rng, crowns) {
  const cards = [];
  const n = new THREE.Vector3();
  for (const lobe of crowns) {
    // With a floor: area alone gives a median's 0.6-radius ornamental three cards after the cull,
    // which is a smooth crown next to a fuzzy one rather than a smaller fuzzy one.
    const count = Math.max(MIN_CARDS, Math.round(lobe.r * lobe.r * PER_R2));
    for (let i = 0; i < count; i++) {
      // Every draw taken whether the card survives or not, so the cull can change freely.
      const y = rng.range(-1, 1);
      const phi = rng.range(0, Math.PI * 2);
      const ring = Math.sqrt(1 - y * y);
      const sink = rng.range(SINK[0], SINK[1]);
      const size = lobe.r * rng.range(CARD[0], CARD[1]);
      const roll = rng.range(0, Math.PI * 2);
      const variant = rng.int(0, VARIANTS - 1);
      const color = jitterColor(lobe.color, rng, { h: 0.015, s: 0.03, l: 0.05 });

      const ux = ring * Math.cos(phi);
      const uz = ring * Math.sin(phi);
      // The point on the scaled lobe, and the ellipsoid's normal there (the gradient, which for a
      // scaled sphere is the direction divided by the scale).
      n.set(ux / LOBE_SCALE.x, y / LOBE_SCALE.y, uz / LOBE_SCALE.z).normalize();
      if (n.dot(TO_CAMERA) < BACK) continue;
      cards.push({
        x: lobe.x + ux * LOBE_SCALE.x * lobe.r * sink,
        y: lobe.y + y * LOBE_SCALE.y * lobe.r * sink,
        z: lobe.z + uz * LOBE_SCALE.z * lobe.r * sink,
        nx: n.x, ny: n.y, nz: n.z,
        size, roll, variant, color, tx: lobe.tx, tz: lobe.tz,
      });
    }
  }
  return cards;
}

/** One merged geometry, six vertices a card, each wound to face the camera. */
export function canopyFuzzGeometry(cards) {
  const count = cards.length;
  const pos = new Float32Array(count * 18);
  const nrm = new Float32Array(count * 18);
  const col = new Float32Array(count * 18);
  const uv = new Float32Array(count * 12);
  const entry = new Float32Array(count * 18);
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();

  cards.forEach((card, c) => {
    const half = card.size / 2;
    // Rolled in the screen plane, so every card still faces the camera square on.
    const cos = Math.cos(card.roll);
    const sin = Math.sin(card.roll);
    r.copy(VIEW_RIGHT).multiplyScalar(cos).addScaledVector(VIEW_UP, sin).multiplyScalar(half);
    u.copy(VIEW_UP).multiplyScalar(cos).addScaledVector(VIEW_RIGHT, -sin).multiplyScalar(half);
    const at = (sr, su) => [card.x + r.x * sr + u.x * su, card.y + r.y * sr + u.y * su,
      card.z + r.z * sr + u.z * su];
    const bl = at(-1, -1);
    const br = at(1, -1);
    const tr = at(1, 1);
    const tl = at(-1, 1);
    const u0 = card.variant / VARIANTS;
    const u1 = (card.variant + 1) / VARIANTS;
    const corners = [bl, br, tr, bl, tr, tl];
    const uvs = [[u0, 0], [u1, 0], [u1, 1], [u0, 0], [u1, 1], [u0, 1]];
    const rand = hash01(card.tx, card.tz);
    corners.forEach((p, k) => {
      const v = c * 6 + k;
      pos.set(p, v * 3);
      nrm.set([card.nx, card.ny, card.nz], v * 3);
      card.color.toArray(col, v * 3);
      uv.set(uvs[k], v * 2);
      // The tree's own trunk anchor, so the fuzz grows in with its crown in the entrance wave.
      entry.set([card.tx, card.tz, rand], v * 3);
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aEntry', new THREE.BufferAttribute(entry, 3));
  return geometry;
}

/** Every crown's fuzz in one mesh, one draw. */
export function createCanopyFuzz(rng, crowns) {
  const cards = planCanopyFuzz(rng, crowns);
  const mesh = new THREE.Mesh(canopyFuzzGeometry(cards), propMaterial({ cutout: leafAtlas() }));
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'canopy-fuzz';
  return { mesh, cards };
}
