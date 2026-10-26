import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { LOT_Y, PAINT_Y, box, disc, roadsideCorner, span, wordParts } from './roadside.js';

// The car wash: a wash tunnel with its brushes turning, a lot out front with vacuum bays and a
// pay kiosk, a pylon sign, and an inflatable tube man flailing on the corner (game/tubeman.js) —
// which is what it is here for. Tyler wanted the tube man on a business of his own rather than on
// the burger joint's corner (2026-10-17), and a car wash is where they live.
//
// One of the two businesses the roadside block can be (city/roadside.js picks the block, and says
// which business by `?roadside=`): this one is the default. Scenery only for now — no car goes
// through the tunnel and nothing routes into it.
//
// **Which way it faces is settled by the camera**, as the joint's is. Only +X and +Z faces are ever
// seen, so the tunnel stands against the block's −Z edge with its long side open to +Z, and the
// lot, the sign and the tube man are all in front of it. A car would go through −X to +X and
// come out of the end the camera faces.

/** The tunnel's floor, over the lot. */
const FLOOR_Y = LOT_Y + 0.02;

// --- The tunnel, in block-local terms -----------------------------------------
const TUN_SIDE = 1.0;            // off the block's −X and −Z edges
const TUN_END = 1.4;             // short of its +X edge: the exit apron
const TUN_D = 3.4;               // deep, along Z
/**
 * Eaves height, and it is a sightline rather than a proportion. The long +Z side is open so the
 * brushes show, and a sightline into it climbs 0.92 per unit of z on its way out under the roof:
 * the top brush, 2 up and 1.7 in from the open side, needs 2 + 1.56 = 3.56 of headroom to be seen.
 * At 3.0 the roof hid it entirely.
 */
const ROOF_H = 3.6;
const ROOF_T = 0.25;
const FASCIA_H = 0.9;
const WALL_T = 0.2;
const POST = 0.24;

// --- The lot --------------------------------------------------------------------
const LOT_INSET = 0.3;
const SIGN_IN = 1.0;
const SIGN_H = 5.6;              // to the panel's middle (`?washsign=classic`)
const VAC_BACK = 1.3;            // the vacuum posts, back from the +Z kerb

// --- The brushes -------------------------------------------------------------------
const BRUSH_R = 0.55;
const BRUSH_H = 2.3;
/** Radians per second. A real wash brush turns at about two revolutions a second; this is half. */
export const BRUSH_SPIN = 6.5;
const FINS = 10;

// --- The elephant (default) --------------------------------------------------------
// A squat pink elephant cut out of board on a pole, its trunk bobbing up and down and spraying a
// cutout jet of water with blue neon bulbs that chase on at the top of every bob: a nod to
// Seattle's Elephant Car Wash, which Tyler asked for by name (2026-10-26) — the sign, not the water.
// Built like the garage's taxi cutout — extruded `Shape`s, so three winds them — and for the same
// reason it sways rather than turns: a board edge-on is a line. `?washsign=classic` keeps the blue
// WASH panel it replaced.

/** `?washsign=classic` — the blue pylon panel spelling WASH, as it was before the elephant. */
export const WASH_SIGN_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('washsign') === 'classic';

/**
 * The silhouette's whole scale. Authored 6.9 by 4.5, spray to tail and feet to spray, and drawn at
 * 0.72: 5.0 across is 38px at play zoom, about the burger's 40 — a sign over the lot rather than a
 * statue on it.
 */
const ELE_SCALE = 0.72;
/** The feet's height over the lot. Clear of the vacuum posts (2.5) the board's end swings over. */
const ELE_FOOT = 3.0;
// Board thickness and chamfer, as the taxi cutout's.
const ELE_T = 0.3;
const ELE_BEVEL = 0.05;
/** How far the pale rim stands out round the board's edge — the photo's neon, as paint. */
const ELE_RIM = 0.1;
/** How much thinner each overlapping piece of the board is than the one before (`elephantGeometry`). */
const ELE_STEP = 0.008;
/** What is stuck on the front face stands this proud of it; the pupil twice that. */
const ELE_PROUD = 0.04;
// How much of the board's own pink it gives off, for the cutout's reason (`BOARD_LIFT` in
// city/garage.js): a face turned from the sun goes lilac under the shadow tint without it.
const ELE_LIFT = 0.35;
const SPRAY_LIFT = 0.5;
// The sway: facing the camera's diagonal and swinging a few degrees either side of it, slowly — a
// sign turning in the wind on its bearing, not a turntable. 0.14 rad is 8°; 0.55 rad/s of phase is
// about eleven seconds there and back.
const ELE_FACING = Math.PI / 4;
const ELE_SWAY = 0.14;
export const ELE_SWAY_RATE = 0.55;
// The trunk's bob, about its root in the head: this far up and down (0.1 rad is 6°), at this rate
// (2.2 rad/s of phase is just under three seconds a bob). Down here so the spray reads as the trunk
// lifting to blow, not as the sign wobbling — the sway is four times slower.
const TRUNK_BOB = 0.1;
export const TRUNK_BOB_RATE = 2.2;
/** Where the trunk pivots, in authored units: inside the head, so the join never opens. */
const TRUNK_ROOT = [-1.95, 1.8];
// The neon bulbs down the spray: dark until the bob passes BULB_FROM of its lift, then on one at a
// time outward along each jet across BULB_SPAN more of it, so they chase out of the trunk as it
// tops out and run back in as it drops. A cheesy sign's water, not water.
const BULBS_PER_JET = 5;
const BULB_FROM = 0.5;
const BULB_SPAN = 0.4;

/**
 * A stroke as a closed outline: a Catmull-Rom through `pts`, `w0` wide at its start tapering to
 * `w1`, with a round end. The trunk and the tail.
 */
function strokeShape(pts, w0, w1) {
  const curve = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const n = 24;
  const left = [];
  const right = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const p = curve.getPoint(u);
    const t = curve.getTangent(u);
    const w = (w0 + (w1 - w0) * u) / 2;
    left.push(new THREE.Vector2(p.x - t.y * w, p.y + t.x * w));
    right.push(new THREE.Vector2(p.x + t.y * w, p.y - t.x * w));
  }
  // The round end: a half circle from the left edge to the right one, round the tip.
  const tip = curve.getPoint(1);
  const end = curve.getTangent(1);
  const a0 = Math.atan2(end.x, -end.y);
  const cap = [];
  for (let k = 1; k < 8; k++) {
    const a = a0 - (k / 8) * Math.PI;
    cap.push(new THREE.Vector2(tip.x + Math.cos(a) * w1 / 2, tip.y + Math.sin(a) * w1 / 2));
  }
  return new THREE.Shape([...left, ...cap, ...right.reverse()]);
}

const ellipseShape = (x, y, rx, ry) => new THREE.Shape().absellipse(x, y, rx, ry, 0, Math.PI * 2, false, 0);
const rectShape = (x0, x1, y0, y1) => new THREE.Shape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  .map(([x, y]) => new THREE.Vector2(x, y)));

/**
 * The silhouette, side-on, facing −x (screen left once turned to the camera), as the pieces it is
 * cut from: a round body, a head set high on its front, four legs, the trunk hanging and curling up
 * at the tip, and a tail.
 *
 * **A picture-book elephant, not the photo's pose.** The first cut followed the photo — one outline,
 * the trunk raised off the forehead and arched over the back, two legs, CAR WASH across the body —
 * and Tyler's verdict was that it did not look like an elephant at all. A real sign gets away with
 * that pose because it is twenty feet of neon; at 32 pixels the arch merged with the head, the two
 * legs read as a plinth, and the letters were noise. What says "elephant" at this size is the
 * trunk hanging free of everything, the ear as its own big shape, and four legs with sky between.
 *
 * Pieces rather than one outline because a union of circles and a stroke is not something `Shape`
 * can do; they overlap at one depth, and an overlap of one colour on one plane is not a fight
 * (tools/zfight.mjs agrees: it only counts surfaces of different colours).
 */
function elephantPieces() {
  return [
    ellipseShape(0.55, 1.45, 2.0, 1.15),
    ellipseShape(-1.4, 2.2, 0.95, 0.95),
    // Stumpy legs: wide, and showing only 0.3 to 0.75 below the belly. The first elephant's stood
    // 1.4 tall under a body held up off them, which read as a table more than as an animal.
    // 0.45 of sky between each pair — at 0.3 the rim closed the gaps and they merged.
    ...[[-1.1, -0.55], [-0.05, 0.5], [0.95, 1.5], [1.95, 2.4]].map(([x0, x1]) => rectShape(x0, x1, 0, 1.05)),
    strokeShape([[2.5, 1.75], [2.85, 1.35], [2.9, 0.95]], 0.14, 0.14),
  ];
}

/** The trunk: out of the head, down and forward, and curling up to blow. */
const TRUNK_PATH = [[-1.85, 1.95], [-2.45, 1.7], [-2.95, 2.05], [-3.1, 2.7], [-2.95, 3.2]];
/** The two jets of spray off its tip: one arching back over the head, one flicking forward. */
const JETS = [
  [[-2.95, 3.2], [-2.75, 3.95], [-2.1, 4.35], [-1.45, 4.15]],
  [[-2.95, 3.2], [-3.35, 3.85], [-3.8, 3.9]],
];

/**
 * The elephant about its pivot: x along the board, y up from the pivot (the lot), the board's
 * faces ±z. The body and the trunk are separate, because the trunk bobs: `trunk` is built about
 * its own root, `trunkRoot` is where that root sits. Each is two geometries — the board's pink is
 * lifted on a material of its own and the rest is not — and the trunk carries the spray's `bulbs`,
 * whose `bulb` attribute is each vertex's place along its jet (0 by the trunk). `body` is the
 * body's cut-out alone, for the probe's winding check.
 *
 * Only the +z face carries anything. The camera never turns and the board only sways 8°, so the
 * back is never seen — the taxi cutout puts its details *through* the board because it was once
 * meant to spin.
 */
export function elephantGeometry() {
  const pieces = elephantPieces();
  const front = ELE_T / 2;
  const extrude = (sh, depth, bevel, size, segs = 10) => {
    const geo = new THREE.ExtrudeGeometry(sh, {
      depth, curveSegments: segs, bevelEnabled: bevel > 0,
      bevelThickness: bevel, bevelSize: size, bevelSegments: 1,
    });
    geo.deleteAttribute('uv');
    geo.translate(0, 0, -depth / 2);
    return geo;
  };
  const merge = (geos) => {
    const geo = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    return geo;
  };
  // Each piece after the first sits 8mm thinner than the one before it. Level with each other, a
  // piece's chamfer starts on the plane of the cap it overlaps, and every leg and the head drew a
  // pale seam up through the body where the two tied. The trunk and its spray come last.
  const boardPiece = (sh, k, col) => bakeColor(
    extrude(sh, ELE_T - 2 * ELE_BEVEL - 2 * ELE_STEP * k, ELE_BEVEL, ELE_BEVEL), color(col));
  // The rim: every piece grown by ELE_RIM and kept thinner than the board, so it shows only as a
  // band round the silhouette — where one piece's rim falls inside another piece it is buried in
  // that piece's board — and none of its faces shares a plane with the board's.
  const rimPiece = (sh) => bakeColor(extrude(sh, 0.12, 0.02, ELE_RIM), color('elephantRim'));
  // A flat on the front face, `proud` off it.
  const flat = (sh, col, proud = ELE_PROUD) => {
    const geo = extrude(sh, proud + 0.02, 0, 0, 16);
    geo.translate(0, 0, front + (proud - 0.02) / 2);
    return bakeColor(geo, col);
  };

  const body = merge(pieces.map((sh, k) => boardPiece(sh, k, 'elephantPink')));
  const parts = pieces.map(rimPiece);
  // The ear: a big paler flap over the join of head and body, ringed in a deeper pink so it stays a
  // separate shape at play zoom. On the board's lifted material, not the trim's: ringed in cream and
  // unlifted, an earlier ear went grey in shade and read as a hole in the board.
  const board = merge([
    body.clone(),
    flat(ellipseShape(-0.6, 2.05, 0.8, 0.98), color('elephantEarEdge'), ELE_PROUD / 2),
    flat(ellipseShape(-0.6, 2.05, 0.66, 0.84), color('elephantEar')),
  ]);
  // The eye, looking forward.
  parts.push(flat(ellipseShape(-1.75, 2.55, 0.17, 0.2), color('elephantRim')));
  parts.push(flat(ellipseShape(-1.8, 2.53, 0.09, 0.11), color('elephantPupil'), ELE_PROUD * 2));
  // A white plinth under the feet, as the photo's stands on.
  parts.push(bakeColor(new THREE.BoxGeometry(4.0, 0.22, ELE_T + 0.1).translate(0.65, -0.11, 0),
    color('elephantRim')));

  // --- The trunk and its spray, about the trunk's root ---
  let k = pieces.length;
  const trunkShape = strokeShape(TRUNK_PATH, 0.6, 0.32);
  const trunkBoard = boardPiece(trunkShape, k++, 'elephantPink');
  const trunkParts = [rimPiece(trunkShape)];
  const sprayK = k++;
  const bulbs = [];
  const spray = [];
  for (const jet of JETS) {
    const shape = strokeShape(jet, 0.34, 0.2);
    const [ex, ey] = jet[jet.length - 1];
    // The splash at its end: a drop a little fatter than the jet.
    const drop = ellipseShape(ex, ey, 0.17, 0.17);
    for (const sh of [shape, drop]) {
      spray.push(boardPiece(sh, sprayK, 'elephantSpray'));
      trunkParts.push(rimPiece(sh));
    }
    const curve = new THREE.SplineCurve(jet.map(([x, y]) => new THREE.Vector2(x, y)));
    for (let n = 0; n < BULBS_PER_JET; n++) {
      const p = curve.getPoint((n + 1) / (BULBS_PER_JET + 0.5));
      const bulb = new THREE.CylinderGeometry(0.095, 0.095, ELE_PROUD + 0.02, 8);
      bulb.rotateX(Math.PI / 2);
      bulb.translate(p.x, p.y, front + (ELE_PROUD - 0.02) / 2);
      const geo = bakeColor(bulb, color('elephantBulbOff'));
      geo.setAttribute('bulb', new THREE.BufferAttribute(
        new Float32Array(geo.attributes.position.count).fill(n / (BULBS_PER_JET - 1)), 1));
      bulbs.push(geo);
    }
  }
  const [rx, ry] = TRUNK_ROOT;
  const trunkTrim = merge(trunkParts);
  const bulbGeo = merge(bulbs);
  const sprayGeo = merge(spray);
  for (const g of [trunkBoard, trunkTrim, bulbGeo, sprayGeo]) g.translate(-rx, -ry, 0);
  return {
    board, parts, body,
    trunk: { board: trunkBoard, trim: trunkTrim, spray: sprayGeo, bulbs: bulbGeo },
    trunkRoot: [rx, ry],
  };
}

/**
 * How lit each bulb is at a given lift of the trunk (−1 bottom, 1 top), by its place along its jet
 * (0 by the trunk, 1 at the splash): off below BULB_FROM, then on in order out along the jet.
 */
export function bulbLevel(lift, along) {
  const at = BULB_FROM + BULB_SPAN * along * 0.8;
  return THREE.MathUtils.clamp((lift - at) / (BULB_SPAN * 0.2), 0, 1);
}

/** Every number about a car wash, derived from its block — so the chooser can ask before building. */
export function carWashSite(block) {
  const { x0, x1, z0, z1 } = block.bounds;
  const tunnel = { x0: x0 + TUN_SIDE, x1: x1 - TUN_END, z0: z0 + TUN_SIDE, z1: z0 + TUN_SIDE + TUN_D };
  const zc = (tunnel.z0 + tunnel.z1) / 2;
  return {
    bi: block.bi,
    bj: block.bj,
    bounds: block.bounds,
    tunnel,
    zc,
    tubeMan: roadsideCorner(block),
    sign: { x: x0 + SIGN_IN, z: z1 - SIGN_IN },
    // The review framing: the block's middle.
    focus: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 },
  };
}

/**
 * A roller brush about its own origin, axis up: a core and a ring of fins in two colours. The fins
 * are what make the spin visible — a round brush turning reads as a brush standing still.
 */
function brushGeometry(r, h) {
  const parts = [];
  const core = new THREE.CylinderGeometry(0.1, 0.1, h + 0.3, 8);
  parts.push(bakeColor(core, color('carWashBrushCore')));
  for (let n = 0; n < FINS; n++) {
    const a = (n / FINS) * Math.PI * 2;
    const fin = new THREE.BoxGeometry(r - 0.08, h, 0.09);
    fin.translate((r - 0.08) / 2 + 0.08, 0, 0);
    fin.rotateY(a);
    parts.push(bakeColor(fin, color(n % 2 ? 'carWashBrushA' : 'carWashBrushB')));
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

/** The pylon sign `?washsign=classic` keeps: a pole and a blue WASH panel square to the camera. */
function pylonSign(sx, base, sz, { trim, blue, white }) {
  const parts = [box(0.3, SIGN_H - 0.9, 0.3, sx, base, sz, trim)];
  const panel = [];
  const PW = 3.0;
  const PH = 1.8;
  panel.push(bakeColor(new THREE.BoxGeometry(PW + 0.24, PH + 0.24, 0.2).translate(0, 0, -0.02), trim));
  panel.push(bakeColor(new THREE.BoxGeometry(PW, PH, 0.2), blue));
  // Three bubbles over the word.
  for (const [bx, by, br] of [[-0.95, 0.52, 0.2], [-0.5, 0.62, 0.13], [0.9, 0.55, 0.16]]) {
    const b = new THREE.CylinderGeometry(br, br, 0.06, 14);
    b.rotateX(Math.PI / 2);
    b.translate(bx, by, 0.12);
    panel.push(bakeColor(b, white));
  }
  const word = wordParts('WASH', 0.08, white);
  word.forEach((g) => g.translate(0, -0.25, 0.1));
  panel.push(...word);
  const toSign = new THREE.Matrix4().compose(
    new THREE.Vector3(sx, base + SIGN_H, sz),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
    new THREE.Vector3(1, 1, 1),
  );
  for (const g of panel) parts.push(g.applyMatrix4(toSign));
  return parts;
}

/** What the model workshop finds this landmark by (src/workshop/catalog.js, `LANDMARKS`). */
// `glow`: what blooms, at which kind (game/bloom.js) — read by main.js and the bench alike.
export const LANDMARK = {
  id: 'carwash', label: 'Car wash', create: createCarWash,
  glow: (c) => [[c.glow, 'window'], [c.bulbs, 'window']].filter(([m]) => m),
};

export function createCarWash(block, rng) {
  const site = carWashSite(block);
  const { tunnel: t, zc } = site;
  const { x0, x1, z0, z1 } = block.bounds;
  const base = LOT_Y;
  const eaves = FLOOR_Y + ROOF_H;
  const blue = color('carWashBlue');
  const wall = jitterColor(color('carWashWall'), rng, { l: 0.02 });
  const trim = color('carWashTrim');
  const white = color('carWashBubble');
  const paint = color('laneMark');
  const len = t.x1 - t.x0;

  const parts = [
    // The lot: concrete over the whole block, a shade off the pavement round it.
    span(x0 + LOT_INSET, x1 - LOT_INSET, LOT_Y - 0.04, LOT_Y, z0 + LOT_INSET, z1 - LOT_INSET,
      jitterColor(color('carWashLot'), rng, { l: 0.02 })),
    // The tunnel's floor, and the two guide rails a wheel runs between. The floor's open edge stops
    // a hair short of `t.z1`, which is where the posts' street faces stand: flush, the bottom two
    // centimetres of every post shared a plane with the floor's edge (tools/zfight.mjs).
    span(t.x0 - 0.6, t.x1 + 0.6, FLOOR_Y - 0.03, FLOOR_Y, t.z0 + WALL_T, t.z1 - 0.02, color('carWashFloor')),
    span(t.x0 - 0.6, t.x1 + 0.6, FLOOR_Y, FLOOR_Y + 0.08, zc + 0.85, zc + 0.95, color('carWashRail')),
    span(t.x0 - 0.6, t.x1 + 0.6, FLOOR_Y, FLOOR_Y + 0.08, zc - 0.95, zc - 0.85, color('carWashRail')),
    // The back wall, full height: the one long face the camera never sees from the front.
    span(t.x0, t.x1, base, eaves, t.z0, t.z0 + WALL_T, wall),
    // The roof, and a fascia band round its two visible faces, oversailing by a little.
    span(t.x0 - 0.15, t.x1 + 0.15, eaves, eaves + ROOF_T, t.z0 - 0.15, t.z1 + 0.15, trim),
    span(t.x0 - 0.2, t.x1 + 0.2, eaves + ROOF_T, eaves + ROOF_T + FASCIA_H, t.z1 - 0.1, t.z1 + 0.2, blue),
    span(t.x1 - 0.1, t.x1 + 0.2, eaves + ROOF_T, eaves + ROOF_T + FASCIA_H, t.z0 - 0.2, t.z1 + 0.2, blue),
    span(t.x0 - 0.2, t.x0 + 0.1, eaves + ROOF_T, eaves + ROOF_T + FASCIA_H, t.z0 - 0.2, t.z1 + 0.2, blue),
    // A cap along the top of the band.
    span(t.x0 - 0.25, t.x1 + 0.25, eaves + ROOF_T + FASCIA_H, eaves + ROOF_T + FASCIA_H + 0.12,
      t.z0 - 0.25, t.z1 + 0.25, trim),
  ];
  // Posts down the open +Z side: one at each end and the span between split about every 2.6.
  const bays = Math.max(2, Math.round(len / 2.6));
  for (let n = 0; n <= bays; n++) {
    const x = t.x0 + (len - POST) * (n / bays) + POST / 2;
    parts.push(box(POST, eaves - base, POST, x, base, t.z1 - POST / 2, trim));
  }
  // Soap bubbles across the fascia, both faces: white discs at a scatter of sizes.
  const bandY = eaves + ROOF_T + FASCIA_H / 2;
  for (let x = t.x0 + 0.5; x < t.x1 - 0.3; x += rng.range(0.7, 1.1)) {
    const r = rng.range(0.16, 0.34);
    parts.push(disc(r, 0.04, x, bandY + rng.jitter(0.15), t.z1 + 0.22, 'z', white));
  }
  for (let z = t.z0 + 0.4; z < t.z1 - 0.2; z += rng.range(0.7, 1.0)) {
    const r = rng.range(0.16, 0.3);
    parts.push(disc(r, 0.04, t.x1 + 0.22, bandY + rng.jitter(0.15), z, 'x', white));
  }

  // The pay kiosk at the way in, and the arrow painted on the lot pointing into the tunnel.
  const kx = t.x0 + 0.5;
  const kz = t.z1 + 1.1;
  parts.push(box(0.55, 1.35, 0.45, kx, base, kz, trim));
  parts.push(box(0.75, 0.12, 0.65, kx, base + 1.35, kz, blue));
  for (const along of [0, 0.7]) {
    // A chevron's two bars, aimed −X toward the tunnel mouth.
    for (const s of [-1, 1]) {
      const bar = new THREE.BoxGeometry(0.7, PAINT_Y - LOT_Y, 0.16);
      bar.rotateY(s * 0.6);
      bar.translate(t.x0 - 0.3 + along + 0.28, (LOT_Y + PAINT_Y) / 2, zc + s * 0.2);
      parts.push(bakeColor(bar, paint));
    }
  }

  // Vacuum bays along the +Z kerb: two posts with a hose arched over to a canister, and the bay
  // lines between them.
  const vz = z1 - VAC_BACK;
  for (const vx of [x0 + 3.4, x0 + 6.0]) {
    parts.push(box(0.26, 2.1, 0.26, vx, base, vz, color('carWashVacuum')));
    parts.push(box(0.5, 0.4, 0.4, vx, base + 2.1, vz, color('carWashVacuum')));
    const hose = new THREE.TorusGeometry(0.42, 0.05, 4, 10, Math.PI);
    hose.translate(vx + 0.42, base + 1.5, vz);
    parts.push(bakeColor(hose, color('carWashRail')));
    parts.push(box(0.35, 0.5, 0.35, vx + 0.84, base, vz, color('carWashVacuum')));
  }
  for (const lx of [x0 + 2.1, x0 + 4.7, x0 + 7.3]) {
    parts.push(span(lx - 0.07, lx + 0.07, LOT_Y, PAINT_Y, vz - 1.9, z1 - LOT_INSET - 0.3, paint));
  }

  // --- The sign: the elephant on its pole, or the pylon panel turned square to the camera ---
  const sx = site.sign.x;
  const sz = site.sign.z;
  // The elephant's pole stops inside its belly, up through a front leg, so the board reads as
  // mounted on it. Static, in the shell: the board sways about it.
  if (WASH_SIGN_CLASSIC) parts.push(...pylonSign(sx, base, sz, { trim, blue, white }));
  // 0.2 thick, inside the board's 0.26 (ELE_T at ELE_SCALE): the pylon's 0.3 poked out of both
  // faces as a dark cross over the belly.
  else parts.push(box(0.2, ELE_FOOT + 0.7 * ELE_SCALE, 0.2, sx, base, sz, trim));

  // One entrance anchor for the whole lot, so it rises as one object.
  const anchorX = block.bounds.cx;
  const anchorZ = block.bounds.cz;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);
  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'car-wash';

  // --- What is lit: a strip light down the tunnel, and the kiosk's screen -------
  const glowParts = [
    span(t.x0 + 0.3, t.x1 - 0.3, eaves - 0.08, eaves - 0.02, zc - 0.12, zc + 0.12, color('carWashGlow')),
    span(kx + 0.28, kx + 0.3, base + 0.75, base + 1.15, kz - 0.15, kz + 0.15, color('carWashGlow')),
  ];
  glowParts.forEach(stampAll);
  const glow = new THREE.Mesh(mergeGeometries(glowParts, false), unlitMaterial({ vertexColors: true }));
  glowParts.forEach((p) => p.dispose());
  glow.name = 'car-wash-glow';

  // --- The moving parts ------------------------------------------------------------
  // Each about its own origin, for the burger sign's reason: they turn, and the entrance wave's
  // world-space anchor means nothing in a turning object's frame. Grown on the CPU instead.
  const material = propMaterial();
  const brushGeo = brushGeometry(BRUSH_R, BRUSH_H);
  const spinners = [];
  const moving = new THREE.Group();
  moving.name = 'car-wash-moving';
  const brushY = FLOOR_Y + 0.15 + BRUSH_H / 2;
  // Two pairs of side brushes, turning opposite ways so they scrub toward the middle.
  for (const at of [0.3, 0.72]) {
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(brushGeo, material);
      // 0.9 off the middle: a 0.55 brush then stops 0.05 short of the back wall's face.
      m.position.set(t.x0 + len * at, brushY, zc + s * 0.9);
      m.rotation.y = rng.range(0, Math.PI);
      m.castShadow = true;
      moving.add(m);
      spinners.push({ mesh: m, axis: 'y', rate: s * BRUSH_SPIN });
    }
  }
  // The top brush, lying across the tunnel, between the two pairs.
  const topGeo = brushGeometry(0.5, 2.6).rotateX(Math.PI / 2);
  const top = new THREE.Mesh(topGeo, material);
  top.position.set(t.x0 + len * 0.51, FLOOR_Y + 2.0, zc);
  top.castShadow = true;
  moving.add(top);
  spinners.push({ mesh: top, axis: 'z', rate: -BRUSH_SPIN * 0.8 });

  // The cloth curtain at the way in: strips hung from the roof, swinging as one.
  const curtainParts = [];
  for (let n = 0; n < 9; n++) {
    const z = zc - 1.3 + n * 0.325;
    const strip = new THREE.BoxGeometry(0.04, 1.5, 0.26);
    strip.translate(0, -0.75, z - zc);
    curtainParts.push(bakeColor(strip, color(n % 2 ? 'carWashBrushA' : 'carWashBubble')));
  }
  const curtain = new THREE.Mesh(mergeGeometries(curtainParts, false), material);
  curtainParts.forEach((p) => p.dispose());
  curtain.position.set(t.x0 + len * 0.1, eaves - 0.05, zc);
  moving.add(curtain);

  // The elephant, on a pivot at the foot of its pole: the entrance wave grows it from there, up
  // the pole as the pole grows (see `objects` in game/cityentry.js), and it sways about the pole's
  // axis. Out of the AO lookup for the garage cutout's reason — it moves, so it is not in the depth
  // prepass, and a receiver that is not an occluder samples whatever is behind it on screen.
  let sign = null;
  let trunk = null;
  let bulbs = null;
  if (!WASH_SIGN_CLASSIC) {
    const geo = elephantGeometry();
    geo.body.dispose();
    const trimGeo = mergeGeometries(geo.parts, false);
    geo.parts.forEach((p) => p.dispose());
    const lift = (geometry, x = 0, y = ELE_FOOT) => geometry.scale(ELE_SCALE, ELE_SCALE, ELE_SCALE).translate(x, y, 0);
    for (const g of [geo.board, trimGeo]) lift(g);
    for (const g of Object.values(geo.trunk)) lift(g, 0, 0);
    const boardMat = propMaterial({ ao: false });
    boardMat.emissive.set(color('elephantPink')).multiplyScalar(ELE_LIFT);
    const trimMat = propMaterial({ ao: false });
    const shadowed = (mesh, name) => {
      mesh.castShadow = true;
      mesh.name = name;
      return mesh;
    };
    sign = new THREE.Group();
    sign.name = 'car-wash-sign';
    sign.position.set(sx, base, sz);
    sign.add(shadowed(new THREE.Mesh(geo.board, boardMat), 'car-wash-elephant'),
      shadowed(new THREE.Mesh(trimGeo, trimMat), 'car-wash-elephant-trim'));
    // The trunk on its own pivot at its root, carrying the spray and the bulbs with it. The bulbs
    // are unlit, so they hold their blue whatever the sun is doing, and bloom at night (LANDMARK).
    trunk = new THREE.Group();
    trunk.name = 'car-wash-trunk';
    trunk.position.set(geo.trunkRoot[0] * ELE_SCALE, ELE_FOOT + geo.trunkRoot[1] * ELE_SCALE, 0);
    bulbs = new THREE.Mesh(geo.trunk.bulbs, unlitMaterial({ vertexColors: true }));
    bulbs.name = 'car-wash-spray-bulbs';
    // The spray's board lifted like the pink, harder: it stands out past the head where it is in
    // the shade of nothing but itself, and unlifted it went the grey of the road behind it.
    const sprayMat = propMaterial({ ao: false });
    sprayMat.emissive.set(color('elephantSpray')).multiplyScalar(SPRAY_LIFT);
    trunk.add(shadowed(new THREE.Mesh(geo.trunk.board, boardMat), 'car-wash-trunk-board'),
      shadowed(new THREE.Mesh(geo.trunk.trim, trimMat), 'car-wash-trunk-trim'),
      shadowed(new THREE.Mesh(geo.trunk.spray, sprayMat), 'car-wash-spray'), bulbs);
    sign.add(trunk);
  }
  const bulbOff = new THREE.Color(color('elephantBulbOff'));
  const bulbOn = new THREE.Color(color('elephantBulbOn'));
  const bulbTint = new THREE.Color();
  function lightBulbs(lift) {
    const along = bulbs.geometry.attributes.bulb.array;
    const col = bulbs.geometry.attributes.color;
    const a = col.array;
    for (let i = 0; i < along.length; i++) {
      bulbTint.lerpColors(bulbOff, bulbOn, bulbLevel(lift, along[i]));
      a[i * 3] = bulbTint.r;
      a[i * 3 + 1] = bulbTint.g;
      a[i * 3 + 2] = bulbTint.b;
    }
    col.needsUpdate = true;
  }

  const group = new THREE.Group();
  group.name = 'car-wash-root';
  group.add(shell, glow, moving);
  if (sign) group.add(sign);

  let clock = rand * 10;
  // The sway's phase, seeded so shot mode — which ticks once and freezes — does not catch every
  // city's elephant at the same angle.
  const swayPhase = rand * Math.PI * 2;
  function update(dt) {
    clock += dt;
    for (const s of spinners) s.mesh.rotation[s.axis] += s.rate * dt;
    curtain.rotation.z = 0.22 * Math.sin(clock * 2.1);
    if (!sign) return;
    sign.rotation.y = ELE_FACING + ELE_SWAY * Math.sin(swayPhase + clock * ELE_SWAY_RATE);
    // The bob: negative is up, the trunk reaching out toward −x.
    const lift = Math.sin(swayPhase * 3 + clock * TRUNK_BOB_RATE);
    trunk.rotation.z = -TRUNK_BOB * lift;
    lightBulbs(lift);
  }
  update(0);

  const entry = { x: anchorX, z: anchorZ, rand };
  const elephantMeshes = [];
  sign?.traverse((o) => { if (o.isMesh) elephantMeshes.push(o); });
  return {
    site,
    group,
    shell,
    glow,
    update,
    /** The stamped meshes, for the entrance wave, the AO prepass and the sightline field. */
    meshes: [shell, glow],
    /**
     * What stands in front of a kerb mark: the stamped meshes and the elephant. It only sways 8°, so
     * the field `cornerSeen` reads is as true for it as for the shell — and it is 5.0 by 3.2 of
     * board up where a sightline off the next road west can meet it.
     */
    occluders: [shell, glow, ...elephantMeshes],
    /** The elephant on its pivot (null on `?washsign=classic`), its trunk and its spray's bulbs. */
    sign,
    trunk,
    bulbs,
    /** The brushes, the curtain and the elephant move, so the wave grows them on the CPU. */
    entryObjects: [...spinners.map((s) => s.mesh), curtain, ...(sign ? [sign] : [])]
      .map((object) => ({ object, ...entry })),
    entry,
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(x1 - x0, z1 - z0) / 2, rand },
  };
}
