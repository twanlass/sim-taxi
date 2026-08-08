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

function buildTower(lot, centrality, rng, parts) {
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

// --- Landmarks --------------------------------------------------------------
//
// A handful of blocks are handed a distinct silhouette instead of another setback tower — one
// each of a clocktower, dome, cathedral, radio mast and round hotel per city. They exist to give
// the map memorable reference points ("turn left at the dome"), so each is shaped to read at
// play zoom on a fixed 3/4 camera: the important lines are the outline, not the surface detail.
// Landmarks stay slender at the top for the same reason ordinary towers are height-capped — a
// wide 24-unit mass would sit right on top of the taxi.

function cyl(rTop, rBot, h, x, base, z, col, segments = 14) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, h, segments);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

function halfSphere(r, x, base, z, col, segments = 14) {
  const geo = new THREE.SphereGeometry(r, segments, Math.max(4, segments / 2),
    0, Math.PI * 2, 0, Math.PI / 2);
  geo.translate(x, base, z);
  return bakeColor(geo, col);
}

/** 4-sided pyramid with a square base of side `w`, apex at height `h`. */
function pyramid(w, h, x, base, z, col) {
  const geo = new THREE.ConeGeometry(w * Math.SQRT1_2, h, 4);
  geo.rotateY(Math.PI / 4);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Triangular prism roof: base is `w` across, `d` along the ridge, apex `h` above base.
 * `rotY` rotates the whole prism around its centre before placement — pass Math.PI/2 to turn
 * a z-ridge roof into an x-ridge one.
 */
function pitchedRoof(w, h, d, rotY, x, base, z, col) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  // Extrusion runs 0..d along +Z; centre it, then rotate, then place.
  geo.translate(0, 0, -d / 2);
  if (rotY) geo.rotateY(rotY);
  geo.translate(x, base, z);
  return bakeColor(geo, col);
}

/** Small quad decal (window/clock face) offset from a wall by `eps`. */
function decal(w, h, rotY, x, y, z, col) {
  const geo = new THREE.PlaneGeometry(w, h);
  geo.rotateY(rotY);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

/** Circular decal (clock face) offset from a wall by `eps`. */
function disc(r, rotY, x, y, z, col) {
  const geo = new THREE.CircleGeometry(r, 16);
  geo.rotateY(rotY);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

/**
 * Puts the same decal on all four vertical faces of a box centred on (cx, cz, side w × d).
 * `eps` moves the decal away from the wall — increase it in layered calls so stacked decals
 * (e.g. dark panel → white face → clock hands) don't z-fight with each other.
 */
function fourSides(cx, y, cz, w, d, decalFn, eps = 0.04) {
  return [
    decalFn(0,           cx,               y, cz + d / 2 + eps),
    decalFn(Math.PI,     cx,               y, cz - d / 2 - eps),
    decalFn(Math.PI / 2, cx + w / 2 + eps, y, cz),
    decalFn(-Math.PI / 2,cx - w / 2 - eps, y, cz),
  ];
}

function landmarkClocktower(block, rng, parts) {
  const { cx, cz } = block.bounds;
  const stone = color('limestone');
  const stoneDark = jitterColor(stone, rng, { l: -0.06 });
  const trim = color('cathedralRoof');
  const win = color('window');
  const face = color('crosswalk');
  const brass = color('brass');
  let y = KERB_H;

  // Plinth — the wide square base that reads as "civic building" before you notice the clock.
  parts.push(box(9, 2.2, 9, cx, y, cz, stone));
  y += 2.2;

  // Shaft — the tall main body. Fine floor lines keep the mass legible.
  const shaftW = 6;
  const shaftH = 12;
  parts.push(box(shaftW, shaftH, shaftW, cx, y, cz, stone));
  parts.push(...windowBands(shaftW, shaftH, shaftW, cx, y, cz, win));
  // Corner pilasters — thin rectangles at each edge of the shaft, so it doesn't read as a plain
  // box. Cheap detail; four boxes total.
  const pilW = 0.6;
  for (const [ox, oz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    parts.push(box(pilW, shaftH, pilW,
      cx + ox * (shaftW / 2 - pilW / 2), y, cz + oz * (shaftW / 2 - pilW / 2), stoneDark));
  }
  y += shaftH;

  // Cornice — thin overhang between shaft and belfry, sells the transition.
  parts.push(box(shaftW + 0.6, 0.35, shaftW + 0.6, cx, y, cz, trim));
  y += 0.35;

  // Belfry with clock faces.
  const belW = 5.2;
  const belH = 2.8;
  parts.push(box(belW, belH, belW, cx, y, cz, stone));
  // Dark recessed panel behind each clock face — without this the white disc on light stone is
  // near-invisible at play zoom, since a landmark is 30-50px across on the whole screen.
  const clockY = y + belH / 2;
  const panelW = belW * 0.78;
  parts.push(...fourSides(cx, clockY, cz, belW, belW,
    (rotY, px, py, pz) => decal(panelW, panelW * 0.86, rotY, px, py, pz, color('window')), 0.04));
  parts.push(...fourSides(cx, clockY, cz, belW, belW,
    (rotY, px, py, pz) => disc(1.1, rotY, px, py, pz, face), 0.07));
  // Cross of two thin hands over the face — a landmark you can read the hour on.
  parts.push(...fourSides(cx, clockY, cz, belW, belW,
    (rotY, px, py, pz) => decal(0.18, 1.7, rotY, px, py, pz, color('window')), 0.09));
  parts.push(...fourSides(cx, clockY, cz, belW, belW,
    (rotY, px, py, pz) => decal(1.1, 0.18, rotY, px, py, pz, color('window')), 0.11));
  y += belH;

  // Second cornice + spire.
  parts.push(box(belW + 0.4, 0.3, belW + 0.4, cx, y, cz, trim));
  y += 0.3;
  parts.push(pyramid(belW - 0.4, 3.4, cx, y, cz, trim));
  y += 3.4;

  // Brass finial: ball + short mast. The small warm colour on top pulls the eye up.
  const ball = new THREE.SphereGeometry(0.36, 8, 6);
  ball.translate(cx, y + 0.36, cz);
  parts.push(bakeColor(ball, brass));
  parts.push(cyl(0.05, 0.05, 1.3, cx, y + 0.72, cz, color('pole'), 5));
}

function landmarkDome(block, rng, parts) {
  const { cx, cz } = block.bounds;
  const stone = color('limestone');
  const trim = color('cathedralRoof');
  const dome = color('copperDome');
  const domeShade = jitterColor(dome, rng, { l: -0.05 });
  const brass = color('brass');
  let y = KERB_H;

  // Square plinth so the dome sits on a civic base rather than levitating on a lawn.
  parts.push(box(10, 2.5, 10, cx, y, cz, stone));
  y += 2.5;

  // Drum — cylindrical body. Columns are hinted by a ring of thin vertical bars around it.
  const drumR = 4;
  const drumH = 4.2;
  parts.push(cyl(drumR, drumR, drumH, cx, y, cz, stone, 20));
  const columns = 12;
  for (let k = 0; k < columns; k++) {
    const angle = (k / columns) * Math.PI * 2;
    const rx = cx + Math.cos(angle) * (drumR + 0.04);
    const rz = cz + Math.sin(angle) * (drumR + 0.04);
    const bar = new THREE.BoxGeometry(0.35, drumH - 0.6, 0.18);
    bar.rotateY(-angle);
    bar.translate(rx, y + drumH / 2, rz);
    parts.push(bakeColor(bar, trim));
  }
  y += drumH;

  // Cornice — the flat lip the dome springs from.
  parts.push(cyl(drumR + 0.35, drumR + 0.35, 0.4, cx, y, cz, trim, 20));
  y += 0.4;

  // The dome itself — a hemisphere in patina copper green. The city's one colour splash that
  // isn't a car or a fare pin, and the only round mass at that scale on the whole map.
  parts.push(halfSphere(drumR - 0.15, cx, y, cz, dome, 20));
  y += drumR - 0.4;

  // Cupola: a tiny second dome perched on the top of the main one.
  const cupR = 1.1;
  parts.push(cyl(cupR, cupR, 1.0, cx, y, cz, stone, 12));
  y += 1.0;
  parts.push(halfSphere(cupR - 0.05, cx, y, cz, domeShade, 12));
  y += cupR;

  // Brass finial.
  const ball = new THREE.SphereGeometry(0.28, 8, 6);
  ball.translate(cx, y + 0.28, cz);
  parts.push(bakeColor(ball, brass));
  parts.push(cyl(0.045, 0.045, 1.0, cx, y + 0.6, cz, color('pole'), 5));
}

function landmarkCathedral(block, rng, parts) {
  const { cx, cz } = block.bounds;
  const stone = color('cathedralStone');
  const roof = color('cathedralRoof');
  const win = color('window');
  const brass = color('brass');
  let y = KERB_H;

  // Nave: a long low body running along the block's longer axis (blocks are square here so we
  // orient by the seed — one bit of variety across cities).
  const runX = rng.chance(0.5);
  const naveL = 10;                // length along the ridge
  const naveW = 5;                 // width across the aisles
  const naveH = 3.2;

  const nx = runX ? naveL : naveW;
  const nz = runX ? naveW : naveL;
  parts.push(box(nx, naveH, nz, cx, y, cz, stone));

  // Buttress-like piers at the sides of the nave.
  const piers = 4;
  for (let k = 1; k < piers; k++) {
    const t = k / piers - 0.5;
    if (runX) {
      parts.push(box(0.5, naveH, 0.5, cx + t * naveL, y, cz + naveW / 2, roof));
      parts.push(box(0.5, naveH, 0.5, cx + t * naveL, y, cz - naveW / 2, roof));
    } else {
      parts.push(box(0.5, naveH, 0.5, cx + naveW / 2, y, cz + t * naveL, roof));
      parts.push(box(0.5, naveH, 0.5, cx - naveW / 2, y, cz + t * naveL, roof));
    }
  }

  // Rose windows on the long faces — one dark plane per side, just enough to say "cathedral".
  const roseY = y + naveH * 0.55;
  if (runX) {
    parts.push(decal(1.4, 1.4, 0,       cx, roseY, cz + nz / 2 + 0.04, win));
    parts.push(decal(1.4, 1.4, Math.PI, cx, roseY, cz - nz / 2 - 0.04, win));
  } else {
    parts.push(decal(1.4, 1.4,  Math.PI / 2, cx + nx / 2 + 0.04, roseY, cz, win));
    parts.push(decal(1.4, 1.4, -Math.PI / 2, cx - nx / 2 - 0.04, roseY, cz, win));
  }

  y += naveH;

  // Pitched roof — ridge runs along the nave. pitchedRoof's default ridge is along z, so rotate
  // 90° when the nave is oriented along x.
  const roofH = 1.8;
  parts.push(pitchedRoof(naveW, roofH, naveL, runX ? Math.PI / 2 : 0, cx, y, cz, roof));

  // Bell tower on one end — the vertical accent that makes a cathedral read from across the map.
  const towerW = 3.4;
  const towerH = 12;
  const towerOff = runX ? -naveL / 2 + towerW / 2 : 0;
  const towerOffZ = runX ? 0 : -naveL / 2 + towerW / 2;
  const tx = cx + towerOff;
  const tz = cz + towerOffZ;
  parts.push(box(towerW, towerH, towerW, tx, KERB_H, tz, stone));
  parts.push(...windowBands(towerW, towerH, towerW, tx, KERB_H, tz, win));

  // Belfry — the open arch at the top of the tower, shown as a taller dark band.
  const belY = KERB_H + towerH - 1.6;
  parts.push(...fourSides(tx, belY + 0.8, tz, towerW, towerW,
    (rotY, px, py, pz) => decal(towerW * 0.6, 1.5, rotY, px, py, pz, win)));

  // Steeple: cornice + tall pyramid + brass cross-finial.
  parts.push(box(towerW + 0.4, 0.3, towerW + 0.4, tx, KERB_H + towerH, tz, roof));
  parts.push(pyramid(towerW - 0.2, 4.5, tx, KERB_H + towerH + 0.3, tz, roof));
  const finialBase = KERB_H + towerH + 0.3 + 4.5;
  parts.push(cyl(0.055, 0.055, 1.4, tx, finialBase, tz, brass, 5));
  parts.push(box(0.6, 0.13, 0.13, tx, finialBase + 0.9, tz, brass));
}

function landmarkRadio(block, rng, parts) {
  const { cx, cz } = block.bounds;
  const conc = color('concrete');
  const slate = color('slate');
  const red = color('latticeRed');
  const beacon = color('beacon');
  const win = color('window');
  let y = KERB_H;

  // Low broadcast building at the base — a modernist block with a bright red mast rising from
  // its centre. The base gives the tower somewhere to *stand* so it isn't a floating stick.
  parts.push(box(9, 2.5, 9, cx, y, cz, conc));
  parts.push(...windowBands(9, 2.5, 9, cx, y, cz, win));
  y += 2.5;
  parts.push(box(5.5, 2.4, 5.5, cx, y, cz, slate));
  y += 2.4;
  // Small equipment box.
  parts.push(box(2, 1.4, 2, cx, y, cz, slate));
  y += 1.4;

  // Tapered mast — 4-sided prism, wider at the bottom, narrow at the top. The 4 sides are what
  // gives it the low-poly lattice look.
  const mastH = 13;
  const geo = new THREE.CylinderGeometry(0.18, 1.4, mastH, 4);
  geo.rotateY(Math.PI / 4);
  geo.translate(cx, y + mastH / 2, cz);
  parts.push(bakeColor(geo, red));

  // Two horizontal rings at 1/3 and 2/3 up the mast — the strongest low-poly cue for "lattice".
  for (const t of [0.32, 0.66]) {
    const ringR = 1.4 - (1.4 - 0.18) * t;
    const ringY = y + mastH * t;
    parts.push(cyl(ringR + 0.18, ringR + 0.18, 0.25, cx, ringY, cz, red, 4));
  }
  y += mastH;

  // Antenna tip: thin pole + red beacon lamp. The beacon is over the height cap but it's a
  // sphere the size of a car door, so it does not occlude much.
  parts.push(cyl(0.06, 0.06, 2.2, cx, y, cz, color('pole'), 5));
  y += 2.2;
  const bulb = new THREE.SphereGeometry(0.34, 8, 6);
  bulb.translate(cx, y + 0.34, cz);
  parts.push(bakeColor(bulb, beacon));
}

function landmarkRound(block, rng, parts) {
  const { cx, cz } = block.bounds;
  const stone = color('limestone');
  const glass = color('hotelGlass');
  const trim = color('cathedralRoof');
  const brass = color('brass');
  let y = KERB_H;

  // Wider plinth than the tower above, so it sits on a proper skirt like the cylindrical hotels
  // this shape borrows from.
  parts.push(cyl(4.6, 4.8, 1.6, cx, y, cz, stone, 20));
  y += 1.6;
  parts.push(cyl(4.2, 4.2, 0.5, cx, y, cz, trim, 20));
  y += 0.5;

  // Main body: alternating glass + darker banding to imply floors. The rings sit *slightly*
  // proud of the body so they cast their own shadow — that's the whole read at play zoom.
  const floors = 6;
  const floorH = 1.8;
  const body = 3.9;
  const band = 3.98;
  for (let f = 0; f < floors; f++) {
    parts.push(cyl(body, body, floorH * 0.72, cx, y + 0.08, cz, glass, 20));
    parts.push(cyl(band, band, floorH * 0.18, cx, y, cz, trim, 20));
    y += floorH;
  }

  // Cornice + slightly narrower crown so the profile has a shoulder.
  parts.push(cyl(body + 0.2, body + 0.2, 0.4, cx, y, cz, trim, 20));
  y += 0.4;
  const crownH = 2.4;
  parts.push(cyl(2.8, body, crownH, cx, y, cz, stone, 20));
  y += crownH;
  parts.push(halfSphere(2.6, cx, y, cz, trim, 16));
  y += 1.4;

  // Rooftop mast + brass finial.
  parts.push(cyl(0.08, 0.08, 1.8, cx, y, cz, color('pole'), 5));
  const ball = new THREE.SphereGeometry(0.22, 8, 6);
  ball.translate(cx, y + 1.9, cz);
  parts.push(bakeColor(ball, brass));
}

const LANDMARK_BUILDERS = {
  clocktower: landmarkClocktower,
  dome: landmarkDome,
  cathedral: landmarkCathedral,
  radio: landmarkRadio,
  roundtower: landmarkRound,
};

export function createBuildings(rng, blocks) {
  const parts = [];

  for (const block of blocks) {
    if (block.type === 'park') continue;
    if (block.type === 'landmark') {
      const build = LANDMARK_BUILDERS[block.landmarkKind];
      if (build) build(block, rng, parts);
      continue;
    }
    const { x0, z0, x1, z1 } = block.bounds;

    for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) {
      buildTower(lot, block.centrality, rng, parts);
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  return { mesh, count: parts.length };
}
