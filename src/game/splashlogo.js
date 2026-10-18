import * as THREE from 'three';
import { makeRng } from '../util/rng.js';

/**
 * The startup screen's logo (game/splash.js): ROCKET RIDES in chunky extruded block letters,
 * standing in the black until the taxi comes down through it, and the debris it leaves.
 *
 * **Every letter is built from the strokes it breaks into.** An R is a stem, a bowl and a leg; an E
 * is a stem and three bars. Each stroke is its own extruded slab, abutting its neighbours along a
 * shared edge, so the intact word and the wreckage are the same meshes: nothing is swapped out on
 * the frame of the hit, and a piece flying off is visibly the piece that was there. The bevel is
 * pulled in by its own size (`bevelOffset`) so the outlines still abut instead of overlapping, which
 * leaves a fine chamfered groove at every joint — the logo reads as built from blocks before it
 * comes apart, and the break lines are where they look like they should be.
 *
 * **The debris is a pure simulation** (`createDebris`), stepped by the splash and walked headless by
 * tools/probe.mjs: no piece goes through the floor, every piece is knocked loose, and the lot has
 * come to rest by the fade. A piece is a rigid slab whose floor contact is its lowest hull corner,
 * and one that has stopped bouncing is laid flat over a few frames — left to tumble to rest on its
 * own, a slab spun to a stop on a corner stood balanced on it, which reads as a bug.
 */

// --- The letterforms ---------------------------------------------------------------------------
// In units of cap height: verticals are heavier than horizontals, as in any display face — at one
// weight, an E's three bars and two gaps had 0.05 of gap left in a unit of height.
const V = 0.32;
const H = 0.22;

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** Turned a half turn inside a box `w` wide: the S's lower hook is its upper one. */
const turned = (points, w) => points.map(([x, y]) => [w - x, 1 - y]);
/** Mirrored across a box `w` wide: the O's right half is its left. */
const mirrored = (points, w) => points.map(([x, y]) => [w - x, y]).reverse();
/** Mirrored top to bottom: the C's lower half is its upper. */
const flipped = (points) => points.map(([x, y]) => [x, 1 - y]).reverse();

const O_LEFT = [[0.46, 0], [0.46, H], [0.40, H], [V, 0.32], [V, 0.68], [0.40, 1 - H], [0.46, 1 - H],
  [0.46, 1], [0.22, 1], [0, 0.78], [0, 0.22], [0.22, 0]];
const C_TOP = [[0.84, 1], [0.22, 1], [0, 0.78], [0, 0.5], [V, 0.5], [V, 0.68], [0.40, 1 - H], [0.84, 1 - H]];
const S_TOP = [[0.84, 1], [0.20, 1], [0, 0.80], [0, 0.58], [0.18, 0.39], [0.42, 0.39], [0.42, 0.61],
  [V, 0.61], [V, 1 - H], [0.84, 1 - H]];

/** Each glyph: its advance width and the strokes it is built from, as outlines in cap height. */
export const GLYPHS = {
  R: {
    w: 0.9,
    pieces: [
      rect(0, 0, V, 1),
      [[V, 1], [0.66, 1], [0.86, 0.82], [0.86, 0.62], [0.66, 0.44], [V, 0.44], [V, 0.64], [0.54, 0.64],
        [0.54, 0.8], [V, 0.8]],
      [[0.40, 0.44], [0.70, 0.44], [0.90, 0], [0.58, 0]],
    ],
  },
  O: { w: 0.92, pieces: [O_LEFT, mirrored(O_LEFT, 0.92)] },
  C: { w: 0.84, pieces: [C_TOP, flipped(C_TOP)] },
  K: {
    w: 0.94,
    pieces: [
      rect(0, 0, V, 1),
      [[V, 0.36], [0.92, 1], [0.54, 1], [V, 0.70]],
      [[0.38, 0.40], [0.56, 0], [0.94, 0], [0.60, 0.60]],
    ],
  },
  E: {
    w: 0.78,
    pieces: [rect(0, 0, V, 1), rect(V, 1 - H, 0.78, 1), rect(V, 0.39, 0.68, 0.61), rect(V, 0, 0.78, H)],
  },
  T: { w: 0.86, pieces: [rect(0, 1 - H, 0.86, 1), rect(0.27, 0, 0.59, 1 - H)] },
  I: { w: V, pieces: [rect(0, 0.5, V, 1), rect(0, 0, V, 0.5)] },
  D: {
    w: 0.9,
    pieces: [
      rect(0, 0, V, 1),
      [[V, 1], [0.62, 1], [0.90, 0.72], [0.90, 0.28], [0.62, 0], [V, 0], [V, H], [0.50, H], [0.58, 0.34],
        [0.58, 0.66], [0.50, 1 - H], [V, 1 - H]],
    ],
  },
  S: { w: 0.84, pieces: [S_TOP, turned(S_TOP, 0.84)] },
};

export const LOGO_LINES = ['ROCKET', 'RIDES'];
/** Cap height in world units, and the space between letters and between the lines, in cap heights. */
export const CAP = 1.3;
const TRACKING = 0.12;
const LEADING = 0.24;
/** Slab depth, in world units: half a cap, so it reads as a block and not as a sign. */
export const DEPTH = 0.65;
const BEVEL = 0.07;
/**
 * Where it stands: the bottom line's baseline this far off the floor, so the car has the whole word
 * to come down through before it reaches the road. Turned a little on its vertical so the left-hand
 * faces of the extrusion show; the sun is off to the right, so they come out in the fill's shade
 * against the white faces, which is the extruded-logo look.
 */
export const LOGO_BASE = 0.9;
export const LOGO_YAW = 0.2;

/**
 * Builds the pieces in world space: each one's geometry centred on its own middle, where it sits
 * when the word is whole, and the hull corners its floor contact is measured from.
 * Pure THREE, no materials — the splash colours them; the probe only needs where they are.
 */
export function buildLogo() {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), LOGO_YAW);
  const pieces = [];
  const letters = [];
  const lineW = (word) => [...word].reduce((w, ch) => w + GLYPHS[ch].w, 0) + TRACKING * (word.length - 1);
  LOGO_LINES.forEach((word, row) => {
    const baseline = (LOGO_LINES.length - 1 - row) * (1 + LEADING);
    let pen = -lineW(word) / 2;
    for (const ch of word) {
      const glyph = GLYPHS[ch];
      const letter = { index: letters.length, char: ch, centre: new THREE.Vector3(), pieces: [] };
      letter.centre.set((pen + glyph.w / 2) * CAP, (baseline + 0.5) * CAP, 0).applyQuaternion(turn);
      letter.centre.y += LOGO_BASE;
      letters.push(letter);
      for (const outline of glyph.pieces) {
        const pts = outline.map(([x, y]) => new THREE.Vector2((pen + x) * CAP, (baseline + y) * CAP));
        const middle = pts.reduce((m, p) => m.add(p), new THREE.Vector2()).divideScalar(pts.length);
        const local = pts.map((p) => p.clone().sub(middle));
        const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(local), {
          depth: DEPTH - 2 * BEVEL,
          bevelEnabled: true,
          bevelThickness: BEVEL,
          bevelSize: BEVEL,
          bevelOffset: -BEVEL,
          bevelSegments: 1,
          curveSegments: 1,
        });
        geometry.translate(0, 0, -(DEPTH - 2 * BEVEL) / 2);
        const hull = [];
        for (const p of local) for (const z of [-DEPTH / 2, DEPTH / 2]) hull.push(new THREE.Vector3(p.x, p.y, z));
        const home = new THREE.Vector3(middle.x, middle.y, 0).applyQuaternion(turn);
        home.y += LOGO_BASE;
        const piece = { letter: letter.index, geometry, hull, home, homeQuat: turn.clone() };
        letter.pieces.push(pieces.length);
        pieces.push(piece);
      }
      pen += glyph.w + TRACKING;
    }
  });
  return { pieces, letters };
}

// --- The debris ---------------------------------------------------------------------------------
const GRAVITY = 34;
/** Floor bounce: what is kept of the downward speed, and of the speed along the floor. */
const RESTITUTION = 0.3;
const SCUFF = 0.7;
/** Below this rebound a piece stops bouncing and slides; friction and the lay-flat take it from there. */
const SETTLE_SPEED = 1.4;
/** The car's reach, from its origin: half its drawn length along x, half its width and then some in z. */
const CAR_REACH_X = 2.3;
const CAR_REACH_Z = 1.3;
/** How far below its origin the car's nose reaches on the way down — it falls nose first. */
const NOSE_DROP = 0.45;

/**
 * @param logo  what `buildLogo` returned.
 * @returns `{ state, update(dt, car) }`. `state[i]` is piece i's position and orientation. `car` is
 *   the taxi's pose as splash.js has it, plus `landed` (it has touched the road) and `speed` (how
 *   fast it is driving off). `update` returns what happened this step for the effects to answer:
 *   `contact` the moment the car first meets the word, `blast` at the landing, `thuds` for each hard
 *   landing of a piece on the floor.
 */
export function createDebris(logo, seed = 0x10605) {
  const rng = makeRng(seed);
  const state = logo.pieces.map((p) => ({
    pos: p.home.clone(),
    quat: p.homeQuat.clone(),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    loose: false,
    grounded: false,
    kicked: false,
  }));
  let touched = false;
  let blasted = false;
  const corner = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const face = new THREE.Vector3();
  const flat = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);

  function lowest(i) {
    let min = Infinity;
    for (const h of logo.pieces[i].hull) {
      corner.copy(h).applyQuaternion(state[i].quat);
      if (corner.y < min) min = corner.y;
    }
    return state[i].pos.y + min;
  }
  function highest(i) {
    let max = -Infinity;
    for (const h of logo.pieces[i].hull) {
      corner.copy(h).applyQuaternion(state[i].quat);
      if (corner.y > max) max = corner.y;
    }
    return state[i].pos.y + max;
  }
  const tumble = (s, rate) => s.spin.set(rng.jitter(1), rng.jitter(1), rng.jitter(1)).normalize().multiplyScalar(rate);

  function update(dt, car) {
    const events = { contact: null, blast: false, thuds: [] };

    // Struck: the car's nose has come down to a piece's top inside its own reach. Driven down and
    // thrown out sideways, away from the middle of the car, and some of it at the camera.
    if (car && !car.landed) {
      for (let i = 0; i < state.length; i++) {
        const s = state[i];
        if (s.loose) continue;
        const dx = s.pos.x - car.x;
        if (Math.abs(dx) > CAR_REACH_X || car.y - NOSE_DROP > highest(i)) continue;
        s.loose = true;
        const side = Math.sign(dx) || (rng.chance(0.5) ? 1 : -1);
        s.vel.set(side * rng.range(3, 8) + dx * 1.5, -rng.range(4, 10), rng.range(-1, 5));
        tumble(s, rng.range(6, 14));
        if (!touched) {
          touched = true;
          events.contact = new THREE.Vector3(car.x, Math.min(highest(i), car.y), s.pos.z);
        }
      }
    }

    // The landing: the Big Air's shockwave takes everything the car itself did not reach, hardest
    // close in. The top line is still hanging in the air when it goes, so it goes up and over.
    if (car && car.landed && !blasted) {
      blasted = true;
      events.blast = true;
      for (const s of state) {
        if (s.loose) continue;
        s.loose = true;
        const dx = s.pos.x - car.x;
        const near = THREE.MathUtils.clamp(1.5 - Math.abs(dx) / 6, 0.45, 1.3);
        const side = Math.sign(dx) || 1;
        s.vel.set(side * rng.range(3, 7) * near, rng.range(4, 9) * near, rng.range(0, 4) * near);
        tumble(s, rng.range(3, 9) * near);
      }
    }

    // Driving off through the wreckage: anything low in the car's path is bowled ahead of it.
    if (car && car.speed > 0) {
      for (const s of state) {
        if (!s.loose || s.kicked || s.pos.y > 2) continue;
        if (Math.abs(s.pos.x - car.x) > CAR_REACH_X || Math.abs(s.pos.z - car.z) > CAR_REACH_Z) continue;
        s.kicked = true;
        s.grounded = false;
        s.vel.set(car.speed * rng.range(0.9, 1.3) + 2, rng.range(3, 7), rng.jitter(3) + Math.sign(s.pos.z - car.z) * 2);
        tumble(s, rng.range(8, 16));
      }
    }

    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (!s.loose) continue;
      if (!s.grounded) s.vel.y -= GRAVITY * dt;
      s.pos.addScaledVector(s.vel, dt);
      const w = s.spin.length();
      if (w > 1e-6) {
        dq.setFromAxisAngle(axis.copy(s.spin).divideScalar(w), w * dt);
        s.quat.premultiply(dq).normalize();
      }
      const under = lowest(i);
      if (under < 0) {
        s.pos.y -= under;
        if (!s.grounded && s.vel.y < 0) {
          const hit = -s.vel.y;
          if (hit > 5) events.thuds.push({ x: s.pos.x, z: s.pos.z, strength: Math.min(1, hit / 14) });
          s.vel.y = hit * RESTITUTION;
          s.vel.x *= SCUFF;
          s.vel.z *= SCUFF;
          s.spin.multiplyScalar(0.6);
          if (s.vel.y < SETTLE_SPEED) {
            s.grounded = true;
            s.vel.y = 0;
          }
        }
      }
      if (s.grounded) {
        // Sliding to a stop and lying down on whichever face is nearer the floor.
        const drag = Math.exp(-dt * 5);
        s.vel.x *= drag;
        s.vel.z *= drag;
        s.spin.multiplyScalar(Math.exp(-dt * 7));
        face.set(0, 0, 1).applyQuaternion(s.quat);
        flat.setFromUnitVectors(face, face.y >= 0 ? UP : DOWN).multiply(s.quat);
        s.quat.slerp(flat, 1 - Math.exp(-dt * 9));
        s.pos.y -= lowest(i);
      }
    }
    return events;
  }

  return {
    state,
    update,
    /** Every piece is loose and lying still on the floor. */
    settled: () => state.every((s) => s.loose && s.grounded && s.vel.length() < 0.5),
    lowest,
  };
}
