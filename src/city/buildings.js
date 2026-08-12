import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { BUILDING_COLORS, color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';
import { treeParts } from './props.js';

const FLOOR_H = 2.6;
// The ground floor is its own storey height. A shopfront is taller than the flats above it, and
// the difference is most of what makes a building read as having a *base* rather than as a box
// with windows starting at the pavement.
const GROUND_H = 2.4;
const MIN_LOT = 4.2;

// Façade rhythm. At play zoom one world unit is about 7.7px (see docs/rendering.md), so a window
// this size is 8×11 pixels — the smallest thing that still reads as a window rather than as
// dirt on the wall. Below about 0.8 units they stop separating from each other and the whole
// façade goes grey.
const BAY = 2.3;          // horizontal pitch between window centres
const WIN_W = 1.05;
const WIN_H = 1.4;
const SILL = 0.55;        // sill height above the floor line
// How far an opening stands off the wall it is punched into. Small enough not to read as a
// pilaster from any angle, large enough to beat depth precision at DISTANCE = 400.
const EPS = 0.03;

/**
 * Nothing on a roof may reach past this.
 *
 * The ambient aeroplane cruises at 26 units at the bottom of its jitter and `tools/probe.mjs`
 * asserts four units of clearance under its belly, which puts the hard ceiling at 20.9. Roof
 * furniture is the only thing here that can reach it — the tallest possible tower is 16.4 to its
 * parapet — so the water tower and the mast are *conditional on fitting under this*, and fall
 * back to something shorter rather than being clamped into a stump. The probe asserts the
 * clearance across seeds; this is what makes the assertion hold by construction.
 */
export const SKYLINE_CEILING = 20.5;

// Curtain wall on the two cool envelopes, punched openings on the masonry. A rule rather than a
// roll: a glass tower with holes cut in it and a brick walk-up glazed floor to ceiling are both
// wrong, and tying the façade to the envelope colour means the city never builds either.
const CURTAIN_WALL = new Set(['glass', 'slate']);

// Sides are the city's own direction encoding — 0..3 meaning +X, +Z, -X, -Z (see docs/city.md), so
// a façade index is the same number the traffic model uses for the road it faces.
const SIDE_OUT = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// The tangent that runs along each face, chosen so that `tangent × up` is the outward normal.
// That is what winds the quads below the right way round, and it is asserted rather than
// eyeballed — see "a façade faces out of its wall" in tools/probe.mjs.
const SIDE_TAN = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * A stop darker than the colour handed in.
 *
 * Cornices and ledges are cut from the building's own envelope rather than from a shared grey.
 * A flat `roof` grey on top of every mass was tried first and it drained the city: at play zoom a
 * building is forty pixels tall, a third of which is then the same dark cap as its neighbour's,
 * and the tan/brick/concrete families stop telling each other apart. Darkening the body keeps the
 * colour and still reads as a ledge, because the sun is low enough that the underside of one is
 * in shadow anyway.
 */
function shade(col, amount = 0.78) {
  return col.clone().multiplyScalar(amount);
}

function box(w, h, d, x, base, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Every opening on one façade, written into a single geometry.
 *
 * A window is two triangles and a mid-rise carries forty of them, so the city is a few thousand
 * openings. Emitted one `PlaneGeometry` at a time they are a few thousand objects for
 * `mergeGeometries` to walk and dispose, which costs several times the rest of the city put
 * together; a face's openings go straight into one position array instead.
 *
 * `rects` are `{ u, y, w, h }` in face-local terms: `u` along the face from its centre, `y` the
 * world height of the rect's centre.
 *
 * Exported for the winding assertion in `tools/probe.mjs`. Hand-wound triangles get their normals
 * from `computeVertexNormals`, which launders a reversed triangle into whatever its neighbours
 * say — so the sign has to be checked from the winding rather than looked at. The roadworks ramp
 * shipped inside out for exactly this reason.
 */
export function facadeQuads(rects, side, cx, cz, hw, hd, col, out = EPS) {
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const reach = (side % 2 === 0 ? hw : hd) + out;
  const ox = cx + nx * reach;
  const oz = cz + nz * reach;

  const positions = new Float32Array(rects.length * 18);
  let p = 0;

  for (const { u, y, w, h } of rects) {
    const uL = u - w / 2;
    const uR = u + w / 2;
    const yB = y - h / 2;
    const yT = y + h / 2;

    // A (left, bottom), B (right, bottom), E (right, top), D (left, top).
    const corner = (uu, yy) => [ox + tx * uu, yy, oz + tz * uu];
    const A = corner(uL, yB);
    const B = corner(uR, yB);
    const E = corner(uR, yT);
    const D = corner(uL, yT);

    for (const v of [A, B, E, A, E, D]) {
      positions[p++] = v[0];
      positions[p++] = v[1];
      positions[p++] = v[2];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return bakeColor(geo, col);
}

/** How many window bays fit across a face, and how far apart their centres sit. */
function bayLayout(faceW) {
  const bays = Math.max(1, Math.min(6, Math.round(faceW / BAY)));
  // 0.88 of the face, so the outermost window keeps a pier of masonry between it and the corner.
  // Without it the windows run off the edge of narrow lots and the building loses its corners.
  return { bays, pitch: (faceW * 0.88) / bays };
}

/** Floor lines above the ground storey of a tier, as world heights. */
function floorLines(base, h, firstFloorH) {
  const lines = [];
  let y = base + firstFloorH;
  while (y + FLOOR_H <= base + h - 0.35) {
    lines.push(y);
    y += FLOOR_H;
  }
  return lines;
}

/**
 * How much of each side of a `w × d` box is glazable, indexed by side (+X, +Z, -X, -Z).
 *
 * The default is the whole face. A courtyard wing overrides it: two of its four sides are buried
 * inside the wings beside it, and a third is only exposed across its middle. Windows drawn into
 * those would be invisible geometry at best and two coplanar grids fighting over the same depth
 * at worst — which is exactly what the first version of the courtyard did at all four corners.
 */
function fullFaces(w, d) {
  return [d, w, d, w];
}

/**
 * Punched openings: a grid of individual windows, one per bay per floor.
 *
 * This is the masonry half of the façade rule. It is worth the triangles that a continuous band
 * isn't: a band gives a mass *scale* and nothing else, where a grid gives it a grain — and grain
 * is what tells the eye that the row of five boxes down one street are five separate buildings
 * rather than one long one that happens to change colour.
 */
function punchedWindows(parts, cx, base, cz, w, d, h, firstFloorH, windowColor,
  faces = fullFaces(w, d)) {
  const lines = floorLines(base, h, firstFloorH);
  if (!lines.length) return;

  for (let side = 0; side < 4; side++) {
    const faceW = faces[side];
    if (faceW < 1.6) continue;
    const { bays, pitch } = bayLayout(faceW);
    const winW = Math.min(WIN_W, pitch * 0.62);

    const rects = [];
    for (const y of lines) {
      for (let b = 0; b < bays; b++) {
        rects.push({
          u: (b + 0.5 - bays / 2) * pitch,
          y: y + SILL + WIN_H / 2,
          w: winW,
          h: WIN_H,
        });
      }
    }
    parts.push(facadeQuads(rects, side, cx, cz, w / 2, d / 2, windowColor));
  }
}

/**
 * Curtain wall: one horizontal ribbon per floor, inset a hair from each face.
 *
 * The original façade treatment, and still the right one for a glass envelope — the glass on a
 * tower like this genuinely is continuous, and a ribbon is one quad per face where a grid is a
 * dozen.
 */
function ribbonWindows(parts, cx, base, cz, w, d, h, firstFloorH, windowColor,
  faces = fullFaces(w, d)) {
  const lines = floorLines(base, h, firstFloorH);
  if (!lines.length) return;

  const bandH = Math.min(1.5, FLOOR_H - 0.9);
  for (let side = 0; side < 4; side++) {
    const faceW = faces[side];
    if (faceW < 1.6) continue;
    const rects = lines.map((y) => ({
      u: 0, y: y + 0.5 + bandH / 2, w: faceW * 0.84, h: bandH,
    }));
    parts.push(facadeQuads(rects, side, cx, cz, w / 2, d / 2, windowColor));
  }
}

/**
 * The street-level storey: a glazed shopfront on every face that meets a street, and one door.
 *
 * Only the street sides get it, which is the whole reason the block bounds are threaded down here.
 * A lot's interior sides face the back of the next lot along and a shopfront there would be a
 * window into somebody's party wall — and the difference between a building that has a front and
 * one that is glazed on all four sides is most of what makes a row of them read as a street.
 */
function groundFloor(parts, cx, cz, w, d, streetSides, rng) {
  const base = KERB_H;
  const glassH = Math.min(1.2, GROUND_H - 0.8);
  const glassY = base + 0.5 + glassH / 2;

  for (const side of streetSides) {
    const faceW = side % 2 === 0 ? d : w;
    if (faceW < 1.6) continue;
    parts.push(facadeQuads(
      [{ u: 0, y: glassY, w: faceW * 0.74, h: glassH }],
      side, cx, cz, w / 2, d / 2, color('shopfront'),
    ));
  }

  // One entrance, on one street side. A door per face would read as four doors on a building the
  // size of a bus, which at this scale is what most of them are.
  const side = rng.pick(streetSides);
  const faceW = side % 2 === 0 ? d : w;
  if (faceW < 1.6) return;

  const { bays, pitch } = bayLayout(faceW);
  // Off-centre on a wide façade, which is what a real entrance is: dead centre reads as a
  // symmetry the rest of the building doesn't have.
  const bay = bays > 1 ? rng.int(0, bays - 1) : 0;
  const u = (bay + 0.5 - bays / 2) * pitch;
  const doorW = Math.min(1.15, pitch * 0.7);
  const doorH = GROUND_H - 0.45;

  // Stood off in two layers, so neither the door nor its surround is coplanar with the glazing
  // beside it. The surround is not decoration: `door` and `shopfront` sit within four points of
  // each other in value, and without a light frame around it the entrance is a dark patch on a
  // dark band that nobody can find. It is what makes a door read at all.
  parts.push(facadeQuads(
    [{ u, y: base + (doorH + 0.18) / 2, w: doorW + 0.3, h: doorH + 0.18 }],
    side, cx, cz, w / 2, d / 2, color('awning'), EPS * 2,
  ));
  parts.push(facadeQuads(
    [{ u, y: base + doorH / 2, w: doorW, h: doorH }],
    side, cx, cz, w / 2, d / 2, color('door'), EPS * 3,
  ));

  if (!rng.chance(0.55)) return;

  // The canopy over it. Reaches 0.47 out, which is well inside the 0.85 the tower is already
  // inset into its lot — a façade that grew past that line would be a building with its awning
  // over the pavement, and `tools/probe.mjs` measures cars against exactly that line.
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const reach = (side % 2 === 0 ? w / 2 : d / 2) + 0.22;
  const along = doorW + 0.5;
  parts.push(box(
    side % 2 === 0 ? 0.5 : along, 0.16, side % 2 === 0 ? along : 0.5,
    cx + nx * reach + tx * u, base + doorH + 0.12, cz + nz * reach + tz * u,
    color('awning'),
  ));
}

/**
 * A cornice, and then whatever the roof can carry.
 *
 * The cornice is the cheapest of the lot and does the most work: twelve triangles of ledge
 * standing 0.18 proud of the walls turns the top of a box into the top of a *building*, and it
 * reads at play zoom where none of the rest of this does.
 */
function roofKit(parts, cx, cz, cw, cd, y, style, body, rng) {
  const capH = 0.3;
  if (style === 'punched') {
    parts.push(box(cw + 0.36, capH, cd + 0.36, cx, y, cz, shade(body)));
  } else {
    // A curtain wall has no cornice to have — the glass runs to a flush parapet, which is the
    // whole visual difference between the two at a distance.
    parts.push(box(cw, capH, cd, cx, y, cz, color('rooftop')));
  }
  const deck = y + capH;
  const area = cw * cd;

  // Plant room / stair bulkhead. Every roof used to get one, which made a skyline of identical
  // boxes wearing identical smaller boxes.
  if (rng.chance(0.55) && area > 6) {
    parts.push(box(cw * rng.range(0.26, 0.46), rng.range(0.7, 1.6), cd * rng.range(0.26, 0.46),
      cx + rng.jitter(cw * 0.2), deck, cz + rng.jitter(cd * 0.2), color('rooftop')));
  }

  // Air conditioning. Small enough to be one pixel of shadow at play zoom and to be the thing
  // that makes a roof look occupied when the camera comes in close.
  const units = area > 14 ? rng.int(0, 2) : rng.int(0, 1);
  for (let n = 0; n < units; n++) {
    const uw = rng.range(0.5, 0.85);
    const ud = rng.range(0.45, 0.75);
    const uh = rng.range(0.3, 0.5);
    const ux = cx + rng.jitter(Math.max(0, cw / 2 - uw));
    const uz = cz + rng.jitter(Math.max(0, cd / 2 - ud));
    parts.push(box(uw, uh, ud, ux, deck, uz, color('rooftop')));
    // The fan grille on top, as a plate rather than a disc: a cylinder here is 24 triangles for
    // something four pixels across.
    parts.push(box(uw * 0.62, 0.06, ud * 0.62, ux, deck + uh, uz, color('rooftopIron')));
  }

  // The water tower. Mid-rise only: a tank on legs is a walk-up's answer to water pressure and
  // looks wrong on the tallest thing in the city, which has a plant room for it instead. The
  // ceiling test is belt and braces on top of that — see SKYLINE_CEILING.
  const TANK_R = 0.62;
  const LEG_H = 1.1;
  const TANK_H = 1.7;
  const CAP_H = 0.5;
  const TOWER_H = LEG_H + TANK_H + CAP_H;
  const MID_RISE = 13;
  // One in eight. It was three in ten to start with and the city grew a forest of them: at play
  // zoom a water tower is a 5px spike above the roofline, and on every roof that is a texture
  // rather than a landmark. Rare enough to notice one is the whole point of it.
  if (area > 12 && deck < MID_RISE && deck + TOWER_H < SKYLINE_CEILING && rng.chance(0.125)) {
    const tx = cx + rng.jitter(Math.max(0, cw / 2 - TANK_R - 0.5));
    const tz = cz + rng.jitter(Math.max(0, cd / 2 - TANK_R - 0.5));

    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      parts.push(box(0.13, LEG_H, 0.13, tx + lx * TANK_R * 0.62, deck, tz + lz * TANK_R * 0.62,
        color('rooftopIron')));
    }
    const tank = new THREE.CylinderGeometry(TANK_R, TANK_R * 0.94, TANK_H, 8);
    tank.translate(tx, deck + LEG_H + TANK_H / 2, tz);
    parts.push(bakeColor(tank, jitterColor(color('watertank'), rng, { l: 0.04 })));
    // The hoop that holds the staves together. Two triangles' worth of ring is what stops the tank
    // reading as a plain drum.
    const hoop = new THREE.CylinderGeometry(TANK_R * 1.04, TANK_R * 1.02, 0.14, 8);
    hoop.translate(tx, deck + LEG_H + TANK_H * 0.32, tz);
    parts.push(bakeColor(hoop, color('rooftopIron')));
    const cap = new THREE.ConeGeometry(TANK_R * 1.1, CAP_H, 8);
    cap.translate(tx, deck + LEG_H + TANK_H + CAP_H / 2, tz);
    parts.push(bakeColor(cap, color('roof')));
    return;
  }

  // Or a mast, on the tall ones. The old threshold was `height > 22` against a ceiling of 16, so
  // no building in the shipped city ever grew one.
  const MAST_H = rng.range(2.2, 4.5);
  if (deck > 9 && deck + MAST_H < SKYLINE_CEILING && rng.chance(0.4)) {
    const mast = new THREE.CylinderGeometry(0.1, 0.15, MAST_H, 5);
    mast.translate(cx, deck + MAST_H / 2, cz);
    parts.push(bakeColor(mast, color('pole')));
  }
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

/** Which of a lot's four sides sit on the block's edge, and so face a street. */
function streetSidesOf(lot, bounds) {
  const on = (a, b) => Math.abs(a - b) < 0.05;
  const sides = [];
  if (on(lot.x1, bounds.x1)) sides.push(0);
  if (on(lot.z1, bounds.z1)) sides.push(1);
  if (on(lot.x0, bounds.x0)) sides.push(2);
  if (on(lot.z0, bounds.z0)) sides.push(3);
  return sides;
}

/** The buildable rectangle inside a lot: the lot minus the setback off every line. */
const INSET = 0.85;
function buildableOf(lot) {
  const x0 = lot.x0 + INSET;
  const z0 = lot.z0 + INSET;
  const x1 = lot.x1 - INSET;
  const z1 = lot.z1 - INSET;
  return {
    x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
  };
}

function buildTower(lot, block, rng, parts) {
  const { w, d, cx, cz } = buildableOf(lot);
  if (w < 2 || d < 2) return;

  const streetSides = streetSidesOf(lot, block.bounds);

  // Height is driven by how central the block is — this is what produces a downtown silhouette
  // instead of an evenly tall grid.
  // Capped far lower than the city sim's 43. Downtown towers there were tall enough to hide the
  // taxi behind them, and the player has to be able to see the car they're directing at all times.
  const ceiling = 5 + block.centrality * 11;
  const height = Math.max(5, rng.range(0.42, 1) * ceiling);

  const family = rng.pick(BUILDING_COLORS);
  const style = CURTAIN_WALL.has(family) ? 'curtain' : 'punched';
  const body = jitterColor(color(family), rng, { l: 0.05 });
  const windowColor = color('window');

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

    // The ground storey only exists on the tier that meets the pavement; everything above it
    // starts its floor lines straight off the setback.
    const firstFloorH = tier === 0 ? GROUND_H : 0.4;
    if (style === 'punched') {
      punchedWindows(parts, cx, y, cz, cw, cd, tierH, firstFloorH, windowColor);
    } else {
      ribbonWindows(parts, cx, y, cz, cw, cd, tierH, firstFloorH, windowColor);
    }
    if (tier === 0 && streetSides.length) groundFloor(parts, cx, cz, cw, cd, streetSides, rng);

    y += tierH;
    remaining -= tierH;
    tier += 1;

    if (remaining <= 4) break;
    // A ledge where the tower steps in, so a setback reads as a setback rather than as two boxes
    // that happen to be stacked.
    parts.push(box(cw + 0.2, 0.22, cd + 0.2, cx, y, cz, shade(body, 0.86)));
    y += 0.22;
    const shrink = rng.range(0.62, 0.82);
    cw *= shrink;
    cd *= shrink;
  }

  roofKit(parts, cx, cz, cw, cd, y, style, body, rng);
}

// --- Courtyard blocks -------------------------------------------------------
//
// A hollow perimeter block: four wings around a planted courtyard. It is the one massing in the
// city that isn't a solid, and it only works because of a measurement.
//
// The camera looks down VIEW_DIR (1, 0.92, 1), which is 33.0° above horizontal. A wing of height
// h hides everything within h / tan(33°) = 1.54h of its inner face, so an enclosed courtyard with
// 5-unit wings and 6 units of opening shows the player nothing at all — the trees inside would be
// invisible and the whole thing would read as a slightly lumpy box.
//
// Three things fix it, and none of them is a cheat — they are all ordinary things for a building
// to do:
//
//   - The wings facing the camera (+X and +Z, which are also the two the sun lights) are built
//     from a **lower** height range than the pair behind them. A perimeter block that steps down
//     toward its front is normal architecture, and it is what opens the courtyard to the one
//     direction anybody ever looks from. The camera never rotates — see docs/rendering.md — so
//     "the front" is a fixed pair of sides.
//   - The wings are thin, which is what buys the yard the width to be seen into at all.
//   - The trees are grown from the tall end of the park's range, sized against the *front* pair.
//     The tall pair sit past the yard rather than between it and the camera, so they are not what
//     a crown has to clear.
const COURT_MIN = 8.2;        // smallest buildable rectangle worth hollowing out
// Thin wings and low ones at the front, and both numbers come straight off the 1.54h above. At
// 2.3–3.1 thick with 3.2–4.6 at the front the yard was 4.9 across — 6.9 on the diagonal against
// 4.9–7.1 of occlusion — and the lawn never showed at all: the trees read as sitting on the roof
// of a lumpy box rather than as standing in a hole in it. At these it is 5.7 across, 8.1 on the
// diagonal against 3.9–5.5, so a couple of units of the far corner is always in view.
const WING_MIN = 2;
const WING_MAX = 2.7;
const FRONT_H = [2.6, 3.6];

function buildCourtyard(lot, block, rng, parts) {
  const { x0, z0, x1, z1, w, d, cx, cz } = buildableOf(lot);
  const streetSides = streetSidesOf(lot, block.bounds);

  const family = rng.pick(BUILDING_COLORS);
  const style = CURTAIN_WALL.has(family) ? 'curtain' : 'punched';
  const body = jitterColor(color(family), rng, { l: 0.05 });
  const windowColor = color('window');

  const t = rng.range(WING_MIN, WING_MAX);

  // The lawn first, so the wings draw over its edges rather than leaving a green seam.
  const yard = { x0: x0 + t, z0: z0 + t, x1: x1 - t, z1: z1 - t };
  parts.push(box(yard.x1 - yard.x0, 0.06, yard.z1 - yard.z0,
    (yard.x0 + yard.x1) / 2, KERB_H, (yard.z0 + yard.z1) / 2,
    jitterColor(color('park'), rng, { l: 0.03 })));

  // Wing rectangles, indexed by the side each one faces: 0 = +X, 1 = +Z, 2 = -X, 3 = -Z. The pair
  // running along Z are full length and the pair along X fill what is left between them, so the
  // four meet edge to edge and no two of them overlap — a ring, not four crossed slabs.
  //
  // `faces` is how much of each side is glazable. The two ends of a short wing are buried in the
  // long wing beside it, and a long wing's inner face only shows across the gap between them.
  const mid = Math.max(0, w - 2 * t);
  const inner = Math.max(0, d - 2 * t);
  const wings = [
    { side: 0, x0: x1 - t, x1, z0, z1, faces: [d, t, inner, t] },
    { side: 2, x0, x1: x0 + t, z0, z1, faces: [inner, t, d, t] },
    { side: 1, x0: x0 + t, x1: x1 - t, z0: z1 - t, z1, faces: [0, mid, 0, mid] },
    { side: 3, x0: x0 + t, x1: x1 - t, z0, z1: z0 + t, faces: [0, mid, 0, mid] },
  ];

  let tallest = 0;
  for (const wing of wings) {
    // Front pair low, back pair full height. See the note above.
    const front = wing.side === 0 || wing.side === 1;
    const h = front
      ? rng.range(FRONT_H[0], FRONT_H[1])
      : rng.range(5.2, 5.2 + block.centrality * 5);
    tallest = Math.max(tallest, h);

    const ww = wing.x1 - wing.x0;
    const wd = wing.z1 - wing.z0;
    const wx = (wing.x0 + wing.x1) / 2;
    const wz = (wing.z0 + wing.z1) / 2;
    if (ww < 0.5 || wd < 0.5) continue;

    parts.push(box(ww, h, wd, wx, KERB_H, wz, jitterColor(body, rng, { l: 0.03 })));
    // One ground storey across the whole perimeter, low wings included — they are the same
    // building. Starting a short wing's windows lower would put a row of them straight through
    // the shopfront band that `groundFloor` paints on the same face.
    const firstFloorH = GROUND_H;
    if (style === 'punched') {
      punchedWindows(parts, wx, KERB_H, wz, ww, wd, h, firstFloorH, windowColor, wing.faces);
    } else {
      ribbonWindows(parts, wx, KERB_H, wz, ww, wd, h, firstFloorH, windowColor, wing.faces);
    }
    // A cornice per wing, so the stepped heights read as four buildings in a terrace.
    parts.push(box(ww + 0.3, 0.26, wd + 0.3, wx, KERB_H + h, wz, shade(body)));
  }

  // Street-level glazing and an entrance, on the perimeter as usual. The courtyard is behind it.
  if (streetSides.length) groundFloor(parts, cx, cz, w, d, streetSides, rng);

  // Grown from the tall end so the crowns clear the wings around them.
  const trees = rng.int(3, 5);
  const yw = yard.x1 - yard.x0;
  const yd = yard.z1 - yard.z0;
  for (let n = 0; n < trees; n++) {
    parts.push(...treeParts(
      rng.range(yard.x0 + 0.7, yard.x1 - 0.7),
      rng.range(yard.z0 + 0.7, yard.z1 - 0.7),
      rng,
      // Sized against the *front* wings, which are the only ones that occlude anything — the tall
      // pair behind sit past the courtyard, not between it and the camera. Grown from the tall
      // end of the park's range so a crown always clears a 4.6-unit wing; taken from the back
      // wings' height instead, a downtown courtyard produced one ten-unit tree that filled the
      // whole yard like a cauliflower.
      { low: 4.4, high: 6 },
    ));
  }

  // One AC unit or two on the tallest wing, reached through the same kit as everything else —
  // minus the water tower, which wants a roof this doesn't have.
  if (yw > 2 && yd > 2 && rng.chance(0.5)) {
    const wing = wings[rng.chance(0.5) ? 2 : 3];
    parts.push(box(rng.range(0.5, 0.8), 0.4, rng.range(0.45, 0.7),
      rng.range(wing.x0 + 0.6, wing.x1 - 0.6), KERB_H + tallest + 0.26,
      rng.range(wing.z0 + 0.6, wing.z1 - 0.6), color('rooftop')));
  }
}

export function createBuildings(rng, blocks) {
  const parts = [];
  let courtyards = 0;

  for (const block of blocks) {
    if (block.type !== 'built') continue;
    const { x0, z0, x1, z1 } = block.bounds;

    for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) {
      const buildable = buildableOf(lot);
      // Only an undivided block is wide enough to hollow out and still leave wings with rooms in
      // them, so this is rare by construction rather than by a low roll — two or three per city.
      const roomy = buildable.w > COURT_MIN && buildable.d > COURT_MIN;
      if (roomy && rng.chance(0.55)) {
        buildCourtyard(lot, block, rng, parts);
        courtyards += 1;
      } else {
        buildTower(lot, block, rng, parts);
      }
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  return { mesh, count: parts.length, courtyards };
}
