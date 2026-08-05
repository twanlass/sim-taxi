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

// --- Lit windows -------------------------------------------------------------
//
// After dusk a subset of the panes comes on. They are separate geometry from the dark bands,
// merged into their own mesh wearing `glowMaterial` — unlit, and faded in by the day/night cycle
// (game/nightlights.js). Baking them into the main building mesh would mean they get shaded by
// the night they are supposed to be pushing back on.
//
// The lit set is fixed per city seed rather than flickering. A window that switches on and off is
// a thing the player will look at, and there is nothing there to reward looking — every pixel of
// attention this game asks for should be a fare, a signal or a cop.

/** Width of one pane's worth of glass, so a wide facade gets more windows rather than wider ones. */
const CELL_W = 1.55;
const CELL_H = 1.1;
/** How lit a building is at all — drawn once per tower, so some blocks blaze and some are dark. */
const OCCUPANCY = [0.1, 0.22, 0.4, 0.62];
/** The office-at-2am pane. Rare on purpose; warm-vs-cool is the read, and a 50/50 mix has none. */
const COOL_PANE = 0.11;

/**
 * The panes that are on, laid over one tier's four faces.
 *
 * Its own grid rather than a subdivision of `windowBands` below, even though both are on the same
 * FLOOR_H pitch and line up where they overlap. The bands stop well short of the parapet and skip
 * the ground floor, which is right for a daytime floor line drawn on a mass — but it left this
 * city, whose towers top out around eleven units, with **thirteen** band rows in total to hang a
 * night skyline off. Counting them is what turned a sparse first attempt into this: the lit grid
 * runs from the ground floor to the parapet and gets three or four rows out of the same tower.
 */
function litPanes(w, h, d, x, base, z, rng, occupancy, lights) {
  // Proud of the band it may be sharing a line with, which is itself proud of the facade. Both
  // offsets are far below a pixel at play zoom; they exist only to keep the depth test off the fence.
  const eps = 0.06;

  for (let f = 0; ; f++) {
    const y = base + f * FLOOR_H + 1.1;
    if (y + CELL_H / 2 > base + h - 0.35) break;

    const spanW = w * 0.84;
    const spanD = d * 0.84;

    for (const [span, rotY, px, pz] of [
      [spanW, 0, x, z + d / 2],
      [spanW, Math.PI, x, z - d / 2],
      [spanD, Math.PI / 2, x + w / 2, z],
      [spanD, -Math.PI / 2, x - w / 2, z],
    ]) {
      const cells = Math.max(1, Math.round(span / CELL_W));
      const cellW = (span / cells) * 0.72;
      for (let c = 0; c < cells; c++) {
        if (!rng.chance(occupancy)) continue;
        const offset = (c - (cells - 1) / 2) * (span / cells);
        const pane = new THREE.PlaneGeometry(cellW, CELL_H);
        pane.rotateY(rotY);
        // A plane's normal is +Z and its width runs along +X, so the one rotateY places the pane
        // both along its row and clear of the wall — `offset` down the face, `eps` out of it.
        pane.translate(
          px + Math.cos(rotY) * offset + Math.sin(rotY) * eps,
          y,
          pz - Math.sin(rotY) * offset + Math.cos(rotY) * eps,
        );
        const glass = rng.chance(COOL_PANE) ? PALETTE.windowLitCool : PALETTE.windowLit;
        lights.push(bakeColor(pane, jitterColor(glass, rng, { h: 0.012, s: 0.08, l: 0.09 })));
      }
    }
  }
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

function buildTower(lot, centrality, rng, lightRng, parts, lights) {
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
  // How many of this tower's panes are on tonight. Per tower rather than per pane so the night
  // skyline has bright buildings and dark ones — a flat 30% everywhere reads as texture, not as
  // a city where some people are still at work.
  //
  // Drawn from `lightRng`, a stream of its own. Taking it from `rng` would mean adding night
  // lighting reshuffled every tower in every city — the same trap the per-generator streams in
  // main.js exist to avoid, one level further down. With the split, `?seed=71624` is the city it
  // has always been and the lit panes are simply switched on over the top of it.
  const occupancy = lightRng.pick(OCCUPANCY);

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
    litPanes(cw, tierH, cd, cx, y, cz, lightRng, occupancy, lights);

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
 * @param rng       the city stream: lots, heights, colours, setbacks
 * @param blocks    the layout
 * @param lightRng  which panes are lit, on its own stream — see the note in buildTower()
 */
export function createBuildings(rng, blocks, lightRng) {
  const parts = [];
  const lights = [];

  for (const block of blocks) {
    if (block.type !== 'built') continue;
    const { x0, z0, x1, z1 } = block.bounds;

    for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) {
      buildTower(lot, block.centrality, rng, lightRng, parts, lights);
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';

  // The lit panes come back as raw geometry rather than a mesh: game/nightlights.js owns the one
  // material every light in the city shares, and the one opacity that fades them all in at dusk.
  // `city/` still knows nothing about `game/` — it hands over geometry and stops there.
  const windows = lights.length ? mergeGeometries(lights, false) : null;
  lights.forEach((p) => p.dispose());

  return { mesh, windows, count: parts.length, litWindows: lights.length };
}
