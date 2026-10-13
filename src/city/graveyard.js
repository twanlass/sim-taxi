import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { KERB_H, PARK_EDGE } from './ground.js';
import { GRID_I, GRID_J, segmentKey } from './grid.js';
import { STATUE_PLAZA, statueParts, treeParts } from './props.js';

// The city's graveyard: two blocks and the street between them behind an iron fence, with rows of
// headstones either side of a gravel path, one big tree and a little ground mist. Scenery, on the
// skatepark's terms — nothing routes through it, nothing on it can be tapped, the fare loop has
// never heard of it.
//
// **A double block** (Tyler, 2026-10-13), built the way a park district is: two blocks side by
// side along X and the road that ran between them closed, so the lot is one wide green behind one fence
// (`planGraveyardPair`). The road has to be closed *before* the network is baked, so unlike the
// depot and the burger joint this is planned early in `createLayout`, right after the park
// districts — and **without a draw**, the pocket park's way, so planning it moves nothing else.
// `?graveyard=single` brings back the first cut: one block, chosen last (`chooseGraveyardBlock`).
// `?graveyard=classic` leaves the city without one.
//
// **Which way it faces is not a choice**, for the reason city/burgerjoint.js gives at length: the
// camera looks down the +X+Z diagonal and never rotates, so only a block's +X and +Z faces are ever
// in front of what stands on it. So the gate is in the +Z fence, every headstone faces +Z, and the
// trees — the only tall things on the lot — stand in its back half, behind the stones rather than
// in front of them.

/**
 * `'double'` (the default), `'single'`, or `'classic'` for none — `?graveyard=` in the browser,
 * `GRAVEYARD=` for the headless tools.
 */
export const GRAVEYARD_MODE = (() => {
  const raw = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('graveyard')
    : globalThis.process?.env?.GRAVEYARD;
  return raw === 'classic' || raw === 'single' ? raw : 'double';
})();
export const GRAVEYARD_ON = GRAVEYARD_MODE !== 'classic';

/** What ground.js lays the lawn at — the park's own level, since it is the park's own surface. */
export const GRAVE_GRASS_Y = KERB_H + 0.01;
/** Anything standing on the lawn starts a little under it, so no base ever shows a seam of sky. */
const FOOT = GRAVE_GRASS_Y - 0.03;

// --- The fence ----------------------------------------------------------------
// On the lawn's edge, a quarter unit in from where the walk stops. A knee-high stone plinth with
// iron railings on it: the railings are what say "cemetery" rather than "park" from across the map,
// and they are see-through, so a fence round a low lot hides nothing behind it.
const FENCE_IN = PARK_EDGE + 0.25;
const PLINTH_H = 0.28;
const PLINTH_W = 0.3;
const RAIL_H = 0.95;        // railing height above the plinth
const PICKET = 0.07;
const PICKET_PITCH = 0.3;
const PIER = 0.42;          // the stone piers at the corners and every few units along
const PIER_H = PLINTH_H + RAIL_H + 0.12;
const PIER_PITCH = 3.2;

// --- The gate -----------------------------------------------------------------
const GATE_HALF = 1.0;       // half the opening in the +Z fence
const GATE_PIER = 0.6;
const GATE_PIER_H = 1.9;
const ARCH_R = GATE_HALF + GATE_PIER / 2 - 0.12;
/** How far the leaves stand open, in radians from shut. */
const GATE_OPEN = 1.2;

// --- The rows -----------------------------------------------------------------
const PATH_HALF = 0.65;
// Thinned 2026-10-13 (Tyler: "too many"): 1.2 x 1.55 with 18% gaps put 84-93 stones on the
// double lot, wall to wall. This and 30% gaps (below) leave lawn between them: 44-49 over five cities.
const COL_PITCH = 1.7;
const ROW_PITCH = 2.1;
/**
 * Headstones are modelled at life size against a 3.2-tall figure and then drawn this much bigger:
 * at life size a stone is four pixels at play zoom and the lot read as a fenced lawn with grit on it.
 */
const STONE_SCALE = 1.4;
const STONE_CLEAR = 0.55;    // from the fence and from the path
const TREE_CLEAR = 1.3;      // no stone inside a trunk's reach
/** The tree's height: past the top of the parks' 3.4–5.6, so it is the one big tree on the block. */
const TREE_H = 6.6;

// --- The mist -----------------------------------------------------------------
/** Mist puffs per single block's worth of lawn. */
const MIST_PUFFS = 9;
const BLOCK_AREA = 8.5 * 8.5;
/** Opacity at golden hour and at full dark — `update` mixes between them on the sun's power. */
const MIST_DAY = 0.07;
const MIST_NIGHT = 0.5;

function box(dx, dy, dz, x, base, z, col) {
  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(x, base + dy / 2, z);
  return bakeColor(geo, col);
}

function span(x0, x1, y0, y1, z0, z1, col) {
  return box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, y0, (z0 + z1) / 2, col);
}

/**
 * Where the graveyard goes, or `null`.
 *
 * Out of downtown, like the burger joint and for a stronger reason: a cemetery between the towers
 * is a hole in the skyline, and a low lot among tall neighbours is one the camera cannot see into.
 * Not touching the depot or the joint on any side, so the three landmarks spread out rather than
 * clumping into one district of specials. Each filter falls back to the pool it narrows.
 */
export function chooseGraveyardBlock(rng, blocks) {
  const special = blocks.filter((b) => b.type === 'garage' || b.type === 'burger');
  const touches = (b) => special.some((s) => Math.abs(s.bi - b.bi) <= 1 && Math.abs(s.bj - b.bj) <= 1);
  const candidates = blocks.filter((b) => b.type === 'built'
    && (b.districtId === null || b.districtId === undefined));
  if (!candidates.length) return null;

  const apart = candidates.filter((b) => !touches(b));
  const pool = apart.length ? apart : candidates;
  const quiet = pool.filter((b) => b.centrality <= 0.5);
  const inner = quiet.filter((b) => b.bi > 0 && b.bi < GRID_I - 1 && b.bj > 0 && b.bj < GRID_J - 1);
  return rng.pick(inner.length ? inner : quiet.length ? quiet : pool);
}

/**
 * Where the double graveyard goes: two blocks side by side along X, and the north-south road
 * between them closed.
 *
 * Side by side rather than stacked along Z because of which road it closes. A stacked pair closes an
 * east-west street, and an east-west side street is the scarce kind: it is what the U-turn's tip card
 * films on (`pickStreet` in game/uturnclip.js wants three straight open blocks, off the river), and
 * the north-south streets nearly all cross the river and never qualify. Stacked, 20 cities in 200
 * had no street to film; side by side it is 2 in 200, the same as with no graveyard. The lot comes
 * out wide, with its gate in the middle of the long +Z fence the camera faces and the path running
 * straight through to the matching gate at the back. Neither block may be water, a park or the
 * central park;
 * the road between them may not be a main street (a closed arterial breaks its green wave); and
 * both blocks are out of downtown, preferring off the outer ring. Each filter falls back to the
 * pool it narrows.
 *
 * **Without a draw**: which candidate wins is hashed off the park districts' positions, the way the
 * pocket park picks its block, so adding this to `createLayout` moves no park, tree or tower.
 *
 * @param o.taken        `(bi, bj) => boolean`, true for a block something else already claimed
 * @param o.isWater      `(bi, bj) => boolean`
 * @param o.arterialZ    the N-S main streets, by line i
 * @param o.centrality   `(bi, bj) => number`, 1 at the core
 * @param o.districts    the park districts, for the hash
 */
export function planGraveyardPair({ taken, isWater, arterialZ, centrality, districts }) {
  const pairs = [];
  for (let bi = 0; bi + 1 < GRID_I; bi++) {
    for (let bj = 0; bj < GRID_J; bj++) {
      const cells = [[bi, bj], [bi + 1, bj]];
      if (cells.some(([i, j]) => taken(i, j) || isWater(i, j))) continue;
      if (arterialZ.has(bi + 1)) continue;
      pairs.push({ cells, quiet: Math.max(...cells.map(([i, j]) => centrality(i, j))) });
    }
  }
  if (!pairs.length) return null;

  const quiet = pairs.filter((p) => p.quiet <= 0.5);
  const pool = quiet.length ? quiet : pairs;
  const inner = pool.filter((p) => p.cells.every(([i, j]) => i > 0 && i < GRID_I - 1 && j > 0 && j < GRID_J - 1));
  const from = inner.length ? inner : pool;
  const key = districts.reduce((sum, d, k) => sum + (k + 1) * (d.bounds.cx * 39.346 + d.bounds.cz * 11.135), 7.7);
  const frac = Math.abs(Math.sin(key) * 43758.5453) % 1;
  const pick = from[Math.min(from.length - 1, Math.floor(frac * from.length))];

  const [[bi, bj]] = pick.cells;
  return {
    cells: pick.cells,
    // The road between the pair, named by the two junctions at its ends — the district's own key.
    closed: segmentKey(bi + 1, bj, bi + 1, bj + 1),
  };
}

/** Every measurement the mesh is built from, off the block's own bounds. */
export function graveyardSite(block) {
  const { x0, x1, z0, z1, cx, cz } = block.bounds;
  const fence = { x0: x0 + FENCE_IN, x1: x1 - FENCE_IN, z0: z0 + FENCE_IN, z1: z1 - FENCE_IN };
  return {
    bi: block.bi,
    bj: block.bj,
    bounds: block.bounds,
    fence,
    gateX: cx,
    /** Where the shots aim: the middle of the lawn, taken flat off the ground. */
    focus: { x: cx, z: cz },
  };
}

// --- The fence ------------------------------------------------------------------

/** One straight run of fence from (ax, az) to (bx, bz), axis-aligned. */
function fenceRun(ax, az, bx, bz, stone, iron, parts) {
  const alongX = az === bz;
  const len = alongX ? bx - ax : bz - az;
  const mid = (a, b) => (a + b) / 2;
  // The plinth.
  parts.push(alongX
    ? box(len, PLINTH_H + 0.03, PLINTH_W, mid(ax, bx), FOOT, az, stone)
    : box(PLINTH_W, PLINTH_H + 0.03, len, ax, FOOT, mid(az, bz), stone));
  // Two rails, one just under the spikes and one low.
  const top = FOOT + PLINTH_H + RAIL_H;
  for (const y of [top - 0.14, FOOT + PLINTH_H + 0.18]) {
    parts.push(alongX
      ? box(len, 0.05, 0.05, mid(ax, bx), y, az, iron)
      : box(0.05, 0.05, len, ax, y, mid(az, bz), iron));
  }
  // The pickets, each with a spike on it.
  const n = Math.max(1, Math.round(len / PICKET_PITCH));
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const x = alongX ? ax + (bx - ax) * u : ax;
    const z = alongX ? az : az + (bz - az) * u;
    parts.push(box(PICKET, RAIL_H, PICKET, x, FOOT + PLINTH_H, z, iron));
    const spike = new THREE.ConeGeometry(0.06, 0.16, 4);
    spike.rotateY(Math.PI / 4);
    spike.translate(x, top + 0.08, z);
    parts.push(bakeColor(spike, iron));
  }
}

function pier(x, z, h, w, stone, cap, parts) {
  parts.push(box(w, h, w, x, FOOT, z, stone));
  parts.push(box(w + 0.12, 0.1, w + 0.12, x, FOOT + h, z, cap));
}

function fenceParts(site, rng, parts) {
  const { fence, gateX } = site;
  const stone = jitterColor(color('graveStoneDark'), rng, { l: 0.02 });
  const cap = color('graveStone');
  const iron = color('graveIron');

  // Each side as a list of runs between piers, both ends broken by a gate on the path's line, so
  // the path runs straight through the lot from one street to the other.
  const gap = GATE_HALF + GATE_PIER / 2;
  const runs = [
    [fence.x0, fence.z0, fence.x0, fence.z1],
    [fence.x1, fence.z0, fence.x1, fence.z1],
  ];
  for (const z of [fence.z0, fence.z1]) {
    runs.push([fence.x0, z, gateX - gap, z], [gateX + gap, z, fence.x1, z]);
  }
  for (const [ax, az, bx, bz] of runs) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / PIER_PITCH));
    for (let k = 0; k < n; k++) {
      const u0 = k / n;
      const u1 = (k + 1) / n;
      fenceRun(ax + (bx - ax) * u0, az + (bz - az) * u0, ax + (bx - ax) * u1, az + (bz - az) * u1,
        stone, iron, parts);
      if (k > 0) pier(ax + (bx - ax) * u0, az + (bz - az) * u0, PIER_H, PIER, stone, cap, parts);
    }
  }
  for (const [x, z] of [[fence.x0, fence.z0], [fence.x1, fence.z0], [fence.x0, fence.z1], [fence.x1, fence.z1]]) {
    pier(x, z, PIER_H, PIER, stone, cap, parts);
  }

  // The gates, one at each end: two tall piers and an iron arch between them, with the leaves
  // standing open into the lot. `inward` is the way into the lot from that fence.
  for (const [z, inward] of [[fence.z1, -1], [fence.z0, 1]]) {
    for (const s of [-1, 1]) pier(gateX + s * gap, z, GATE_PIER_H, GATE_PIER, stone, cap, parts);
    // Half a torus is a ring three winds itself, so it cannot arrive inside out.
    const arch = new THREE.TorusGeometry(ARCH_R, 0.05, 4, 14, Math.PI);
    arch.translate(gateX, FOOT + GATE_PIER_H - 0.25, z);
    parts.push(bakeColor(arch, iron));
    // A little cross at the crown of the arch.
    const crown = FOOT + GATE_PIER_H - 0.25 + ARCH_R;
    parts.push(box(0.06, 0.42, 0.06, gateX, crown, z, iron));
    parts.push(box(0.26, 0.06, 0.06, gateX, crown + 0.24, z, iron));

    // The leaves, built along +X from the hinge and turned so each points back across the opening
    // and swings `GATE_OPEN` of the way round into the lot. `rotateY(θ)` sends +X to (cos θ, −sin θ).
    for (const s of [-1, 1]) {
      const leaf = [];
      const w = GATE_HALF - 0.05;
      leaf.push(box(w, 0.05, 0.05, w / 2, 0.25, 0, iron));
      leaf.push(box(w, 0.05, 0.05, w / 2, 1.1, 0, iron));
      for (let k = 0; k <= 4; k++) leaf.push(box(0.05, 1.2, 0.05, (w * k) / 4, 0.1, 0, iron));
      const g = mergeGeometries(leaf, false);
      leaf.forEach((p) => p.dispose());
      g.rotateY(Math.atan2(-inward * Math.sin(GATE_OPEN), -s * Math.cos(GATE_OPEN)));
      g.translate(gateX + s * GATE_HALF, FOOT, z);
      parts.push(g);
    }
  }
}

// --- The headstones -------------------------------------------------------------

/** One headstone at the origin, facing +Z, with the grave in front of it. */
function headstone(kind, rng) {
  const out = [];
  const stone = jitterColor(color(rng.chance(0.35) ? 'graveStoneDark' : 'graveStone'), rng, { l: 0.05 });
  const mound = jitterColor(color('graveMound'), rng, { l: 0.03 });

  if (kind === 'round') {
    const w = rng.range(0.5, 0.62);
    const h = rng.range(0.4, 0.55);
    out.push(box(w, h, 0.14, 0, 0, 0, stone));
    const top = new THREE.CylinderGeometry(w / 2, w / 2, 0.14, 8, 1, false, Math.PI / 2, Math.PI);
    top.rotateX(Math.PI / 2);
    top.translate(0, h, 0);
    out.push(bakeColor(top, stone));
  } else if (kind === 'cross') {
    out.push(box(0.4, 0.14, 0.24, 0, 0, 0, stone));
    out.push(box(0.13, 0.95, 0.12, 0, 0.14, 0, stone));
    out.push(box(0.5, 0.12, 0.12, 0, 0.7, 0, stone));
  } else if (kind === 'tablet') {
    const h = rng.range(0.5, 0.7);
    out.push(box(0.56, h, 0.16, 0, 0, 0, stone));
    out.push(box(0.64, 0.08, 0.2, 0, h, 0, stone));
  } else {
    // A little obelisk: a tapered four-sided shaft with a point on it.
    out.push(box(0.46, 0.2, 0.46, 0, 0, 0, stone));
    const shaft = new THREE.CylinderGeometry(0.13, 0.19, 1.25, 4);
    shaft.rotateY(Math.PI / 4);
    shaft.translate(0, 0.2 + 0.625, 0);
    out.push(bakeColor(shaft, stone));
    const tip = new THREE.ConeGeometry(0.13, 0.22, 4);
    tip.rotateY(Math.PI / 4);
    tip.translate(0, 0.2 + 1.25 + 0.11, 0);
    out.push(bakeColor(tip, stone));
  }
  const stoneGeo = mergeGeometries(out, false);
  out.forEach((p) => p.dispose());
  stoneGeo.scale(STONE_SCALE, STONE_SCALE, STONE_SCALE);
  // Old stones lean. A few of them, a little, about the base — the stone, not the grave.
  if (rng.chance(0.3)) stoneGeo.rotateZ(rng.jitter(0.16));
  if (rng.chance(0.2)) stoneGeo.rotateX(-rng.range(0.04, 0.14));
  // The grave in front of it, at its own size: low and dark, so a row reads as a row of plots and
  // not as a row of signs.
  const grave = box(0.72, 0.06, 1.0, 0, 0, 0.7, mound);
  const geo = mergeGeometries([stoneGeo, grave], false);
  stoneGeo.dispose();
  grave.dispose();
  return geo;
}

/** `keepOut`: the tree and the statue, each `{ x, z, r? }` — no stone within `r` (TREE_CLEAR by default). */
function headstoneParts(site, keepOut, rng, parts) {
  const { fence, gateX } = site;
  const zFirst = fence.z0 + STONE_CLEAR + 0.2;
  const zLast = fence.z1 - STONE_CLEAR - 1.2;  // leave the grave in front of the last row room
  const rows = Math.max(1, Math.floor((zLast - zFirst) / ROW_PITCH) + 1);

  for (const side of [-1, 1]) {
    const inner = gateX + side * (PATH_HALF + STONE_CLEAR);
    const outer = side < 0 ? fence.x0 + STONE_CLEAR : fence.x1 - STONE_CLEAR;
    const width = Math.abs(outer - inner);
    const cols = Math.max(1, Math.floor(width / COL_PITCH) + 1);
    const pitch = cols > 1 ? width / (cols - 1) : 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Gaps in the rows: a full grid reads as a car park.
        if (rng.chance(0.3)) continue;
        const x = inner + side * c * pitch + rng.jitter(0.08);
        const z = zFirst + r * ROW_PITCH + rng.jitter(0.06);
        if (keepOut.some((t) => Math.hypot(t.x - x, t.z - z) < (t.r ?? TREE_CLEAR))) continue;
        const roll = rng.next();
        const kind = roll < 0.45 ? 'round' : roll < 0.72 ? 'tablet' : roll < 0.92 ? 'cross' : 'obelisk';
        const geo = headstone(kind, rng);
        geo.rotateY(rng.jitter(0.06));
        geo.translate(x, FOOT, z);
        parts.push(geo);
      }
    }
  }
}

// --- The mist ---------------------------------------------------------------------

function createMist(site, rng) {
  const { fence } = site;
  const group = new THREE.Group();
  group.name = 'graveyard-mist';
  const cx = (fence.x0 + fence.x1) / 2;
  const cz = (fence.z0 + fence.z1) / 2;
  group.position.set(cx, GRAVE_GRASS_Y, cz);
  const material = unlitMaterial({
    color: color('graveMist'), transparent: true, opacity: MIST_DAY, depthWrite: false, fog: true,
  });
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const hx = (fence.x1 - fence.x0) / 2 - 0.6;
  const hz = (fence.z1 - fence.z0) / 2 - 0.6;
  const puffs = [];
  const count = Math.round(MIST_PUFFS * Math.max(1, (4 * hx * hz) / BLOCK_AREA));
  for (let k = 0; k < count; k++) {
    const mesh = new THREE.Mesh(geo, material);
    const s = rng.range(1.0, 1.7);
    mesh.scale.set(s * rng.range(1.2, 1.6), 0.22, s);
    mesh.renderOrder = 2;
    group.add(mesh);
    puffs.push({
      mesh,
      x: rng.range(-hx, hx),
      z: rng.range(-hz, hz),
      vx: rng.range(0.12, 0.25) * (rng.chance(0.5) ? 1 : -1),
      phase: rng.range(0, Math.PI * 2),
    });
  }
  let time = 0;
  const place = () => {
    for (const p of puffs) {
      // Drift along X and wrap, bobbing a little: the lot is small enough that a puff leaving one
      // side is never in shot when it comes back in the other.
      let x = p.x + p.vx * time;
      x = ((x + hx) % (2 * hx) + 2 * hx) % (2 * hx) - hx;
      p.mesh.position.set(x, 0.18 + 0.05 * Math.sin(time * 0.6 + p.phase), p.z);
    }
  };
  place();
  return {
    group,
    material,
    update(dt, dark) {
      time += dt;
      place();
      material.opacity = MIST_DAY + (MIST_NIGHT - MIST_DAY) * dark;
    },
  };
}

// --- The whole lot ----------------------------------------------------------------

export function createGraveyard(block, rng) {
  const site = graveyardSite(block);
  const { fence, gateX } = site;
  const parts = [];

  // The gravel path, gate to gate. A slab rather than paint: its top is 0.03 over the lawn, so it
  // is never coplanar with it.
  parts.push(span(gateX - PATH_HALF, gateX + PATH_HALF, FOOT, GRAVE_GRASS_Y + 0.03,
    fence.z0 - 0.1, fence.z1 + 0.1, jitterColor(color('gravePath'), rng, { l: 0.02 })));

  fenceParts(site, rng, parts);

  // One big tree, the parks' own (`treeParts`, props.js) at the top of their size and past it, in
  // the back corner on the −X side of the path so its crown stands behind the stones rather than
  // over them. Its crown is the one thing here that isn't the parks' palette: a dark plum, so it
  // reads as the graveyard's tree and not as a park tree that wandered in.
  const tree = { x: fence.x0 + 1.6, z: fence.z0 + 1.6 };
  parts.push(...treeParts(tree.x, tree.z, rng, { height: TREE_H, trunk: 0.5, canopy: PALETTE.graveTree }));

  // A park statue (Tyler, 2026-10-13: "a little more asymmetric appeal"), the parks' own model with
  // its paved square, out in the lawn of the −X block in front of the tree. Off the middle of its
  // half on purpose: centred, it would only have made the lot more symmetrical.
  const statue = {
    x: fence.x0 + (gateX - PATH_HALF - fence.x0) * 0.4,
    z: (fence.z0 + fence.z1) / 2 + 0.6,
    // Clear of the whole plaza, corner to corner, and a stone's width past it.
    r: STATUE_PLAZA / 2 * Math.SQRT2 + 0.4,
  };
  parts.push(...statueParts(statue.x, statue.z, GRAVE_GRASS_Y, rng));

  headstoneParts(site, [tree, statue], rng, parts);

  // The lanterns' iron caps and points, on both gates; the lit glass under them is `glow` below.
  for (const z of [fence.z0, fence.z1]) {
    for (const sx of [-1, 1]) {
      const x = gateX + sx * (GATE_HALF + GATE_PIER / 2);
      const y = FOOT + GATE_PIER_H + 0.1;
      parts.push(box(0.28, 0.06, 0.28, x, y + 0.26, z, color('graveIron')));
      const point = new THREE.ConeGeometry(0.16, 0.16, 4);
      point.rotateY(Math.PI / 4);
      point.translate(x, y + 0.32 + 0.08, z);
      parts.push(bakeColor(point, color('graveIron')));
    }
  }

  // One anchor for the lot, so the whole graveyard comes up out of the ground as one object.
  const anchorX = block.bounds.cx;
  const anchorZ = block.bounds.cz;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);

  parts.forEach(stampAll);
  // Smooth for the tree's crown, which is how every tree in the city is lit (see `treeParts`); the
  // stones and the ironwork still light off their own face normals.
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial({ smooth: true }));
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'graveyard';

  // The two lanterns on the gate piers: unlit, for the reason the burger joint's windows are —
  // they are lights, and a pale box in its own shadow reads as grey paint.
  const glowParts = [];
  for (const z of [fence.z0, fence.z1]) {
    for (const s of [-1, 1]) {
      const x = gateX + s * (GATE_HALF + GATE_PIER / 2);
      const y = FOOT + GATE_PIER_H + 0.1;
      glowParts.push(box(0.2, 0.26, 0.2, x, y, z, color('graveLantern')));
    }
  }
  glowParts.forEach(stampAll);
  const glow = new THREE.Mesh(mergeGeometries(glowParts, false), unlitMaterial({ vertexColors: true }));
  glowParts.forEach((p) => p.dispose());
  glow.name = 'graveyard-glow';

  const mist = createMist(site, rng);

  const group = new THREE.Group();
  group.name = 'graveyard-root';
  group.add(shell, glow, mist.group);

  return {
    site,
    group,
    shell,
    glow,
    /** Advance the mist. `dark` is 0 in daylight and 1 at full night. */
    update(dt, dark = 0) {
      mist.update(dt, dark);
    },
    /** The stamped meshes, for the entrance wave, the AO prepass and the sightline field. */
    meshes: [shell, glow],
    /** The mist moves, so the wave grows its group on the CPU instead. */
    entryObject: { object: mist.group, x: anchorX, z: anchorZ, rand },
    entrySite: {
      x: anchorX,
      z: anchorZ,
      r: Math.max(fence.x1 - fence.x0, fence.z1 - fence.z0) / 2,
      rand,
    },
  };
}
