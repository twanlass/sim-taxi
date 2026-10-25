import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { wordParts } from './roadside.js';

// The vet clinic: one of the city's ordinary shops, left exactly as the tower generator built it,
// with a giant cartoon dog's head on a pole over its roof and a small neon OPEN sign in its window.
// Tyler asked for it on 2026-10-25, in the burger joint's terms — the sign *is* the building.
//
// **Nothing about the building changes.** It is not a landmark that takes a block the way the depot
// and the burger joint do: `createBuildings` builds every tower first, hands back what each one is
// (`buildTower`'s record), and `chooseVetSite` below picks one afterwards by hash. So the skyline a
// seed builds is the skyline it always built, down to the last air conditioner; the clinic is only
// the two things added to it. `?vet=classic` leaves them off.
//
// **Which shop.** A one-tier masonry shop with a flat roof, on the **+X+Z corner lot** of its block.
// The camera looks down the +X+Z diagonal and never turns, so that corner is the one that faces it:
// both street faces visible, the shopfront glazing on both, nothing of its own block in front. Then
// the sightline: a ray off the OPEN sign and another off the dog's head, marched towards the camera
// through every other tower's box. The tallest towers sit downtown, and a corner shop with one
// across the street from it has its window hidden however well it faces.

/** `?vet=classic` — the shop stays a plain shop. */
export const VET_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('vet') === 'classic';

/**
 * `?vetopen=word` — the OPEN sign spelled out in red neon letters inside the blue frame, instead
 * of the default: the blue frame with one red bar through it.
 *
 * The bar is the default on a measurement rather than a taste. The letters are 0.06 a pixel, which
 * is under half a screen pixel each at play zoom (a world unit is ~7.7px), so "OPEN" lands as a
 * red smudge; the bar is the same red in one stroke and reads as exactly the same smudge, a crisper
 * one. Both are kept so the close-up can still spell it.
 */
export const OPEN_STYLE = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('vetopen') === 'word' ? 'word' : 'bar';

const SIDE_OUT = [[1, 0], [0, 1], [-1, 0], [0, -1]];     // as city/buildings.js numbers its faces
const SIDE_TAN = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// --- The head ---------------------------------------------------------------------------------

/**
 * The head's radius, and the only size it has: every part in `dogHeadGeometry` is a fraction of
 * it. 1.75 makes the head about 4.2 units across the ears — 32px at play zoom, a little under the
 * burger's 40. The first pass at 1.4 read as a dog but not as an *oversized* one: on a corner shop
 * 6 units across it was a statue on the roof rather than a sign over it.
 */
export const HEAD_R = 1.75;
/** Deck to the head's centre. Puts the collar 1.75 over the roof, clear of the tallest plant room (1.6). */
const POLE_H = 3.7;
const POLE_R = 0.11;
/**
 * Which way the face looks: the camera's own bearing, swung 0.5 rad towards +X. Square on, the
 * snout points down the view axis and foreshortens to nothing, and a dog with no snout is a bear.
 * Swung off it the muzzle and the tongue come out past the cheek in profile, which is what says dog.
 */
const HEAD_YAW = Math.PI / 4 + 0.5;
/** ...and tipped back so the face is turned up towards a camera that is 33° above it. */
const HEAD_PITCH = -0.32;
/** The head cock: how far, and how often (rad, rad/s). Slow — a dog listening, not a metronome. */
const COCK = 0.16;
const COCK_RATE = 1.3;
/** The pant: the tongue stretching and settling, a few times a second. */
const PANT = 0.12;
const PANT_RATE = 8;

/**
 * `bakeColor` that keeps soft normals — the head is round, and `bakeColor` would facet it. The
 * same thing `bakeSmooth` does in city/burgerjoint.js.
 */
function smooth(geometry, col) {
  const geo = geometry.toNonIndexed();
  geometry.dispose();
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  const c = new THREE.Color(col);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** A sphere squashed to an ellipsoid and placed, with its normals re-derived for the squash. */
function blob(r, [sx, sy, sz], [x, y, z], col, { rx = 0, ry = 0, rz = 0, seg = 12 } = {}) {
  const geo = new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.7)));
  geo.scale(sx, sy, sz);
  geo.rotateX(rx);
  geo.rotateY(ry);
  geo.rotateZ(rz);
  geo.translate(x, y, z);
  geo.computeVertexNormals();
  return smooth(geo, col);
}

/**
 * The dog's head, about its own centre, looking down +Z. Everything but the tongue: that is its
 * own geometry (`dogTongueGeometry`) so it can pant.
 *
 * A toy, the way the burger is: every part is a squashed sphere at twelve segments, so it reads as
 * moulded fibreglass on a pole rather than as an animal. The proportions are the ones a dog is
 * *drawn* in — a skull, a muzzle pushed well forward, eyes far too big, and ears longer than the
 * head is tall — because at 32 pixels it is the outline that has to say dog, and those are the
 * four things in it.
 */
export function dogHeadGeometry() {
  const R = HEAD_R;
  const fur = color('dogFur');
  const parts = [
    // The skull, a touch wider than it is tall.
    blob(R, [1.0, 0.92, 0.95], [0, 0, 0], fur),
    // The muzzle, cream, pushed forward and down off the face.
    blob(R * 0.6, [1.05, 0.78, 1.0], [0, -R * 0.32, R * 0.78], color('dogMuzzle')),
    // The nose on the end of it.
    blob(R * 0.2, [1.35, 0.95, 1.0], [0, -R * 0.12, R * 1.36], color('dogNose'), { seg: 10 }),
    // The open mouth under the muzzle, the dark the tongue hangs out of.
    blob(R * 0.3, [1.2, 0.55, 0.8], [0, -R * 0.62, R * 0.95], color('dogMouth'), { seg: 10 }),
    // The neck, down into the collar.
    blob(R * 0.55, [1.0, 0.9, 0.95], [0, -R * 0.78, -R * 0.08], fur),
  ];
  // Eyes: a white each, and a pupil sat forward on it and a little in, so he is looking at you.
  for (const s of [-1, 1]) {
    parts.push(blob(R * 0.22, [1, 1.1, 0.7], [s * R * 0.38, R * 0.22, R * 0.8], color('dogEye'), { seg: 10 }));
    parts.push(blob(R * 0.12, [1, 1.1, 0.6], [s * R * 0.35, R * 0.22, R * 0.94], color('dogNose'), { seg: 8 }));
    // The ears: long, flat and floppy, hung off the top of the skull and down past the jaw, kicked
    // out at the bottom so the silhouette is wider at the ears than at the crown.
    parts.push(blob(R * 0.5, [0.38, 1.35, 0.85], [s * R * 0.98, -R * 0.2, -R * 0.08], color('dogEar'),
      { rz: s * 0.32 }));
  }
  // The collar, in the sign's blue, and its gold tag hanging at the front.
  const collar = new THREE.TorusGeometry(R * 0.5, R * 0.1, 6, 16);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, -R * 1.12, -R * 0.08);
  parts.push(smooth(collar, color('dogCollar')));
  parts.push(blob(R * 0.12, [1, 1, 0.45], [0, -R * 1.3, R * 0.5], color('dogTag'), { seg: 8 }));

  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

/** Where the tongue hangs from, in the head's frame: the front lip of the mouth. */
const TONGUE_AT = [0.12, -0.66, 1.02];

/**
 * The tongue, about its own **root** rather than its centre, so scaling it in y stretches it down
 * out of the mouth and the root stays put. Big and a little off-centre, the way a cartoon dog's is.
 */
export function dogTongueGeometry() {
  const R = HEAD_R;
  const geo = blob(R * 0.27, [1.0, 1.75, 0.42], [0, -R * 0.36, R * 0.04], color('dogTongue'), { rx: -0.35 });
  return geo;
}

// --- The OPEN sign ----------------------------------------------------------------------------

const SIGN_W = 1.0;
const SIGN_H = 0.5;
const TUBE_R = 0.035;
/** Off the wall to the tube's centre: in front of the glass (0.03), behind the mullions' face (0.1). */
const SIGN_OUT = 0.065;

/**
 * The sign, in its own XY plane facing +Z, centred: a blue tube round a rounded rectangle, and
 * inside it either a red bar or the word. See `OPEN_STYLE`.
 */
export function openSignParts(style = OPEN_STYLE, w = SIGN_W) {
  const h = Math.min(SIGN_H, w * 0.5);
  const r = h * 0.3;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0);
  shape.lineTo(w / 2, h / 2 - r);
  shape.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5);
  const points = shape.getSpacedPoints(48).map((p) => new THREE.Vector3(p.x, p.y, 0));
  const path = new THREE.CatmullRomCurve3(points, true);
  const parts = [bakeColor(new THREE.TubeGeometry(path, 64, TUBE_R, 5, true), color('vetNeonBlue'))];
  const red = color('vetNeonRed');
  if (style === 'word') {
    const pixel = (w - 4 * TUBE_R - 0.12) / 19;          // OPEN is 19 pixels wide in wordParts' font
    const word = wordParts('OPEN', TUBE_R, red, pixel);
    word.forEach((g) => g.translate(0, 0, -TUBE_R / 2));
    parts.push(...word);
  } else {
    // Twice the frame's tube: a bar the same weight as the frame read as a hairline at play zoom
    // (Tyler, 2026-10-25), and the bar is the one stroke that says "this is a sign".
    const bar = new THREE.CapsuleGeometry(TUBE_R * 2, w * 0.5, 3, 6);
    bar.rotateZ(Math.PI / 2);
    parts.push(bakeColor(bar, red));
  }
  return parts;
}

// --- Choosing the shop ------------------------------------------------------------------------

const RISE = 0.92;              // the view's climb per unit of x (and of z): VIEW_DIR in game/camera.js
const LIP = 0.28;               // the roof's lip, which the pole keeps inside (LIP_W in buildings.js)

/** Does a ray from `p` towards the camera get out without entering another tower's box? */
function clearOf(towers, self, p) {
  for (let t = 0.25; t < 40; t += 0.25) {
    const x = p.x + t;
    const y = p.y + RISE * t;
    const z = p.z + t;
    for (const o of towers) {
      if (o === self) continue;
      // The roof's highest thing is not recorded — a pitched roof rises up to 2.4, a plant room 1.6
      // — so every box is taken as that much taller. Rounding up only ever costs a candidate.
      if (y < o.top + 2.6 && x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return false;
    }
  }
  return true;
}

/** The OPEN sign's place on a tower's shopfront: which face, where along it, and how wide. */
function signSpot(tower) {
  const shops = tower.front.shops.filter((s) => s.side === 0 || s.side === 1);
  // +X first: it is the face the sun is on (FACING in buildings.js), and the brighter of the two.
  shops.sort((a, b) => a.side - b.side);
  for (const shop of shops) {
    const rect = shop.rects.reduce((best, r) => (r.w > best.w ? r : best));
    // In one pane, between the mullions, rather than straddling one: the middle pane.
    const panes = rect.panes ?? 1;
    const paneW = rect.w / panes;
    const k = Math.floor(panes / 2);
    const u = rect.u - rect.w / 2 + (k + 0.5) * paneW;
    const w = Math.min(SIGN_W, paneW - 0.2);
    if (w < 0.6) continue;
    const [nx, nz] = SIDE_OUT[shop.side];
    const [tx, tz] = SIDE_TAN[shop.side];
    const reach = (shop.side === 0 ? tower.w : tower.d) / 2 + SIGN_OUT;
    return {
      side: shop.side, w,
      x: tower.cx + nx * reach + tx * u, y: rect.y, z: tower.cz + nz * reach + tz * u,
    };
  }
  return null;
}

/** Where on the roof the pole goes: the middle, unless the plant room is there. */
function poleSpot(deck) {
  const ax = deck.cw / 2 - LIP - 0.6;
  const az = deck.cd / 2 - LIP - 0.6;
  const tries = [[0, 0], [0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const free = ([fx, fz]) => {
    const x = deck.cx + fx * ax;
    const z = deck.cz + fz * az;
    return deck.keep.every((k) => x < k.x0 - 0.25 || x > k.x1 + 0.25 || z < k.z0 - 0.25 || z > k.z1 + 0.25);
  };
  const [fx, fz] = tries.find(free) ?? [0, 0];
  return { x: deck.cx + fx * ax, z: deck.cz + fz * az };
}

/**
 * Pick the city's vet clinic from the towers `createBuildings` built, or null.
 *
 * By hash, after everything else is decided, so it spends no draw and moves nothing. `pad` is the
 * deck the helicopter lands on, which is not a roof anyone can put a dog on.
 */
export function chooseVetSite(towers, pad) {
  const candidates = [];
  for (const t of towers) {
    if (t.tiers !== 1 || t.style !== 'punched' || !t.deck || t.deck === pad) continue;
    if (!t.streetSides.includes(0) || !t.streetSides.includes(1) || !t.front) continue;
    if (Math.min(t.deck.cw, t.deck.cd) < 2.4) continue;
    const sign = signSpot(t);
    if (!sign) continue;
    const pole = poleSpot(t.deck);
    const head = { x: pole.x, y: t.deck.deck + POLE_H, z: pole.z };
    if (!clearOf(towers, t, sign) || !clearOf(towers, t, { ...head, y: head.y - HEAD_R })) continue;
    candidates.push({ tower: t, sign, pole, head });
  }
  if (!candidates.length) return null;
  const sx = candidates.reduce((n, c) => n + c.tower.cx, 0);
  const sz = candidates.reduce((n, c) => n + c.tower.cz, 0);
  const pick = candidates[Math.floor(hash01(sx * 0.37, sz * 0.61) * candidates.length) % candidates.length];
  const { tower, sign, pole, head } = pick;
  // The birds roost on decks and walk round what stands on them (game/birds.js).
  tower.deck.keep.push({ x0: pole.x - 0.3, x1: pole.x + 0.3, z0: pole.z - 0.3, z1: pole.z + 0.3 });
  return {
    sign, pole, head, deck: tower.deck.deck,
    bounds: { x0: tower.x0, x1: tower.x1, z0: tower.z0, z1: tower.z1 },
    // The entrance anchor its building was stamped with (`createBuildings`), so the sign rises with it.
    anchor: { x: tower.cx, z: tower.cz, rand: hash01(tower.cx, tower.cz) },
    // Where to point a camera: the shop's street corner, at the height of its window.
    focus: { x: tower.x1, y: sign.y, z: tower.z1 },
  };
}

// --- Building it ------------------------------------------------------------------------------

/**
 * The clinic's additions: the pole (lit, in the entrance wave's shader), the OPEN sign (unlit, a
 * light, in the wave too), and the head on a pivot of its own (grown on the CPU, `entryObject`,
 * because it moves — see `burgerGeometry` in city/burgerjoint.js for why a moving thing cannot ride
 * the wave's shader).
 */
export function createVetClinic(site, { open = OPEN_STYLE } = {}) {
  const { anchor } = site;
  const stamp = (geo) => stampEntry(geo, anchor.x, anchor.z, anchor.rand);

  const poleGeo = new THREE.CylinderGeometry(POLE_R, POLE_R * 1.3, POLE_H - HEAD_R * 0.9, 8);
  poleGeo.translate(site.pole.x, site.deck + (POLE_H - HEAD_R * 0.9) / 2, site.pole.z);
  const shell = new THREE.Mesh(stamp(bakeColor(poleGeo, color('pole'))), propMaterial());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'vet-pole';

  const signParts = openSignParts(open, site.sign.w);
  const turn = site.sign.side === 0 ? Math.PI / 2 : 0;          // local +Z onto the face's outward
  for (const g of signParts) {
    g.rotateY(turn);
    g.translate(site.sign.x, site.sign.y, site.sign.z);
    stamp(g);
  }
  const glow = new THREE.Mesh(mergeGeometries(signParts, false), unlitMaterial({ vertexColors: true }));
  signParts.forEach((p) => p.dispose());
  glow.name = 'vet-open-sign';

  // Three objects for the head, each doing one thing: the pivot carries the place and the bearing,
  // the head inside it cocks about its own axis, and the tongue inside that pants.
  const head = new THREE.Mesh(dogHeadGeometry(), propMaterial({ smooth: true }));
  head.castShadow = true;
  head.name = 'vet-dog-head';
  const tongue = new THREE.Mesh(dogTongueGeometry(), propMaterial({ smooth: true }));
  tongue.castShadow = true;
  tongue.name = 'vet-dog-tongue';
  tongue.position.set(...TONGUE_AT.map((v) => v * HEAD_R));
  head.add(tongue);
  const pivot = new THREE.Group();
  pivot.name = 'vet-dog-pivot';
  pivot.position.set(site.head.x, site.head.y, site.head.z);
  pivot.rotation.set(HEAD_PITCH, HEAD_YAW, 0, 'YXZ');
  pivot.add(head);

  const group = new THREE.Group();
  group.name = 'vet-clinic';
  group.add(shell, glow, pivot);

  // Opened at a hashed phase rather than at zero: shot mode ticks once and freezes, and a dog that
  // is mid-cock in every screenshot reads better than one bolt upright in all of them.
  let clock = anchor.rand * 10;
  function update(dt) {
    clock += dt;
    head.rotation.z = COCK * Math.sin(clock * COCK_RATE);
    tongue.scale.y = 1 + PANT * (0.5 + 0.5 * Math.sin(clock * PANT_RATE));
  }
  update(0);

  return {
    site, group, shell, glow, head, tongue, pivot, update,
    /** Stamped meshes, for the entrance wave and the AO prepass. */
    meshes: [shell, glow],
    entryObject: { object: pivot, x: anchor.x, z: anchor.z, rand: anchor.rand },
  };
}
