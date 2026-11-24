import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { HALF_SPAN_X, HALF_SPAN_Z } from './grid.js';
import { planLTrain, LTRAIN_DIMENSIONS } from '../game/ltrain.js';

// The construction crane: one mid-rise in the city is adding floors, and a tower crane stands up
// through its middle swinging a steel beam about. Background flavour and nothing else — Tyler,
// 2026-11-21: "a building is under construction and the crane ... has a box or a beam or something
// that it's sort of just like kind of ambiently moving around, not really doing anything".
//
// **The building is one `createBuildings` already built.** Rather than clear a lot for a fenced pit
// (which would mean `createLayout` taking a block, and every draw after it moving), the site is a
// flat roof picked afterwards by rule and hash, exactly as the vet clinic and the billboards are:
// the roof grows one bare concrete storey (columns and a slab) and the stubs of the next, and the
// crane's mast rises up through the slab. That is how a city crane really stands — an internal
// climbing crane goes up the building's own core — and it spends no draw, so the city is the same
// city with or without it. `?crane=classic` leaves the roof a roof.
//
// **Low, on purpose.** Under this camera every unit of height is 1.09 units of ground hidden
// up-screen, and a jib up in the air is drawn over whatever is that far behind it. So the jib sits
// `CLEAR` over the tallest roof it can swing across and no higher, and the site is chosen where
// that comes out modest (`MAX_LIFT`). Not tappable, and not in the sightline field: the mast and jib
// are under a unit across against a 3.5-unit kerb mark, so a girder can cover a slice of a mark but
// never the whole of one.
//
// **Cheap.** The concrete and the mast are static, stamped into the entrance wave with the
// tower's own anchor so they rise with their building. What moves is four small meshes under two
// transforms — the slewing top (yaw), the trolley along the jib, the hoist rope (a scale) and the
// hook with its beam (a position and a swing) — so a frame costs a handful of matrix updates and
// four draw calls. The moving parts cast no shadow by default (`?crane=shadow` turns the jib's on,
// for comparison) and are kept out of the AO prepass, so they are made `ao: false`: a mesh that
// receives AO it does not cast samples the crease of whatever is behind it (CLAUDE.md).

/** `?crane=classic` — no crane, the roof stays a roof. `?crane=shadow` — the moving parts cast. */
const CRANE_PARAM = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('crane') : null;
export const CRANE_CLASSIC = CRANE_PARAM === 'classic';
export const CRANE_SHADOW = CRANE_PARAM === 'shadow';

// --- Sizes ------------------------------------------------------------------------------------

/** Jib, mast to tip. 10 units is ~77px at play zoom: long enough to read as a crane's arm. */
export const REACH = 10;
const COUNTER = 3.6;          // counter-jib, mast to the back end
// **Chunky, not spindly.** The first cut was a real lattice — chords and zigzag bracing 0.07 to
// 0.12 across, one or two device pixels at play zoom — and Tyler, 2026-11-23: "busy and clunky ...
// too spindly ... doesn't really read at this small screen resolution". So every member is now a
// solid box sized to be several pixels wide, and the segmenting a lattice gives a crane is carried
// by darker bands round the mast and the jib instead of by the bracing itself.
const MAST_W = 0.85;          // the mast's square section: ~6.5px at play zoom
const JIB_W = 0.62;           // the jib's section at the root, tapering to `JIB_TIP` of that
const JIB_H = 0.62;
const JIB_TIP = 0.55;
const BAND = 1.6;             // pitch of the darker bands on the mast and the jib
const HEAD_H = 1.5;           // the tower head over the jib root, the top lamp on it
const LAMP = 0.34;            // the aircraft-warning lamps' size: 0.16 at first, a speck
const STOREY = 2.4;           // the new storey, deck to the top of its slab
const SLAB = 0.26;
const COLUMN = 0.3;
const STUB = 1.1;             // the next storey's column stubs over the slab
/** How far the jib's underside has to clear every roof it can swing over, and the hook block. */
const CLEAR = 3.4;
/** The jib's underside over the building's own roof at most. Past this the site is too tall. */
const MAX_LIFT = 10;
/** The deck the storey stands on, smallest side. Under 3.6 the slab is a table and not a floor. */
const MIN_DECK = 3.6;
/** ...and the building under it, no taller than this: a mid-rise, not a tower. */
const MAX_TOP = 8.5;
const MIN_TOP = 3.2;
/** The hook block to the beam, along the slings. */
const SLING = 1.0;
const BEAM_L = 3.0;
const BEAM_H = 0.3;
/** Hoisted: the hook this far under the jib. */
const DROP_UP = 1.4;
/** Where over its own slab the crane sets the beam down, out along the jib. */
const SET_R = 2.2;
/** Past this fraction of the half-span (either axis) a block is on the outer ring. */
const RIM = 0.78;

// --- Choosing the roof ------------------------------------------------------------------------

/** Every flat roof in `towers` that is not spoken for, one of them the crane's — or null. */
export function chooseCraneSite(towers, { taken = [], bank = null, pad = null, billboards = [] } = {}) {
  // What the jib could hit: every tower's roof (plus 2.6 for what stands on it, as in `clearOf`),
  // the bank's dome, the billboards' boards.
  const tall = towers.map((t) => ({ x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, top: t.top + (t.deck ? 2.6 : 2.4), t }));
  if (bank) tall.push({ ...bank.block, top: bank.domeY });
  for (const b of billboards) {
    tall.push({ x0: b.at.x - b.w / 2, x1: b.at.x + b.w / 2, z0: b.at.z - b.w / 2, z1: b.at.z + b.w / 2, top: b.y0 + b.h });
  }
  // And the L train, the roof of its cars: the first cut left it out and swung a beam through it.
  // Sampled every two units along the line, each sample a box the deck's width.
  const line = planLTrain();
  if (line) {
    const trainTop = LTRAIN_DIMENSIONS.RAIL_TOP + LTRAIN_DIMENSIONS.ROOF_TOP;
    const r = LTRAIN_DIMENSIONS.DECK_HALF_W;
    for (let a = line.from; a <= line.to; a += 2) {
      const p = line.world(a);
      tall.push({ x0: p.x - r, x1: p.x + r, z0: p.z - r, z1: p.z + r, top: trainTop });
    }
  }
  const candidates = [];
  for (const t of towers) {
    const deck = t.deck;
    if (!deck || taken.includes(deck)) continue;
    if (Math.min(deck.cw, deck.cd) < MIN_DECK) continue;
    if (t.top > MAX_TOP || t.top < MIN_TOP) continue;
    // Keep a helicopter's approach clear of the jib's circle.
    if (pad && Math.hypot(pad.x - deck.cx, pad.z - deck.cz) < REACH + COUNTER + 6) continue;
    const mast = { x: deck.cx, z: deck.cz };
    const slabTop = t.top + STOREY;
    // The tallest thing in the circle the jib (and the counter-jib, shorter) sweeps.
    let roof = slabTop + STUB;
    for (const o of tall) {
      if (o.t === t) continue;
      const nx = Math.max(o.x0, Math.min(mast.x, o.x1));
      const nz = Math.max(o.z0, Math.min(mast.z, o.z1));
      if (Math.hypot(nx - mast.x, nz - mast.z) < REACH + 0.6) roof = Math.max(roof, o.top);
    }
    const jibY = roof + CLEAR;
    if (jibY - t.top > MAX_LIFT) continue;
    candidates.push({ tower: t, deck, mast, slabTop, jibY, roof, plain: deck.keep.length === 0 });
  }
  if (!candidates.length) return null;
  // The lowest crane wins — it hides the least — but not out on the outer ring of blocks, where it
  // stands in the edge fog and half of what it swings over is sea: the first cut chose the rim on
  // 23 cities of 40, because the rim is where the neighbours are lowest. A bare roof breaks ties,
  // and a hash after that, so it spends no draw.
  const order = candidates.map((c, i) => {
    const rim = Math.max(Math.abs(c.mast.x) / HALF_SPAN_X, Math.abs(c.mast.z) / HALF_SPAN_Z) > RIM;
    return {
      c,
      key: (c.jibY - c.tower.top) + (rim ? 4 : 0) + (c.plain ? 0 : 0.8)
        + hash01(c.mast.x * 0.37 + i, c.mast.z * 0.61) * 1.5,
    };
  }).sort((a, b) => a.key - b.key);
  const { tower, deck, mast, slabTop, jibY, roof } = order[0].c;
  // The birds roost on decks: this one is a building site now.
  deck.keep.push({ x0: deck.cx - deck.cw / 2, x1: deck.cx + deck.cw / 2, z0: deck.cz - deck.cd / 2, z1: deck.cz + deck.cd / 2 });
  return {
    deck: { cx: deck.cx, cz: deck.cz, cw: deck.cw, cd: deck.cd, y: deck.deck },
    top: tower.top, mast, slabTop, jibY, roof,
    anchor: { x: tower.cx, z: tower.cz, rand: hash01(tower.cx, tower.cz) },
    // Where to point a camera: the middle of the jib's height over the mast.
    focus: { x: mast.x, y: (tower.top + jibY) / 2, z: mast.z },
  };
}

// --- Geometry helpers -------------------------------------------------------------------------

function box(w, h, d, x, y, z, col) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, col);
}


/**
 * A solid yellow box from `y0` to `y1` about (x, z), `w` square, banded every `BAND` with a darker
 * collar standing 0.03 proud all round — proud rather than flush, so no band face shares a plane
 * with the mast's own.
 */
function mastParts(x, z, y0, y1, w, col, bandCol) {
  const parts = [box(w, y1 - y0, w, x, (y0 + y1) / 2, z, col)];
  for (let y = y0 + BAND; y < y1 - 0.4; y += BAND) parts.push(box(w + 0.06, 0.12, w + 0.06, x, y, z, bandCol));
  return parts;
}

/**
 * The jib: a box from x = 0 to `len`, `w` wide and `h` tall at the root, narrowed to `tip` of that
 * at the far end — the taper is what makes a girder read as an arm rather than as a plank.
 */
function jibParts(len, w, h, tip, col, bandCol) {
  const g = new THREE.BoxGeometry(len, h, w);
  g.translate(len / 2, h / 2, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 1 - (1 - tip) * (pos.getX(i) / len);
    pos.setY(i, pos.getY(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  const parts = [bakeColor(g, col)];
  for (let x = BAND; x < len - 0.4; x += BAND) {
    const k = 1 - (1 - tip) * (x / len);
    parts.push(box(0.12, h * k + 0.06, w * k + 0.06, x, (h * k) / 2, 0, bandCol));
  }
  return parts;
}

// --- Building it ------------------------------------------------------------------------------

/**
 * The crane and its storey. `rng` is the run's: where the beam swings to is the situation's, where
 * the crane stands is the city's.
 */
export function createCrane(site, rng) {
  const { deck, top, mast, slabTop, jibY, anchor } = site;
  const stamp = (geo) => stampEntry(geo, anchor.x, anchor.z, anchor.rand);
  const yellow = color('craneYellow');
  const concrete = color('siteConcrete');

  // --- The static part: the new storey and the mast, in world space ---------------------------
  const parts = [];
  // Columns round the deck's edge, inside the parapet, at no more than 2.4 apart.
  const ix = deck.cw / 2 - 0.45;
  const iz = deck.cd / 2 - 0.45;
  const nx = Math.max(1, Math.ceil((2 * ix) / 2.4));
  const nz = Math.max(1, Math.ceil((2 * iz) / 2.4));
  const posts = [];
  for (let i = 0; i <= nx; i++) for (const s of [-1, 1]) posts.push([-ix + (2 * ix * i) / nx, s * iz]);
  for (let k = 1; k < nz; k++) for (const s of [-1, 1]) posts.push([s * ix, -iz + (2 * iz * k) / nz]);
  const floorY = deck.y;
  for (const [px, pz] of posts) {
    parts.push(box(COLUMN, slabTop - SLAB - floorY + 0.02, COLUMN, deck.cx + px, (floorY + slabTop - SLAB) / 2, deck.cz + pz, concrete));
  }
  // The slab, the building's own footprint less a hair (its edge would otherwise sit flush over the
  // walls below — no shared plane, since the slab starts 2.1 above the wall's top, but there is no
  // reason to make the scan think about it).
  parts.push(box(deck.cw - 0.1, SLAB, deck.cd - 0.1, deck.cx, slabTop - SLAB / 2, deck.cz, concrete));
  // The next storey begun: stubs on alternate columns, rebar out of their tops, and the timber
  // formwork for one more standing beside them.
  const rebar = color('siteRebar');
  posts.forEach(([px, pz], i) => {
    if (i % 2) return;
    parts.push(box(COLUMN, STUB, COLUMN, deck.cx + px, slabTop + STUB / 2, deck.cz + pz, concrete));
    for (const [rx, rz] of [[-0.08, -0.08], [0.08, 0.08]]) {
      parts.push(box(0.04, 0.5, 0.04, deck.cx + px + rx, slabTop + STUB + 0.25, deck.cz + pz + rz, rebar));
    }
  });
  const [fx, fz] = posts[1];
  parts.push(box(COLUMN + 0.12, STUB + 0.1, COLUMN + 0.12, deck.cx + fx, slabTop + (STUB + 0.1) / 2, deck.cz + fz, color('siteFormwork')));
  // A stack of beams waiting on the slab, and a pallet, on the side away from the mast.
  const sx = deck.cx;
  for (let k = 0; k < 3; k++) {
    parts.push(box(2.0, 0.14, 0.18, sx - deck.cw * 0.18, slabTop + 0.07 + k * 0.14, deck.cz + deck.cd * 0.22 + (k % 2) * 0.05, color('craneLoad')));
  }
  parts.push(box(0.8, 0.5, 0.8, deck.cx + deck.cw * 0.28, slabTop + 0.25, deck.cz - deck.cd * 0.28, color('siteFormwork')));
  // The mast, from the deck up through the slab to the slewing ring.
  parts.push(...mastParts(mast.x, mast.z, floorY, jibY - 0.3, MAST_W, yellow, color('craneBand')));
  parts.forEach(stamp);
  const storey = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  storey.castShadow = true;
  storey.receiveShadow = true;
  storey.name = 'crane-site';

  // --- The slewing top, in its own frame: origin on the mast at jibY, +X along the jib ---------
  const band = color('craneBand');
  const top_ = [];
  top_.push(box(1.2, 0.3, 1.2, 0, -0.15, 0, color('craneDark')));          // the slewing ring
  top_.push(...jibParts(REACH, JIB_W, JIB_H, JIB_TIP, yellow, band));
  // The counter-jib, a deck as deep as the jib, and the counterweight hung off its end.
  top_.push(box(COUNTER, 0.32, 0.8, -COUNTER / 2, 0.16, 0, yellow));
  top_.push(box(1.1, 1.2, 1.1, -COUNTER + 0.6, -0.3, 0, color('craneWeight')));
  // The tower head over the root: a short block, not the lattice mast it used to be, with the
  // top lamp on it. No pendant ties off it any more — black lines a pixel wide read as cracks.
  top_.push(box(0.6, HEAD_H, 0.6, 0, JIB_H + HEAD_H / 2 - 0.1, 0, yellow));
  // The operator's cab, up at the top where a real one is: a chunky box on the slewing platform
  // beside the jib's root, glazed on the front and the side the camera sees.
  const cab = { x: 0.35, y: 0.55, z: 0.95, w: 1.1, h: 1.0, d: 0.9 };
  top_.push(box(cab.w, cab.h, cab.d, cab.x, cab.y, cab.z, yellow));
  top_.push(box(0.04, cab.h * 0.55, cab.d * 0.75, cab.x + cab.w / 2 + 0.02, cab.y + 0.1, cab.z, color('craneGlass')));
  top_.push(box(cab.w * 0.75, cab.h * 0.55, 0.04, cab.x + 0.05, cab.y + 0.1, cab.z + cab.d / 2 + 0.02, color('craneGlass')));
  top_.push(box(cab.w + 0.12, 0.08, cab.d + 0.12, cab.x, cab.y + cab.h / 2 + 0.04, cab.z, color('craneDark')));
  const slewMesh = new THREE.Mesh(mergeGeometries(top_, false), propMaterial({ ao: false }));
  top_.forEach((p) => p.dispose());
  slewMesh.name = 'crane-jib';

  // The aircraft-warning lamps, on the head and the jib's tip: unlit red, and bloomed at night.
  const lampGeo = [box(LAMP, LAMP, LAMP, 0, JIB_H + HEAD_H - 0.1 + LAMP / 2, 0, color('craneLamp')),
    box(LAMP, LAMP, LAMP, REACH - LAMP / 2, JIB_H * JIB_TIP + LAMP / 2, 0, color('craneLamp'))];
  const lamps = new THREE.Mesh(mergeGeometries(lampGeo, false), unlitMaterial({ vertexColors: true }));
  lampGeo.forEach((g) => g.dispose());
  lamps.name = 'crane-lamps';

  // The trolley rides under the jib; the rope and the hook hang off a pendulum under it. One rope,
  // a steel grey rather than black: two black hairlines read as scratches on the screen, and with
  // no rope at all the beam floats.
  const trolley = new THREE.Mesh(box(0.7, 0.26, 0.7, 0, -0.1, 0, color('craneDark')), propMaterial({ ao: false }));
  trolley.name = 'crane-trolley';
  const rope = new THREE.Mesh(box(0.1, 1, 0.1, 0, -0.5, 0, color('craneRope')), propMaterial({ ao: false }));
  rope.name = 'crane-rope';
  const loadParts = [];
  loadParts.push(box(0.42, 0.5, 0.36, 0, -0.25, 0, yellow));               // the hook block
  // The beam, an I-section along the jib's cross direction, hung straight under the block — the
  // slings went with the other hairlines.
  const by = -0.6 - SLING;
  for (const [h, w, y] of [[0.08, 0.4, by + BEAM_H / 2 - 0.04], [0.08, 0.4, by - BEAM_H / 2 + 0.04], [BEAM_H, 0.12, by]]) {
    loadParts.push(box(w, h, BEAM_L, 0, y, 0, color('craneLoad')));
  }
  loadParts.push(box(0.1, SLING - 0.1, 0.1, 0, -0.5 - SLING / 2, 0, color('craneRope')));
  const load = new THREE.Mesh(mergeGeometries(loadParts, false), propMaterial({ ao: false }));
  loadParts.forEach((p) => p.dispose());
  load.name = 'crane-load';

  for (const m of [slewMesh, trolley, rope, load]) {
    m.castShadow = CRANE_SHADOW;
    m.receiveShadow = true;
  }

  const pendulum = new THREE.Group();
  pendulum.add(rope, load);
  const trolleyGroup = new THREE.Group();
  trolleyGroup.add(trolley, pendulum);
  const slew = new THREE.Group();
  slew.name = 'crane-slew';
  slew.position.set(mast.x, jibY, mast.z);
  slew.add(slewMesh, lamps, trolleyGroup);

  const group = new THREE.Group();
  group.name = 'crane';
  group.add(storey, slew);

  // --- The motion ------------------------------------------------------------------------------
  //
  // A loop of moves, each easing every channel (slew yaw, trolley radius, hook drop) from where the
  // last left it: set the beam down on the slab, wait, hoist it, swing it out somewhere new, hover,
  // swing back. Nothing is being built — it is a crane doing crane things in the corner of your eye.
  // The beam then swings on its rope as a damped pendulum driven by the trolley's acceleration, which
  // is the whole difference between a crane and a clock hand.
  // Set down level with the tops of the column stubs, as if lining it up on them.
  const setDrop = jibY - (slabTop + STUB + 0.1 + 0.6 + SLING + BEAM_H);
  const setR = Math.max(1.1, Math.min(SET_R, Math.min(deck.cw, deck.cd) / 2 - 0.5));
  // Out over the neighbours the beam's underside stays a unit over the tallest roof in reach.
  const awayDrop = Math.max(DROP_UP, jibY - (site.roof + 1.0) - (0.6 + SLING + BEAM_H));
  const home = rng.range(0, Math.PI * 2);
  const state = { yaw: home, r: setR, drop: setDrop };
  let moves = [];
  let move = null;
  let from = null;
  let t = 0;
  const plan = () => {
    const out = home + (rng.chance(0.5) ? 1 : -1) * rng.range(1.1, 2.6);
    const r = rng.range(4.5, REACH - 1.2);
    moves = [
      { dur: rng.range(2.5, 5), to: {} },                                       // the beam on the slab
      { dur: 3.5, to: { drop: DROP_UP } },                                      // hoist
      { dur: rng.range(8, 12), to: { yaw: out, r, drop: awayDrop } },           // swing out
      { dur: rng.range(2, 4), to: { r: r - rng.range(0.5, 1.5) } },             // creep, as if lining up
      { dur: rng.range(8, 12), to: { yaw: home + rng.range(-0.25, 0.25), r: setR, drop: DROP_UP } },
      { dur: 3.5, to: { drop: setDrop } },                                      // set it down
    ];
  };
  const ease = (k) => k * k * k * (k * (k * 6 - 15) + 10);

  // The pendulum: angle about the jib's cross axis (swinging along the jib) and about the jib's
  // own axis (swinging across it), in radians.
  const sway = { a: 0, va: 0, b: 0, vb: 0 };
  const prev = { yaw: state.yaw, r: state.r, vyaw: 0, vr: 0 };
  let spin = rng.range(0, Math.PI * 2);

  const apply = () => {
    slew.rotation.y = -state.yaw;
    trolleyGroup.position.set(state.r, 0, 0);
    pendulum.rotation.set(sway.b, 0, sway.a);
    rope.scale.y = state.drop;
    load.position.y = -state.drop;
    load.rotation.y = spin;
  };

  const update = (dt) => {
    dt = Math.min(dt, 0.1);
    if (dt <= 0) return;
    if (!move) {
      if (!moves.length) plan();
      move = moves.shift();
      from = { ...state };
      t = 0;
    }
    t += dt;
    const k = ease(Math.min(1, t / move.dur));
    for (const key of ['yaw', 'r', 'drop']) {
      if (move.to[key] !== undefined) state[key] = from[key] + (move.to[key] - from[key]) * k;
    }
    if (t >= move.dur) move = null;

    // Accelerations of the hook point in the slewing frame, from the last two frames.
    const vyaw = (state.yaw - prev.yaw) / dt;
    const vr = (state.r - prev.r) / dt;
    const ayaw = (vyaw - prev.vyaw) / dt;
    const ar = (vr - prev.vr) / dt;
    const radial = ar - state.r * vyaw * vyaw;
    const tangential = state.r * ayaw + 2 * vr * vyaw;
    Object.assign(prev, { yaw: state.yaw, r: state.r, vyaw, vr });
    const len = state.drop + SLING;
    const g = 9.8;
    const damp = 0.35;
    const step = (ang, vel, accel) => {
      const acc = -(g / len) * ang - damp * vel - accel / len;
      const nv = vel + acc * dt;
      return [THREE.MathUtils.clamp(ang + nv * dt, -0.35, 0.35), nv];
    };
    // A positive radial acceleration leaves the load behind: it swings back toward the mast.
    [sway.a, sway.va] = step(sway.a, sway.va, radial);
    [sway.b, sway.vb] = step(sway.b, sway.vb, -tangential);
    // The beam turns slowly on its hook, as a load on one rope does.
    spin += Math.sin(t * 0.4) * 0.08 * dt;
    apply();
  };
  apply();

  return {
    site, group, slew,
    /** Stamped for the entrance wave's shader: the static storey and mast. */
    meshes: [storey],
    /** Moving, so grown on the CPU (see `objects` in game/cityentry.js). */
    entryObject: { object: slew, x: anchor.x, z: anchor.z, rand: anchor.rand },
    lamps,
    update,
  };
}
