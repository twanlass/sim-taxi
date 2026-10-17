import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { KERB_H } from './ground.js';
import { GRID_I, GRID_J } from './grid.js';

// The roadside block: the fourth block `createLayout` takes out of the tower generator's hands,
// for a business with an inflatable tube man flailing on its corner (game/tubeman.js). Tyler
// wanted him on a business of his own rather than on the burger joint's corner (2026-10-17), and
// then wanted to compare two: a car wash (city/carwash.js, the default) and a gas station with a
// convenience store (city/gasstation.js). This file holds what the two share — which block, where
// the tube man stands, the levels, and the little geometry helpers — and the switch between them.
//
// Built on the burger joint's terms: a whole block, `null` a real answer, drawn after every other
// draw so adding it moves nothing above. Its towers are still built and thrown away (`ghost` in
// city/buildings.js) so no other building moves either.
//
// **Which way it faces is settled by the camera**, as the joint's is. Only +X and +Z faces are ever
// seen, so whatever is tall stands toward the block's −X−Z side and the tube man takes the +X+Z
// corner, out in front of everything.

/**
 * `'carwash'` (the default), `'gas'`, or `'classic'` for none — `?roadside=` in the browser,
 * `ROADSIDE=` for the headless tools.
 */
export const ROADSIDE_MODE = (() => {
  const raw = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('roadside')
    : globalThis.process?.env?.ROADSIDE;
  return raw === 'gas' || raw === 'classic' ? raw : 'carwash';
})();

// --- Levels ------------------------------------------------------------------
// Each flat surface clears the one under it rather than sharing its plane (CLAUDE.md: two flat
// surfaces at one height is a shimmer, not a touch). `createGround` lays the pavement.
const PAVEMENT_Y = KERB_H + 0.01;
/** The lot, over the pavement. The tube man stands on it. */
export const LOT_Y = PAVEMENT_Y + 0.02;
/** Paint on the lot. */
export const PAINT_Y = LOT_Y + 0.012;

/** The tube man: in from the +X and +Z kerbs, on the corner the camera faces. */
const TUBE_IN = 1.1;

/** Where the tube man stands on a roadside block. */
export function roadsideCorner(block) {
  return { x: block.bounds.x1 - TUBE_IN, y: LOT_Y, z: block.bounds.z1 - TUBE_IN };
}

/** Height gained per unit travelled along x on the sightline to the camera (see burgerjoint.js). */
const VIEW_RISE = 0.92;
const SIGHT_MARGIN = 1.0;

function ceilingOf(block) {
  if (block.type === 'park' || block.type === 'graveyard') return 6;
  if (block.type === 'garage' || block.type === 'burger' || block.type === 'roadside') return KERB_H + 4.6;
  if (block.type === 'river') return 0;
  return 5 + (block.centrality ?? 0) * 11;
}

/** True if the ground at `p` can be seen from the camera over every block up-camera of it. */
function pointSeen(blocks, self, p) {
  for (const other of blocks) {
    if (other === self) continue;
    if (other.bounds.x1 <= p.x || other.bounds.z1 <= p.z) continue;
    const enter = Math.max(other.bounds.x0 - p.x, other.bounds.z0 - p.z, 0);
    const leave = Math.min(other.bounds.x1 - p.x, other.bounds.z1 - p.z);
    if (leave <= enter) continue;
    if (ceilingOf(other) + SIGHT_MARGIN > KERB_H + enter * VIEW_RISE) return false;
  }
  return true;
}

/**
 * Which block the roadside business takes, or null.
 *
 * Not touching the depot, the burger joint or the graveyard, so the landmarks spread out; out of
 * downtown, like the joint, because a low lot among towers is one the camera cannot see into; and
 * only where the camera can see both the tube man's corner and the middle of the lot. Each filter
 * falls back to the pool it narrows.
 */
export function chooseRoadsideBlock(rng, blocks) {
  const special = blocks.filter((b) => ['garage', 'burger', 'graveyard'].includes(b.type));
  const touches = (b) => special.some((s) => Math.abs(s.bi - b.bi) <= 1 && Math.abs(s.bj - b.bj) <= 1);
  const candidates = blocks.filter((b) => b.type === 'built'
    && (b.districtId === null || b.districtId === undefined));
  if (!candidates.length) return null;
  const seen = candidates.filter((b) => pointSeen(blocks, b, roadsideCorner(b))
    && pointSeen(blocks, b, { x: b.bounds.cx, z: b.bounds.cz }));
  const pool0 = seen.length ? seen : candidates;
  const apart = pool0.filter((b) => !touches(b));
  const pool = apart.length ? apart : pool0;
  const quiet = pool.filter((b) => b.centrality <= 0.6);
  const inner = quiet.filter((b) => b.bi > 0 && b.bi < GRID_I - 1 && b.bj > 0 && b.bj < GRID_J - 1);
  return rng.pick(inner.length ? inner : quiet.length ? quiet : pool);
}

// --- Geometry helpers ------------------------------------------------------------

export function box(dx, dy, dz, x, base, z, col) {
  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(x, base + dy / 2, z);
  return bakeColor(geo, col);
}

/** A box between two corners. */
export function span(x0, x1, y0, y1, z0, z1, col) {
  return box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, y0, (z0 + z1) / 2, col);
}

/** A disc on a face: a short cylinder, its axis along `axis` ('x' or 'z'). */
export function disc(r, depth, x, y, z, axis, col) {
  const geo = new THREE.CylinderGeometry(r, r, depth, 14);
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  else geo.rotateZ(Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

// Signs in a blocky pixel face. Rows top to bottom.
const GLYPHS = {
  W: ['X...X', 'X...X', 'X.X.X', 'XX.XX', 'X...X'],
  A: ['.XX.', 'X..X', 'XXXX', 'X..X', 'X..X'],
  S: ['.XXX', 'X...', '.XX.', '...X', 'XXX.'],
  H: ['X..X', 'X..X', 'XXXX', 'X..X', 'X..X'],
  G: ['.XXX', 'X...', 'X.XX', 'X..X', '.XXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X'],
  R: ['XXX.', 'X..X', 'XXX.', 'X.X.', 'X..X'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
};
const PIXEL = 0.2;

/**
 * A word as pixel boxes in the sign's local XY, centred, standing `depth` proud of z = 0.
 * `pixel` scales it.
 */
export function wordParts(word, depth, col, pixel = PIXEL) {
  const cols = [...word].reduce((n, ch) => n + GLYPHS[ch][0].length + 1, -1);
  let cx = -(cols * pixel) / 2;
  const parts = [];
  for (const ch of word) {
    const rows = GLYPHS[ch];
    rows.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell !== 'X') return;
        const geo = new THREE.BoxGeometry(pixel * 0.92, pixel * 0.92, depth);
        geo.translate(cx + (rx + 0.5) * pixel, (2 - ry) * pixel, depth / 2);
        parts.push(bakeColor(geo, col));
      });
    });
    cx += (rows[0].length + 1) * pixel;
  }
  return parts;
}
