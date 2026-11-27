import * as THREE from 'three';
import { hash01, propMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { jitterColor } from '../palette.js';
import { clumpNormal, crownShade } from './props.js';
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

// On a clumped tree's clump: cards this much bigger against the lobe, and sunk this much less.
const CLUMP_CARD = 1.45;
const CLUMP_PROUD = 0.1;

const lobeScale = new THREE.Vector3();
const scaleOf = (arr) => lobeScale.set(arr[0], arr[1], arr[2]);

// `blob` in props.js scales every lobe by this before placing it.
const LOBE_SCALE = new THREE.Vector3(1.05, 0.9, 1.05);

const VARIANTS = 4;
// Leaf *masses* (`?trees=quads`): whole clumps of leaves on one card, the usual game trick — a few
// big quads per crown and the alpha doing the work. They share the atlas with the small cards, in
// the cells after them, so the two kinds stay one mesh, one texture and one program. The cell is
// twice the old size because a mass has a hundred leaves to draw where a cluster had a dozen; the
// small cards' mips are drawn rather than filtered, so the level a small card reads at play zoom
// is the same rasterisation it always was.
const MASSES = 4;
const CELLS = VARIANTS + MASSES;
const CELL_PX = 128;
// Cards per mass lobe, how big against the lobe, and how far the corner normals bulge outward.
const MASS_CARDS = 3;
const MASS_SIZE = [2.0, 2.5];
const MASS_BULGE = 0.6;

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
  // The masses: a lumpy blob (a few overlapping discs) packed with small leaves, sparser toward its
  // edge so the outline breaks up and with gaps inside so the card behind it shows through.
  for (let k = 0; k < MASSES; k++) {
    const blobs = [];
    const lumps = rng.int(4, 6);
    for (let n = 0; n < lumps; n++) {
      const a = rng.range(0, Math.PI * 2);
      const d = n === 0 ? 0 : rng.range(0.12, 0.2);
      blobs.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d, r: n === 0 ? 0.26 : rng.range(0.13, 0.2) });
    }
    const inside = (x, y) => blobs.reduce((m, b) => Math.max(m, 1 - Math.hypot(x - b.x, y - b.y) / b.r), -1);
    const leaves = [];
    for (let tries = 0; leaves.length < 150 && tries < 4000; tries++) {
      const x = rng.range(0.05, 0.95);
      const y = rng.range(0.05, 0.95);
      const depth = inside(x, y);
      // Keep every leaf well inside, fewer toward the rim, and leave holes: `depth` 0 is the rim.
      if (depth < -0.15 || rng.next() > 0.35 + depth * 1.6) continue;
      const turn = rng.range(0, Math.PI);
      leaves.push({
        x, y, rx: rng.range(0.035, 0.06), ry: rng.range(0.018, 0.032), cos: Math.cos(turn), sin: Math.sin(turn),
      });
    }
    drawings.push(leaves);
  }
  return cutoutAtlas({
    variants: CELLS,
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
  const p = new THREE.Vector3();
  for (const lobe of crowns) {
    // A clumped tree's core (props.js): buried under its clumps, so its cards would be too.
    if (lobe.fuzz === false) continue;
    if (lobe.mass) {
      massCards(rng, lobe, cards);
      continue;
    }
    // With a floor: area alone gives a median's 0.6-radius ornamental three cards after the cull,
    // which is a smooth crown next to a fuzzy one rather than a smaller fuzzy one.
    // `density` (a style's override, props.js `STYLES`) scales the count on top.
    const count = Math.round(Math.max(MIN_CARDS, lobe.r * lobe.r * PER_R2) * (lobe.density ?? 1));
    for (let i = 0; i < count; i++) {
      // Every draw taken whether the card survives or not, so the cull can change freely.
      const y = rng.range(-1, 1);
      const phi = rng.range(0, Math.PI * 2);
      const ring = Math.sqrt(1 - y * y);
      // A clump (props.js `clumpedTree`) is a third of a classic lobe's radius, so its cards grow
      // and stand further out to fringe it the way they fringe a big lobe — the same draws, rescaled.
      // A `fill` lobe (the all-cards tree) spreads its cards through the volume, not over a shell.
      const drawnSink = rng.range(SINK[0], SINK[1]);
      const sink = lobe.fill ? 0.2 + (drawnSink - SINK[0]) / (SINK[1] - SINK[0]) * 0.9
        : drawnSink + (lobe.crown ? CLUMP_PROUD : 0);
      const size = lobe.r * rng.range(CARD[0], CARD[1]) * (lobe.cardScale ?? (lobe.crown ? CLUMP_CARD : 1));
      const roll = rng.range(0, Math.PI * 2);
      const variant = rng.int(0, VARIANTS - 1);
      const color = jitterColor(lobe.color, rng, { h: 0.015, s: 0.03, l: 0.05 });

      // A lobe may carry its own squash (`s`, the card-shape trees' flat layers and columns).
      const ls = lobe.s ? scaleOf(lobe.s) : LOBE_SCALE;
      const ux = ring * Math.cos(phi);
      const uz = ring * Math.sin(phi);
      // The point on the scaled lobe, and the ellipsoid's normal there (the gradient, which for a
      // scaled sphere is the direction divided by the scale).
      n.set(ux / ls.x, y / ls.y, uz / ls.z).normalize();
      // The cull stays on the lobe's own normal, so it drops the same cards whatever the crown.
      if (!lobe.keepBack && n.dot(TO_CAMERA) < BACK) continue;
      p.set(
        lobe.x + ux * ls.x * lobe.r * sink,
        lobe.y + y * ls.y * lobe.r * sink,
        lobe.z + uz * ls.z * lobe.r * sink,
      );
      // On a clump, a card lights and shades the way the clump does at that point (props.js).
      if (lobe.crown) {
        clumpNormal(n, p.x, p.y, p.z, lobe.x, lobe.y, lobe.z, lobe.crown);
        color.multiplyScalar(crownShade(lobe.crown, p.x, p.y, p.z));
      }
      cards.push({
        x: p.x, y: p.y, z: p.z,
        nx: n.x, ny: n.y, nz: n.z,
        size, roll, variant, color, tx: lobe.tx, tz: lobe.tz,
      });
    }
  }
  return cards;
}

/**
 * A mass lobe's few big cards: one in front, the rest a little behind and to the sides, each
 * covering the whole lobe. Lit by bulged corner normals and shaded per corner (`bulge`, `crown`),
 * so a card that is one quad still turns from its lit shoulder to its shaded underside.
 */
function massCards(rng, lobe, cards) {
  const n = new THREE.Vector3();
  if (lobe.crown) {
    clumpNormal(n, lobe.x, lobe.y, lobe.z, lobe.crown.x, lobe.crown.y, lobe.crown.z, lobe.crown, 1);
  } else {
    n.copy(TO_CAMERA);
  }
  for (let i = 0; i < MASS_CARDS; i++) {
    const side = i === 0 ? 0 : (i % 2 ? 1 : -1) * rng.range(0.25, 0.45);
    const lift = i === 0 ? 0 : rng.range(-0.25, 0.3);
    const toward = i === 0 ? 0.25 : -0.2;
    const r = lobe.r;
    cards.push({
      x: lobe.x + (VIEW_RIGHT.x * side + VIEW_UP.x * lift + TO_CAMERA.x * toward) * r,
      y: lobe.y + (VIEW_RIGHT.y * side + VIEW_UP.y * lift + TO_CAMERA.y * toward) * r,
      z: lobe.z + (VIEW_RIGHT.z * side + VIEW_UP.z * lift + TO_CAMERA.z * toward) * r,
      nx: n.x, ny: n.y, nz: n.z,
      size: r * rng.range(MASS_SIZE[0], MASS_SIZE[1]) * (i === 0 ? 1 : 0.85),
      roll: rng.range(0, Math.PI * 2),
      variant: VARIANTS + rng.int(0, MASSES - 1),
      color: jitterColor(lobe.color, rng, { h: 0.015, s: 0.03, l: 0.05 }).multiplyScalar(i === 0 ? 1 : 0.8),
      tx: lobe.tx, tz: lobe.tz, bulge: MASS_BULGE, crown: lobe.crown ?? null,
    });
  }
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
  const bent = new THREE.Vector3();
  const base = new THREE.Vector3();
  const shaded = new THREE.Color();

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
    const u0 = card.variant / CELLS;
    const u1 = (card.variant + 1) / CELLS;
    const corners = [bl, br, tr, bl, tr, tl];
    const uvs = [[u0, 0], [u1, 0], [u1, 1], [u0, 0], [u1, 1], [u0, 1]];
    const rand = hash01(card.tx, card.tz);
    corners.forEach((p, k) => {
      const v = c * 6 + k;
      pos.set(p, v * 3);
      if (card.bulge) {
        // A mass card: the normal leans out toward its corner, and the colour takes the crown's
        // shade there (`massCards`).
        bent.set(p[0] - card.x, p[1] - card.y, p[2] - card.z).normalize().multiplyScalar(card.bulge)
          .add(base.set(card.nx, card.ny, card.nz)).normalize();
        nrm.set([bent.x, bent.y, bent.z], v * 3);
        const k = card.crown ? crownShade(card.crown, p[0], p[1], p[2]) : 1;
        shaded.copy(card.color).multiplyScalar(k).toArray(col, v * 3);
      } else {
        nrm.set([card.nx, card.ny, card.nz], v * 3);
        card.color.toArray(col, v * 3);
      }
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
  // Out of the z-fighting scan (util/zfight.js). Every card faces the camera, so all of them share
  // one normal, and a few thousand of them scattered through the crowns put a pair on one plane now
  // and then — measured at 0.6 u² on a whole city, a few leaf texels in the middle of a canopy's own
  // noise, and cut out to nothing wherever the atlas is clear.
  mesh.userData.zfight = false;
  return { mesh, cards };
}
