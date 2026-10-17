import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// The inflatable tube man on the car wash's corner (city/carwash.js): a red tube on a blower,
// yellow hair, a cartoon face and two floppy arms, flailing (Tyler, 2026-10-17, off a photo of the
// real thing). Scenery on the boom box's terms — no collisions, nothing the fare loop knows about,
// and a run seed for its rhythm. Where he stands is the car wash's to say (`site.tubeMan`), and
// `chooseCarWashBlock` only takes a block where the camera can see that corner.
//
// He stood on the burger joint's apron first; Tyler wanted him on a business of his own.
//
// **How he moves.** A chain of capsules, each jointed to the one under it, each joint a spring
// chasing an air pressure that comes and goes (see "The motion" below). Full, he stands with his
// arms thrown up over his head and gusts knocking him about; every few seconds the air cuts out,
// he folds over at the hips with his top half hanging head-down and his arms dropped, and then he
// refills with a whip back up. The sway is across the screen, since a bend toward or away from a
// camera that never rotates barely shows, and the fold goes to the screen's left or right, always
// back over the lot rather than out over the two roads round his corner.

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


// The motion: a pressure that comes and goes, and springs that chase it.
//
// The first cut bent the tube along sine waves and read as rubber: a rubber tube sways, an air
// tube *gets blown about*. What sells the air is (1) the collapse — the blower stutters, the tube
// folds hard at the hips and the top half hangs head-down — (2) the refill, a whip back up that
// overshoots, and (3) arms that shoot up over his head when the air is in. So each joint is a
// lightly damped spring chasing a target set by the pressure, stiff at the blower and floppy at
// the head, and random gusts kick their velocities so no two seconds look alike (Tyler, 2026-10-17:
// "feels like rubber... needs to feel like he's filled with air and be much more dramatic").
/** The hinge he folds at — the bottom of this segment, 2 units up, about halfway: his hips. */
const HIP = 3;
/** Folded angles: the hip, the joint above it, and each joint further up as the top half droops. */
const FOLD_HIP = 1.8;
const FOLD_NEXT = 0.4;
const FOLD_DROOP = 0.08;
/** Spring stiffness at the blower and at the head (1/s²), and the damping ratio: low, so it rings. */
const K_BASE = 150;
const K_TIP = 55;
const ZETA = 0.22;
/**
 * The fold's own damping, heavier: at the lateral's 0.22 the refill overshot by half the fold and
 * whipped him 2.6 units out over the road at car height. At this he overshoots by about a fifth,
 * which still reads as a snap back up.
 */
const ZETA_FOLD = 0.5;
/** Gusts: how often, and how hard they kick a joint (rad/s). */
const GUST_GAP = [0.12, 0.35];
const GUST_KICK = 2.6;
/** Upright, the lateral wave that keeps him busy between gusts. */
const SWAY = 0.12;
const SWAY_W = 5.5;
/** Arms: hanging when empty, overhead when full (radians out from straight down), and the flap. */
const ARM_DOWN = 0.25;
const ARM_UP = 2.85;
const ARM_FLAP = 0.35;
/** The arm's own spring, stiff enough that they are back overhead within half a second of a refill. */
const ARM_K = 110;
const ARM_ZETA = 0.3;
/** How far each joint down the arm lags and flops, radians. */
const ELBOW_FLOP = 0.35;
/** The pressure cycle, seconds: full for a while, collapse, hang, refill. */
const FULL = [1.6, 4.2];
const COLLAPSE = 0.3;
const HANG = [0.25, 0.7];
const REFILL = 0.22;
/** How thin the tube goes when the air is out, as a share of its full width. */
const SLACK = 0.8;

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * @param scene
 * @param rng    run stream — the phases and the slump timing
 * @param spot   `{ x, y, z }` to stand on (`site.tubeMan` from city/carwash.js), or null: a quiet
 *               no-op, as the boom box is
 * @param anchor the car wash's entrance anchor `{ x, z, rand }`, so he rises with the lot
 */
export function createTubeMan(scene, rng, spot, anchor = null) {
  const group = new THREE.Group();
  group.name = 'tube-man';
  if (!spot) return { group, entryObjects: [], update: () => {}, settle: () => {}, at: null };
  scene.add(group);

  const at = { x: spot.x, y: spot.y, z: spot.z };
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
  // Fold directions, in the holder's frame (+Z toward the camera, +X across the screen): world −Z
  // and world −X, both back over the lot and away from the two roads round his corner, and one
  // falls to the screen's right and the other to its left.
  const FOLD_DIRS = [[Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];
  const bodyMeshes = joints.map((j) => j.children.find((c) => c.isMesh));
  // Per joint: the fold (`f`) and the lateral bend (`l`), each an angle and a rate.
  const springs = joints.map((_, k) => {
    const t = k / (SEGS - 1);
    const kk = K_BASE + (K_TIP - K_BASE) * t;
    return { k: kk, c: 2 * ZETA * Math.sqrt(kk), cf: 2 * ZETA_FOLD * Math.sqrt(kk), f: 0, fv: 0, l: 0, lv: 0 };
  });
  const armSprings = arms.map(() => ({ a: ARM_DOWN, v: 0, e: [0, 0, 0], ev: [0, 0, 0] }));
  const phase = [rng.range(0, 6.3), rng.range(0, 6.3)];
  let clock = 0;
  let pressure = 1;
  let stage = 'full';
  let stageEnd = rng.range(...FULL);
  let fold = FOLD_DIRS[0];
  let gustAt = rng.range(...GUST_GAP);

  /** Advance the pressure cycle; returns the pressure, 0 empty to 1 full. */
  function breathe() {
    if (clock >= stageEnd) {
      if (stage === 'full') {
        stage = 'collapse';
        stageEnd = clock + COLLAPSE;
        fold = FOLD_DIRS[rng.int(0, FOLD_DIRS.length - 1)];
      }
      else if (stage === 'collapse') { stage = 'hang'; stageEnd = clock + rng.range(...HANG); }
      else if (stage === 'hang') { stage = 'refill'; stageEnd = clock + REFILL; }
      else { stage = 'full'; stageEnd = clock + rng.range(...FULL); }
    }
    const left = stageEnd - clock;
    if (stage === 'collapse') return smooth(left / COLLAPSE);
    if (stage === 'hang') return 0;
    if (stage === 'refill') return 1 - left / REFILL;
    return 1;
  }

  function step(dt) {
    clock += dt;
    pressure = breathe();
    const empty = 1 - pressure;
    if (clock >= gustAt) {
      gustAt = clock + rng.range(...GUST_GAP);
      // A gust kicks one joint sideways, harder the higher it is and the fuller the tube.
      const k = rng.int(1, SEGS - 1);
      springs[k].lv += rng.range(-1, 1) * GUST_KICK * (0.4 + 0.6 * k / SEGS) * (0.3 + 0.7 * pressure);
      const arm = armSprings[rng.int(0, 1)];
      arm.v += rng.range(-1, 1) * GUST_KICK * 1.5;
    }
    for (let k = 1; k < SEGS; k++) {
      const s = springs[k];
      const foldTo = empty * (k === HIP ? FOLD_HIP : k === HIP + 1 ? FOLD_NEXT : k > HIP ? FOLD_DROOP : 0);
      const w = 0.4 + 0.6 * (k / SEGS);
      const swayTo = pressure * w * SWAY * Math.sin(SWAY_W * clock - 0.9 * k + phase[0]);
      s.fv += (s.k * (foldTo - s.f) - s.cf * s.fv) * dt;
      s.lv += (s.k * (swayTo - s.l) - s.c * s.lv) * dt;
      s.f += s.fv * dt;
      s.l += s.lv * dt;
    }
    arms.forEach((arm, n) => {
      const a = armSprings[n];
      const flap = Math.sin(arm.rate * clock + arm.phase);
      const to = ARM_DOWN + pressure * (ARM_UP - ARM_DOWN) + pressure * ARM_FLAP * flap;
      a.v += (ARM_K * (to - a.a) - 2 * ARM_ZETA * Math.sqrt(ARM_K) * a.v) * dt;
      a.a += a.v * dt;
      // Each joint down the arm lags the one above it, which is what makes it flop.
      for (let k = 1; k < ARM_SEGS; k++) {
        const eTo = ELBOW_FLOP * Math.sin(arm.rate * clock + arm.phase - 1.3 * k) * (0.4 + 0.6 * pressure);
        a.ev[k] += (45 * (eTo - a.e[k]) - 2 * 0.25 * Math.sqrt(45) * a.ev[k]) * dt;
        a.e[k] += a.ev[k] * dt;
      }
    });
  }

  const foldAxis = new THREE.Vector3();
  const qFold = new THREE.Quaternion();
  const qLat = new THREE.Quaternion();
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  function pose() {
    const [dx, dz] = fold;
    // The fold turns about the horizontal axis square to its direction, Y × (dx, 0, dz). It has to
    // be one axis-angle turn: written as Euler X and Z turns, a fold toward a diagonal leans over
    // toward one of the two axes instead once it passes a radian or so, and a fold aimed back over
    // the lot laid his head 2 units out toward the road.
    foldAxis.set(dz, 0, -dx);
    for (let k = 1; k < SEGS; k++) {
      const s = springs[k];
      qFold.setFromAxisAngle(foldAxis, s.f);
      qLat.setFromAxisAngle(Z_AXIS, s.l);
      joints[k].quaternion.multiplyQuaternions(qFold, qLat);
    }
    const girth = SLACK + (1 - SLACK) * pressure;
    for (const m of bodyMeshes) m.scale.set(girth, 1, girth);
    arms.forEach((arm, n) => {
      const a = armSprings[n];
      arm.root.rotation.set(0.2 * Math.sin(arm.rate * 0.7 * clock + arm.phase), 0, arm.side * a.a);
      for (let k = 1; k < ARM_SEGS; k++) arm.chain[k].rotation.z = arm.side * a.e[k];
    });
  }

  function update(dt) {
    // Substepped: the stiffest spring rings at ~2 Hz and a slow frame is 1/20 s.
    const n = Math.max(1, Math.ceil(dt * 120));
    for (let i = 0; i < n; i++) step(dt / n);
    pose();
  }
  // Run in for a few seconds at construction, so the first frame — and a shot, which ticks once and
  // freezes — catches him mid-flail with the springs moving, not standing to attention.
  function settle() { update(0); }
  update(rng.range(2, 6));

  const entryObjects = anchor ? [{ object: holder, ...anchor }] : [];
  return { group, holder, joints, arms, entryObjects, update, settle, at };
}
