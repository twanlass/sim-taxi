import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, bakeGradient, jitterVertices, propMaterial } from '../util/geo.js';
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

// --- Street lighting ---------------------------------------------------------
//
// Three pieces per lamp, all of them unlit geometry faded in at dusk by game/nightlights.js: the
// head burning, a cone of lit air under it, and a pool on the tarmac. The pool is the one that
// matters — after dark it is what you actually steer by, because it puts a bright patch on the
// road at every block corner and therefore around every junction.

const LAMP_H = 4.2;
/** Pool radius. Reaches ~4.75 units off the kerb, so it covers the near lane and most of the far
 *  one — the lamp stands 0.75 in from a kerb that is 4 units from the road centreline. */
const POOL_R = 5.4;
/** Peak additive brightness at the centre of the pool, before the night fade scales it. Low: this
 *  is a wash that lifts the asphalt off black, not a spotlight that blows out the lane markings.
 *
 *  It has to stay low because the pools *stack*. There are four lamps per block corner and the
 *  blocks are 20 units apart, so at any point on a downtown road three or four of these overlap
 *  additively. The first pass ran 0.5 over a 6.5 radius and the whole city centre came back as one
 *  continuous cream blanket with the roads lost inside it. */
const POOL_PEAK = 0.24;
/** The pool sits above the road paint (0.02) and the route band (0.03), and below the sidewalk
 *  surface (KERB_H + 0.01), so where it overhangs a block the depth test hides it — which is
 *  exactly right, since a lamp lights the road, and the block it stands on has its own. */
const POOL_Y = 0.06;

/** Street lamp: pole, head, and the light it throws once the sun is down. */
function lamp(x, z, lightRng, glow) {
  const parts = [];
  const h = LAMP_H;

  const pole = new THREE.CylinderGeometry(0.08, 0.11, h, 5);
  pole.translate(x, KERB_H + h / 2, z);
  parts.push(bakeColor(pole, color('pole')));

  const head = new THREE.BoxGeometry(0.55, 0.18, 0.3);
  head.translate(x, KERB_H + h, z);
  parts.push(bakeColor(head, color('rooftop')));

  // The bulb. Fractionally larger than the head it sits inside, so the head reads as a housing
  // with something burning in it rather than as a box that changed colour.
  const bulb = new THREE.BoxGeometry(0.42, 0.16, 0.24);
  bulb.translate(x, KERB_H + h - 0.06, z);
  glow.push(bakeColor(bulb, color('lampLight')));

  // Lit air under the head. Open-ended, so it is two rings of triangles and no caps — a cap at the
  // wide end would read as a solid disc hanging in the street. Brightest at the lamp and gone by
  // the pavement, which is the one falloff that never looks like a cone-shaped object.
  const cone = new THREE.ConeGeometry(1.2, 3.2, 7, 1, true);
  const coneTop = 1.6;      // ConeGeometry is centred on its own origin; apex at +h/2
  glow.push(bakeGradient(
    cone.translate(x, KERB_H + h - coneTop, z),
    color('lampLight'),
    (px, py) => 0.13 * Math.max(0, (py - (KERB_H + h - 3.2)) / 3.2) ** 1.5,
  ));

  // The pool on the road.
  const pool = new THREE.CircleGeometry(POOL_R, 14);
  pool.rotateX(-Math.PI / 2);
  glow.push(bakeGradient(
    pool.translate(x, POOL_Y, z),
    // Drawn from `lightRng` rather than the prop stream, so switching the street lights on does
    // not move a single tree — the same split city/buildings.js makes for its lit panes.
    jitterColor(PALETTE.lampLight, lightRng, { h: 0.01, s: 0.05, l: 0.04 }),
    (px, py, pz) => {
      const r = Math.hypot(px - x, pz - z) / POOL_R;
      // Steeper than a linear falloff, so a pool has a definite centre and its edge is gone before
      // it reaches the next lamp's — which is what keeps four overlapping ones reading as four
      // lamps rather than as one lit area.
      return POOL_PEAK * Math.max(0, 1 - r) ** 2.2;
    },
  ));

  return parts;
}

/**
 * @param rng       the city stream: tree placement, size and colour
 * @param blocks    the layout
 * @param lightRng  the street lamps' own variation — see the note in lamp()
 */
export function createProps(rng, blocks, lightRng) {
  const parts = [];
  const glow = [];

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
    ]) parts.push(...lamp(lx, lz, lightRng, glow));
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
      parts.push(...lamp(lx, lz, lightRng, glow));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'props';

  // Bulbs, cones and pools, handed over as raw geometry for game/nightlights.js to give the one
  // shared unlit material and the one night-fade opacity to. Same arrangement as the lit windows
  // in city/buildings.js, and for the same reason: `city/` doesn't know `game/` exists.
  const lights = glow.length ? mergeGeometries(glow, false) : null;
  glow.forEach((p) => p.dispose());

  return { mesh, glow: lights, lamps: glow.length / 3 };
}
