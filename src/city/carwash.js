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
const SIGN_H = 5.6;              // to the panel's middle
const VAC_BACK = 1.3;            // the vacuum posts, back from the +Z kerb

// --- The brushes -------------------------------------------------------------------
const BRUSH_R = 0.55;
const BRUSH_H = 2.3;
/** Radians per second. A real wash brush turns at about two revolutions a second; this is half. */
export const BRUSH_SPIN = 6.5;
const FINS = 10;

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
    // The tunnel's floor, and the two guide rails a wheel runs between.
    span(t.x0 - 0.6, t.x1 + 0.6, FLOOR_Y - 0.03, FLOOR_Y, t.z0 + WALL_T, t.z1, color('carWashFloor')),
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

  // --- The pylon sign: a pole and a panel turned square to the camera ------------
  const sx = site.sign.x;
  const sz = site.sign.z;
  parts.push(box(0.3, SIGN_H - 0.9, 0.3, sx, base, sz, trim));
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

  const group = new THREE.Group();
  group.name = 'car-wash-root';
  group.add(shell, glow, moving);

  let clock = rand * 10;
  function update(dt) {
    clock += dt;
    for (const s of spinners) s.mesh.rotation[s.axis] += s.rate * dt;
    curtain.rotation.z = 0.22 * Math.sin(clock * 2.1);
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
    /** The brushes and the curtain turn, so the wave grows them on the CPU. */
    entryObjects: [...spinners.map((s) => s.mesh), curtain].map((object) => ({ object, ...entry })),
    entry,
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(x1 - x0, z1 - z0) / 2, rand },
  };
}
