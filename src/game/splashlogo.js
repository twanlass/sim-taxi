import * as THREE from 'three';
import { makeRng } from '../util/rng.js';
import { LOGO_GLYPHS } from './logoglyphs.js';

/**
 * The startup screen's logo (game/splash.js): ROCKET RIDES in the game's own Space Grotesk Bold,
 * extruded into white slabs, standing in the black until the taxi comes down through it, and the
 * debris it leaves.
 *
 * **The letters are the font's own outlines**, baked out of the shipped woff2 by
 * tools/logo-glyphs.py into src/game/logoglyphs.js — data, not a loader, like every other mesh here.
 * The curves are flattened to a few facets each, which is what makes them read as this city's.
 *
 * **Every letter is cut into the pieces it breaks into before it is ever drawn.** Two straight cuts
 * through each glyph, at angles of its own, split it into cells (`clipPolygon`), and each connected
 * run of a cell is one slab. So the intact word and the wreckage are the same meshes: nothing is
 * swapped out on the frame of the hit, and a piece flying off is visibly the piece that was there,
 * broken along a clean line. The slabs are extruded by hand (`extrudeTriangles`) rather than by
 * `ExtrudeGeometry` because a piece is a set of triangles from the glyph's own triangulation, not a
 * shape with an outline — and its break faces are walls like any other edge, hidden behind the front
 * faces until the pieces part.
 *
 * **The debris is a pure simulation** (`createDebris`), stepped by the splash and walked headless by
 * tools/probe.mjs: no piece goes through the floor, every piece is knocked loose, and the lot has
 * come to rest by the fade. A piece is a rigid slab whose floor contact is its lowest hull corner,
 * and one that has stopped bouncing is laid flat over a few frames — left to tumble to rest on its
 * own, a slab spun to a stop on a corner stood balanced on it, which reads as a bug.
 */

// --- The letterforms ---------------------------------------------------------------------------
export const LOGO_LINES = ['ROCKET', 'RIDES'];
/** Cap height in world units, and the space between letters and between the lines, in cap heights. */
export const CAP = 1.45;
const TRACKING = 0.16;
const LEADING = 0.22;
/** Slab depth, in world units: about half a cap, so it reads as a block and not as a sign. */
export const DEPTH = 0.7;
/**
 * Where it stands: the bottom line's baseline this far off the floor, so the car has the whole word
 * to come down through before it reaches the road. Turned a little on its vertical so the left-hand
 * faces of the extrusion show, in the logo light's shade against the white faces — the extruded-logo
 * look.
 */
export const LOGO_BASE = 0.9;
export const LOGO_YAW = 0.15;

/** Smallest piece kept, in square world units. */
const MIN_PIECE = 0.004;

const area2 = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

function inside(pt, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** A glyph's outlines as triangles, every one wound counter-clockwise. */
function glyphTriangles(glyph) {
  const contours = glyph.contours.map((c) => c.map(([x, y]) => new THREE.Vector2(x, y)));
  // TrueType winds outer contours clockwise and holes the other way.
  const outers = contours.filter((c) => area2(c) < 0).map((c) => ({ outline: c.slice().reverse(), holes: [] }));
  for (const c of contours) {
    if (area2(c) < 0) continue;
    const home = outers.find((o) => inside(c[0], o.outline)) ?? outers[0];
    home.holes.push(c.slice().reverse());
  }
  const tris = [];
  for (const { outline, holes } of outers) {
    const all = [outline, ...holes].flat();
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outline, holes)) {
      const t = [all[a], all[b], all[c]];
      tris.push(area2(t) < 0 ? [t[0], t[2], t[1]] : t);
    }
  }
  return tris;
}

/** Sutherland–Hodgman against one half-plane: keeps the side where `n·p >= c`. */
function clipPolygon(poly, n, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = n.dot(p) - c;
    const dq = n.dot(q) - c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) out.push(p.clone().lerp(q, dp / (dp - dq)));
  }
  return out;
}

const key = (p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
const edgeKey = (p, q) => {
  const a = key(p);
  const b = key(q);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/** Splits a cell's triangles into the runs of it that touch, each one a piece of its own. */
function components(tris) {
  const parent = tris.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(t[k], t[(k + 1) % 3]);
      if (seen.has(e)) parent[find(i)] = find(seen.get(e));
      else seen.set(e, i);
    }
  });
  const groups = new Map();
  tris.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  return [...groups.values()];
}

/**
 * A slab from counter-clockwise triangles: their front at +depth/2, their back at -depth/2, and a
 * wall on every edge no other triangle in the set shares. For a counter-clockwise edge p to q the
 * outside is on the right, so the wall is wound (p front, p back, q back) to face it.
 */
function extrudeTriangles(tris, depth) {
  const z = depth / 2;
  const pos = [];
  const push = (...vs) => { for (const [x, y, w] of vs) pos.push(x, y, w); };
  const count = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(t[k], t[(k + 1) % 3]);
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  const rim = [];
  for (const [a, b, c] of tris) {
    push([a.x, a.y, z], [b.x, b.y, z], [c.x, c.y, z]);
    push([a.x, a.y, -z], [c.x, c.y, -z], [b.x, b.y, -z]);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (count.get(edgeKey(p, q)) !== 1) continue;
      push([p.x, p.y, z], [p.x, p.y, -z], [q.x, q.y, -z]);
      push([p.x, p.y, z], [q.x, q.y, -z], [q.x, q.y, z]);
      rim.push(p);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  return { geometry, rim };
}

/**
 * Builds the pieces in world space: each one's geometry centred on its own middle, where it sits
 * when the word is whole, and the hull corners its floor contact is measured from.
 * Pure THREE, no materials — the splash colours them; the probe only needs where they are.
 */
export function buildLogo() {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), LOGO_YAW);
  const rng = makeRng(0x1060);
  const pieces = [];
  const letters = [];
  const lineW = (word) => [...word].reduce((w, ch) => w + LOGO_GLYPHS[ch].w, 0) + TRACKING * (word.length - 1);
  LOGO_LINES.forEach((word, row) => {
    const baseline = (LOGO_LINES.length - 1 - row) * (1 + LEADING);
    let pen = -lineW(word) / 2;
    for (const ch of word) {
      const glyph = LOGO_GLYPHS[ch];
      const letter = { index: letters.length, char: ch, centre: new THREE.Vector3(), pieces: [] };
      letter.centre.set((pen + glyph.w / 2) * CAP, (baseline + 0.5) * CAP, 0).applyQuaternion(turn);
      letter.centre.y += LOGO_BASE;
      letters.push(letter);

      // Two cuts through the middle of the glyph, roughly a cross but never square to the strokes,
      // so a stem breaks on a slant. A narrow I gets the one, across it.
      const mid = new THREE.Vector2(glyph.w / 2, 0.5 + rng.jitter(0.12));
      const a1 = rng.range(0.25, 0.6) * (rng.chance(0.5) ? 1 : -1);
      const cuts = [new THREE.Vector2(Math.sin(a1), Math.cos(a1))];
      if (glyph.w > 0.4) {
        const a2 = a1 + Math.PI / 2 + rng.jitter(0.35);
        cuts.push(new THREE.Vector2(Math.sin(a2), Math.cos(a2)));
      }
      let cells = [glyphTriangles(glyph).map((t) => t)];
      for (const n of cuts) {
        const c = n.dot(mid);
        const next = [];
        for (const cell of cells) {
          for (const side of [1, -1]) {
            const ns = n.clone().multiplyScalar(side);
            const out = [];
            for (const tri of cell) {
              const poly = clipPolygon(tri, ns, c * side);
              for (let k = 1; k + 1 < poly.length; k++) {
                const t = [poly[0], poly[k], poly[k + 1]];
                if (Math.abs(area2(t)) > 1e-7) out.push(t);
              }
            }
            if (out.length) next.push(out);
          }
        }
        cells = next;
      }

      for (const cell of cells) {
        for (const tris of components(cell)) {
          // A sliver where a cut grazes a corner — a few hundredths of a unit across — is not worth
          // a piece: it would fly as a speck. Under `MIN_PIECE` it is left out.
          if (tris.reduce((a, t) => a + area2(t), 0) * CAP * CAP < MIN_PIECE) continue;
          // Into world units, about the piece's own area-weighted middle.
          let total = 0;
          const middle = new THREE.Vector2();
          for (const t of tris) {
            const a = area2(t);
            total += a;
            middle.addScaledVector(t[0].clone().add(t[1]).add(t[2]), a / 3);
          }
          middle.divideScalar(total);
          const local = tris.map((t) => t.map((p) => new THREE.Vector2(
            (p.x - middle.x) * CAP, (p.y - middle.y) * CAP)));
          const { geometry, rim } = extrudeTriangles(local, DEPTH);
          const hull = [];
          for (const p of rim) for (const zz of [-DEPTH / 2, DEPTH / 2]) hull.push(new THREE.Vector3(p.x, p.y, zz));
          const home = new THREE.Vector3((pen + middle.x) * CAP, (baseline + middle.y) * CAP, 0).applyQuaternion(turn);
          home.y += LOGO_BASE;
          letter.pieces.push(pieces.length);
          pieces.push({ letter: letter.index, geometry, hull, home, homeQuat: turn.clone(), area: total * CAP * CAP });
        }
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
