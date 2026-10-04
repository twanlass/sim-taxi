import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, setFinish, FINISH } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { BARGE_AIR, TUG_AIR } from '../city/river.js';

// Two boats, and the difference between them is the whole reason the drawbridge exists.
//
// **They are told apart by their air draught, not by their looks.** A barge sits low enough to
// clear every span in the city; the sailboat's mast does not clear the flat one. The numbers
// are `BARGE_AIR` and `TUG_AIR` in city/river.js, where they sit next to the soffit heights they
// have to beat, because a chain of four constants is only checkable if it is written in one place.
//
// Built the way every vehicle in this game is: boxes and cylinders, `bakeColor`, one merged mesh,
// `flatShading`. A boat at play zoom is about twenty pixels long.

// --- Sizes, measured against the traffic ---------------------------------------
//
// A car is 3.4 × 1.7 (`CAR_LEN`, `CAR_W`). The first cut of these boats was sized off nothing in
// particular — an 8.6 × 2.2 barge, a 4.4 × 2.2 tug — and on screen next to the cars on the bridges
// they read as toys: a barge one and a third cars wide in a channel nine units across. They are now
// sized off the **water**, which is the thing they are seen against: the water is 9.2 across on an
// ordinary channel and 7.87 where one bank is an arterial, and a working barge fills most of it.

/** Barge: half the water across — 4.2 against 9.2, or 7.87 where one bank is an arterial — and
 *  eleven long, a little over three cars. It was 16 × 6 for a while, three quarters of the channel,
 *  which read as big and also as a slab; a trash barge wants to be a *heap* with a boat under it. */
export const BARGE_LEN = 11;
export const BARGE_BEAM = 4.2;
/** Sailboat: a thirty-footer at car scale. Not much longer than the old tug — what grew is the mast. */
export const TUG_LEN = 6.0;
export const TUG_BEAM = 2.4;

/**
 * A hull, as a box drawn in along its length.
 *
 * `plan` is the beam fraction at each of `plan.length` stations from the stern (first) to the bow
 * (last), and `rake` lifts the bottom at the same stations — a bow that climbs out of the water
 * rather than ending in a wall. Both are applied by scaling and shifting the vertices of a
 * `BoxGeometry` with that many depth segments, rather than by hand-winding a wedge: a box cannot be
 * built inside out, and a hull is exactly the sloped-face shape the roadworks ramp shipped
 * reversed. Positive per-vertex scaling preserves handedness, and the y shift only ever moves a
 * bottom vertex *up* to a height still under the top, so neither step can turn a face over.
 *
 * Two hulls built off the same `plan` meet exactly along a shared height, which is how the
 * sailboat gets its boot stripe: two pieces stacked, touching, not overlapping.
 */
function hullPiece(length, beam, y0, y1, plan, rake, col) {
  const segs = plan.length - 1;
  const geo = new THREE.BoxGeometry(beam, y1 - y0, length, 1, 1, segs);
  geo.translate(0, (y0 + y1) / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round((pos.getZ(i) / length + 0.5) * segs);
    pos.setX(i, pos.getX(i) * plan[k]);
    if (rake && pos.getY(i) < y1 - 1e-6) pos.setY(i, Math.min(y0 + rake[k], y1 - 0.02));
  }
  geo.computeVertexNormals();
  return bakeColor(geo, col);
}

/**
 * A deck lid, so the open hull does not read as a trough from this camera — drawn in on the same
 * plan as the hull it sits in, so it cannot poke out through the bow where the hull narrows.
 * Half under the hull's top face and half over it, so the two never share a plane.
 */
function deckLid(length, beam, inset, y, plan, col) {
  const segs = plan.length - 1;
  const geo = new THREE.BoxGeometry(beam - inset * 2, 0.1, length - inset * 2, 1, 1, segs);
  geo.translate(0, y, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round((pos.getZ(i) / (length - inset * 2) + 0.5) * segs);
    pos.setX(i, pos.getX(i) * plan[k]);
  }
  return bakeColor(geo, col);
}

/** A box `w` × `h` × `d` with its base centred on (x, y, z) — what most of a boat is. */
function block(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  return bakeColor(geo, col);
}

/** A thin square rod from `a` to `b`: a stay, a shroud, a spreader. Rotation keeps the winding. */
function rod(a, b, t, col) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const geo = new THREE.BoxGeometry(t, t, dir.length());
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return bakeColor(geo, col);
}

/** A round spar lying along Z from `z0` up to `z1`, tapering `r0` → `r1`. */
function spar(z0, z1, r0, r1, y, col, sides = 8) {
  const geo = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), sides);
  // +Y onto +Z, so the cylinder's top (r1) ends up at the larger z.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y, (z0 + z1) / 2);
  return bakeColor(geo, col);
}

// --- The barge ---------------------------------------------------------------
//
// A **trash barge**: a rusty scow heaped with rubbish, a wheelhouse at the stern and gulls working
// the pile (`game/gulls.js`). It was a deck barge with containers, which was tidy and read as
// nothing in particular; a heap of bin bags with birds over it is a joke the player gets from
// across the map.

// Low in the water, the way a laden scow sits — and every unit the deck comes down is a unit the
// wheelhouse can stand taller under the same flat soffit.
const BARGE_FREEBOARD = 0.32;
const BARGE_DRAFT = 0.3;
// Square at the stern, **rounded at the bow**: twenty stations, so the last few can follow a
// quarter-ellipse over `BOW_ROUND` of the length rather than one raked step. It stops at a 0.38
// beam fraction instead of a point — a barge that came to a point would be a ship.
const BARGE_STATIONS = 21;
const BOW_ROUND = 2.4;
const BARGE_PLAN = [];
const BARGE_RAKE = [];
for (let k = 0; k < BARGE_STATIONS; k++) {
  const z = (k / (BARGE_STATIONS - 1) - 0.5) * BARGE_LEN;     // stern -L/2 to bow +L/2
  const toBow = BARGE_LEN / 2 - z;
  const u = Math.max(0, 1 - toBow / BOW_ROUND);             // 0 aft of the round, 1 at the stem
  BARGE_PLAN.push(k === 0 ? 0.95 : 0.38 + 0.62 * Math.sqrt(1 - u * u));
  BARGE_RAKE.push(k === 0 ? 0.2 : 0.24 * u * u);
}
/** Half the hull's beam at hull-frame `z`, off the same plan — for anything placed near the side. */
const halfBeamAt = (z) => {
  const k = Math.round((z / BARGE_LEN + 0.5) * (BARGE_STATIONS - 1));
  return (BARGE_BEAM / 2) * BARGE_PLAN[Math.max(0, Math.min(BARGE_STATIONS - 1, k))];
};
const BARGE_DECK_Y = BARGE_FREEBOARD + 0.05;   // top of the deck lid, where the load stands

/**
 * How high a gull may stand, measured to its feet. Everything on this hull has to clear the flat
 * span's soffit, 1.65 off the water (`FLAT_SOFFIT - WATER_Y`), and a gull perched on the heap rides
 * under it with the barge — so the heap is capped low enough that a bird standing on top of it
 * still fits. `GULL_STAND` is the bird's own height (game/gulls.js asserts the sum in the probe).
 */
export const GULL_STAND = 0.34;
export const PERCH_CEIL = 1.62 - GULL_STAND;

// The wheelhouse, at the stern. It is **not** a perch: it stands to `BARGE_AIR`, above the heap's
// ceiling, so a gull on its roof would put its head through the flat span.
const HOUSE_Z = -BARGE_LEN / 2 + 1.05;
const HOUSE_D = 1.25;
const HOUSE_W = 1.9;

/**
 * The barge: a scow, a heap and a wheelhouse, all under `BARGE_AIR`.
 *
 * Returns the geometry with `userData.perches` — points on top of the heap and on the bow, in the
 * hull's own frame (bow toward +Z), for the gulls to land on — and `userData.house`, the
 * wheelhouse, which game/boats.js draws as a mesh of its own in the cars' metal finish.
 */
export function createBargeMesh(rng) {
  const hullCol = jitterColor(PALETTE.trashHull, rng, { l: 0.03 });
  const deckCol = jitterColor(PALETTE.trashGrime, rng, { l: 0.03 });
  const ceil = Math.min(BARGE_AIR - 0.02, PERCH_CEIL);
  const perches = [];

  const parts = [
    hullPiece(BARGE_LEN, BARGE_BEAM, -BARGE_DRAFT, BARGE_FREEBOARD, BARGE_PLAN, BARGE_RAKE, hullCol),
    deckLid(BARGE_LEN, BARGE_BEAM, 0.14, BARGE_FREEBOARD, BARGE_PLAN, deckCol),
  ];

  // A low bulwark round the deck, a shade darker than the hull, so the heap sits *in* something.
  const wall = jitterColor(PALETTE.trashHull, rng, { l: 0.02 }).offsetHSL(0, 0, -0.04);
  // Straight down the sides, then round the bow on the hull's own curve in short pieces.
  const wallZ0 = -BARGE_LEN / 2 + 0.6;
  const wallZ1 = BARGE_LEN / 2 - BOW_ROUND;
  for (const side of [-1, 1]) {
    parts.push(block(0.12, 0.22, wallZ1 - wallZ0, side * (BARGE_BEAM / 2 - 0.2), BARGE_DECK_Y,
      (wallZ0 + wallZ1) / 2, wall));
  }
  const ring = [];
  for (let k = 0; k <= 8; k++) {
    const z = wallZ1 + (k / 8) * (BOW_ROUND - 0.25);
    ring.push(z);
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < ring.length - 1; k++) {
      const a = new THREE.Vector3(side * (halfBeamAt(ring[k]) - 0.2), BARGE_DECK_Y + 0.11, ring[k]);
      const b = new THREE.Vector3(side * (halfBeamAt(ring[k + 1]) - 0.2), BARGE_DECK_Y + 0.11, ring[k + 1]);
      parts.push(rod(a, b, 0.17, wall));
    }
  }
  const stem = ring[ring.length - 1];
  parts.push(block((halfBeamAt(stem) - 0.2) * 2 + 0.12, 0.22, 0.12, 0, BARGE_DECK_Y, stem, wall));

  // Tyres slung over the side as fenders — the detail in every picture of a working barge, and at
  // play zoom a row of dark dots along the waterline that says "boat" rather than "box".
  const fenders = 5;
  for (let k = 0; k < fenders; k++) {
    // Along the straight sides only: a tyre hung where the bow rounds in would hang in the air.
    const z = -BARGE_LEN / 2 + 1.2 + (k * (BARGE_LEN - BOW_ROUND - 1.8)) / (fenders - 1);
    for (const side of [-1, 1]) {
      const tyre = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 8);
      tyre.rotateZ(Math.PI / 2);
      tyre.translate(side * (BARGE_BEAM / 2 + 0.05), BARGE_FREEBOARD - 0.22, z + rng.jitter(0.15));
      parts.push(bakeColor(tyre, PALETTE.trashTyre));
    }
  }

  // --- The heap. A low mound first, so no deck shows between the pieces, then the rubbish on it.
  const z0 = HOUSE_Z + HOUSE_D / 2 + 0.25;
  const z1 = BARGE_LEN / 2 - 1.3;   // short of the round, where the hull is still near full beam
  const zc = (z0 + z1) / 2;
  const az = (z1 - z0) / 2;
  const ax = BARGE_BEAM / 2 - 0.4;
  const peak = ceil - BARGE_DECK_Y;
  const mound = new THREE.IcosahedronGeometry(1, 1);
  mound.scale(ax * 0.92, peak * 0.7, az * 0.95);
  mound.translate(0, BARGE_DECK_Y, zc);
  // Only the top half is wanted, and a scale cannot cut it — so the lower vertices are pressed flat
  // onto the deck. Moving a vertex up to a height still under its neighbours turns nothing over.
  const mp = mound.attributes.position;
  for (let k = 0; k < mp.count; k++) {
    if (mp.getY(k) < BARGE_DECK_Y) mp.setY(k, BARGE_DECK_Y - 0.02);
  }
  parts.push(bakeColor(mound, PALETTE.trashHeap));

  // The dome the pieces follow: full height at the middle, nothing at the edges.
  const heightAt = (x, z) => {
    const u = 1 - (x / ax) ** 2;
    const v = 1 - ((z - zc) / az) ** 2;
    return u > 0 && v > 0 ? peak * Math.sqrt(u * v) : 0;
  };
  const kinds = [
    { w: 0.7, col: PALETTE.trashBag, shape: 'bag' },
    { w: 0.7, col: PALETTE.trashBag, shape: 'bag' },
    { w: 0.7, col: PALETTE.trashBag, shape: 'bag' },
    { w: 0.65, col: PALETTE.trashBagGreen, shape: 'bag' },
    { w: 0.6, col: PALETTE.trashWhite, shape: 'bag' },
    { w: 0.6, col: PALETTE.trashBox, shape: 'box' },
    { w: 0.6, col: PALETTE.trashBox, shape: 'box' },
    { w: 0.45, col: PALETTE.trashJunk, shape: 'box' },
    { w: 0.5, col: PALETTE.trashTyre, shape: 'tyre' },
    { w: 0.42, col: PALETTE.trashBarrel, shape: 'barrel' },
    { w: 0.5, col: PALETTE.trashWhite, shape: 'box' },
  ];
  // Dense enough that the mound under them only shows in the gaps: a heap, not a deck with litter.
  const pieces = 85;
  for (let k = 0; k < pieces; k++) {
    const x = rng.range(-ax, ax) * 0.9;
    const z = zc + rng.range(-az, az) * 0.92;
    const kind = rng.pick(kinds);
    const sz = kind.w * rng.range(0.7, 1.15);
    const col = jitterColor(kind.col, rng, { l: 0.05, s: 0.03 });
    let geo;
    let h;
    if (kind.shape === 'bag') {
      geo = new THREE.IcosahedronGeometry(sz / 2, 0);
      h = sz * 0.8;
      geo.scale(1, 0.8, rng.range(0.9, 1.3));
    } else if (kind.shape === 'tyre') {
      geo = new THREE.CylinderGeometry(sz / 2, sz / 2, sz * 0.32, 8);
      h = sz * 0.32;
    } else if (kind.shape === 'barrel') {
      geo = new THREE.CylinderGeometry(sz * 0.38, sz * 0.38, sz, 8);
      h = sz;
    } else {
      geo = new THREE.BoxGeometry(sz, sz * rng.range(0.6, 1), sz * rng.range(0.8, 1.4));
      h = geo.parameters.height;
    }
    geo.rotateY(rng.range(0, Math.PI));
    // Bedded into the mound by a third of itself, and never poking through the ceiling.
    const base = BARGE_DECK_Y + heightAt(x, z) * 0.85 - h * 0.35;
    const y = Math.min(base, ceil - h);
    geo.translate(x, Math.max(BARGE_DECK_Y, y) + h / 2, z);
    parts.push(bakeColor(geo, col));
    // The tallest pieces near the middle make the perches.
    if (Math.abs(x) < ax * 0.6 && heightAt(x, z) > peak * 0.5) {
      perches.push({ x, y: Math.max(BARGE_DECK_Y, y) + h, z });
    }
  }

  // --- The wheelhouse: its own geometry, because it wears the cars' **metal** finish — a gloss
  // material is centred on one geometry's bounds, and the hull's flat-shaded paint is not one. It
  // stands to `BARGE_AIR`, which is as tall as the flat span lets anything on this boat be: a deck
  // 0.13 lower than it was and a roof no longer kept down for gulls bought it 0.32 of height.
  const roofTop = BARGE_AIR - 0.3;
  const roofY = roofTop - 0.11;
  const houseH = roofY - BARGE_DECK_Y;
  const steel = jitterColor(PALETTE.trashHouse, rng, { l: 0.03 });
  const metal = (g) => setFinish(g, FINISH.METAL);
  const house = merge([
    metal(block(HOUSE_W, houseH, HOUSE_D, 0, BARGE_DECK_Y, HOUSE_Z, steel)),
    // The windows: a band round the top of the house, proud of the walls by a hair so the two
    // never share a plane, in the cars' glass.
    setFinish(block(HOUSE_W + 0.03, 0.28, HOUSE_D + 0.03, 0, roofY - 0.38, HOUSE_Z, PALETTE.carGlass),
      FINISH.GLASS),
    metal(block(HOUSE_W + 0.16, 0.08, HOUSE_D + 0.16, 0, roofY, HOUSE_Z, steel.clone().offsetHSL(0, 0, -0.12))),
    metal(block(HOUSE_W + 0.04, 0.03, HOUSE_D + 0.04, 0, roofY + 0.08, HOUSE_Z, steel)),
  ]);

  // The smoke stack, up through the roof: dark, with a pale band and a black lip — the funnel
  // every working boat has. It is the tallest thing aboard and stops at `BARGE_AIR` exactly. It
  // stood off the back wall at first and the house hid it whenever the boat ran away from the
  // camera; through the roof it shows both ways, which is what the roof's lower line pays for.
  const stackTop = BARGE_AIR - 0.02;
  const stackX = 0.4;
  const stackZ = HOUSE_Z - 0.2;
  const stackH = stackTop - BARGE_DECK_Y;
  const stack = new THREE.CylinderGeometry(0.2, 0.2, stackH - 0.06, 10);
  stack.translate(stackX, BARGE_DECK_Y + (stackH - 0.06) / 2, stackZ);
  parts.push(bakeColor(stack, PALETTE.trashStack));
  const band = new THREE.CylinderGeometry(0.215, 0.215, 0.09, 10);
  band.translate(stackX, stackTop - 0.14, stackZ);
  parts.push(bakeColor(band, PALETTE.trashWhite));
  const lip = new THREE.CylinderGeometry(0.225, 0.225, 0.06, 10);
  lip.translate(stackX, stackTop - 0.03, stackZ);
  parts.push(bakeColor(lip, PALETTE.trashTyre));

  // ...and the bow, on the stem where the bulwark comes round: a bird on the very front of the boat.
  perches.push({ x: 0, y: BARGE_DECK_Y + 0.22, z: stem });

  const geo = merge(parts);
  geo.userData.perches = perches;
  geo.userData.house = house;
  return geo;
}

// --- The sailboat --------------------------------------------------------------
//
// The boat that asks for the lift. It used to be a tug, and a tug's wheelhouse and mast read as
// "a boat" without saying *why* this one needs the bridge out of the way when the barge does not.
// A sailboat's mast says it on sight: a white hull, sails down and furled along the boom, and a
// stick standing far taller than anything else on the water. The simulation still calls it the
// tug (`TUG_AIR`, `TUG_LEN`, `kind: 'tug'`) — it is the same boat to everything but the eye.

const SAIL_FREEBOARD = 0.5;
const SAIL_DRAFT = 0.3;
// Where the white topsides meet the blue stripe. High enough that a band of it shows above the
// water: at 0.07 it sat under the surface and the hull read as white all the way down.
const BOOT_Y = 0.17;
// A yacht's planform: a wide transom, fullest just aft of the middle, and a fine entry to a point.
const SAIL_PLAN = [0.8, 0.95, 1, 0.97, 0.82, 0.5, 0.06];
const SAIL_RAKE = [0.06, 0, 0, 0.02, 0.1, 0.22, 0.32];
const SAIL_DECK_Y = SAIL_FREEBOARD + 0.05;
const MAST_Z = TUG_LEN * 0.12;

/**
 * The sailboat: short, white, and the one that has to ask.
 *
 * **The masthead is placed at `TUG_AIR`, not measured afterwards.** It is the tallest thing on the
 * boat and the only number in the clearance chain a bit of styling could quietly break: a first
 * cut of the old tug with a mast eyeballed on top came out at 2.81, which was over the 2.75 an
 * arched span left at the time, and would have left it unable to reach the drawbridge at all. Hanging the
 * mast off the constant means the geometry cannot disagree with the chain — and everything else up
 * there (stays, spreaders) is hung off the masthead and stops short of it.
 *
 * `TUG_AIR` is capped by the two *arched* spans the boat has to sail under unopened, so the arch
 * rise is the real ceiling on how big this mast can look.
 */
export function createTugMesh(rng) {
  const L = TUG_LEN;
  const white = jitterColor(PALETTE.sailHull, rng, { l: 0.015, s: 0.01 });
  const trim = jitterColor(PALETTE.sailTrim, rng, { l: 0.03 });
  // White on deck as well as on the topsides: a glass-fibre boat. The barge's tan deck here made the
  // hull read as a white rim round a brown boat.
  const deckCol = jitterColor(PALETTE.sailHull, rng, { l: 0.04, s: 0.01 }).offsetHSL(0, 0, -0.06);

  const parts = [
    hullPiece(L, TUG_BEAM, -SAIL_DRAFT, BOOT_Y, SAIL_PLAN, SAIL_RAKE, trim),
    hullPiece(L, TUG_BEAM, BOOT_Y, SAIL_FREEBOARD, SAIL_PLAN, null, white),
    deckLid(L, TUG_BEAM, 0.12, SAIL_FREEBOARD, SAIL_PLAN, deckCol),
  ];

  // The coachroof: a low white cabin aft of the mast, with a dark band of windows down each side.
  // The band is a hair wider and shorter than the cabin, so no face of one lies on a face of the
  // other.
  const cabinZ = -L * 0.1;
  parts.push(block(1.25, 0.32, L * 0.36, 0, SAIL_DECK_Y, cabinZ, white));
  parts.push(block(1.27, 0.1, L * 0.36 - 0.25, 0, SAIL_DECK_Y + 0.12, cabinZ, PALETTE.rigging));

  // The mast, from the deck to `TUG_AIR` exactly.
  const foot = SAIL_DECK_Y;
  const mastH = TUG_AIR - foot;
  const mast = new THREE.CylinderGeometry(0.055, 0.09, mastH, 8);
  mast.translate(0, foot + mastH / 2, MAST_Z);
  parts.push(bakeColor(mast, PALETTE.mast));

  // Spreaders, three fifths of the way up, and the shrouds over them to the deck edge.
  const top = new THREE.Vector3(0, TUG_AIR - 0.06, MAST_Z);
  const sprY = foot + mastH * 0.6;
  const sprW = 0.5;
  parts.push(rod(new THREE.Vector3(-sprW, sprY, MAST_Z), new THREE.Vector3(sprW, sprY, MAST_Z), 0.04, PALETTE.mast));
  for (const side of [-1, 1]) {
    const tip = new THREE.Vector3(side * sprW, sprY, MAST_Z);
    const chain = new THREE.Vector3(side * (TUG_BEAM / 2 - 0.25), SAIL_DECK_Y, MAST_Z - 0.2);
    parts.push(rod(top, tip, 0.03, PALETTE.rigging));
    parts.push(rod(tip, chain, 0.03, PALETTE.rigging));
  }

  // Forestay to the stemhead and backstay to the transom: the two lines that make the triangle,
  // and the triangle is what says "sailboat" from across the map. The forestay carries the jib,
  // rolled up round it, so it is drawn as a thin white spar rather than as wire.
  const stem = new THREE.Vector3(0, SAIL_DECK_Y, L / 2 - 0.15);
  const transom = new THREE.Vector3(0, SAIL_DECK_Y, -L / 2 + 0.15);
  parts.push(rod(top, stem, 0.08, white));
  parts.push(rod(top, transom, 0.03, PALETTE.rigging));

  // The boom, and the mainsail lowered onto it under a blue cover: fat at the mast where the sail
  // is bunched up, thinning aft. This is "sails down" — the one shape on the boat that is not a
  // stick or a box.
  const boomY = SAIL_DECK_Y + 0.6;
  const boomAft = -L / 2 + 0.45;
  parts.push(spar(boomAft, MAST_Z - 0.02, 0.04, 0.04, boomY, PALETTE.mast, 6));
  parts.push(spar(boomAft + 0.25, MAST_Z - 0.08, 0.08, 0.17, boomY + 0.12, trim, 8));

  return merge(parts);
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}
