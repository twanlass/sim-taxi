import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, stampEntry } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { BIG_CITY, GRID_I, GRID_J, segmentKey } from './grid.js';
import { KERB_H, PAVE_INSET, roundedRectShape } from './ground.js';
import { treeParts } from './props.js';

// The turbine square: the one place the city stops being a plain grid (Tyler, 2026-11-17, off a
// magazine illustration of a medieval town plan — "something other than a pure grid").
//
// **What a turbine square is.** A plaza whose streets arrive at its corners *offset*, each one
// carrying on along a different side of the square rather than crossing it, so from above the four
// approaches spin round it like the blades of a turbine. Nobody can drive straight through; every
// approach meets the square at a T.
//
// **Why it costs this city nothing it cannot already do.** On the lattice it is exactly a plaza
// block plus **one closed stub at each of its four corners**, the stubs chosen in pinwheel order.
// Closing a road is something every system already understands (`legalExits`, the network bake,
// the router, ambient traffic, the robo-taxis — a park district is the same move), and each closed
// stub merges the two ring blocks either side of it into one long block. The eight blocks round the
// plaza come out as four dominoes spinning round it, which is the whole look: T-junctions, blocks
// that are not all the same square, and a square with a civic building forming one side.
//
// Curved streets and wedge-shaped blocks, the other half of that illustration, are not here: the
// road network can describe them (`roadnet.js`), but the ground, the buildings and the paint still
// read every block as a rectangle. See city.md#the-turbine-square.
//
// `?layout=classic` (`LAYOUT=classic` headless) is the plain grid. Off on `?city=big`, whose 2 × 2
// central park already breaks its grid in the middle.

export const LAYOUT_CLASSIC = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('layout') === 'classic'
  : globalThis.process?.env?.LAYOUT === 'classic';
export const HAS_SQUARE = !BIG_CITY && !LAYOUT_CLASSIC;

/**
 * Where the square goes, and which stubs it closes. `null` when no block fits.
 *
 * The plaza needs a full ring of land round it — three block rows on one bank and three columns —
 * and it wants the **middle column**, because a town square on the edge of town is not a town
 * square. A first cut kept every closure off the arterials and that forced it to column 1 or 3,
 * half in the fog.
 *
 * **No closure may land on an arterial**: a closed stub on a main street would cut its green wave
 * and its median in two, and the L runs down the north-south one. Every closure sits on one of the
 * plaza's own boundary lines, so in the middle column the north-south arterial is always one of
 * them — and that one blade is simply left off. The main street runs straight past the square's
 * side and the other three corners spin; a three-bladed turbine still never lets a side street
 * cross the square. The east-west arterial is held to the stricter rule (`strictX`): the caller
 * moves it to its other middle line rather than lose a second blade.
 */
export function planSquare(rng, { arterialX, arterialZ, isWater, bridged = new Set(), strictX = true }) {
  const candidates = [];
  for (let bi = 1; bi + 1 < GRID_I; bi++) {
    for (let bj = 1; bj + 1 < GRID_J; bj++) {
      if (strictX && (arterialX.has(bj) || arterialX.has(bj + 1))) continue;
      if ([bj - 1, bj, bj + 1].some((r) => isWater(0, r))) continue;
      candidates.push({ bi, bj, score: Math.hypot(bi + 0.5 - GRID_I / 2, bj + 0.5 - GRID_J / 2) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates.filter((c) => c.score < candidates[0].score + 1e-6);
  const { bi, bj } = best[rng.int(0, best.length - 1)];
  const flip = rng.chance(0.5);

  // The four corners, counter-clockwise from (bi, bj), with the stub each one loses. `x` closes the
  // stub running away from the square along X, `z` the one along Z. Alternating round the square is
  // what makes a pinwheel; the other alternation is the same pinwheel spinning the other way.
  //
  // A blade is left off (the corner stays a crossroads) where it would land on a main street (see
  // above), or where it would close the last block of road onto a bridge: in the middle column one
  // of the square's north-south lines is the drawbridge's, and closing its approach takes away the
  // straight run-up Mega Air needs. **The spin is chosen to keep the most blades** — which in the
  // middle column means the riverside blade lands on the arterial, where it was being dropped
  // anyway, and the drawbridge keeps its approach. The draw only breaks a tie.
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const touchesBridge = (i, j, far) => bridged.has(i)
    && [j, far].some((k) => isWater(0, k) || isWater(0, k - 1));
  const layout = (spin) => {
    const closed = [];
    const merges = [];
    corners.forEach(([dx, dz], n) => {
      const i = bi + dx;
      const j = bj + dz;
      const alongX = (n % 2 === 0) === (spin === 1);
      if (alongX ? arterialX.has(j) : arterialZ.has(i)) return;
      if (alongX) {
        // Away from the square along X, on line j: the column beside the square, rows j-1 and j.
        const far = dx ? i + 1 : i - 1;
        const col = dx ? i : i - 1;
        closed.push(segmentKey(i, j, far, j));
        merges.push([[col, j - 1], [col, j]]);
      } else {
        const far = dz ? j + 1 : j - 1;
        if (touchesBridge(i, j, far)) return;
        const row = dz ? j : j - 1;
        closed.push(segmentKey(i, j, i, far));
        merges.push([[i - 1, row], [i, row]]);
      }
    });
    return { closed, merges, spin };
  };
  const [a, b] = flip ? [layout(1), layout(-1)] : [layout(-1), layout(1)];
  const { closed, merges, spin } = b.closed.length > a.closed.length ? b : a;

  // The town hall stands across the road from the square on its **-Z side**, facing it. The camera
  // looks down the +X+Z diagonal, so that is up-screen of the plaza: the hall is seen front-on over
  // the square and hides nothing of it. (On the +X or +Z side it would stand between the camera
  // and the plaza.)
  const hall = { bi, bj: bj - 1 };
  const ring = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) if (di || dj) ring.push([bi + di, bj + dj]);
  }
  return { plaza: { bi, bj }, hall, ring, closed, merges, spin };
}

/**
 * Turn the planned dominoes into records the ground and the tower generator read: one platform
 * across both blocks and the closed road between them, and the part of it the towers may build on.
 * A domino holding the town hall builds only on its other half, run up to the hall's own lot.
 */
export function bakeMerges(plan, blocks) {
  const at = (bi, bj) => blocks.find((b) => b.bi === bi && b.bj === bj);
  const out = [];
  for (const cells of plan.merges) {
    const [a, b] = cells.map(([bi, bj]) => at(bi, bj));
    if (!a || !b) continue;
    const okType = (k) => k.type === 'built' || k.type === 'townhall';
    if (!okType(a) || !okType(b)) continue;
    const x0 = Math.min(a.bounds.x0, b.bounds.x0);
    const x1 = Math.max(a.bounds.x1, b.bounds.x1);
    const z0 = Math.min(a.bounds.z0, b.bounds.z0);
    const z1 = Math.max(a.bounds.z1, b.bounds.z1);
    const bounds = { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
    const hallBlock = [a, b].find((k) => k.type === 'townhall') ?? null;
    let build = bounds;
    let builder = a;
    if (hallBlock) {
      builder = hallBlock === a ? b : a;
      const h = hallBlock.bounds;
      const bb = { ...bounds };
      // The domino runs along one axis; cut the hall's lot off whichever end it holds.
      if (a.bj === b.bj) {
        if (h.x0 <= bounds.x0 + 1e-6) bb.x0 = h.x1 + 1.2; else bb.x1 = h.x0 - 1.2;
      } else if (h.z0 <= bounds.z0 + 1e-6) bb.z0 = h.z1 + 1.2; else bb.z1 = h.z0 - 1.2;
      bb.cx = (bb.x0 + bb.x1) / 2;
      bb.cz = (bb.z0 + bb.z1) / 2;
      build = bb;
    }
    const merge = { blocks: [a, b], bounds, build, builder, hall: hallBlock };
    a.merge = merge;
    b.merge = merge;
    out.push(merge);
  }
  return out;
}

// --- The plaza and the hall --------------------------------------------------------------------

const PAVE_Y = KERB_H + 0.02;     // over the block's sidewalk paint at KERB_H + 0.01
const INLAY_Y = KERB_H + 0.03;

/** Box helper: centred in x/z, standing on `y`. */
function box(parts, w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  parts.push(bakeColor(geo, col));
}

/** A gable prism `w` wide in x and `d` deep in z, rising `h` from `y`; ridge along X, or Z. */
function gable(parts, w, h, d, x, y, z, col, alongZ = false) {
  // The profile is drawn across the ridge and extruded along it: native ExtrudeGeometry extrudes
  // along +Z, so a ridge along Z needs no turn and one along X a quarter turn.
  const across = alongZ ? w : d;
  const along = alongZ ? d : w;
  const shape = new THREE.Shape();
  shape.moveTo(-across / 2, 0);
  shape.lineTo(across / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: along, bevelEnabled: false });
  geo.translate(0, 0, -along / 2);
  if (!alongZ) geo.rotateY(Math.PI / 2);
  geo.translate(x, y, z);
  parts.push(bakeColor(geo, col));
}

/** A four-sided pyramid cap. */
function pyramid(parts, w, h, x, y, z, col) {
  const geo = new THREE.ConeGeometry(w / Math.SQRT2, h, 4, 1);
  geo.rotateY(Math.PI / 4);
  geo.translate(x, y + h / 2, z);
  parts.push(bakeColor(geo, col));
}

function plazaParts(block, rng) {
  const parts = [];
  const { x0, x1, z0, z1, cx, cz } = block.bounds;
  const w = x1 - x0 - PAVE_INSET * 2;
  const d = z1 - z0 - PAVE_INSET * 2;

  // The square's paving, a band in from the sidewalk so the kerb still reads as a pavement round
  // it, and a darker stone circle in the middle under the monument.
  const pave = new THREE.ShapeGeometry(roundedRectShape(w - 1.6, d - 1.6, 0.6), 8);
  pave.rotateX(-Math.PI / 2);
  pave.translate(cx, PAVE_Y, cz);
  parts.push(bakeColor(pave, jitterColor('plazaStone', rng, { l: 0.02 })));

  const ring = new THREE.RingGeometry(2.1, 3.0, 28);
  ring.rotateX(-Math.PI / 2);
  ring.translate(cx, INLAY_Y, cz);
  parts.push(bakeColor(ring, color('plazaInlay')));

  // Four crossing paths from the circle to the middle of each side, the same inlay stone, so the
  // square reads as laid out rather than as a car park.
  const halfW = (w - 1.6) / 2;
  const halfD = (d - 1.6) / 2;
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const len = (sx ? halfW : halfD) - 3.0;
    if (len <= 0.2) continue;
    const mid = 3.0 + len / 2;
    const geo = new THREE.PlaneGeometry(sx ? len : 0.7, sx ? 0.7 : len);
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx + sx * mid, INLAY_Y, cz + sz * mid);
    parts.push(bakeColor(geo, color('plazaInlay')));
  }

  // The monument: a stepped base and an obelisk. A column of stone is the one shape that reads as
  // "the middle of town" from 400 units up without being a second statue (there is exactly one of
  // those, in a park — props.js).
  const stone = jitterColor('obeliskStone', rng, { l: 0.02 });
  const base = color('bankStep');
  const y = INLAY_Y;
  box(parts, 1.9, 0.3, 1.9, cx, y, cz, base);
  box(parts, 1.3, 0.8, 1.3, cx, y + 0.3, cz, base);
  const shaft = new THREE.CylinderGeometry(0.32, 0.5, 4.6, 4, 1);
  shaft.rotateY(Math.PI / 4);
  shaft.translate(cx, y + 1.1 + 2.3, cz);
  parts.push(bakeColor(shaft, stone));
  pyramid(parts, 0.46, 0.55, cx, y + 1.1 + 4.6, cz, stone);

  // Trees at the four corners of the paving. `treeParts`, as every tree in the city is.
  const ox = halfW - 1.5;
  const oz = halfD - 1.5;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    parts.push(...treeParts(cx + sx * ox, cz + sz * oz, rng, { low: 3.6, high: 4.4 }));
  }
  return parts;
}

/**
 * The town hall: a long stone hall with a red pitched roof and a clock tower, set back to face the
 * square across the road. Distinct from the bank on purpose — the bank is a colonnade, a pediment
 * and a dome; this is a gable and a tower, which is the silhouette of a town square.
 */
function hallParts(block, rng) {
  const parts = [];
  const { x0, x1, z1, cx } = block.bounds;
  const stone = jitterColor('hallStone', rng, { l: 0.02 });
  const trim = color('hallTrim');
  const roof = jitterColor('hallRoof', rng, { l: 0.02 });
  const step = color('bankStep');
  const y0 = KERB_H + 0.01;

  const W = Math.min(10.4, x1 - x0 - 1.4);
  const frontZ = z1 - 2.4;         // the façade, set back for the steps and a forecourt
  const D = 6.8;
  const bodyZ = frontZ - D / 2;
  const H = 4.4;

  // Plinth, body, cornice.
  box(parts, W + 0.4, 0.45, D + 0.4, cx, y0, bodyZ, step);
  box(parts, W, H, D, cx, y0 + 0.45, bodyZ, stone);
  box(parts, W + 0.3, 0.3, D + 0.3, cx, y0 + 0.45 + H, bodyZ, trim);
  const eaves = y0 + 0.45 + H + 0.3;
  gable(parts, W + 0.3, 2.3, D + 0.5, cx, eaves, bodyZ, roof);

  // Steps up to the door, and the entrance bay standing proud of the façade with its own gable,
  // so the front reads as a front.
  box(parts, 4.2, 0.18, 1.6, cx, y0, frontZ + 1.0, step);
  box(parts, 3.6, 0.18, 1.0, cx, y0 + 0.18, frontZ + 0.7, step);
  box(parts, 3.4, H + 0.3, 0.8, cx, y0 + 0.45, frontZ + 0.3, trim);
  gable(parts, 3.4, 1.1, 0.9, cx, eaves, frontZ + 0.3, trim, true);
  // The door: dark, and set into the bay (proud of it by 0.02 so it is not coplanar).
  box(parts, 1.3, 2.1, 0.06, cx, y0 + 0.81, frontZ + 0.72, color('hallDoor'));

  // Tall windows down the façade either side of the bay, dark glass a hair proud of the wall.
  const win = color('window');
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const x = cx + sx * (2.6 + k * 1.9);
      if (Math.abs(x - cx) > W / 2 - 0.7) continue;
      box(parts, 0.9, 2.2, 0.05, x, y0 + 1.4, frontZ + 0.02, win);
    }
  }

  // The clock tower, rising out of the middle of the roof ridge: shaft, belfry, clock faces on the
  // two sides the camera can see, and a spire.
  const TW = 2.6;
  const towerZ = bodyZ - 0.4;
  const top = eaves + 6.2;
  box(parts, TW, top - y0, TW, cx, y0, towerZ, stone);
  box(parts, TW + 0.3, 0.3, TW + 0.3, cx, top, towerZ, trim);
  // Belfry: open-looking via four dark slots.
  box(parts, TW - 0.2, 1.6, TW - 0.2, cx, top + 0.3, towerZ, stone);
  for (const [nx, nz] of [[1, 0], [0, 1]]) {
    box(parts, nx ? 0.04 : 1.0, 1.0, nz ? 0.04 : 1.0,
      cx + nx * (TW / 2 - 0.08), top + 0.6, towerZ + nz * (TW / 2 - 0.08), color('hallDoor'));
  }
  box(parts, TW + 0.2, 0.25, TW + 0.2, cx, top + 1.9, towerZ, trim);
  pyramid(parts, TW + 0.1, 3.0, cx, top + 2.15, towerZ, roof);

  // Clock faces, just under the cornice, on +Z and +X.
  const clockY = top - 1.1;
  const face = color('clockFace');
  const hands = color('clockHands');
  const disc = (nx, nz) => {
    const geo = new THREE.CircleGeometry(0.82, 20);
    if (nx) geo.rotateY(Math.PI / 2);
    geo.translate(cx + nx * (TW / 2 + 0.02), clockY, towerZ + nz * (TW / 2 + 0.02));
    parts.push(bakeColor(geo, face));
    // Hands at ten to two, the way every clock in a shop window is set.
    for (const [len, angle] of [[0.5, Math.PI / 3], [0.66, Math.PI * 0.85]]) {
      const hand = new THREE.PlaneGeometry(0.1, len);
      hand.translate(0, len / 2, 0);
      hand.rotateZ(-angle);
      if (nx) hand.rotateY(Math.PI / 2);
      hand.translate(cx + nx * (TW / 2 + 0.04), clockY, towerZ + nz * (TW / 2 + 0.04));
      parts.push(bakeColor(hand, hands));
    }
  };
  disc(0, 1);
  disc(1, 0);
  return parts;
}

/**
 * The square's static mesh: the plaza block's paving, monument and trees, and the town hall.
 * `null` when the layout has no square.
 */
export function createSquare(rng, layout) {
  const plan = layout.square;
  if (!plan) return null;
  const at = (bi, bj) => layout.find((b) => b.bi === bi && b.bj === bj);
  const plaza = at(plan.plaza.bi, plan.plaza.bj);
  const hall = at(plan.hall.bi, plan.hall.bj);
  const parts = [];
  if (plaza?.type === 'plaza') {
    for (const p of plazaParts(plaza, rng)) {
      stampEntry(p, plaza.bounds.cx, plaza.bounds.cz, 0.35);
      parts.push(p);
    }
  }
  if (hall?.type === 'townhall') {
    for (const p of hallParts(hall, rng)) {
      stampEntry(p, hall.bounds.cx, hall.bounds.cz, 0.5);
      parts.push(p);
    }
  }
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial({ smooth: true }));
  parts.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'square';
  return mesh;
}
