import * as THREE from 'three';
import { hash01, propMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { cutoutAtlas, VIEW_RIGHT } from '../util/cutout.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, PARK_EDGE, GRASS_RADIUS } from './ground.js';
import { parkPlots, BENCH_LEN, STATUE_PLAZA } from './props.js';
import { onCourt } from './blacktop.js';

// Tufts of long grass on the parks' lawns.
//
// A lawn is one flat colour, and from a fixed camera a flat colour is the one surface with nothing
// to say about depth: the trees stand on it, but between them it reads as paint. A scatter of short
// upright cards breaks that up — each one has a silhouette against the lawn behind it and takes the
// trees' shadows a little above the ground they fall on.
//
// **Cards, not blades.** One alpha-cut quad per tuft, its blades drawn into a small atlas built
// here in code (`tuftAtlas`). Geometry blades would be crisper up close and are ten triangles a
// tuft; a card is two, and at play zoom (~7.7px a unit, three times that on a phone) a tuft is a
// handful of pixels either way.
//
// **Every card faces the camera, because the camera never turns.** A crossed pair of cards is what
// a free camera needs; under this one the second card of a pair would be edge-on for the whole
// game. So each card spans the screen's own horizontal, `(1, 0, -1)`, with a little yaw so a field
// of them is not one stamped rank — ±35° still leaves every card front-facing, and the material is
// `FrontSide` like everything else.
//
// **Lit as the lawn, not as a card.** Every vertex carries the ground's own normal, straight up, and
// the material is smooth- rather than flat-shaded so that normal is the one used. A flat-shaded card
// takes its normal from its own face, which points at the camera, and the sun lights that face
// differently from the grass it stands in — every tuft came out as a pale chip on the lawn. With
// the lawn's normal and its colour at the root, the base of a tuft is the lawn, and only the tip
// says anything.
//
// **Receives shadows, casts none.** A tuft's shadow is a few speckled pixels under itself, and a
// card in the shadow map is the thin-shell problem `sinkShadowCaster` exists for (game/scene.js).
// Receiving is the point: the shadow is looked up at the card's own height, so a tree's shade lands
// on the tufts standing in it rather than slipping under them.
//
// **Not an occluder.** `markOccluder` would put it in the AO prepass as solid quads — the depth
// override knows nothing about its alpha. It still *receives* AO, which `main.js` warns about in
// general, and here it is what is wanted: what stands behind a tuft in screen space is the lawn it
// grows out of, so it samples that lawn's occlusion and darkens where the lawn darkens.

/** What ground.js lays a park's lawn at — the same number `pond.js` names `GRASS_Y`. */
const LAWN_Y = KERB_H + 0.01;
// Sunk a little into the lawn so no lit gap shows under a tuft's root where the card's bottom
// edge and the ground meet at a grazing angle. Vertical, so there is nothing for it to fight.
const ROOT_SINK = 0.03;

// Size, in world units. Meadow rather than verge: the tallest come up level with a bench's backrest
// (0.75), which is what makes a clump read as a *volume* the tree shadows lie across rather than as
// texture on the lawn. Taller than this and a clump in front of a bench hides it.
const TUFT_W = [0.9, 1.7];
const TUFT_H = [0.5, 0.9];

// Tufts per square unit of lawn *where the clumping lets them grow*. The noise below admits roughly
// half the lawn, so the effective density is about half this.
const DENSITY = 3.6;
// The clumping field: value noise at about this many units a cell. Uniform scatter reads as a
// texture laid over the park; clumps read as grass that grew.
const CLUMP_CELL = 3.2;

// How far each card may turn off facing the camera.
const YAW_JITTER = 0.6;

// The atlas: four tuft drawings side by side.
const VARIANTS = 4;
const CELL_PX = 64;

/**
 * Coverage of one tuft drawing at a point in its cell, both in 0..1 with v up from the root.
 *
 * A blade is a curved taper: its centreline bends from `base` toward `tip` on a power curve and its
 * half-width falls linearly to nothing, never under `minHalf` — see `cutoutAtlas` for why.
 */
function bladeCoverage(blades, u, v, minHalf) {
  for (const blade of blades) {
    if (v >= blade.h) continue;
    const t = v / blade.h;
    const centre = blade.base + (blade.tip - blade.base) * t ** 1.6;
    const half = Math.max(blade.half * (1 - t), minHalf * (1 - t * 0.5));
    if (Math.abs(u - centre) < half) return 1;
  }
  return 0;
}

/**
 * The tuft atlas (util/cutout.js).
 *
 * Fixed-seed rather than the city's: the drawings are the art, not the situation, and a tuft
 * shouldn't redraw because the parks moved.
 */
export function tuftAtlas() {
  const rng = makeRng(0x9a55);
  const drawings = [];
  for (let k = 0; k < VARIANTS; k++) {
    const blades = [];
    const count = rng.int(11, 17);
    for (let b = 0; b < count; b++) {
      // Spread across the middle of the cell, leaning outward from it — a tuft fans — and the
      // tallest in the middle. Kept off the cell's own edges so a mip level can't bleed a blade
      // into its neighbour's drawing.
      const base = 0.5 + (rng.next() - 0.5) * 0.5;
      const out = base - 0.5;
      const h = 0.55 + 0.4 * (1 - Math.abs(out) * 2.4) * rng.range(0.7, 1);
      blades.push({
        base,
        tip: Math.min(0.92, Math.max(0.08, base + out * rng.range(0.8, 1.6) + rng.range(-0.08, 0.08))),
        h: Math.min(0.97, h),
        half: rng.range(0.035, 0.06),
      });
    }
    drawings.push(blades);
  }

  return cutoutAtlas({
    variants: VARIANTS,
    cellPx: CELL_PX,
    coverage: (k, u, v, minHalf) => bladeCoverage(drawings[k], u, v, minHalf),
  });
}

/** Smooth value noise over the ground, 0..1, from the same hash the entrance wave uses. */
function clump(x, z) {
  const gx = x / CLUMP_CELL;
  const gz = z / CLUMP_CELL;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz);
  const b = hash01(ix + 1, iz);
  const c = hash01(ix, iz + 1);
  const d = hash01(ix + 1, iz + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

/** Is `(x, z)` at least `m` inside a plot's lawn, rounded corners included? */
function onLawn(bounds, x, z, m) {
  const x0 = bounds.x0 + PARK_EDGE + m;
  const x1 = bounds.x1 - PARK_EDGE - m;
  const z0 = bounds.z0 + PARK_EDGE + m;
  const z1 = bounds.z1 - PARK_EDGE - m;
  if (x < x0 || x > x1 || z < z0 || z > z1) return false;
  // The corner arcs, shrunk by the same margin as the straights.
  const r = Math.max(GRASS_RADIUS - m, 0);
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cz = Math.min(Math.max(z, z0 + r), z1 - r);
  return Math.hypot(x - cx, z - cz) <= r;
}

/**
 * Where the tufts go. Split out from the build the way `planPond` is, so `tools/probe.mjs` can
 * sweep the placement rules over seeds.
 *
 * @param furniture  `{ benches, statue, pond, court, skatepark }` as `createProps` returns them — the things the grass
 *                   has to keep out of.
 */
export function planGrass(rng, blocks, {
  benches = [], statue = null, pond = null, court = null, skatepark = null,
} = {}) {
  const tufts = [];
  for (const plot of parkPlots(blocks)) {
    const { x0, z0, x1, z1 } = plot.bounds;
    const attempts = Math.round((x1 - x0) * (z1 - z0) * DENSITY);
    for (let n = 0; n < attempts; n++) {
      // Every draw is taken whether the tuft survives or not, so one rule changing does not move
      // every tuft after it.
      const x = rng.range(x0, x1);
      const z = rng.range(z0, z1);
      const w = rng.range(TUFT_W[0], TUFT_W[1]);
      const h = rng.range(TUFT_H[0], TUFT_H[1]) * (0.8 + 0.2 * w / TUFT_W[1]);
      const yaw = rng.range(-YAW_JITTER, YAW_JITTER);
      const variant = rng.int(0, VARIANTS - 1);
      const keep = rng.next();

      // Clumps, with a soft edge: a hard threshold on the noise draws its contour lines.
      const c = clump(x, z);
      const want = Math.min(1, Math.max(0, (c - 0.22) / 0.28));
      if (keep > want) continue;

      const reach = w / 2;
      // The card's two ends, not its root, have to stay on the grass — a tuft spilling over the
      // walk is grass growing out of the paving. Worked out from the yaw rather than assumed
      // diagonal: turned 0.6 off the view, a card runs within 11° of a grid axis.
      const ex = reach * Math.cos(Math.PI / 4 + yaw);
      const ez = reach * Math.sin(Math.PI / 4 + yaw);
      if (!onLawn(plot.bounds, x + ex, z - ez, 0.05) || !onLawn(plot.bounds, x - ex, z + ez, 0.05)) continue;
      if (statue && Math.abs(x - statue.x) < STATUE_PLAZA / 2 + reach
        && Math.abs(z - statue.z) < STATUE_PLAZA / 2 + reach) continue;
      if (pond && Math.hypot(x - pond.x, z - pond.z) < pond.r + reach * 0.6) continue;
      // Off the blacktop, with a card's reach to spare — long grass sprouting from a court's apron
      // reads as the slab being laid under the lawn rather than in it.
      if (court && onCourt(court, x, z, reach)) continue;
      // And off the skatepark's concrete, on the same terms (`onCourt` reads only a slab's centre,
      // axis and size, which the two share).
      if (skatepark && onCourt(skatepark, x, z, reach)) continue;
      // In each bench's own frame, the way `createProps` keeps trunks off them: grass through a
      // seat is the one arrangement that reads as a rendering fault rather than as a park.
      const underBench = benches.some((bench) => {
        const cos = Math.cos(bench.yaw);
        const sin = Math.sin(bench.yaw);
        const dx = x - bench.x;
        const dz = z - bench.z;
        return Math.abs(dx * cos - dz * sin) < BENCH_LEN / 2 + reach * 0.7
          && Math.abs(dx * sin + dz * cos) < 0.34 + reach * 0.5;
      });
      if (underBench) continue;

      tufts.push({ x, z, w, h, yaw, variant });
    }
  }
  return tufts;
}

/**
 * The cards themselves, as one merged geometry. Non-indexed, six vertices a tuft, wound to face
 * the camera — `tools/probe.mjs` asserts that from the winding.
 */
export function grassGeometry(tufts, rng) {
  const n = tufts.length;
  const pos = new Float32Array(n * 18);
  const nrm = new Float32Array(n * 18);
  const uv = new Float32Array(n * 12);
  const entry = new Float32Array(n * 18);
  const col = new Float32Array(n * 18);
  const root = new THREE.Color();
  const tip = new THREE.Color();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  tufts.forEach((tuft, t) => {
    right.copy(VIEW_RIGHT).applyAxisAngle(up, tuft.yaw).multiplyScalar(tuft.w / 2);
    const y0 = LAWN_Y - ROOT_SINK;
    const y1 = LAWN_Y + tuft.h;
    const bl = [tuft.x - right.x, y0, tuft.z - right.z];
    const br = [tuft.x + right.x, y0, tuft.z + right.z];
    const tr = [tuft.x + right.x, y1, tuft.z + right.z];
    const tl = [tuft.x - right.x, y1, tuft.z - right.z];
    const u0 = tuft.variant / VARIANTS;
    const u1 = (tuft.variant + 1) / VARIANTS;
    // Counter-clockwise seen from the camera: right × up points at it.
    const corners = [bl, br, tr, bl, tr, tl];
    const uvs = [[u0, 0], [u1, 0], [u1, 1], [u0, 0], [u1, 1], [u0, 1]];

    // The root is the lawn's own colour so the card's base melts into the ground; the tip carries
    // the tuft. Jittered per tuft so a clump is not one swatch.
    root.set(jitterColor(PALETTE.park, rng, { l: 0.03 }));
    tip.set(jitterColor(PALETTE.grassTip, rng, { h: 0.03, l: 0.08 }));
    const rand = hash01(tuft.x, tuft.z);

    corners.forEach((p, k) => {
      const v = t * 6 + k;
      pos.set(p, v * 3);
      nrm.set([0, 1, 0], v * 3);
      uv.set(uvs[k], v * 2);
      entry.set([tuft.x, tuft.z, rand], v * 3);
      (uvs[k][1] > 0.5 ? tip : root).toArray(col, v * 3);
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // Written directly rather than through `bakeColors`, which drops the uv and recomputes the
  // normals — the two things this geometry is built around.
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Each tuft anchored on its own root (the `stampEntry` layout), so the grass comes up with its
  // park in the city's entrance wave.
  geometry.setAttribute('aEntry', new THREE.BufferAttribute(entry, 3));
  return geometry;
}

/**
 * The parks' grass: one mesh, one draw.
 *
 * @param furniture  `{ benches, statue, pond }` from `createProps`.
 */
export function createGrass(rng, blocks, furniture) {
  const tufts = planGrass(rng, blocks, furniture);
  const mesh = new THREE.Mesh(grassGeometry(tufts, rng), propMaterial({ cutout: tuftAtlas() }));
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'grass';
  return { mesh, tufts };
}
