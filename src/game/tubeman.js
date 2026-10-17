import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { APRON_Y } from '../city/burgerjoint.js';

// The inflatable tube man at the burger joint's drive-through entrance: a red tube on a blower,
// yellow hair, a cartoon face and two floppy arms, flailing (Tyler, 2026-10-17, off a photo of the
// real thing). Scenery on the boom box's terms — no collisions, nothing the fare loop knows about,
// and a run seed for its rhythm. `?tubeman=classic` leaves him out.
//
// **Where he stands is a sightline, not a taste.** On the joint's apron, between the drive-through
// lane and the +X kerb, a little way down from the +Z corner. The obvious spot is the corner
// itself, and it is taken twice over: the lane's entry arc is centred a unit in from it, so a car
// turning in sweeps its inner flank within a unit of the corner post; and the −X end of the +Z
// forecourt, the other corner, is the one place on the block the city across the road can hide —
// measured over 200 cities with `ceilingOf`'s height predictions, 27 had more than 2.5 units of him
// behind a tower there. The +X strip had none, because `chooseBurgerBlock` already filters on a
// sightline from that lane to the camera, and this strip sits beside the lane.
//
// **How he moves.** A chain of capsules, each jointed to the one under it, bent by two travelling
// waves — a slow lateral one and a faster one over it — so the S runs up the tube from the blower
// rather than the whole thing rocking as one stick. The sway is about the local Z axis, across the
// screen: the camera never rotates, so a bend toward or away from it barely shows. Every few
// seconds he **slumps**: the lower joints fold him over, the head hangs, the arms drop, and he
// whips back up with an overshoot. That fold is what makes it read as an inflatable rather than a
// wobbling pole, and it goes down the strip rather than across it — see `update`.

/** Body: capsule radius, joint spacing, and how many. 7 × 0.55 over the blower is about 4.2 up. */
const R = 0.3;
const SEG = 0.55;
const SEGS = 7;
/** The joint the arms hang off — the top of this segment, about seven tenths of the way up. */
const SHOULDER = 4;
const ARM_R = 0.12;
const ARM_SEG = 0.38;
const ARM_SEGS = 3;
/** The blower box he stands on. */
const BLOWER = { w: 0.8, h: 0.36 };

/** From the +X kerb, in to his centre; and from the +Z kerb, down to it. See the note above. */
const KERB_IN = 0.9;
const CORNER_BACK = 2.6;

// The motion. Angles in radians per joint, so the tip of the tube sees about `SEGS` of each.
const SWAY = 0.15;              // the slow lateral wave
const SWAY_W = 4.2;
const FLUTTER = 0.07;           // the fast one riding on it
const FLUTTER_W = 7.3;
const NOD = 0.07;               // toward and away from the camera
const NOD_W = 3.1;
/** How far the arms stand out from hanging straight down, and how much they flap about that. */
const ARM_OUT = 0.95;
const ARM_FLAP = 0.6;
/** The slump: fall, hang folded, whip back up. Seconds. */
const SLUMP_FALL = 0.45;
const SLUMP_HOLD = 0.25;
const SLUMP_RISE = 0.8;
const SLUMP_GAP = [3.5, 7];

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * @param scene
 * @param rng    run stream — the phases and the slump timing
 * @param site   `burger.site` from city/burgerjoint.js, or null: a quiet no-op, as the boom box is
 * @param anchor the joint's entrance anchor `{ x, z, rand }`, so he rises with the building
 */
export function createTubeMan(scene, rng, site, anchor = null) {
  const group = new THREE.Group();
  group.name = 'tube-man';
  if (!site) return { group, entryObjects: [], update: () => {}, settle: () => {}, at: null };
  scene.add(group);

  const at = { x: site.kerbX - KERB_IN, y: APRON_Y, z: site.kerbZ - CORNER_BACK };
  const holder = new THREE.Group();
  holder.position.set(at.x, at.y, at.z);
  // Face the camera: local +Z onto (1, 0, 1), which leaves local X across the screen.
  holder.rotation.y = Math.PI / 4;
  group.add(holder);

  const material = propMaterial();
  const col = (name) => new THREE.Color(PALETTE[name]);
  const mesh = (parts) => {
    const geo = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  /** A capsule standing on its own origin, `len` between the centres of its two caps. */
  const capsule = (r, len, c) => {
    const geo = new THREE.CapsuleGeometry(r, len, 2, 10);
    geo.translate(0, len / 2, 0);
    return bakeColor(geo, c);
  };

  // --- The blower ----------------------------------------------------------
  const blowerGeo = new THREE.BoxGeometry(BLOWER.w, BLOWER.h, BLOWER.w);
  blowerGeo.translate(0, BLOWER.h / 2, 0);
  const grilleGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.03, 10);
  grilleGeo.rotateX(Math.PI / 2);
  grilleGeo.translate(0, BLOWER.h / 2, BLOWER.w / 2 + 0.015);
  holder.add(mesh([bakeColor(blowerGeo, col('tubeManBlower')), bakeColor(grilleGeo, col('tubeManGrille'))]));

  // --- The body ------------------------------------------------------------
  // `joints[k]` is the joint at the *bottom* of segment k; each segment's mesh and the next joint
  // ride inside it, so a bend anywhere carries everything above it.
  const red = col('tubeManBody');
  const joints = [];
  let parent = holder;
  for (let k = 0; k < SEGS; k++) {
    const joint = new THREE.Group();
    joint.position.y = k === 0 ? BLOWER.h : SEG;
    parent.add(joint);
    const parts = [capsule(R, SEG, red)];
    if (k === SEGS - 1) parts.push(...headParts());
    joint.add(mesh(parts));
    joints.push(joint);
    parent = joint;
  }

  // The face and the hair, in the top segment's frame: +Z is toward the camera.
  function headParts() {
    const white = col('tubeManFace');
    const dark = col('tubeManPupil');
    const yellow = col('tubeManHair');
    const parts = [];
    const surf = (x) => Math.sqrt(R * R - x * x);
    for (const s of [-1, 1]) {
      const ex = s * 0.11;
      const eye = new THREE.SphereGeometry(0.1, 8, 6);
      eye.scale(0.85, 1.2, 0.45);
      eye.translate(ex, SEG * 0.72, surf(ex) - 0.01);
      parts.push(bakeColor(eye, white));
      const pupil = new THREE.SphereGeometry(0.045, 6, 4);
      pupil.scale(1, 1.2, 0.6);
      pupil.translate(ex + s * 0.02, SEG * 0.7, surf(ex) + 0.035);
      parts.push(bakeColor(pupil, dark));
    }
    // The grin: the lower half of a ring, across the front of the tube.
    const smile = new THREE.TorusGeometry(0.14, 0.035, 4, 10, Math.PI);
    smile.rotateZ(Math.PI);
    smile.scale(1, 0.75, 1);
    smile.translate(0, SEG * 0.42, R + 0.005);
    parts.push(bakeColor(smile, white));
    // Hair: a fan of yellow streamers off the top, splayed out every which way.
    const tufts = 7;
    for (let n = 0; n < tufts; n++) {
      const a = (n / tufts) * Math.PI * 2;
      const lean = 0.35 + 0.25 * ((n * 5) % 3) / 2;
      const tuft = new THREE.ConeGeometry(0.1, 0.5, 4);
      tuft.translate(0, 0.25, 0);
      tuft.rotateX(lean);
      tuft.rotateY(a);
      tuft.translate(Math.sin(a) * R * 0.45, SEG + R * 0.75, Math.cos(a) * R * 0.45);
      parts.push(bakeColor(tuft, yellow));
    }
    return parts;
  }

  // --- The arms --------------------------------------------------------------
  // Each hangs off the shoulder joint in a chain of its own, built pointing straight down so that
  // a turn about Z of `side · angle` swings it out and up on its own side.
  const yellow = col('tubeManHair');
  const shoulderJoint = joints[SHOULDER + 1];
  const arms = [-1, 1].map((side) => {
    const root = new THREE.Group();
    root.position.set(side * (R - 0.05), -0.08, 0);
    shoulderJoint.add(root);
    const chain = [];
    let p = root;
    for (let k = 0; k < ARM_SEGS; k++) {
      const joint = new THREE.Group();
      if (k > 0) joint.position.y = -ARM_SEG;
      p.add(joint);
      const geo = new THREE.CapsuleGeometry(ARM_R, ARM_SEG, 2, 8);
      geo.translate(0, -ARM_SEG / 2, 0);
      const parts = [bakeColor(geo, red)];
      if (k === ARM_SEGS - 1) {
        const cuff = new THREE.CylinderGeometry(ARM_R * 1.35, ARM_R * 1.1, 0.2, 8);
        cuff.translate(0, -ARM_SEG - 0.1, 0);
        parts.push(bakeColor(cuff, yellow));
      }
      joint.add(mesh(parts));
      chain.push(joint);
      p = joint;
    }
    return { side, root, chain, phase: rng.range(0, Math.PI * 2), rate: rng.range(5.2, 6.6) };
  });

  // --- Time ------------------------------------------------------------------
  const phase = [rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3)];
  let clock = rng.range(0, 20);
  let slumpAt = clock + rng.range(...SLUMP_GAP);

  /** 0 upright, 1 folded over — with an overshoot past upright as he whips back. */
  function slumpLevel() {
    const u = clock - slumpAt;
    if (u < 0) return 0;
    if (u < SLUMP_FALL) return smooth(u / SLUMP_FALL);
    if (u < SLUMP_FALL + SLUMP_HOLD) return 1;
    const r = (u - SLUMP_FALL - SLUMP_HOLD) / SLUMP_RISE;
    if (r < 1) return Math.exp(-4 * r) * Math.cos(3.5 * r);
    slumpAt = clock + rng.range(...SLUMP_GAP);
    return 0;
  }

  function update(dt) {
    clock += dt;
    const e = slumpLevel();
    for (let k = 1; k < SEGS; k++) {
      // Stiff at the blower, floppier up the tube.
      const w = 0.45 + 0.55 * (k / SEGS);
      let side = w * (SWAY * Math.sin(SWAY_W * clock - 0.9 * k + phase[0])
        + FLUTTER * Math.sin(FLUTTER_W * clock - 0.6 * k + phase[1]));
      let nod = w * NOD * Math.sin(NOD_W * clock - 0.7 * k + phase[2]);
      // The fold: the two lowest joints give way and the rest curls back on itself — down the
      // strip he stands on, world −Z, which in this frame is local +X and away from the camera.
      // Sideways would be the bigger gesture on screen and has nowhere to go: the strip is about
      // two units wide, with the lane on one side and the road on the other.
      const fold = k <= 2 ? 0.72 : -0.2;
      side -= e * fold * Math.SQRT1_2;
      nod -= e * fold * Math.SQRT1_2;
      joints[k].rotation.set(nod, 0, side);
    }
    for (const arm of arms) {
      const flap = Math.sin(arm.rate * clock + arm.phase);
      const out = THREE.MathUtils.lerp(ARM_OUT + ARM_FLAP * flap, 0.2, Math.max(0, e));
      arm.root.rotation.set(0.15 * Math.sin(arm.rate * 0.7 * clock + arm.phase), 0, arm.side * out);
      // Each joint down the arm lags the one above it, which is what makes it flop.
      for (let k = 1; k < ARM_SEGS; k++) {
        arm.chain[k].rotation.z = arm.side * 0.45 * Math.sin(arm.rate * clock + arm.phase - 1.3 * k);
      }
    }
  }
  // Posed at construction, so the first frame — and a shot, which ticks once and freezes — catches
  // him mid-flail rather than standing to attention.
  function settle() { update(0); }
  settle();

  const entryObjects = anchor ? [{ object: holder, ...anchor }] : [];
  return { group, holder, joints, arms, entryObjects, update, settle, at };
}
