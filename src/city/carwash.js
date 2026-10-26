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
// A pink elephant cut out of board on a pole, spraying water over its own back: Seattle's Elephant
// Car Wash, which Tyler asked for by name (2026-10-26). Built like the garage's taxi cutout — one
// extruded `Shape`, so three winds it — and for the same reason it sways rather than turns: a board
// edge-on is a line. `?washsign=classic` keeps the blue WASH panel it replaced.

/** `?washsign=classic` — the blue pylon panel spelling WASH, as it was before the elephant. */
export const WASH_SIGN_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('washsign') === 'classic';

/**
 * The outline's whole scale. Authored about 4.9 by 4.5 and drawn at 0.85: 4.2 across is 32px at
 * play zoom, the vet's dog head — a sign over the lot rather than a statue on it.
 */
const ELE_SCALE = 0.85;
/** The feet's height over the lot. Clear of the vacuum posts (2.5) the board's end swings over. */
const ELE_FOOT = 3.0;
// Board thickness and chamfer, as the taxi cutout's.
const ELE_T = 0.3;
const ELE_BEVEL = 0.05;
/** How far the pale rim stands out round the board's edge — the photo's neon, as paint. */
const ELE_RIM = 0.2;
/** What is stuck on the front face stands this proud of it; the letters twice that. */
const ELE_PROUD = 0.04;
/** The letters' pixel, in authored units — `wordParts` would use 0.2. */
const ELE_PIXEL = 0.15;
// How much of the board's own pink it gives off, for the cutout's reason (`BOARD_LIFT` in
// city/garage.js): a face turned from the sun goes lilac under the shadow tint without it.
const ELE_LIFT = 0.35;
// The sway: facing the camera's diagonal and swinging a few degrees either side of it, slowly — a
// sign turning in the wind on its bearing, not a turntable. 0.14 rad is 8°; 0.55 rad/s of phase is
// about eleven seconds there and back.
const ELE_FACING = Math.PI / 4;
const ELE_SWAY = 0.14;
export const ELE_SWAY_RATE = 0.55;

/**
 * The outline, side-on, facing −x as the photo's does (screen left, once turned to the camera):
 * two legs under a round body, the trunk raised off the forehead and arched back over it so its tip
 * hangs over the back, and the ear scalloped down the front of the head.
 *
 * Counter-clockwise from the front foot. The trunk's tip never meets the back — the gap between
 * them is open sky, and the spray (`elephantGeometry`) fills it the way the photo's does.
 */
function elephantShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.75, 0);
  s.lineTo(-0.95, 0);
  // The arch between the legs.
  s.lineTo(-0.95, 0.3);
  s.quadraticCurveTo(0.12, 0.6, 1.2, 0.3);
  s.lineTo(1.2, 0);
  s.lineTo(2.0, 0);
  // The rump and the back.
  s.quadraticCurveTo(2.7, 0.5, 2.65, 1.5);
  s.quadraticCurveTo(2.55, 2.6, 1.4, 2.8);
  s.lineTo(0.25, 2.8);
  // Up the trunk's underside to the tip, and back over its top to the forehead. The trunk stands a
  // full unit clear of the back at its tip: the first cut left 0.4, the spray filled it, and at play
  // zoom the trunk merged into the head and the whole board read as a pink cloud.
  s.quadraticCurveTo(0.35, 3.75, 1.35, 3.85);
  s.lineTo(1.62, 3.66);
  s.quadraticCurveTo(1.2, 4.6, 0.0, 4.3);
  // The dome of the head, the face's smooth front, and the jaw tucking in to the front leg. The
  // photo's scalloped front was tried first and is what made it a cloud.
  s.quadraticCurveTo(-0.9, 4.75, -1.6, 4.0);
  s.quadraticCurveTo(-2.2, 3.4, -2.0, 2.4);
  s.quadraticCurveTo(-1.9, 1.4, -1.75, 1.2);
  s.lineTo(-1.75, 0);
  return s;
}

/**
 * The elephant about its pivot: x along the board, y up from the pivot (the lot), the board's
 * faces ±z. Two geometries, because the board's pink is lifted on a material of its own and the
 * rest is not.
 *
 * Only the +z face carries anything. The camera never turns and the board only sways 8°, so the
 * back is never seen — the taxi cutout puts its details *through* the board because it was once
 * meant to spin.
 */
export function elephantGeometry() {
  const shape = elephantShape();
  const front = ELE_T / 2;
  const extrude = (sh, depth, bevel, size, segs = 6) => {
    const geo = new THREE.ExtrudeGeometry(sh, {
      depth, curveSegments: segs, bevelEnabled: bevel > 0,
      bevelThickness: bevel, bevelSize: size, bevelSegments: 1,
    });
    geo.deleteAttribute('uv');
    geo.translate(0, 0, -depth / 2);
    return geo;
  };
  const body = bakeColor(extrude(shape, ELE_T - 2 * ELE_BEVEL, ELE_BEVEL, ELE_BEVEL), color('elephantPink'));

  // The rim: the same outline grown by ELE_RIM and kept thinner than the board, so it shows only as
  // a band round the edge and none of its faces shares a plane with the board's.
  const parts = [bakeColor(extrude(shape, 0.12, 0.02, ELE_RIM), color('elephantRim'))];
  // A flat on the front face, `proud` off it.
  const flat = (sh, col, proud = ELE_PROUD) => {
    const geo = extrude(sh, proud + 0.02, 0, 0, 10);
    geo.translate(0, 0, front + (proud - 0.02) / 2);
    return bakeColor(geo, col);
  };
  const ellipse = (x, y, rx, ry) => new THREE.Shape().absellipse(x, y, rx, ry, 0, Math.PI * 2, false, 0);
  // The ear: a big paler flap behind the eye, ringed in a deeper pink so it stays a separate shape
  // at play zoom. On the board's lifted material, not the trim's: ringed in cream and unlifted, the
  // first cut went grey in shade and read as a hole in the board.
  const board = mergeGeometries([
    body,
    flat(ellipse(-1.05, 2.7, 0.63, 0.88), color('elephantEarEdge'), ELE_PROUD / 2),
    flat(ellipse(-1.05, 2.7, 0.53, 0.78), color('elephantEar')),
  ], false);
  // The eye, looking forward.
  parts.push(flat(ellipse(-1.5, 3.72, 0.2, 0.24), color('elephantRim')));
  parts.push(flat(ellipse(-1.58, 3.7, 0.1, 0.13), color('elephantPupil'), ELE_PROUD * 2));
  // The smile, a pale arc under the eye like the photo's neon line.
  const smile = new THREE.TorusGeometry(0.3, 0.05, 4, 10, Math.PI * 0.6);
  smile.rotateZ(-Math.PI / 2 - Math.PI * 0.3);
  smile.translate(-1.55, 3.3, front);
  parts.push(bakeColor(smile, color('elephantRim')));
  // The spray off the trunk's tip, fanning down onto the back.
  const spray = new THREE.Shape([[1.5, 3.62], [1.2, 2.65], [1.95, 2.45]].map(([x, y]) => new THREE.Vector2(x, y)));
  parts.push(flat(spray, color('elephantSpray')));
  // A white plinth under the feet, as the photo's stands on.
  parts.push(bakeColor(new THREE.BoxGeometry(4.6, 0.22, ELE_T + 0.1).translate(0.15, -0.11, 0),
    color('elephantRim')));

  // CAR WASH across the body: cream pixels, each on a larger maroon one behind it — the photo's
  // bulbs-in-an-outline at a size a pixel face can manage.
  const centre = new THREE.Vector3();
  for (const [word, x, y] of [['CAR', 0.85, 2.0], ['WASH', 0.85, 1.1]]) {
    for (const [col, depth, grow] of [['elephantLetterEdge', ELE_PROUD, 1.7], ['elephantLetter', ELE_PROUD * 2, 1]]) {
      for (const g of wordParts(word, depth, color(col), ELE_PIXEL)) {
        // Grown about the pixel's own centre, so the edge pixels overlap into one outline.
        g.computeBoundingBox();
        g.boundingBox.getCenter(centre);
        g.translate(-centre.x, -centre.y, 0).scale(grow, grow, 1).translate(centre.x + x, centre.y + y, front);
        parts.push(g);
      }
    }
  }
  return { board, parts, body };
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
  id: 'carwash', label: 'Car wash', create: createCarWash, glow: (c) => [[c.glow, 'window']],
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
  // The elephant's pole stops inside its belly, over the arch between the legs, so the board reads
  // as mounted on it. Static, in the shell: the board sways about it.
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
  if (!WASH_SIGN_CLASSIC) {
    const { board: boardGeo, parts: trimParts, body } = elephantGeometry();
    body.dispose();
    const trimGeo = mergeGeometries(trimParts, false);
    trimParts.forEach((p) => p.dispose());
    for (const g of [boardGeo, trimGeo]) g.scale(ELE_SCALE, ELE_SCALE, ELE_SCALE).translate(0, ELE_FOOT, 0);
    const boardMat = propMaterial({ ao: false });
    boardMat.emissive.set(color('elephantPink')).multiplyScalar(ELE_LIFT);
    const board = new THREE.Mesh(boardGeo, boardMat);
    const trimMesh = new THREE.Mesh(trimGeo, propMaterial({ ao: false }));
    board.name = 'car-wash-elephant';
    trimMesh.name = 'car-wash-elephant-trim';
    sign = new THREE.Group();
    sign.name = 'car-wash-sign';
    sign.position.set(sx, base, sz);
    for (const m of [board, trimMesh]) {
      m.castShadow = true;
      sign.add(m);
    }
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
    if (sign) sign.rotation.y = ELE_FACING + ELE_SWAY * Math.sin(swayPhase + clock * ELE_SWAY_RATE);
  }
  update(0);

  const entry = { x: anchorX, z: anchorZ, rand };
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
     * the field `cornerSeen` reads is as true for it as for the shell — and it is 4.2 by 4.0 of
     * board up where a sightline off the next road west can meet it.
     */
    occluders: [shell, glow, ...(sign ? sign.children : [])],
    /** The elephant on its pivot (null on `?washsign=classic`), for the probe. */
    sign,
    /** The brushes, the curtain and the elephant move, so the wave grows them on the CPU. */
    entryObjects: [...spinners.map((s) => s.mesh), curtain, ...(sign ? [sign] : [])]
      .map((object) => ({ object, ...entry })),
    entry,
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(x1 - x0, z1 - z0) / 2, rand },
  };
}
