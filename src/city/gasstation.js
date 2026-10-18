import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { LOT_Y, PAINT_Y, box, roadsideCorner, span, wordParts } from './roadside.js';

// The gas station: a convenience store on the block's −X half, a canopy over two pump islands on
// its +X half, a pylon sign, and the inflatable tube man on the corner (game/tubeman.js). Tyler
// asked for it beside the car wash to compare the two (2026-10-17): "a simple convenience store on
// half and two pumps on the other half". `?roadside=gas` picks it (city/roadside.js). Scenery only:
// no car pulls in to fill up.
//
// **Which way it faces is settled by the camera.** Only +X and +Z faces are ever seen, so the store
// stands against the −X−Z corner with its windows on +Z, and the canopy sits toward +X, pulled
// back from the +Z kerb so the tube man's corner stays open in front of everything.

const STORE_IN = 0.8;            // off the block's −X and −Z edges
const STORE_D = 5.4;             // deep, along Z
const STORE_GAP = 0.4;           // short of the block's middle on X
const STORE_H = 3.0;
const PARAPET = 0.9;             // the fascia band over the roofline

// --- The canopy --------------------------------------------------------------------
const CAN_IN_X = 0.5;            // off the +X kerb
const CAN_GAP = 0.3;             // past the block's middle
/**
 * Back from the +Z kerb, so the tube man stands in front of it — and far enough that his fold
 * stays under it. Folded over toward −Z, he reaches 3.3 back from his blower at canopy height
 * (measured over 20 s), and he stands 1.1 in from the kerb; 3.0 put his head through the deck.
 */
const CAN_FRONT = 4.6;
/**
 * Canopy depth along Z, and the underside height — both a sightline rather than a proportion. A
 * line from the camera to a pump leaves the canopy across its +Z edge, climbing 0.92 for every unit
 * of z on the way out. Islands centred under a 4.5-deep canopy put the pump's face 1.8 in from that
 * edge, so its top (1.65 up) is seen under a 3.7 ceiling with 0.2 to spare. Deeper, or lower, and
 * the pumps vanish under their own roof.
 */
const CAN_D = 4.5;
const CAN_H = 3.7;
const CAN_T = 0.7;               // the deck plus its fascia
const ISLAND_SPREAD = 1.5;       // each island off the canopy's middle, along X
const ISLAND = { w: 0.7, l: 3.4, h: 0.15 };
const PUMP = { w: 0.55, l: 0.9, h: 1.5 };

const SIGN_IN = 1.0;
const SIGN_H = 5.4;              // to the panel's middle

/** Every number about a gas station, derived from its block. */
export function gasStationSite(block) {
  const { x0, x1, z0, z1, cx } = block.bounds;
  const store = { x0: x0 + STORE_IN, x1: cx - STORE_GAP, z0: z0 + STORE_IN, z1: z0 + STORE_IN + STORE_D };
  const canopy = { x0: cx + CAN_GAP, x1: x1 - CAN_IN_X, z0: z1 - CAN_FRONT - CAN_D, z1: z1 - CAN_FRONT };
  const canopyX = (canopy.x0 + canopy.x1) / 2;
  const canopyZ = (canopy.z0 + canopy.z1) / 2;
  return {
    bi: block.bi,
    bj: block.bj,
    bounds: block.bounds,
    store,
    canopy,
    islands: [-1, 1].map((s) => ({ x: canopyX + s * ISLAND_SPREAD, z: canopyZ })),
    tubeMan: roadsideCorner(block),
    sign: { x: x0 + SIGN_IN, z: z1 - SIGN_IN },
    focus: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 },
  };
}

/** What the model workshop finds this landmark by (src/workshop/catalog.js, `LANDMARKS`). */
// `glow`: what blooms, at which kind (game/bloom.js) — read by main.js and the bench alike.
export const LANDMARK = {
  id: 'gas', label: 'Gas station', create: createGasStation, glow: (g) => [[g.glow, 'window']],
};

export function createGasStation(block, rng) {
  const site = gasStationSite(block);
  const { store: s, canopy: c } = site;
  const { x0, x1, z0, z1 } = block.bounds;
  const base = LOT_Y;
  const green = color('gasGreen');
  const stripe = color('gasStripe');
  const white = color('gasWhite');
  const trim = color('gasTrim');
  const dark = color('gasPumpScreen');
  const paint = color('laneMark');

  const parts = [
    // The forecourt: asphalt over the whole block, a shade off the road so it reads as a lot.
    span(x0 + 0.3, x1 - 0.3, LOT_Y - 0.04, LOT_Y, z0 + 0.3, z1 - 0.3,
      jitterColor(color('gasLot'), rng, { l: 0.02 })),
  ];

  // --- The store ---------------------------------------------------------------------
  const top = base + STORE_H;
  parts.push(
    span(s.x0, s.x1, base, top, s.z0, s.z1, jitterColor(color('gasStoreWall'), rng, { l: 0.03 })),
    // The roof, and the green band round the two faces the camera sees, a yellow stripe along it.
    span(s.x0, s.x1, top, top + 0.1, s.z0, s.z1, trim),
    span(s.x0 - 0.1, s.x1 + 0.12, top - 0.35, top + PARAPET, s.z1 - 0.3, s.z1 + 0.12, green),
    span(s.x1 - 0.3, s.x1 + 0.12, top - 0.35, top + PARAPET, s.z0 - 0.1, s.z1 + 0.12, green),
    span(s.x0 - 0.1, s.x1 + 0.14, top - 0.35, top - 0.15, s.z1 + 0.12, s.z1 + 0.14, stripe),
    span(s.x1 + 0.12, s.x1 + 0.14, top - 0.35, top - 0.15, s.z0 - 0.1, s.z1 + 0.14, stripe),
    // A unit on the roof, so the roof is not a blank.
    box(1.1, 0.6, 0.8, (s.x0 + s.x1) / 2 - 0.6, top + 0.1, s.z0 + 1.4, trim),
  );
  // The store's name on the band.
  const word = wordParts('MART', 0.06, white, 0.15);
  word.forEach((g) => g.translate((s.x0 + s.x1) / 2, top + 0.3, s.z1 + 0.12));
  parts.push(...word);
  // The door on the +Z front, by the +X end, with a mat in front of it.
  const doorX = s.x1 - 1.0;
  parts.push(span(doorX - 0.55, doorX + 0.55, base, base + 2.2, s.z1, s.z1 + 0.04, trim));
  parts.push(span(doorX - 0.6, doorX + 0.6, LOT_Y, PAINT_Y, s.z1 + 0.05, s.z1 + 0.8, dark));
  // An ice chest under the window.
  parts.push(box(1.0, 0.95, 0.55, s.x0 + 1.0, base, s.z1 + 0.3, color('gasIce')));
  parts.push(box(1.06, 0.08, 0.6, s.x0 + 1.0, base + 0.95, s.z1 + 0.3, white));
  // Parking out front: three bays, nose in to the windows.
  for (let n = 0; n <= 3; n++) {
    const lx = s.x0 + 0.2 + n * ((s.x1 - s.x0 - 1.8) / 3);
    parts.push(span(lx - 0.07, lx + 0.07, LOT_Y, PAINT_Y, s.z1 + 1.1, s.z1 + 3.3, paint));
  }

  // --- The canopy and the pumps ---------------------------------------------------------
  // The deck and its band as one block, with a white soffit under it.
  parts.push(
    span(c.x0, c.x1, base + CAN_H, base + CAN_H + CAN_T, c.z0, c.z1, green),
    span(c.x0 - 0.02, c.x1 + 0.02, base + CAN_H + 0.12, base + CAN_H + 0.3, c.z1, c.z1 + 0.02, stripe),
    span(c.x1, c.x1 + 0.02, base + CAN_H + 0.12, base + CAN_H + 0.3, c.z0 - 0.02, c.z1 + 0.02, stripe),
    span(c.x0 + 0.05, c.x1 - 0.05, base + CAN_H - 0.02, base + CAN_H, c.z0 + 0.05, c.z1 - 0.05, white),
  );
  for (const isl of site.islands) {
    const { x, z } = isl;
    const ib = base + ISLAND.h;
    parts.push(box(ISLAND.w, ISLAND.h, ISLAND.l, x, base, z, color('gasIsland')));
    // The pump: a white cabinet with a green cap, a screen and a holstered nozzle on each side.
    parts.push(box(PUMP.w, PUMP.h, PUMP.l, x, ib, z, white));
    parts.push(box(PUMP.w + 0.06, 0.28, PUMP.l + 0.06, x, ib + PUMP.h, z, green));
    for (const side of [-1, 1]) {
      const fx = x + side * (PUMP.w / 2);
      parts.push(span(Math.min(fx, fx + side * 0.03), Math.max(fx, fx + side * 0.03),
        ib + 1.0, ib + 1.35, z - 0.25, z + 0.25, dark));
      parts.push(box(0.1, 0.32, 0.14, fx + side * 0.06, ib + 0.5, z + 0.25, dark));
      const hose = new THREE.TorusGeometry(0.28, 0.035, 4, 8, Math.PI);
      // The upper half of a ring turned over into a U and stood in the pump's face: a hose hanging
      // from the screen down to the nozzle.
      hose.rotateX(Math.PI);
      hose.rotateY(Math.PI / 2);
      hose.translate(fx + side * 0.04, ib + 0.95, z - 0.05);
      parts.push(bakeColor(hose, dark));
    }
    // The canopy's columns at the island ends, and a bollard guarding each.
    for (const end of [-1, 1]) {
      const pz = z + end * (ISLAND.l / 2 - 0.3);
      parts.push(box(0.26, CAN_H - ISLAND.h, 0.26, x, ib, pz, white));
      const bollard = new THREE.CylinderGeometry(0.11, 0.11, 0.8, 8);
      bollard.translate(x, ib + 0.4, z + end * (ISLAND.l / 2 + 0.25));
      parts.push(bakeColor(bollard, color('gasBollard')));
    }
  }

  // --- The pylon sign: GAS on green, and a white price board under it ---------------
  const sx = site.sign.x;
  const sz = site.sign.z;
  parts.push(box(0.3, SIGN_H - 1.2, 0.3, sx, base, sz, trim));
  const panel = [];
  const PW = 2.4;
  panel.push(bakeColor(new THREE.BoxGeometry(PW + 0.2, 1.4, 0.2).translate(0, 0.3, -0.02), trim));
  panel.push(bakeColor(new THREE.BoxGeometry(PW, 1.2, 0.2).translate(0, 0.3, 0), green));
  panel.push(bakeColor(new THREE.BoxGeometry(PW, 0.1, 0.22).translate(0, -0.18, 0), stripe));
  const gas = wordParts('GAS', 0.08, white, 0.18);
  gas.forEach((g) => g.translate(0, 0.38, 0.1));
  panel.push(...gas);
  panel.push(bakeColor(new THREE.BoxGeometry(PW, 0.9, 0.2).translate(0, -0.75, 0), white));
  // Two price rows: a short grade label and three digits as dark blocks.
  for (const row of [-0.55, -0.95]) {
    panel.push(bakeColor(new THREE.BoxGeometry(0.5, 0.18, 0.04).translate(-0.75, row, 0.11), green));
    for (let d = 0; d < 3; d++) {
      panel.push(bakeColor(new THREE.BoxGeometry(0.22, 0.28, 0.04).translate(0.1 + d * 0.32, row, 0.11), dark));
    }
  }
  const toSign = new THREE.Matrix4().compose(
    new THREE.Vector3(sx, base + SIGN_H, sz),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
    new THREE.Vector3(1, 1, 1),
  );
  for (const g of panel) parts.push(g.applyMatrix4(toSign));

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
  shell.name = 'gas-station';

  // --- What is lit: the store's windows. Not the canopy's underside: the camera never sees it, and
  // panels lit there showed on the deck's top as pale squares in the first render.
  const glowCol = color('gasGlow');
  const glowParts = [
    // The +Z windows, either side of the door, and a run down the +X face.
    span(s.x0 + 0.4, doorX - 0.75, base + 0.6, base + 2.2, s.z1, s.z1 + 0.03, glowCol),
    span(s.x1, s.x1 + 0.03, base + 0.6, base + 2.2, s.z1 - 2.6, s.z1 - 0.4, glowCol),
  ];
  glowParts.forEach(stampAll);
  const glow = new THREE.Mesh(mergeGeometries(glowParts, false), unlitMaterial({ vertexColors: true }));
  glowParts.forEach((p) => p.dispose());
  glow.name = 'gas-station-glow';

  const group = new THREE.Group();
  group.name = 'gas-station-root';
  group.add(shell, glow);

  const entry = { x: anchorX, z: anchorZ, rand };
  return {
    site,
    group,
    shell,
    glow,
    update: () => {},
    meshes: [shell, glow],
    entryObjects: [],
    entry,
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(x1 - x0, z1 - z0) / 2, rand },
  };
}
