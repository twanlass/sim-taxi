import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BODY_EULER_ORDER, bakeColor, hash01, propMaterial, stampEntry } from '../util/geo.js';
import { color } from '../palette.js';
import { LANE_TO_KERB } from './grid.js';
import { KERB_H } from './ground.js';
import { cityNetwork } from './roadnet.js';
import { clearOf } from './vetclinic.js';

// The donut shop: one of the city's ordinary corner shops with a giant cake donut standing on its
// roof — pink frosting, sprinkles — and a police cruiser parked out front with two wheels up on the
// kerb. Tyler asked for it on 2026-11-26 ("We should have a cop parked in front lol").
//
// **Built the way the vet clinic is** (city/vetclinic.js), and for the same reasons: the building
// is whatever the tower generator put there, `chooseDonutSite` picks it afterwards by hash, so it
// spends no draw and moves nothing in the skyline. The shop is a one-tier flat roof on a block's
// **+X+Z corner lot** — the corner that faces the camera — with both its sightlines clear: the donut
// over the roof, and the cruiser at the kerb. `?donut=classic` leaves both off.
//
// **The donut is static, so it rides the entrance wave's shader** (one stamped mesh with its two
// legs). The burger turns and the dog cocks its head, and both had to be CPU-grown objects for it;
// a donut stood on edge reads best square to the camera and would only lose its hole by turning.
//
// **The cruiser is the patrol cruiser's own body** (`policeGeometry`, sim/police.js) with its bar
// dark — off duty, on a donut run — parked the way the ambient pull-over parks a car: kerb-side
// wheels up on the pavement, the body leaning toward the road. Up on the kerb is the joke and also
// the arithmetic: a car parked *at* the kerb sits 0.35 into the lane beside it, where traffic would
// drive through it (ambient cars do not collide with scenery). See CAR_OUT.

/** `?donut=classic` — the shop stays a plain shop, and no cruiser. */
export const DONUT_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('donut') === 'classic';

// --- The donut --------------------------------------------------------------------------------

/**
 * The ring's radius (centre of the tube) and the tube's. 2.15 across the outside — 4.3 units, about
 * 33px at play zoom, the dog's head's size — with a fat tube and a small hole, because that is what
 * a *cake* donut looks like next to a yeast ring. The hole is still 1.1 across, ~8px: enough to see
 * the sky or the street through it, which is the whole of what says donut rather than disc.
 */
export const RING_R = 1.35;
export const TUBE_R = 0.8;
const OUTER_R = RING_R + TUBE_R;
/** How far the frosting stands proud of the cake: a ledge you can see at the edge, not a decal. */
const FROST_T = 0.07;
/**
 * Deck to the donut's lowest point: up on its legs, clear of the tallest plant room (1.6), so the
 * only things on the roof it has to keep off are its own two feet. The first cut sat it 0.35 off the
 * deck and had to find a 3.2-unit square of bare roof for it, which 11 seeds in 40 did not have.
 */
const LIFT = 1.75;
/** The legs stand this far either side of the ring's centre, along its across-axis. */
const LEG_SPREAD = RING_R * 0.62;
/**
 * Which way the frosted face looks: the camera's bearing (π/4), swung 0.3 rad towards +Z so the
 * tube's flank shows past the rim — square on, a donut is a flat pink ring and loses its thickness.
 * Towards +Z rather than +X because that is where the golden-hour sun is (azimuth 56°, game/scene.js):
 * swung the other way the frosting faced 40° off it and came out a shaded mauve rather than pink.
 */
const DONUT_YAW = Math.PI / 4 - 0.3;
/** ...tipped back towards a camera 33° above, a little under half way, so it still stands up. */
const DONUT_TILT = 0.28;
const SEG_RING = 44;
const SEG_TUBE = 18;
/** The ring's own triangles, which come first in `donutGeometry` — the probe's winding check walks these. */
export const DONUT_BODY_TRIS = SEG_RING * SEG_TUBE * 2;
const SPRINKLES = 64;
const SPRINKLE_LEN = 0.26;
const SPRINKLE_W = 0.065;

/**
 * Half the frosting's reach round the tube, from the front of the face, at ring angle `u`. Wavy, and
 * longer in a few places, so the outer edge drips. Periodic in `u`, so the seam at 0/2π agrees.
 */
function frostReach(u) {
  const drip = Math.max(0, Math.sin(5 * u + 0.7)) ** 6 * 0.45 + Math.max(0, Math.sin(3 * u + 2.1)) ** 8 * 0.3;
  return 1.2 + 0.12 * Math.sin(11 * u) + 0.06 * Math.sin(17 * u + 1.3) + drip;
}

/** Angular distance round the tube from the middle of the frosted face (v = π/2), 0..π. */
const fromFront = (v) => Math.abs(Math.atan2(Math.sin(v - Math.PI / 2), Math.cos(v - Math.PI / 2)));

/** A point on the donut's surface at ring angle `u`, tube angle `v`, tube radius `r`. +Z is the face. */
function surface(u, v, r) {
  const k = RING_R + r * Math.cos(v);
  return new THREE.Vector3(k * Math.cos(u), k * Math.sin(u), r * Math.sin(v));
}

/**
 * The donut, about its own centre, with the frosted face towards +Z. One geometry, colour per face:
 * cake, the paler fried band round the outside where the frosting does not reach, frosting proud of
 * both, and the sprinkles as tiny boxes half sunk into it.
 *
 * The frosting is the *same surface* lifted by FROST_T where it is frosted — not a second shell laid
 * over the cake — so there is nothing coplanar to fight, and the step between the two radii is the
 * frosting's edge. The sprinkles are geometry rather than a shader: 64 boxes is 768 triangles in the
 * same mesh and draw call, a sprinkle is a 2px stroke at play zoom (a fragment-shader fleck would be
 * a texture lookup on every pixel of the donut to say the same thing), and a box casts its own
 * crumb of shadow in the close-up.
 */
export function donutGeometry() {
  const cake = color('donutCake');
  const band = color('donutBand');
  const frost = color('donutFrosting');
  // Indexed grid first, so the normals come out smooth; the colours go on per face afterwards.
  const pos = [];
  const frosted = [];
  for (let j = 0; j <= SEG_TUBE; j++) {
    const v = (j / SEG_TUBE) * Math.PI * 2;
    for (let i = 0; i <= SEG_RING; i++) {
      const u = (i / SEG_RING) * Math.PI * 2;
      const f = fromFront(v) < frostReach(u);
      frosted.push(f);
      const p = surface(u, v, TUBE_R + (f ? FROST_T : 0));
      pos.push(p.x, p.y, p.z);
    }
  }
  const index = [];
  const faceCol = [];
  const row = SEG_RING + 1;
  for (let j = 0; j < SEG_TUBE; j++) {
    for (let i = 0; i < SEG_RING; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // Wound counter-clockwise seen from outside: (u, v) increasing is right-handed with the
      // outward normal (the probe checks it from the winding, not from computeVertexNormals).
      index.push(a, b, d, a, d, c);
      const all = frosted[a] && frosted[b] && frosted[c] && frosted[d];
      const v = ((j + 0.5) / SEG_TUBE) * Math.PI * 2;
      // The fried band: the outside of the ring, round its equator, where a cake donut floats in the
      // oil and comes out paler.
      const col = all ? frost : Math.abs(Math.sin(v)) < 0.28 && Math.cos(v) > 0 ? band : cake;
      faceCol.push(col, col);
    }
  }
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  grid.setIndex(index);
  grid.computeVertexNormals();
  const body = grid.toNonIndexed();
  grid.dispose();
  const colors = new Float32Array(body.attributes.position.count * 3);
  faceCol.forEach((c, f) => {
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (f * 3 + k) * 3);
  });
  body.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const parts = [body];
  const tints = ['donutSprinkleA', 'donutSprinkleB', 'donutSprinkleC', 'donutSprinkleD', 'donutSprinkleE']
    .map((name) => color(name));
  // A fixed sequence rather than the city's rng — the donut is the same donut in every city, and a
  // draw here would reshuffle whatever generator it was taken from.
  let seed = 7;
  const next = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const up = new THREE.Vector3();
  for (let n = 0, tries = 0; n < SPRINKLES && tries < SPRINKLES * 20; tries++) {
    const u = next() * Math.PI * 2;
    const v = Math.PI / 2 + (next() * 2 - 1) * 1.05;
    // Clear of the frosting's edge by a sprinkle's half-length, so none hangs off onto the cake.
    if (fromFront(v) > frostReach(u) - 0.3) continue;
    const p = surface(u, v, TUBE_R + FROST_T);
    const normal = p.clone().sub(new THREE.Vector3(RING_R * Math.cos(u), RING_R * Math.sin(u), 0)).normalize();
    const dir = new THREE.Vector3(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1);
    dir.addScaledVector(normal, -dir.dot(normal)).normalize();
    up.crossVectors(normal, dir);
    const box = new THREE.BoxGeometry(SPRINKLE_LEN, SPRINKLE_W, SPRINKLE_W);
    // Long axis along `dir`, flat against the frosting, sunk to two-thirds so it sits *in* it.
    box.applyMatrix4(new THREE.Matrix4().makeBasis(dir, normal, up.clone().negate()));
    box.translate(p.x + normal.x * SPRINKLE_W * 0.15, p.y + normal.y * SPRINKLE_W * 0.15, p.z + normal.z * SPRINKLE_W * 0.15);
    parts.push(bakeColor(box, tints[n % tints.length]));
    n++;
  }
  // Every part down to position/normal/colour, so they merge.
  for (const g of parts) {
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return geo;
}

/**
 * The donut and its legs, placed on the roof: the ring stood on edge at `spot`, turned and tipped
 * to the camera, on two steel legs from the deck up into the underside of the tube.
 */
export function donutSignGeometry(spot, deck) {
  const donut = donutGeometry();
  const turn = new THREE.Euler(-DONUT_TILT, DONUT_YAW, 0, 'YXZ');
  const centre = new THREE.Vector3(spot.x, deck + LIFT + OUTER_R, spot.z);
  donut.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(turn));
  donut.translate(centre.x, centre.y, centre.z);
  const parts = [donut];
  // The legs: either side of the bottom of the ring, along its own across-axis, each rising to meet
  // the tube where it is still well inside it.
  const across = new THREE.Vector3(1, 0, 0).applyEuler(turn);
  across.y = 0;
  across.normalize();
  for (const s of [-1, 1]) {
    const lx = centre.x + across.x * s * LEG_SPREAD;
    const lz = centre.z + across.z * s * LEG_SPREAD;
    const top = centre.y - OUTER_R * 0.62;
    const h = top - deck;
    const leg = new THREE.CylinderGeometry(0.09, 0.12, h, 6);
    leg.translate(lx, deck + h / 2, lz);
    parts.push(bakeColor(leg, color('pole')));
  }
  for (const g of parts) {
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
  }
  const geo = mergeGeometries(parts, false);
  parts.slice(1).forEach((g) => g.dispose());
  donut.dispose();
  return { geometry: geo, centre };
}

// --- The cruiser's parking space --------------------------------------------------------------

/**
 * The cruiser's centre, out from the kerb line onto the road. Its kerb-side wheels (track 1.4) are
 * then 0.35 onto the pavement and its road-side flank 1.2 out, against the 1.4 at which the flank of
 * a car driving the lane beside it passes (LANE_TO_KERB 2.25 less half of CAR_W 1.7).
 */
export const CAR_OUT = 0.35;
/** Half the wheel track (wheelAnchors at CAR_W): what the lean is worked out from. */
const HALF_TRACK = 0.7;
/** Kerb-side wheels up by a kerb's height over the track: about 14°. */
export const CAR_ROLL = Math.atan2(KERB_H, HALF_TRACK * 2);
/** ...and the body's centre up by half of that. */
export const CAR_LIFT = KERB_H / 2;
/** The cruiser's drawn half-length, bumpers in. */
const CAR_HALF = 1.85;
/**
 * The nose's distance back from the block's corner. A rider stands on the corner (game/fares.js)
 * and the board puts a disc round them; parked in that, the cruiser hides the job.
 */
export const CORNER_CLEAR = 3;
/** How far the cruiser's front wheels are turned in to the kerb — parked, not stopped. */
export const KERB_LOCK = 0.32;

/**
 * Where the cruiser parks beside `tower`'s face on `side` (0 = +X, 1 = +Z), or null.
 *
 * Driving the way the traffic beside that kerb drives — on the right, so +Z along a +X face and −X
 * along a +Z face — with its nose towards the block's corner. The lane it is beside has to really
 * be there and run the whole length of the car: a block's edge is not a road where a park has
 * closed it (`isParkBlock` districts).
 */
function parkingSpot(tower, side) {
  const b = tower.block.bounds;
  const net = cityNetwork();
  if (!net) return null;
  const heading = side === 0 ? { x: 0, z: 1 } : { x: -1, z: 0 };
  const kerb = side === 0 ? b.x1 : b.z1;
  // Along the face: the middle of the shop, unless that puts the nose inside CORNER_CLEAR.
  const along = side === 0
    ? Math.min(tower.cz, b.z1 - CORNER_CLEAR - CAR_HALF)
    : Math.max(tower.cx, b.x0 + CORNER_CLEAR + CAR_HALF);
  // Mostly in front of the shop it is visiting.
  const [lo, hi] = side === 0 ? [tower.z0, tower.z1] : [tower.x0, tower.x1];
  if (along < lo - 0.5 || along > hi + 0.5) return null;
  const x = side === 0 ? kerb + CAR_OUT : along;
  const z = side === 0 ? along : kerb + CAR_OUT;
  const lane = net.lanes.find((l) => {
    if (!l.path || l.path.kind !== 'line' || l.edge.oneway) return false;
    const t = l.path.tangentAt(0);
    if (t.x * heading.x + t.z * heading.z < 0.999) return false;
    const p = l.path.at(0);
    const q = l.path.at(l.length);
    // On this kerb: its centre LANE_TO_KERB out from it.
    const off = side === 0 ? p.x - kerb : p.z - kerb;
    if (Math.abs(off - LANE_TO_KERB) > 0.05) return false;
    // And running past the whole car, rear bumper to nose.
    const [s0, s1] = side === 0 ? [p.z, q.z] : [-p.x, -q.x];
    const a = side === 0 ? along : -along;
    return s0 <= a - CAR_HALF && s1 >= a + CAR_HALF;
  });
  if (!lane) return null;
  return { x, z, side, yaw: side === 0 ? -Math.PI / 2 : Math.PI, lane: lane.id, kerb };
}

/** The legs' feet for a donut centred over (x, z): its across-axis is the turn's local X, flattened. */
function feet(x, z) {
  const ax = Math.cos(DONUT_YAW);
  const az = -Math.sin(DONUT_YAW);
  return [-1, 1].map((s) => ({ x: x + ax * s * LEG_SPREAD, z: z + az * s * LEG_SPREAD }));
}

/**
 * Where on the roof the donut stands: the middle, unless a foot would land on the plant room or off
 * the deck. It is up over everything else (LIFT), so its feet are all that has to find room.
 */
function donutSpot(deck) {
  const tries = [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
  const ax = Math.max(0, deck.cw / 2 - 1.2);
  const az = Math.max(0, deck.cd / 2 - 1.2);
  const onDeck = (f) => Math.abs(f.x - deck.cx) < deck.cw / 2 - 0.45 && Math.abs(f.z - deck.cz) < deck.cd / 2 - 0.45;
  const free = (f) => deck.keep.every((k) => f.x < k.x0 - 0.25 || f.x > k.x1 + 0.25 || f.z < k.z0 - 0.25 || f.z > k.z1 + 0.25);
  for (const [fx, fz] of tries) {
    const x = deck.cx + fx * ax;
    const z = deck.cz + fz * az;
    if (feet(x, z).every((f) => onDeck(f) && free(f))) return { x, z };
  }
  return null;
}

/**
 * Pick the city's donut shop from the towers `createBuildings` built, or null.
 *
 * By hash, after everything else is decided — the same contract as `chooseVetSite`. `taken` is the
 * decks already spoken for (the helipad, the vet's roof); the vet's whole tower is passed too, so
 * the dog and the donut never share a shop.
 */
export function chooseDonutSite(towers, taken = [], { exclude = [] } = {}) {
  const candidates = [];
  for (const t of towers) {
    if (t.tiers !== 1 || !t.deck || taken.includes(t.deck) || exclude.includes(t)) continue;
    if (!t.streetSides.includes(0) || !t.streetSides.includes(1) || !t.block?.bounds) continue;
    if (Math.min(t.deck.cw, t.deck.cd) < 2.4) continue;
    const spot = donutSpot(t.deck);
    if (!spot) continue;
    const ring = { x: spot.x, y: t.deck.deck + LIFT + OUTER_R * 0.4, z: spot.z };
    if (!clearOf(towers, t, ring)) continue;
    // +X first: the sunny face (FACING in buildings.js).
    const car = [0, 1].map((s) => parkingSpot(t, s))
      .find((c) => c && clearOf(towers, t, { x: c.x, y: 1.2, z: c.z }));
    if (!car) continue;
    candidates.push({ tower: t, spot, car });
  }
  if (!candidates.length) return null;
  // Its own hash, off a different pair of primes from the vet's, so the two do not walk together.
  const sx = candidates.reduce((n, c) => n + c.tower.cx, 0);
  const sz = candidates.reduce((n, c) => n + c.tower.cz, 0);
  const pick = candidates[Math.floor(hash01(sx * 0.53, sz * 0.29) * candidates.length) % candidates.length];
  const { tower, spot, car } = pick;
  // The birds roost on decks and walk round what stands on them (game/birds.js).
  for (const f of feet(spot.x, spot.z)) tower.deck.keep.push({ x0: f.x - 0.3, x1: f.x + 0.3, z0: f.z - 0.3, z1: f.z + 0.3 });
  const [cx, cz] = car.side === 0 ? [0, 1] : [-1, 0];
  return {
    spot, car, tower, deck: tower.deck.deck,
    roof: tower.deck,
    bounds: { x0: tower.x0, x1: tower.x1, z0: tower.z0, z1: tower.z1 },
    anchor: { x: tower.cx, z: tower.cz, rand: hash01(tower.cx, tower.cz) },
    /**
     * The cruiser's footprint on the ground, a little generous, for everything else placed along a
     * kerb to keep off: the lamps, the post boxes, the bag piles, the roadworks.
     */
    carRect: {
      x0: car.x - (car.side === 0 ? 1.2 : CAR_HALF + 0.4), x1: car.x + (car.side === 0 ? 1.2 : CAR_HALF + 0.4),
      z0: car.z - (car.side === 0 ? CAR_HALF + 0.4 : 1.2), z1: car.z + (car.side === 0 ? CAR_HALF + 0.4 : 1.2),
    },
    /** Points along the cruiser, and a little past each end, for keep-outs that only take points. */
    carPoints: [-3, -1.5, 0, 1.5, 3].map((k) => ({ x: car.x + cx * k, z: car.z + cz * k })),
    // Where to point a camera: between the shop's corner and the cruiser.
    focus: { x: (tower.x1 + car.x) / 2, z: (tower.z1 + car.z) / 2 },
  };
}

// --- Building it ------------------------------------------------------------------------------

/**
 * The shop's additions: the donut on its legs (one lit, stamped mesh — static, so it rides the
 * entrance wave's shader), and the parked cruiser (`cruiser`, a group, grown on the CPU through
 * `entryObject` because it carries a transform of its own).
 *
 * `makeCruiser` builds the car's meshes about its own origin, nose down +X — sim/police.js's
 * `parkedCruiser`, passed in rather than imported so this module stays out of the traffic model's
 * import graph for the tools that only build the city.
 */
export function createDonutShop(site, { makeCruiser = null } = {}) {
  const { anchor } = site;
  const { geometry, centre } = donutSignGeometry(site.spot, site.deck);
  stampEntry(geometry, anchor.x, anchor.z, anchor.rand);
  const sign = new THREE.Mesh(geometry, propMaterial({ smooth: true }));
  sign.castShadow = true;
  sign.receiveShadow = true;
  sign.name = 'donut-sign';

  const group = new THREE.Group();
  group.name = 'donut-shop';
  group.add(sign);

  let cruiser = null;
  if (makeCruiser) {
    cruiser = makeCruiser({ kerbLock: KERB_LOCK });
    cruiser.group.name = 'donut-cruiser';
    cruiser.group.rotation.order = BODY_EULER_ORDER;
    // Kerb side is the car's local +Z (traffic keeps right, and +X forward / +Y up puts +Z on the
    // right — see the roadworks trap in CLAUDE.md); a negative roll about the long axis lifts it.
    cruiser.group.rotation.set(-CAR_ROLL, site.car.yaw, 0);
    cruiser.group.position.set(site.car.x, CAR_LIFT, site.car.z);
    group.add(cruiser.group);
  }

  const carAnchor = { x: site.car.x, z: site.car.z, rand: anchor.rand };
  return {
    site, group, sign, cruiser, centre,
    /** Stamped meshes, for the entrance wave. */
    meshes: [sign],
    /** For the AO prepass. */
    occluders: [sign, ...(cruiser?.occluders ?? [])],
    entryObjects: cruiser ? [{ object: cruiser.group, x: carAnchor.x, z: carAnchor.z, rand: carAnchor.rand }] : [],
  };
}
