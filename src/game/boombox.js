import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, unlitMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { BILLBOARD } from './camera.js';
import { BOOMBOX_D, BOOMBOX_W } from '../city/blacktop.js';

// The boom box on the lawn beside the basketball court (`planBoombox` in city/blacktop.js picks the
// spot), playing to the players: the box bounces on the beat, its woofers pump, and music notes
// float up out of the speakers. Scenery on the hoopers' terms — no collisions, nothing the fare
// loop knows about, and a run seed for the little that is drawn at random.
//
// **There is no sound yet.** The music is to come, and this is built to take it:
//
//   - `emitter` is where it plays from in the world (between the two speakers, at their height),
//     for main.js to hand to `placeAt` beside the court's own bed — see `ambientLevels` there.
//   - `update(dt, musicTime)` takes the track's own playback time when there is one, and then the
//     beat the box bounces to is the track's rather than its own clock. Without it the box keeps
//     time to `BPM` on its own. Set `BPM` to the track's tempo when the file lands.
//
// **The notes are opaque and go out by shrinking, not fading.** A note is three overlapping shapes
// (head, stem, flag), and a translucent one blends twice wherever two of them overlap — a bright
// knot where the stem meets the head. Scale has no such seam, costs no sorting, and the pop in and
// out reads as more musical than a fade anyway.

/** The tempo the box keeps on its own, until a track tells it otherwise. */
export const BPM = 96;

// The box, in its own frame: origin on the ground under its middle (`plan.y` — the lawn, or the
// court's apron), +Z out of its face.
const H = 0.66;
const SPK_X = 0.37;
const SPK_Y = 0.33;
const SPK_R = 0.25;
const CONE_R = 0.19;
const HANDLE_H = 0.2;

/** How hard the box squashes on each beat, and how fast it recovers (per beat). */
const BOUNCE = 0.07;
const DECAY = 7;

// The notes. One per beat, alternating speakers; at 96 BPM and 1.9s of life that is three in the
// air at a time. The pool is sized for a faster track than that.
const NOTE_LIFE = 1.9;
const NOTE_POOL = 7;
/** World units tall — about 9px at play zoom (1 unit ≈ 7.7px), the smallest that reads as a note. */
const NOTE_SIZE = 1.15;
const RISE = 1.15;
const DRIFT = 0.45;
const SWAY = 0.28;
/** The share of notes drawn as a beamed pair rather than a single quaver. */
const PAIRS = 0.35;

/**
 * @param plan  `props.boombox` from `planBoombox`, or null — a quiet no-op, the hoopers' way.
 */
export function createBoombox(scene, rng, plan) {
  const group = new THREE.Group();
  group.name = 'boombox';
  const none = {
    group, entryObjects: [], emitter: null, update: () => {}, settle: () => {},
  };
  if (!plan) return none;
  scene.add(group);

  // --- The box --------------------------------------------------------------
  // `holder` places and turns it, and is what the city's entrance wave scales; `body` is what
  // bounces inside it, so the two never fight over one `scale`.
  const holder = new THREE.Group();
  holder.position.set(plan.x, plan.y, plan.z);
  holder.rotation.y = plan.yaw;
  const body = new THREE.Group();
  holder.add(body);
  group.add(holder);

  const parts = [];
  const box = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };
  /** A disc facing +Z — a cylinder stood on its side. */
  const disc = (r, depth, x, y, z, col, into = parts) => {
    const geo = new THREE.CylinderGeometry(r, r, depth, 12);
    geo.rotateX(Math.PI / 2);
    geo.translate(x, y, z);
    into.push(bakeColor(geo, new THREE.Color(col)));
  };
  const front = BOOMBOX_D / 2;
  box(BOOMBOX_W, H, BOOMBOX_D, 0, H / 2, 0, PALETTE.boomboxBody);
  for (const s of [-1, 1]) {
    disc(SPK_R, 0.05, s * SPK_X, SPK_Y, front + 0.025, PALETTE.boomboxCap);
    // The handle's two posts.
    box(0.07, HANDLE_H, 0.07, s * 0.42, H + HANDLE_H / 2, 0, PALETTE.boomboxTrim);
  }
  box(0.91, 0.07, 0.07, 0, H + HANDLE_H, 0, PALETTE.boomboxTrim);
  // The tape deck between the speakers, and a row of keys along the top edge above it.
  box(0.26, 0.17, 0.03, 0, 0.36, front + 0.015, PALETTE.boomboxTape);
  for (let k = 0; k < 4; k++) box(0.05, 0.04, 0.07, -0.09 + k * 0.06, H + 0.02, front - 0.06, PALETTE.boomboxTrim);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  // The woofers, separate so they can pump: a dark cone with a lighter cap, pivoted on the face.
  const coneParts = [];
  disc(CONE_R, 0.03, 0, 0, 0.015, PALETTE.boomboxCone, coneParts);
  disc(0.07, 0.04, 0, 0, 0.03, PALETTE.boomboxCap, coneParts);
  const coneGeometry = mergeGeometries(coneParts, false);
  coneParts.forEach((p) => p.dispose());
  const coneMaterial = propMaterial();
  const cones = [-1, 1].map((s) => {
    const cone = new THREE.Mesh(coneGeometry, coneMaterial);
    cone.position.set(s * SPK_X, SPK_Y, front + 0.05);
    body.add(cone);
    return cone;
  });

  // Where the sound comes from: the middle of the face at the speakers' height, in the world.
  const toWorld = (lx, ly, lz) => {
    const sin = Math.sin(plan.yaw);
    const cos = Math.cos(plan.yaw);
    return { x: plan.x + lx * cos + lz * sin, y: plan.y + ly, z: plan.z - lx * sin + lz * cos };
  };
  const emitter = toWorld(0, SPK_Y, front);
  // The notes start over the box rather than at the cones: from this camera a note born at a speaker
  // is drawn straight over the box it is meant to be coming out of, and hides it.
  const speakers = [-1, 1].map((s) => toWorld(s * SPK_X, H + HANDLE_H + 0.45, front));
  // Out of the face, in the world: the way the notes drift as they rise.
  const out = { x: Math.sin(plan.yaw), z: Math.cos(plan.yaw) };

  // --- The notes ------------------------------------------------------------
  const geometries = [quaverGeometry(), pairGeometry()];
  const materials = [PALETTE.musicNoteA, PALETTE.musicNoteB].map((color) => unlitMaterial({ color }));
  const notes = [];
  for (let n = 0; n < NOTE_POOL; n++) {
    const mesh = new THREE.Mesh(geometries[0], materials[0]);
    mesh.visible = false;
    group.add(mesh);
    notes.push({ mesh, age: NOTE_LIFE, x: 0, z: 0, y: 0, phase: 0, tilt: 0 });
  }
  const spin = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);

  let side = 0;
  function emit() {
    const note = notes.find((n) => n.age >= NOTE_LIFE);
    if (!note) return;
    const from = speakers[side];
    side = 1 - side;
    note.age = 0;
    note.x = from.x;
    note.y = from.y;
    note.z = from.z;
    note.phase = rng.range(0, Math.PI * 2);
    note.tilt = rng.jitter(0.35);
    note.mesh.geometry = geometries[rng.chance(PAIRS) ? 1 : 0];
    note.mesh.material = materials[rng.int(0, 1)];
    note.mesh.visible = true;
  }

  function stepNote(note, dt) {
    if (note.age >= NOTE_LIFE) return;
    note.age += dt;
    if (note.age >= NOTE_LIFE) {
      note.mesh.visible = false;
      return;
    }
    const t = note.age;
    // Up, out of the face, and swaying side to side across it.
    const sway = Math.sin(t * 3.2 + note.phase) * SWAY;
    const x = note.x + out.x * DRIFT * t + out.z * sway;
    const z = note.z + out.z * DRIFT * t - out.x * sway;
    note.mesh.position.set(x, note.y + RISE * t, z);
    // Pops in, holds, shrinks away — an overshoot on the way in so it reads as bouncing out.
    const k = t / NOTE_LIFE;
    const grow = Math.min(1, t / 0.18);
    const pop = grow < 1 ? grow * (1 + 0.35 * Math.sin(grow * Math.PI)) : 1;
    const shrink = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    note.mesh.scale.setScalar(NOTE_SIZE * pop * shrink);
    // Turned to face the camera, and rocking a little in the screen's plane.
    spin.setFromAxisAngle(Z, note.tilt + Math.sin(t * 4 + note.phase) * 0.25);
    note.mesh.quaternion.copy(BILLBOARD).multiply(spin);
  }

  // --- Time -----------------------------------------------------------------
  let clock = 0;
  let lastBeat = -1;
  function update(dt, musicTime = null) {
    clock += dt;
    const beats = ((musicTime ?? clock) * BPM) / 60;
    const beat = Math.floor(beats);
    // A note on every beat, on the beat. A long frame or a seek in the track can skip several, and
    // only the one is emitted — a flock of notes after a hitch is the hitch made visible.
    if (beat !== lastBeat) {
      if (beat > lastBeat) emit();
      lastBeat = beat;
    }
    const env = Math.exp(-(beats - beat) * DECAY);
    body.scale.set(1 + BOUNCE * 0.5 * env, 1 - BOUNCE * env, 1 + BOUNCE * 0.5 * env);
    for (const cone of cones) {
      cone.scale.set(1 + 0.12 * env, 1 + 0.12 * env, 1 + 2.5 * env);
    }
    for (const note of notes) stepNote(note, dt);
  }

  // Run on for a moment at construction, so the first frame — and a shot, which ticks once and
  // freezes (CLAUDE.md) — has notes already in the air rather than none.
  function settle() {
    for (let n = 0; n < 40; n++) update(0.05);
  }
  settle();

  // Grown in the city's entrance wave with the court beside it, on the court's anchor. The notes
  // ride the same anchor, so none hangs over an empty lawn while the box is still coming up.
  const anchor = { x: plan.court.x, z: plan.court.z, rand: hash01(plan.court.x, plan.court.z) };
  const entryObjects = [holder, ...notes.map((n) => n.mesh)].map((object) => ({ object, ...anchor }));

  return { group, holder, notes, entryObjects, emitter, plan, update, settle };
}

// --- The notes' shapes -------------------------------------------------------
//
// Drawn in XY, about one unit tall, and centred on their own bounds so they scale about their
// middle. `ShapeGeometry` faces +Z whichever way an outline winds, and `BILLBOARD` turns +Z to the
// camera.

const HEAD_RX = 0.2;
const HEAD_RY = 0.15;
const HEAD_TILT = 0.4;
const STEM_W = 0.075;
const STEM_H = 0.85;

function head(cx, cy) {
  const shape = new THREE.Shape();
  shape.absellipse(cx, cy, HEAD_RX, HEAD_RY, 0, Math.PI * 2, false, HEAD_TILT);
  return shape;
}

function rect(x0, y0, x1, y1) {
  const shape = new THREE.Shape();
  shape.moveTo(x0, y0);
  shape.lineTo(x1, y0);
  shape.lineTo(x1, y1);
  shape.lineTo(x0, y1);
  shape.closePath();
  return shape;
}

/** The stem's x, up the right of a head at `cx`. */
const stemX = (cx) => cx + HEAD_RX * 0.86;

function centred(shapes) {
  const geo = new THREE.ShapeGeometry(shapes, 6);
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, 0);
  return geo;
}

/** ♪ — a quaver: a head, a stem, and a flag curling off the stem's top. */
function quaverGeometry() {
  const sx = stemX(0);
  const flag = new THREE.Shape();
  flag.moveTo(sx, STEM_H);
  flag.quadraticCurveTo(sx + 0.05, STEM_H - 0.18, sx + 0.3, STEM_H - 0.3);
  flag.quadraticCurveTo(sx + 0.38, STEM_H - 0.45, sx + 0.26, STEM_H - 0.6);
  flag.quadraticCurveTo(sx + 0.24, STEM_H - 0.42, sx, STEM_H - 0.32);
  flag.closePath();
  return centred([head(0, 0), rect(sx - STEM_W, 0.03, sx, STEM_H), flag]);
}

/** ♫ — two quavers beamed together. */
function pairGeometry() {
  const gap = 0.5;
  const a = stemX(0);
  const b = stemX(gap);
  const beam = new THREE.Shape();
  beam.moveTo(a - STEM_W, STEM_H - 0.16);
  beam.lineTo(b, STEM_H - 0.08);
  beam.lineTo(b, STEM_H + 0.08);
  beam.lineTo(a - STEM_W, STEM_H);
  beam.closePath();
  return centred([
    head(0, 0), rect(a - STEM_W, 0.03, a, STEM_H),
    head(gap, 0.08), rect(b - STEM_W, 0.11, b, STEM_H + 0.08),
    beam,
  ]);
}
