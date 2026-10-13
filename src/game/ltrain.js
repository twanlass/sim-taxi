import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import {
  GRID_I, GRID_J, lineZ, isArterialX, laneOffX, medianRuns, MEDIAN_W,
} from '../city/grid.js';
import { EDGE_FADE, KERB_H } from '../city/ground.js';
import { coastWest, coastEast } from '../city/grid.js';
import { WATER_Y } from '../city/river.js';
import { harborLandAt } from '../city/harborplan.js';
import { ISLAND, pad, padDistance, landHeight, SEA_Y } from '../city/coast.js';
import { railPath, railAt, RAIL_DECK_TOP } from '../city/railpath.js';
import { VIEW_DIR } from './camera.js';
import { sinkShadowCaster } from './scene.js';
import { markOccluder } from './ssao.js';

// The elevated train (on by default, `?ltrain=classic`): a Chicago-style L on a steel structure down the east-west
// arterial, with one train shuttling along it.
//
// **One track, on columns in the arterial's planted median.** The columns need somewhere to stand
// that no car drives on, and the median is the only such strip that runs the width of the city.
// A double-track deck spanning both carriageways was tried and read well, but covered three times
// the road; a single track over the median keeps the city underneath in view.
//
// **High enough to read as high.** The first cut kept the deck low (3.3) and over the median alone,
// on the camera's arithmetic: the view climbs 0.92 per unit in both x and z, so anything `h` tall
// hides about `1.09h` of ground behind it on each axis. That was the right number and the wrong
// answer — at play zoom a low deck beside the lanes projected onto the road as one more strip of
// paving, and it read as a railway cut through the city at street level (Tyler, 2026-10-11). What
// says *raised* from this camera is a tall column with daylight and traffic either side of it and
// a shadow landing well off the deck, so the deck is at 6.4 and the cost — more ground hidden behind it — is
// paid by the fade below rather than by keeping it low.
//
// **Faded where it covers something that matters.** The taxi already has its ghost outline for
// when a building hides it, but a fare marker does not, and a deck across a rider's kerb is a fare
// the player cannot see. So the structure and the train dither out over whatever it is hiding — see
// `FADE_*` below.
//
// The train is one merged mesh on a straight line, so it moves by translation alone: no curve to
// follow, no per-car transform. It runs off one end of the island, waits, and comes back the
// other way — a shuttle reads as one train on a line that goes somewhere, which a loop on a
// straight line could not.

// --- The structure ------------------------------------------------------------------------------

/** Top of the deck, where the ties sit. See the camera note above for why it is this high. */
export const DECK_TOP = RAIL_DECK_TOP;
/** Plate girder depth, so the underside is `DECK_TOP - GIRDER_D`. */
const GIRDER_D = 0.6;
export const DECK_UNDERSIDE = DECK_TOP - GIRDER_D;

/**
 * The track's offset off the median's centreline: **zero, one track.** Two tracks put the deck out
 * over both carriageways (Tyler, 2026-10-11: "a single to keep it simple / obscure less"), and a
 * single line down the middle is a third of the width. The one train shuttles both ways on it.
 */
export const TRACK_OFF = 0;
const TRACKS = [TRACK_OFF];

/**
 * Half the deck's width, girder face to girder face: the train's half-width and a walkway's worth.
 * Over the median and its shoulders, and short of every lane's inner flank (2.33 for a truck) — but
 * the probe still holds the cap above the tallest vehicle and the street lamps, so the deck can be
 * widened again without anything under it having to be re-measured.
 */
export const DECK_HALF_W = 1.35;

const GIRDER_W = 0.22;
const STRINGER_D = 0.32;
const STRINGER_W = 0.16;
const FLOOR_PITCH = 3.0;
const FLOOR_W = 0.18;
const FLOOR_D = 0.2;
const STIFFENER_PITCH = 2.2;

const TIE_PITCH = 0.75;
const TIE_LEN = 1.6;
const TIE_W = 0.22;
const TIE_H = 0.1;
const GAUGE = 0.9;
const RAIL_H = 0.1;
const RAIL_W = 0.09;
/** Railhead height — the train's floor stands here. */
export const RAIL_TOP = DECK_TOP + TIE_H + RAIL_H;

const COLUMN_W = 0.7;
/** How far in from the island's nose a column stands. It has to clear the junction's turn arcs,
 *  which the island already does, so this is only enough to keep the footing on the kerb. */
const COLUMN_NOSE = 0.55;
const FOOTING_W = 1.05;
const FOOTING_H = 0.22;
const CAP_W = 0.7;
const BRACE_DROP = 1.4;
const BRACE_REACH = 1.0;
const CAP_H = 0.45;
/** Underside of the hammerhead cap — the lowest thing over a lane. */
export const CAP_UNDERSIDE = DECK_TOP - GIRDER_D - CAP_H;

/**
 * Past the coast, the line keeps going and fades with the ground — a viaduct that stopped dead at
 * the ring road would be a model on a table. Columns stand out there at this pitch.
 */
const OFFSHORE_PITCH = 11;

/**
 * How far off each end of the map the line runs, so a train can vanish into the haze whole. Per
 * side, because with the harbor (`?harbor=classic` to drop it) the east coast is out past the piers
 * and the line runs on over them and the sea.
 */
const LINE_END = (side) => Math.abs(side < 0 ? coastWest() : coastEast()) + EDGE_FADE + TRAIN_LEN / 2 + 2;

// --- The train ----------------------------------------------------------------------------------

const CARS = 4;
const CAR_LEN = 5.2;
const CAR_GAP = 0.35;
const CAR_W = 1.75;
const BODY_H = 1.3;
export const TRAIN_LEN = CARS * CAR_LEN + (CARS - 1) * CAR_GAP;
/** Top of the roof, above the railhead. */
const ROOF_TOP = 0.3 + BODY_H + 0.15;

/**
 * Cruise speed in world units per second. Cars cruise at 8.5 and the boost tops out around 15, so
 * the train is the fastest thing that is not the taxi — it overtakes the traffic underneath it,
 * which is what sells it as a train rather than a slow float. A crossing is about 14 seconds.
 */
const SPEED = 12;
/** Seconds to come up to speed off the end of the line, and to slow into it. */
const RAMP = 2.5;
/** Seconds the line stands empty between runs. Run seed: the timetable is the situation. */
const WAIT = [5, 14];

// --- Wheel sparks -------------------------------------------------------------------------------
//
// Every few seconds a truck under one of the cars throws a short shower off the rail — the thing
// an L does that nothing else in the city does, and the cue that it is steel on steel up there.
// Through the shared spark pool (game/sparks.js), with the floor taken off: a spark that leaves
// the railhead falls through the open deck instead of skating along the top of it, and the pool's
// life runs out on the way down, so it reads as sparks dripping off the structure.
//
// Only at speed and only over the island: a train easing off the end of the line, or out in the
// haze, sparking at nobody, is a cost with no one to see it.
const SPARK_GAP = [1.2, 4];   // seconds between showers
const SPARK_MIN_SPEED = 6;
const SPARK_PULSES = 3;         // bursts per shower...
const SPARK_PULSE_GAP = 0.09;   // ...this far apart, so a shower has a beat of duration
const SPARK_COUNT = [6, 10];
/** Bogie centres along one car, from its middle. */
const BOGIE_AT = CAR_LEN / 2 - 0.9;
// Each car's middle, along the line from the train's.
const CAR_OFFSETS = Array.from({ length: CARS }, (_, n) => -TRAIN_LEN / 2 + CAR_LEN / 2 + n * (CAR_LEN + CAR_GAP));

// --- The fade -----------------------------------------------------------------------------------
//
// Done as a **dither**, not as alpha blending. The structure is opaque and stays opaque: it writes
// depth, it stays in the AO prepass, and it needs no sorting against the traffic it stands over.
// A fragment either draws or is discarded against a 4x4 ordered threshold, which at phone pixel
// densities reads as a see-through deck rather than as a pattern.
//
// Two things fade it. The coast, on the smoothstep the ground and the boats use (its band is
// `COAST_*` below), so the line dissolves off the island with the asphalt under it. And up to `FADE_SLOTS` points on the ground the player needs to see — the taxi and the fare
// pins — each projected *up the sightline* to the deck: the part of the deck hiding a point is not
// above it, it is `FADE_LIFT * (1, 1)` further toward the camera.
const FADE_SLOTS = 8;
const FADE_IN = 2.6;     // fully faded inside this radius of a projected point...
const FADE_OUT = 5.0;    // ...and solid again past this one
const FADE_FLOOR = 0.22; // never quite gone — a hole in the deck reads as a broken model
/** The height the hidden things are measured at: a car's roofline, a rider's chest. */
const SUBJECT_Y = 1.1;
// The view climbs VIEW_DIR.y per unit of VIEW_DIR.x, and x and z climb together.
const FADE_LIFT = (DECK_TOP - GIRDER_D / 2 - SUBJECT_Y) * (VIEW_DIR.x / VIEW_DIR.y);

// **Earlier than the ground's own band.** The asphalt fades alpha into the sky colour, which the
// eye reads as gone well before the alpha reaches zero; a deck on the ground's exact ramp was still
// plainly there over open sky, a dotted girder hanging off the island. So the line starts going at
// the island's edge less a few units and is gone by about where the ground stops reading.
const COAST_FROM = (side) => (ISLAND ? 1e5 : Math.abs(side < 0 ? coastWest() : coastEast()) - 5);
const COAST_BAND = EDGE_FADE * 0.6;

const FADE_UNIFORMS = {
  uLFade: { value: Array.from({ length: FADE_SLOTS }, () => new THREE.Vector3(0, 0, 0)) },
  uLCoast: { value: new THREE.Vector3(COAST_FROM(-1), COAST_FROM(1), COAST_BAND) },
  uLRadius: { value: new THREE.Vector3(FADE_IN, FADE_OUT, FADE_FLOOR) },
  // Each tunnel mouth on the island, as (x, z, and the direction into the hill): past one, the
  // train is under the mountain and is cut away rather than drawn through the hillside. Zero
  // direction (the classic slab) cuts nothing.
  uLPortal: { value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)] },
};

const PROJECT_VERTEX = '#include <project_vertex>';
const CLIP_FRAGMENT = '#include <clipping_planes_fragment>';

/**
 * Patch the dither into a `propMaterial()`. Chained onto the material's own `onBeforeCompile`
 * rather than replacing it, and keyed off its own `customProgramCacheKey` — the key is a promise
 * about source, so every material carrying this patch answers the same string (see CLAUDE.md).
 *
 * The world position is computed here rather than read from `worldPosition`, which three only
 * declares when something else (shadows, env maps) asked for it.
 *
 * No backticks in the GLSL comments: a backtick ends the template literal (CLAUDE.md).
 */
export function fadeMaterial(material) {
  const base = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${baseKey}-ltrain`;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    if (!shader.vertexShader.includes(PROJECT_VERTEX) || !shader.fragmentShader.includes(CLIP_FRAGMENT)) {
      throw new Error('ltrain: fade patch found no anchor in the shader');
    }
    Object.assign(shader.uniforms, FADE_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vLWorld;`)
      .replace(PROJECT_VERTEX, `${PROJECT_VERTEX}
{
  vec4 lw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  lw = instanceMatrix * lw;
#endif
  vLWorld = (modelMatrix * lw).xyz;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vLWorld;
uniform vec3 uLFade[${FADE_SLOTS}];
uniform vec3 uLCoast;
uniform vec3 uLRadius;
uniform vec4 uLPortal[2];
float lBayer(vec2 p) {
  // 4x4 ordered dither threshold in (0, 1).
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                          3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}`)
      .replace(CLIP_FRAGMENT, `${CLIP_FRAGMENT}
{
  // Off the island: the same smoothstep the ground fades on.
  // x is the west coast's distance and y the east's, which the harbor pushes further out.
  float edge = clamp((abs(vLWorld.x) - (vLWorld.x < 0.0 ? uLCoast.x : uLCoast.y)) / uLCoast.z, 0.0, 1.0);
  float keep = 1.0 - edge * edge * (3.0 - 2.0 * edge);
  // Over something the player needs to see. z of a slot is its strength, 0 for an empty one.
  for (int k = 0; k < ${FADE_SLOTS}; k++) {
    vec3 s = uLFade[k];
    float d = length(vLWorld.xz - s.xy);
    float f = 1.0 - smoothstep(uLRadius.x, uLRadius.y, d);
    keep = min(keep, mix(1.0, uLRadius.z, f * s.z));
  }
  if (keep < 0.999 && keep < lBayer(gl_FragCoord.xy)) discard;
  // Under the mountain: past a portal's face, within the tunnel's width of its line.
  for (int k = 0; k < 2; k++) {
    vec4 pt = uLPortal[k];
    vec2 r = vLWorld.xz - pt.xy;
    if (dot(r, pt.zw) > 0.0 && abs(r.y * pt.z - r.x * pt.w) < 6.0) discard;
  }
}`);
  };
  return material;
}

// --- Plan ---------------------------------------------------------------------------------------

/**
 * Where the line runs and where its columns stand. Pure: reads the grid, builds nothing, so the
 * probe can sweep it over seeds.
 *
 * Returns null on a city with no east-west arterial, which today's layout never builds — but the
 * big-park work may, and an L with nowhere to stand should be absent rather than wrong.
 */
export function planLTrain() {
  let line = null;
  for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) { line = j; break; }
  if (line === null) return null;

  const z = lineZ(line);
  const columns = [];
  // One bent at each nose of every planted island. Two per block reads as a structure; one in the
  // middle left 20-unit spans that looked like a girder balanced on a pin.
  for (const run of medianRuns()) {
    if (run.axis !== 'x' || run.line !== line) continue;
    columns.push(run.from + COLUMN_NOSE, run.to - COLUMN_NOSE);
  }
  // A closed segment (a park built over the arterial) has no island, so the line spans it on the
  // nearest bents either side. Out past the ring road it walks off the island on its own pitch —
  // or, on the island, turns up the coast on posts of its own (`planPosts`).
  const path = railPath();
  const ringFrom = Math.max(...columns.map(Math.abs), 0);
  for (const side of path ? [] : [-1, 1]) {
    for (let x = ringFrom + OFFSHORE_PITCH; x < LINE_END(side); x += OFFSHORE_PITCH) columns.push(side * x);
  }
  columns.sort((a, b) => a - b);

  if (path) {
    let from = Infinity;
    let to = -Infinity;
    for (let s = 0; s <= path.length; s += 1) {
      const q = railAt(path, s);
      from = Math.min(from, q.x);
      to = Math.max(to, q.x);
    }
    return {
      line, z, from, to, columns, track: z + TRACK_OFF, laneOff: laneOffX(line), path, posts: planPosts(path),
    };
  }

  return {
    line,
    z,
    from: -LINE_END(-1),
    to: LINE_END(1),
    columns,
    track: z + TRACK_OFF,
    laneOff: laneOffX(line),
  };
}

/**
 * The island's posts, out past the walk on each side: the first one just off the pad, then every
 * `OFFSHORE_PITCH` along the line round the bend and up the coast, standing on whatever is under
 * them — the verge, the beach, the harbor's waterfront, or the sea bed with a footing at the
 * waterline. None where the ground has come up under the deck: that is the cutting, and the track
 * is on the ground there.
 */
const POST_IN = 2.5;
function planPosts(path) {
  const p = pad();
  const posts = [];
  const straight = path.straight;
  const [west, east] = path.portals;
  const add = (s) => {
    const q = railAt(path, s);
    const foot = footAt(q.x, q.z, p);
    if (foot > CAP_UNDERSIDE - 1.6) return;
    posts.push({ s, x: q.x, z: q.z, heading: q.heading, bank: q.bank, foot });
  };
  const sW = straight.s0 + (p.x0 - straight.a.x);
  const sE = straight.s0 + (p.x1 - straight.a.x);
  for (let s = sW - POST_IN; s > west.s + 1; s -= OFFSHORE_PITCH) add(s);
  for (let s = sE + POST_IN; s < east.s - 1; s += OFFSHORE_PITCH) add(s);
  return posts;
}

/** What a post at (x, z) stands on: the city's level, the ground, or a footing in the sea. */
function footAt(x, z, p) {
  if (padDistance(x, z, p) < 0) return KERB_H;
  // The harbor's waterfront is paved at road level, out over the sea.
  if (x > p.x1 && harborLandAt(x, z)) return 0;
  const h = landHeight(x, z, p);
  return h > SEA_Y + 0.05 ? h : WATER_Y + 0.25;
}

/**
 * The line as something to build along and run on: `at(s)` for `s` in `[0, length]`, in the
 * group's frame (z relative to the median), and the stretch the deck is built over. On the slab
 * it is the straight it always was; on the island it is `city/railpath.js`'s curve, and the deck
 * stops a few units into each tunnel.
 */
function routeOf(plan) {
  if (!plan.path) {
    const length = plan.to - plan.from;
    return {
      length,
      deckFrom: 0,
      deckTo: length,
      pieces: [{ kind: 'line', s0: 0, len: length }],
      at: (s) => ({ x: plan.from + s, z: 0, heading: 0, curve: 0, bank: 0 }),
      sOfX: (x) => x - plan.from,
    };
  }
  const path = plan.path;
  return {
    length: path.length,
    deckFrom: path.portals[0].s - 3,
    deckTo: path.portals[1].s + 3,
    pieces: path.pieces,
    at: (s) => {
      const q = railAt(path, s);
      q.z -= plan.z;
      return q;
    },
    sOfX: (x) => path.straight.s0 + (x - path.straight.a.x),
  };
}

// --- Geometry -----------------------------------------------------------------------------------

const box = (w, h, d, x, y, z, color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, color);
};

/**
 * A box lying along the line at a point on it: `geo` is built centred on the origin with its long
 * axis on x, then carried `o` across the line and `y` up, rolled with the bank about the line's own
 * axis at deck height, turned to the heading and set down at the point.
 */
function placed(geo, q, o, y) {
  geo.translate(0, y - DECK_TOP, o);
  // A positive roll takes the +z side (the inside of a bend turning that way) down.
  if (q.bank) geo.rotateX(q.bank);
  geo.translate(0, DECK_TOP, 0);
  if (q.heading) geo.rotateY(-q.heading);
  geo.translate(q.x, 0, q.z);
  return geo;
}

/**
 * A member running the length of the line: one box per straight, and a chain of short ones round
 * each bend, each sized to its own radius so the inside girder is shorter than the outside one.
 */
function runAlong(route, parts, o, y, h, w, color) {
  for (const piece of route.pieces) {
    const a = Math.max(piece.s0, route.deckFrom);
    const b = Math.min(piece.s0 + piece.len, route.deckTo);
    if (b <= a) continue;
    if (piece.kind === 'line') {
      parts.push(bakeColor(placed(new THREE.BoxGeometry(b - a, h, w), route.at((a + b) / 2), o, y), color));
      continue;
    }
    const n = Math.ceil((b - a) / 1.2);
    const scale = (piece.r - piece.sgn * o) / piece.r;
    for (let k = 0; k < n; k++) {
      const s0 = a + (b - a) * k / n;
      const s1 = a + (b - a) * (k + 1) / n;
      const geo = new THREE.BoxGeometry((s1 - s0) * scale + 0.04, h, w);
      parts.push(bakeColor(placed(geo, route.at((s0 + s1) / 2), o, y), color));
    }
  }
}

/** A member across the line, at every `pitch` along it. */
function acrossAt(route, parts, pitch, build) {
  for (let s = route.deckFrom + pitch / 2; s < route.deckTo; s += pitch) build(route.at(s));
}

/** The deck and its track, in the group's frame (centred on the median, so z is across it). */
function buildDeck(route) {
  const parts = [];
  const steel = PALETTE.ltrainSteel;
  const dark = PALETTE.ltrainSteelDark;

  // Two fascia girders, a stringer under each rail and floor beams across — and **no slab**. An
  // L deck is open steel with ties on it, and from a camera looking down at 33 degrees that is the
  // difference between a structure and a roof: through the ties you see the median and the deck's
  // own striped shadow below.
  for (const s of [-1, 1]) {
    runAlong(route, parts, s * (DECK_HALF_W - GIRDER_W / 2), DECK_TOP - GIRDER_D / 2, GIRDER_D, GIRDER_W, steel);
  }
  for (const t of TRACKS) {
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      runAlong(route, parts, t + r, DECK_TOP - STRINGER_D / 2, STRINGER_D, STRINGER_W, dark);
    }
  }
  acrossAt(route, parts, FLOOR_PITCH, (q) => parts.push(bakeColor(placed(
    new THREE.BoxGeometry(FLOOR_W, FLOOR_D, DECK_HALF_W * 2 - GIRDER_W * 2), q, 0,
    DECK_TOP - STRINGER_D - FLOOR_D / 2 + 0.02), dark)));
  // Stiffeners standing proud of each girder's outer face: the rhythm that makes a long plate read
  // as riveted steel rather than as a grey bar.
  acrossAt(route, parts, STIFFENER_PITCH, (q) => {
    for (const s of [-1, 1]) {
      parts.push(bakeColor(placed(new THREE.BoxGeometry(0.12, GIRDER_D, 0.05), q, s * (DECK_HALF_W + 0.025),
        DECK_TOP - GIRDER_D / 2), dark));
    }
  });
  // The track: open ties and two rails per side.
  for (const t of TRACKS) {
    acrossAt(route, parts, TIE_PITCH, (q) => parts.push(bakeColor(placed(
      new THREE.BoxGeometry(TIE_W, TIE_H, TIE_LEN), q, t, DECK_TOP + TIE_H / 2), PALETTE.ltrainTie)));
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      runAlong(route, parts, t + r, DECK_TOP + TIE_H + RAIL_H / 2, RAIL_H, RAIL_W, PALETTE.ltrainRail);
    }
  }
  return mergeGeometries(parts, false);
}

/**
 * The columns, each a footing, a shaft and a hammerhead cap under the girders: the median's, at
 * `plan.columns` along the arterial, and on the island the posts round the bends and up the coast.
 */
function buildColumns(plan) {
  const parts = [];
  for (const x of plan.columns) {
    // Out over the harbor's sea a column stands in the water, on a footing at the waterline, rather
    // than on ground that is not there.
    const foot = harborLandAt(x, plan.z) ? KERB_H : WATER_Y + 0.25;
    column(parts, { x, z: 0, heading: 0, bank: 0 }, foot);
  }
  for (const post of plan.posts ?? []) {
    column(parts, { x: post.x, z: post.z - plan.z, heading: post.heading, bank: post.bank }, post.foot);
  }
  return mergeGeometries(parts, false);
}

function column(parts, q, foot) {
  const capY = DECK_UNDERSIDE - CAP_H / 2;
  // The shaft stands plumb; only the cap takes the bank, since it is what the deck sits on.
  const plumb = { ...q, bank: 0 };
  const h = capY - CAP_H / 2 - foot;
  parts.push(bakeColor(placed(new THREE.BoxGeometry(FOOTING_W, FOOTING_H, FOOTING_W), plumb, 0,
    foot + FOOTING_H / 2 - 0.05), PALETTE.ltrainFooting));
  parts.push(bakeColor(placed(new THREE.BoxGeometry(COLUMN_W, h, COLUMN_W), plumb, 0, foot + h / 2),
    PALETTE.ltrainSteel));
  parts.push(bakeColor(placed(new THREE.BoxGeometry(CAP_W, CAP_H, DECK_HALF_W * 2 - 0.1), q, 0, capY),
    PALETTE.ltrainSteelDark));
  // Knee braces from the shaft out under each arm of the cap: what makes a T read as a bent
  // carrying weight rather than as a sign post.
  for (const s of [-1, 1]) {
    const z0 = s * COLUMN_W / 2;
    const y0 = capY - CAP_H / 2 - BRACE_DROP;
    const z1 = s * BRACE_REACH;
    const y1 = capY - CAP_H / 2;
    const brace = new THREE.BoxGeometry(0.22, Math.hypot(z1 - z0, y1 - y0), 0.22);
    brace.rotateX(Math.atan2(z1 - z0, y1 - y0));
    brace.translate(0, (y0 + y1) / 2 - DECK_TOP, (z0 + z1) / 2);
    brace.translate(0, DECK_TOP, 0);
    if (q.heading) brace.rotateY(-q.heading);
    brace.translate(q.x, 0, q.z);
    parts.push(bakeColor(brace, PALETTE.ltrainSteel));
  }
}

/**
 * One car, nose along +x, centred on its own origin, floor at y = 0 (the railhead). Each car of the
 * train is its own mesh on this one geometry, because on the island the line bends and every car
 * has to follow it on its own heading.
 */
function buildCar() {
  const parts = [];
  {
    const cx = 0;
    // Running gear: a dark skirt and a truck at each end.
    parts.push(box(CAR_LEN - 0.8, 0.22, CAR_W - 0.35, cx, 0.19, 0, PALETTE.ltrainUnder));
    for (const e of [-1, 1]) parts.push(box(1.1, 0.3, CAR_W - 0.2, cx + e * (CAR_LEN / 2 - 0.9), 0.15, 0, PALETTE.ltrainUnder));
    // Body, roof and the air-con pod on it.
    parts.push(box(CAR_LEN, BODY_H, CAR_W, cx, 0.3 + BODY_H / 2, 0, PALETTE.ltrainBody));
    parts.push(box(CAR_LEN - 0.3, 0.15, CAR_W - 0.3, cx, 0.3 + BODY_H + 0.075, 0, PALETTE.ltrainRoof));
    parts.push(box(1.4, 0.16, 1.0, cx, 0.3 + BODY_H + 0.15 + 0.08, 0, PALETTE.ltrainRoof));
    // The window band down each side and the stripe under it, standing a hair proud of the body.
    // Sides only: the camera never sees the far side's band, but a train is symmetric and costs
    // eight boxes either way.
    for (const s of [-1, 1]) {
      parts.push(box(CAR_LEN - 0.7, 0.42, 0.04, cx, 0.3 + BODY_H - 0.38, s * (CAR_W / 2 + 0.02), PALETTE.ltrainGlass));
      parts.push(box(CAR_LEN + 0.02, 0.12, 0.03, cx, 0.3 + 0.42, s * (CAR_W / 2 + 0.015), PALETTE.ltrainStripe));
    }
    // An end window at each end of every car — the train shuttles, so either end may be the front.
    for (const e of [-1, 1]) {
      parts.push(box(0.04, 0.5, CAR_W - 0.5, cx + e * (CAR_LEN / 2 + 0.02), 0.3 + BODY_H - 0.4, 0, PALETTE.ltrainGlass));
    }
  }
  return mergeGeometries(parts, false);
}

// --- The line -----------------------------------------------------------------------------------

const smoothstep01 = (t) => {
  const k = THREE.MathUtils.clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
};

/**
 * Build the L and its train. Returns null where `planLTrain` does.
 *
 * `rng` is a run-seed stream: which way the first train goes and how long the line stands empty
 * is the situation, not the map.
 */
export function createLTrain(scene, rng, { sparks = null } = {}) {
  const plan = planLTrain();
  if (!plan) return null;
  const route = routeOf(plan);
  const portals = FADE_UNIFORMS.uLPortal.value;
  for (let k = 0; k < 2; k++) {
    const port = plan.path?.portals[k];
    portals[k].set(port?.x ?? 0, port?.z ?? 0, port?.dx ?? 0, port?.dz ?? 0);
  }

  // Centred on the median so the city's entrance can grow it as one object from its middle.
  const group = new THREE.Group();
  group.name = 'ltrain';
  group.position.set(0, 0, plan.z);
  scene.add(group);

  const material = fadeMaterial(propMaterial());

  const deck = new THREE.Mesh(buildDeck(route), material);
  deck.castShadow = true;
  deck.receiveShadow = true;
  // The deck is a thin shell 3 units over the road: its slab, ties and rails are each a few tenths
  // thick, which is the bridge deck's acne all over again. Sunk along the sun's rays — free here
  // for the same reason it is on a bridge, since its shadow lands three units down on asphalt.
  sinkShadowCaster(deck);
  group.add(deck);

  // The columns are not sunk: their shadow starts at their own foot, and sinking it would detach it.
  const columns = new THREE.Mesh(buildColumns(plan), material);
  columns.castShadow = true;
  columns.receiveShadow = true;
  group.add(columns);

  const body = new THREE.Group();
  body.name = 'ltrain-cars';
  const carGeo = buildCar();
  const cars = CAR_OFFSETS.map(() => {
    const car = new THREE.Mesh(carGeo, material);
    car.castShadow = true;
    car.receiveShadow = true;
    // Yaw, then the bank about the car's own length (CLAUDE.md: the default order rolls about
    // the world's x).
    car.rotation.order = BODY_EULER_ORDER;
    body.add(car);
    return car;
  });
  group.add(body);

  markOccluder(group);

  // --- Running it ---
  const state = {
    phase: 'wait',
    dir: rng.chance(0.5) ? 1 : -1,
    x: 0,
    /** How far along the line the train's middle is (`route.at`). */
    s: 0,
    t: 0,
    speed: 0,
    wait: rng.range(1, 4),
    /** Bumped once per departure — the hook a rumble or a horn would count. */
    runs: 0,
  };
  const runLength = route.length;
  // Distance-time profile with a `RAMP` ease at each end and `SPEED` in between.
  const cruiseLen = runLength - SPEED * RAMP;
  const runTime = RAMP * 2 + cruiseLen / SPEED;
  const along = (t) => {
    if (t < RAMP) return SPEED * t * t / (2 * RAMP);
    if (t < runTime - RAMP) return SPEED * RAMP / 2 + SPEED * (t - RAMP);
    const r = runTime - t;
    return runLength - SPEED * r * r / (2 * RAMP);
  };

  const place = () => {
    body.visible = state.phase === 'run';
    if (!body.visible) return;
    for (let n = 0; n < CARS; n++) {
      const q = route.at(state.s + CAR_OFFSETS[n]);
      cars[n].position.set(q.x, RAIL_TOP, q.z + TRACK_OFF);
      cars[n].rotation.set(q.bank, -q.heading, 0);
    }
  };

  function depart() {
    state.phase = 'run';
    state.t = 0;
    state.runs += 1;
  }

  function update(dt) {
    if (state.phase === 'wait') {
      state.wait -= dt;
      if (state.wait <= 0) depart();
    }
    if (state.phase === 'run') {
      state.t += dt;
      if (state.t >= runTime) {
        state.phase = 'wait';
        state.wait = rng.range(WAIT[0], WAIT[1]);
        state.dir = -state.dir;
        state.speed = 0;
      } else {
        const s = along(state.t);
        state.s = state.dir > 0 ? s : runLength - s;
        state.x = route.at(state.s).x;
        state.speed = (along(state.t + 1e-3) - s) / 1e-3;
      }
    }
    place();
    if (sparks) sparkle(dt);
  }

  let sparkWait = rng.range(SPARK_GAP[0], SPARK_GAP[1]);
  let pulses = 0;
  let pulseWait = 0;
  let bogieX = 0;
  function sparkle(dt) {
    const onIsland = plan.path
      ? state.s - TRAIN_LEN / 2 > plan.path.portals[0].s && state.s + TRAIN_LEN / 2 < plan.path.portals[1].s
      : Math.abs(state.x) < COAST_FROM(Math.sign(state.x));
    if (state.phase !== 'run' || state.speed < SPARK_MIN_SPEED || !onIsland) {
      pulses = 0;
      return;
    }
    if (pulses === 0) {
      sparkWait -= dt;
      if (sparkWait > 0) return;
      sparkWait = rng.range(SPARK_GAP[0], SPARK_GAP[1]);
      pulses = SPARK_PULSES;
      pulseWait = 0;
      // Which truck: a car, then one end of it.
      const car = rng.int(0, CARS - 1);
      bogieX = -TRAIN_LEN / 2 + CAR_LEN / 2 + car * (CAR_LEN + CAR_GAP) + (rng.chance(0.5) ? 1 : -1) * BOGIE_AT;
    }
    pulseWait -= dt;
    if (pulseWait > 0) return;
    pulseWait = SPARK_PULSE_GAP;
    pulses -= 1;
    // The train is symmetric, so a bogie is the same offset along the line whichever way it is
    // running. Yaw is a sim heading: 0 runs +x, and forward is (cos, -sin).
    const q = route.at(state.s + bogieX);
    const yaw = -q.heading + (state.dir > 0 ? 0 : Math.PI);
    const count = rng.int(SPARK_COUNT[0], SPARK_COUNT[1]);
    // Off the camera's side of the truck (the side facing +x +z, as the view looks in from
    // there): thrown from under the car on the rail itself, the first cut's sparks were hidden by
    // the body they came out of.
    let px = -Math.sin(q.heading);
    let pz = Math.cos(q.heading);
    if (px + pz < 0) { px = -px; pz = -pz; }
    const side = CAR_W / 2 + 0.05;
    sparks.burst(q.x + px * side, RAIL_TOP + 0.08, plan.z + q.z + TRACK_OFF + pz * side, yaw, count, state.speed,
      { reach: 0.8, lift: 1.0, floor: 0 });
  }

  /**
   * Hand the fade the points on the ground it must not hide. `points` is `{ x, z }` in world space;
   * the first `FADE_SLOTS` within reach of the line are used and the rest ignored. Called each
   * frame — cheap, it is a handful of subtractions and no allocation.
   */
  const reach = DECK_HALF_W + FADE_OUT;
  function setFadePoints(points) {
    const slots = FADE_UNIFORMS.uLFade.value;
    let n = 0;
    for (const p of points) {
      if (n >= FADE_SLOTS) break;
      if (!p) continue;
      const fx = p.x + FADE_LIFT;
      const fz = p.z + FADE_LIFT;
      if (Math.abs(fz - plan.z) > reach) continue;
      slots[n++].set(fx, fz, p.strength ?? 1);
    }
    for (; n < FADE_SLOTS; n++) slots[n].set(0, 0, 0);
  }

  /**
   * Shot mode: park a train mid-run over `x` (the frame's target) so a still has one in it. The
   * fare loop ticks once and freezes, so anything driven off sim time needs telling (CLAUDE.md).
   */
  function settle(x = 0) {
    state.phase = 'run';
    state.s = THREE.MathUtils.clamp(route.sOfX(x), 0, runLength);
    const s = state.dir > 0 ? state.s : runLength - state.s;
    // Invert `along` on the cruise segment, which is where any on-island x lands.
    state.t = RAMP + (s - SPEED * RAMP / 2) / SPEED;
    state.x = route.at(state.s).x;
    state.speed = SPEED;
    place();
    // And one shower in the air, so a still shows what the wheels do.
    if (sparks) {
      sparkWait = 0;
      pulses = 0;
      for (let k = 0; k < SPARK_PULSES; k++) sparkle(SPARK_PULSE_GAP + 1e-3);
    }
  }

  place();

  return {
    group,
    plan,
    state,
    body,
    deck,
    columns,
    material,
    update,
    settle,
    setFadePoints,
    /** The entrance wave's handle: the whole structure grows from the middle of its median. */
    entryObjects: [{ object: group, x: 0, z: plan.z, rand: 0.5 }],
    /**
     * Where a rumble would play from: the train's middle while it runs, null while the line is
     * empty. The level is its speed as a share of cruise, so it swells in and out with the ramps.
     */
    emitter: () => (state.phase === 'run'
      ? { x: state.x, z: plan.z + route.at(state.s).z + TRACK_OFF, y: RAIL_TOP, level: state.speed / SPEED }
      : null),
    runTime,
  };
}

/** For the probe: everything the clearance claims rest on, as numbers. */
export const LTRAIN_DIMENSIONS = {
  DECK_TOP, DECK_UNDERSIDE, DECK_HALF_W, TRACK_OFF, RAIL_TOP, TRAIN_LEN, CAR_W, ROOF_TOP,
  COLUMN_W, FOOTING_W, MEDIAN_W, FADE_LIFT, GRID_I, CAP_UNDERSIDE,
};
