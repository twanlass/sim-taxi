import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, setFinish, FINISH, vehiclePaintOn } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { coneGeometry, coneMaterial, coneQuat } from '../geometry/lights.js';
import {
  GRID_I, GRID_J, lineX, lineZ, isArterialX, isArterialZ, laneOffX, laneOffZ, medianRuns, MEDIAN_W,
  LTRAIN_NS,
} from '../city/grid.js';
import { EDGE_FADE, KERB_H } from '../city/ground.js';
import { coastWest, coastEast, coastNorth, coastSouth } from '../city/grid.js';
import { WATER_Y } from '../city/river.js';
import { harborLandAt } from '../city/harborplan.js';
import { VIEW_DIR } from './camera.js';
import { sinkShadowCaster } from './scene.js';
import { markOccluder, setOccluderDepthMaterial } from './ssao.js';

// The elevated train (on by default, `?ltrain=classic`): a Chicago-style L on a steel structure down the
// north-south arterial, with one train shuttling along it. It crosses the river on the arterial's
// fixed bridge and runs off both ends of the map (Tyler, 2026-10-13; `?lroute=classic` puts it back
// on the east-west arterial, beside the river).
//
// **Everything is built along local +x** and the group is turned onto the line: a quarter turn for
// north-south, so local +x runs north (world -z) and local +z is world +x, the camera's side. `a`
// below is distance along the line in that frame, `c` the line's own cross coordinate in the world.
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
export const DECK_TOP = 6.4;
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
const coastAt = (side) => (LTRAIN_NS
  ? Math.abs(side < 0 ? coastSouth() : coastNorth())
  : Math.abs(side < 0 ? coastWest() : coastEast()));
const LINE_END = (side) => coastAt(side) + EDGE_FADE + TRAIN_LEN / 2 + 2;

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

// --- Lamps -------------------------------------------------------------------------------------
//
// A pair of headlights low on the leading end and a pair of red tail lamps on the trailing one
// (on by default, `?trainlights=classic` for the unlit train). The train shuttles, so both ends
// carry both — but rather than switch four pairs on and off, the lamps are one group with the
// headlights at +x and the tails at -x, and the group is turned half round when the train runs
// west. The train is symmetric about its middle, so the half turn lands each pair exactly on the
// other end's sockets.
//
// The pods are always lit, the way a real train's are: unlit and emissive like the cars' brake
// pods, so they read day or night, and in the bloom. What the dark adds is the **beam** — the same
// additive cone the cars throw (geometry/lights.js), scaled up for a bigger lamp, brought up by
// `setBeams` off the city's running-light level and the night.
//
// Only the +x end is ever face-on to this camera (it looks in from +x +z), so an eastbound train
// shows its headlights and a westbound one shows its tails. Both read; the other end's pair is a
// sliver at most.
const HEAD_R = 0.18;          // 0.36 across: ~2.8px at play zoom, a car's headlight is ~2
const HEAD_Z = 0.4;           // off the centreline, inside the end window's 0.625
const TAIL_R = 0.14;
const TAIL_Z = 0.66;          // the outer corners, so the two ends do not read as one kind of lamp
const LAMP_Y = 0.62;          // above the railhead: under the end window (0.95), over the skirt
const LAMP_D = 0.2;
/** Outer face 0.06 proud of the end face — the end window stands 0.04 proud, and coplanar fights. */
const LAMP_X = TRAIN_LEN / 2 + 0.06 - LAMP_D / 2;
/** The beam is the car's cone at this scale: 6.9 long and 2.6 across at the mouth. */
const BEAM_SCALE = 1.5;
/** Additive strength at full dark — the cars' own `uStrength`. */
const BEAM_STRENGTH = 0.45;

function lampPair(radius, x, z) {
  return mergeGeometries([-1, 1].map((s) => {
    const geo = new THREE.CylinderGeometry(radius, radius, LAMP_D, 10, 1, false);
    geo.rotateZ(Math.PI / 2);
    geo.translate(x, LAMP_Y, s * z);
    return geo;
  }), false);
}

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
const COAST_FROM = (side) => coastAt(side) - 5;
const COAST_BAND = EDGE_FADE * 0.6;

const FADE_UNIFORMS = {
  uLFade: { value: Array.from({ length: FADE_SLOTS }, () => new THREE.Vector3(0, 0, 0)) },
  uLCoast: { value: new THREE.Vector3(COAST_FROM(-1), COAST_FROM(1), COAST_BAND) },
  uLRadius: { value: new THREE.Vector3(FADE_IN, FADE_OUT, FADE_FLOOR) },
  // 1 when the line runs north-south: the coast fade then reads distance along -z, not x.
  uLAxis: { value: LTRAIN_NS ? 1 : 0 },
};

const PROJECT_VERTEX = '#include <project_vertex>';
// 4x4 ordered dither threshold in (0, 1): the fade's, and the intro's on a material without one.
const BAYER = /* glsl */ `
float lBayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                          3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}`;
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
uniform float uLAxis;
${BAYER}`)
      .replace(CLIP_FRAGMENT, `${CLIP_FRAGMENT}
{
  // Off the island: the same smoothstep the ground fades on. Measured along the line (x, or -z
  // for a north-south one); x is the near coast's distance (west or south) and y the far one's.
  float lAlong = mix(vLWorld.x, -vLWorld.z, uLAxis);
  float edge = clamp((abs(lAlong) - (lAlong < 0.0 ? uLCoast.x : uLCoast.y)) / uLCoast.z, 0.0, 1.0);
  float keep = 1.0 - edge * edge * (3.0 - 2.0 * edge);
  // Over something the player needs to see. z of a slot is its strength, 0 for an empty one.
  for (int k = 0; k < ${FADE_SLOTS}; k++) {
    vec3 s = uLFade[k];
    float d = length(vLWorld.xz - s.xy);
    float f = 1.0 - smoothstep(uLRadius.x, uLRadius.y, d);
    keep = min(keep, mix(1.0, uLRadius.z, f * s.z));
  }
  if (keep < 0.999 && keep < lBayer(gl_FragCoord.xy)) discard;
}`);
  };
  return material;
}

// --- The intro ----------------------------------------------------------------------------------
//
// The L's own entrance, alongside the city's (game/cityentry.js) rather than inside it (on by
// default, `?trainintro=classic` grows the whole structure from its middle as one object, which is
// what it did before). **The bents come up the way the buildings do**: the same wave from the taxi,
// the same easeOutBack over the same grow, the same footprint swell, read off the city entry's
// own levers so a retune moves both. **Then the track is laid**: once every bent on the island is
// standing, the spans drop into place one at a time from the end nearer the taxi, each falling
// `DROP_H` and dithering in as it comes (Tyler, 2026-10-13: "falling only a short distance").
//
// In the vertex shader for the same reason the city's is: the deck and the bents are one merged
// mesh each, and splitting them into fifty objects for a two-second flourish would cost draw calls
// for the life of the run. Each vertex carries `aLIntro` = (its start time, its kind, its bent's
// x); the start times are rewritten on `start()`, because they depend on where the taxi is.
//
// Patched into the sun's shadow pass and the AO prepass too (CLAUDE.md: every depth pass), or the
// finished deck's shadow and contact crease would be on the road before the deck is.
//
// The spans come from `deckSpans`, so the order follows whatever the line's own list of spans is.

/** Seconds between one span starting to drop and the next. */
const SPAN_STAGGER = 0.07;
/** How far a span falls, and over how long. Short on purpose: it is set down, not dropped. */
const DROP_H = 1.6;
const DROP_DUR = 0.4;
/** A beat between the last bent settling and the first span coming down. */
const DROP_PAUSE = 0.1;
/** The footprint swell the bents rise with — the city entry's `XZ_FROM`. */
const RISE_XZ_FROM = 0.65;
const RISE_FADE = 0.3;

const INTRO_KIND = { none: 0, rise: 1, drop: 2 };

const INTRO_UNIFORMS = {
  uLIntroT: { value: 1e6 },
  uLGrow: { value: 0.3 },
  uLOver: { value: 3.9 },
};

const BEGIN_VERTEX = '#include <begin_vertex>';

function patchIntroVertex(shader) {
  if (!shader.vertexShader.includes(BEGIN_VERTEX)) throw new Error('ltrain: intro patch found no begin_vertex');
  Object.assign(shader.uniforms, INTRO_UNIFORMS);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec3 aLIntro;
uniform float uLIntroT;
uniform float uLGrow;
uniform float uLOver;
varying float vLIntro;`)
    .replace(BEGIN_VERTEX, `${BEGIN_VERTEX}
vLIntro = 1.0;
if (aLIntro.y > 1.5) {
  // A span: set down from DROP_H above, easing out, dithering in over the first part of the fall.
  float t = clamp((uLIntroT - aLIntro.x) / ${DROP_DUR.toFixed(4)}, 0.0, 1.0);
  float d = 1.0 - t;
  transformed.y += ${DROP_H.toFixed(4)} * d * d * d;
  vLIntro = smoothstep(0.0, 0.6, t);
} else if (aLIntro.y > 0.5) {
  // A bent: the city entry's rise, about its own foot. aLIntro.z is its x; z is centred on it.
  float t = clamp((uLIntroT - aLIntro.x) / uLGrow, 0.0, 1.0);
  float b = t - 1.0;
  float s = 1.0 + (uLOver + 1.0) * b * b * b + uLOver * b * b;
  transformed.y = ${KERB_H.toFixed(4)} + (transformed.y - ${KERB_H.toFixed(4)}) * s;
  float xz = mix(${RISE_XZ_FROM.toFixed(4)}, 1.0, s);
  transformed.x = aLIntro.z + (transformed.x - aLIntro.z) * xz;
  transformed.z *= xz;
  vLIntro = smoothstep(0.0, ${RISE_FADE.toFixed(4)}, t);
}`);
}

/**
 * The intro on a material: the fade's own dither, so nothing new to sort. `bayer` brings the
 * dither function along for a material that has no fade — the river truss, which Tyler wants
 * solid round the taxi but which still has to be laid with its spans.
 */
function introMaterial(material, { bayer = false } = {}) {
  const base = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${baseKey}-lintro`;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    patchIntroVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vLIntro;${bayer ? BAYER : ''}`)
      .replace(CLIP_FRAGMENT, `${CLIP_FRAGMENT}
if (vLIntro < 0.999 && vLIntro < lBayer(gl_FragCoord.xy)) discard;`);
  };
  return material;
}

/** A depth pass's material, intro-patched — a span that has not arrived casts nothing. */
function introDepth(depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })) {
  const base = depth.onBeforeCompile;
  const baseKey = depth.customProgramCacheKey();
  depth.customProgramCacheKey = () => `${baseKey}-lintro`;
  depth.onBeforeCompile = (shader, renderer) => {
    base.call(depth, shader, renderer);
    patchIntroVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vLIntro;`)
      .replace('void main() {', 'void main() {\n\tif (vLIntro <= 0.004) discard;');
  };
  return depth;
}

/** Give a geometry its `aLIntro`, all zero — kind none — until `start()` writes it. */
function addIntro(geo) {
  geo.setAttribute('aLIntro', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
  return geo;
}

// --- Plan ---------------------------------------------------------------------------------------

/**
 * Where the line runs and where its columns stand. Pure: reads the grid, builds nothing, so the
 * probe can sweep it over seeds.
 *
 * Returns null on a city with no arterial on the line's axis, which today's layout never builds —
 * but an L with nowhere to stand should be absent rather than wrong.
 *
 * `columns` and `from`/`to` are distances along the line (`a`, see the top of the file): world x
 * for an east-west line, world -z for a north-south one. `c` is the line's cross coordinate.
 */
export function planLTrain() {
  const ns = LTRAIN_NS;
  let line = null;
  // Interior lines only: a ring road has no median.
  if (ns) {
    for (let i = 1; i < GRID_I; i++) if (isArterialZ(i)) { line = i; break; }
  } else {
    for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) { line = j; break; }
  }
  if (line === null) return null;

  const c = ns ? lineX(line) : lineZ(line);
  const columns = [];
  // One bent at each nose of every planted island. Two per block reads as a structure; one in the
  // middle left 20-unit spans that looked like a girder balanced on a pin. A north-south island
  // runs in z, and `a` is -z, so its ends swap.
  for (const run of medianRuns()) {
    if (run.axis !== (ns ? 'z' : 'x') || run.line !== line) continue;
    if (ns) columns.push(-run.to + COLUMN_NOSE, -run.from - COLUMN_NOSE);
    else columns.push(run.from + COLUMN_NOSE, run.to - COLUMN_NOSE);
  }
  // A closed segment (a park built over the arterial) has no island, so the line spans it on the
  // nearest bents either side. Out past the ring road it walks off the island on its own pitch.
  const ringFrom = Math.max(...columns.map(Math.abs), 0);
  for (const side of [-1, 1]) {
    for (let x = ringFrom + OFFSHORE_PITCH; x < LINE_END(side); x += OFFSHORE_PITCH) columns.push(side * x);
  }
  columns.sort((a, b) => a - b);

  return {
    line,
    axis: ns ? 'z' : 'x',
    c,
    // The world point at the median's middle, where the group stands.
    x: ns ? c : 0,
    z: ns ? 0 : c,
    from: -LINE_END(-1),
    to: LINE_END(1),
    columns,
    track: c + TRACK_OFF,
    laneOff: ns ? laneOffZ(line) : laneOffX(line),
    /** World (x, z) of the point `a` along the line and `o` across it (towards the camera). */
    world: ns ? (a, o = 0) => ({ x: c + o, z: -a }) : (a, o = 0) => ({ x: a, z: c + o }),
    /** The reverse: a world point's distance along the line. */
    alongOf: ns ? (x, z) => -z : (x) => x,
  };
}

// --- Geometry -----------------------------------------------------------------------------------

const box = (w, h, d, x, y, z, color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, color);
};
const boxPart = box;

/**
 * The deck's spans: the stretches between consecutive bents, plus the two runs off the last bent
 * at each end. The intro lays them one at a time, so the deck is built span by span rather than as
 * one length of girder — see the intro above.
 */
export function deckSpans(plan) {
  const cuts = [plan.from, ...plan.columns, plan.to];
  const spans = [];
  for (let k = 0; k < cuts.length - 1; k++) spans.push({ from: cuts[k], to: cuts[k + 1] });
  return spans;
}

/**
 * The deck and its track, in the group's frame (centred on the median, so z is across it). One
 * merged geometry, with each vertex's span index in `span`. The lengthwise members — girders,
 * stringers and rails — are cut at every bent, which leaves butt joints over the caps and nothing
 * coplanar overlapping; the cross members go to the span their x falls in.
 */
function buildDeck(plan) {
  const spans = deckSpans(plan);
  const geos = spans.map((span) => buildDeckSpan(plan, span));
  geos.forEach((geo, k) => {
    geo.setAttribute('span', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(k), 1));
  });
  return mergeGeometries(geos, false);
}

function buildDeckSpan(plan, span) {
  const parts = [];
  const len = span.to - span.from;
  const mid = (span.from + span.to) / 2;
  const inSpan = (x) => x >= span.from && x < span.to;
  const steel = PALETTE.ltrainSteel;
  const dark = PALETTE.ltrainSteelDark;

  // Two fascia girders, a stringer under each rail and floor beams across — and **no slab**. An
  // L deck is open steel with ties on it, and from a camera looking down at 33 degrees that is the
  // difference between a structure and a roof: through the ties you see the median and the deck's
  // own striped shadow below.
  for (const s of [-1, 1]) {
    parts.push(box(len, GIRDER_D, GIRDER_W, mid, DECK_TOP - GIRDER_D / 2, s * (DECK_HALF_W - GIRDER_W / 2), steel));
  }
  for (const t of TRACKS) {
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      parts.push(box(len, STRINGER_D, STRINGER_W, mid, DECK_TOP - STRINGER_D / 2, t + r, dark));
    }
  }
  for (let x = plan.from + FLOOR_PITCH / 2; x < plan.to; x += FLOOR_PITCH) {
    if (!inSpan(x)) continue;
    parts.push(box(FLOOR_W, FLOOR_D, DECK_HALF_W * 2 - GIRDER_W * 2, x, DECK_TOP - STRINGER_D - FLOOR_D / 2 + 0.02, 0, dark));
  }
  // Stiffeners standing proud of each girder's outer face: the rhythm that makes a long plate read
  // as riveted steel rather than as a grey bar.
  for (let x = plan.from + STIFFENER_PITCH / 2; x < plan.to; x += STIFFENER_PITCH) {
    if (!inSpan(x)) continue;
    for (const s of [-1, 1]) {
      parts.push(box(0.12, GIRDER_D, 0.05, x, DECK_TOP - GIRDER_D / 2, s * (DECK_HALF_W + 0.025), dark));
    }
  }
  // The track: open ties and two rails per side.
  for (const t of TRACKS) {
    for (let x = plan.from + TIE_PITCH / 2; x < plan.to; x += TIE_PITCH) {
      if (!inSpan(x)) continue;
      parts.push(box(TIE_W, TIE_H, TIE_LEN, x, DECK_TOP + TIE_H / 2, t, PALETTE.ltrainTie));
    }
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      parts.push(box(len, RAIL_H, RAIL_W, mid, DECK_TOP + TIE_H + RAIL_H / 2, t + r, PALETTE.ltrainRail));
    }
  }
  return mergeGeometries(parts, false);
}

// --- The river truss ----------------------------------------------------------------------------
//
// A north-south line crosses the river, and the river has no median: the road bridge under it runs
// junction to junction, so the bents either side stand 34 units apart against the 7 to 13 of
// every other span. A plate girder that long reads as a plank balanced on two posts. So any span
// past `TRUSS_FROM` gets a through truss — a Warren girder each side, standing up past the train's
// roof (8.35) and braced across the top — which is what a real L does over a river, and which
// gives the crossing a landmark. Every member stays outside the train's half-width (0.88) and
// above its roof, so the train runs through it untouched.
const TRUSS_FROM = 20;
const TRUSS_H = 3.3;
const TRUSS_PANEL = 4.5;
const TRUSS_W = 0.2;

/** A box from `a` to `b` (local x, y, z arrays), `w` square. */
function strut(a, b, w, colour) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.BoxGeometry(w, len, w);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  g.translate((va.x + vb.x) / 2, (va.y + vb.y) / 2, (va.z + vb.z) / 2);
  return bakeColor(g, colour);
}

/** The trusses in the group's frame, or null when no span is long enough to want one. */
function buildTrusses(plan) {
  const geos = [];
  const steel = PALETTE.ltrainSteel;
  const dark = PALETTE.ltrainSteelDark;
  const lo = DECK_TOP - 0.1;
  const hi = DECK_TOP + TRUSS_H;
  const zs = DECK_HALF_W + TRUSS_W / 2;
  for (let n = 1; n < plan.columns.length; n++) {
    const a0 = plan.columns[n - 1];
    const a1 = plan.columns[n];
    if (a1 - a0 < TRUSS_FROM) continue;
    const parts = [];
    const panels = Math.max(2, Math.round((a1 - a0) / TRUSS_PANEL));
    const step = (a1 - a0) / panels;
    for (const side of [-1, 1]) {
      const z = side * zs;
      // The top chord runs between the first and last panel points; the end posts are inclined.
      parts.push(strut([a0, lo, z], [a0 + step, hi, z], TRUSS_W * 1.3, steel));
      parts.push(strut([a1, lo, z], [a1 - step, hi, z], TRUSS_W * 1.3, steel));
      parts.push(strut([a0 + step, hi, z], [a1 - step, hi, z], TRUSS_W * 1.3, steel));
      for (let k = 1; k < panels - 1; k++) {
        // Warren diagonals: down to the deck and back up, panel by panel, with a vertical at each
        // top panel point.
        const x0 = a0 + k * step;
        const x1 = x0 + step;
        parts.push(strut([x0, hi, z], [x0, lo, z], TRUSS_W * 0.8, dark));
        parts.push(strut(k % 2 ? [x0, hi, z] : [x0, lo, z], k % 2 ? [x1, lo, z] : [x1, hi, z], TRUSS_W, steel));
      }
    }
    // Lateral bracing over the top: a strut across at each panel point clear of the train's roof.
    for (let k = 1; k < panels; k++) {
      parts.push(strut([a0 + k * step, hi, -zs], [a0 + k * step, hi, zs], TRUSS_W * 0.8, dark));
    }
    // Laid with the span it stands on: `deckSpans` puts the run before the first bent at 0, so the
    // span between bents n-1 and n is n.
    const geo = mergeGeometries(parts, false);
    geo.setAttribute('span', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(n), 1));
    geos.push(geo);
  }
  return geos.length ? mergeGeometries(geos, false) : null;
}

/** The columns, each a footing, a shaft and a hammerhead cap under the girders. */
function buildColumns(plan) {
  const base = KERB_H;
  const capY = DECK_UNDERSIDE - CAP_H / 2;
  const geos = [];
  for (const x of plan.columns) {
    const parts = [];
    // Out over the harbor's sea a column stands in the water, on a footing at the waterline, rather
    // than on ground that is not there.
    const w = plan.world(x);
    const foot = harborLandAt(w.x, w.z) ? base : WATER_Y + 0.25;
    const h = capY - CAP_H / 2 - foot;
    parts.push(box(FOOTING_W, FOOTING_H, FOOTING_W, x, foot + FOOTING_H / 2 - 0.05, 0, PALETTE.ltrainFooting));
    parts.push(box(COLUMN_W, h, COLUMN_W, x, foot + h / 2, 0, PALETTE.ltrainSteel));
    parts.push(box(CAP_W, CAP_H, DECK_HALF_W * 2 - 0.1, x, capY, 0, PALETTE.ltrainSteelDark));
    // Knee braces from the shaft out under each arm of the cap: what makes a T read as a bent
    // carrying weight rather than as a sign post.
    for (const s of [-1, 1]) {
      const z0 = s * COLUMN_W / 2;
      const y0 = capY - CAP_H / 2 - BRACE_DROP;
      const z1 = s * BRACE_REACH;
      const y1 = capY - CAP_H / 2;
      const brace = new THREE.BoxGeometry(0.22, Math.hypot(z1 - z0, y1 - y0), 0.22);
      brace.rotateX(Math.atan2(z1 - z0, y1 - y0));
      brace.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
      parts.push(bakeColor(brace, PALETTE.ltrainSteel));
    }
    const geo = mergeGeometries(parts, false);
    geo.setAttribute('span', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(geos.length), 1));
    geos.push(geo);
  }
  return mergeGeometries(geos, false);
}

/** One train, nose along +x, centred on its own origin, floor at y = 0 (the railhead). */
function buildTrain() {
  const parts = [];
  const half = TRAIN_LEN / 2;
  // Tagged for the cars' paint the train wears (`createLTrain`): the running gear is metal, the
  // glazing glass, everything else paint.
  const box = (w, h, d, x, y, z, color) => setFinish(boxPart(w, h, d, x, y, z, color),
    color === PALETTE.ltrainUnder ? FINISH.METAL : color === PALETTE.ltrainGlass ? FINISH.GLASS : FINISH.PAINT);
  for (let n = 0; n < CARS; n++) {
    const cx = -half + CAR_LEN / 2 + n * (CAR_LEN + CAR_GAP);
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
export function createLTrain(scene, rng, { sparks = null, lights = true, intro = true } = {}) {
  const plan = planLTrain();
  if (!plan) return null;

  // Centred on the median so the city's entrance can grow it as one object from its middle.
  const group = new THREE.Group();
  group.name = 'ltrain';
  group.position.set(plan.x, 0, plan.z);
  // A quarter turn puts local +x on world -z and local +z on world +x (see the top of the file).
  if (plan.axis === 'z') group.rotation.y = Math.PI / 2;
  scene.add(group);

  const material = fadeMaterial(propMaterial());
  if (intro) introMaterial(material);

  const deck = new THREE.Mesh(addIntro(buildDeck(plan)), material);
  deck.castShadow = true;
  deck.receiveShadow = true;
  // The deck is a thin shell 3 units over the road: its slab, ties and rails are each a few tenths
  // thick, which is the bridge deck's acne all over again. Sunk along the sun's rays — free here
  // for the same reason it is on a bridge, since its shadow lands three units down on asphalt.
  sinkShadowCaster(deck);
  group.add(deck);
  if (intro) introDepth(deck.customDepthMaterial);

  // The river truss stays solid: Tyler, 2026-10-13, "don't do any truss fading". It is its own mesh
  // on a plain material so the deck's dither round the taxi and the pins never reaches it — the
  // taxi under it is still found by the ghost outline. It stands over the river, nowhere near the
  // coast, so the coast fade has nothing to do there either.
  const trussGeo = buildTrusses(plan);
  let truss = null;
  if (trussGeo) {
    const trussMaterial = propMaterial();
    if (intro) introMaterial(trussMaterial, { bayer: true });
    truss = new THREE.Mesh(addIntro(trussGeo), trussMaterial);
    truss.name = 'ltrain-truss';
    truss.castShadow = true;
    truss.receiveShadow = true;
    if (intro) truss.customDepthMaterial = introDepth();
    group.add(truss);
  }

  // The columns are not sunk: their shadow starts at their own foot, and sinking it would detach it.
  const columns = new THREE.Mesh(addIntro(buildColumns(plan)), material);
  columns.castShadow = true;
  columns.receiveShadow = true;
  if (intro) columns.customDepthMaterial = introDepth();
  group.add(columns);

  // The train itself wears the cars' paint, on a material of its own carrying the same fade and
  // intro as the deck's; `?vehiclepaint=classic` puts it back on the deck's plain one.
  const trainGeo = addIntro(buildTrain());
  let bodyMaterial = material;
  if (vehiclePaintOn()) {
    // At the cargo box's 0.55 of the paint's reflection, for the cargo box's reason: a long flat
    // side bends to grazing along most of its length, and at full strength the whole train went
    // to a band of sky — a silver streak across the city at play zoom.
    bodyMaterial = fadeMaterial(propMaterial({ gloss: { geometry: trainGeo, amount: 0.55 } }));
    if (intro) introMaterial(bodyMaterial);
  }
  const body = new THREE.Mesh(trainGeo, bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  markOccluder(group);
  if (intro) {
    setOccluderDepthMaterial(deck, introDepth());
    setOccluderDepthMaterial(columns, introDepth());
    if (truss) setOccluderDepthMaterial(truss, introDepth());
  }

  // Lamps on the body, so they ride it and hide with it between runs. Added after `markOccluder`:
  // a lamp has no business in the AO prepass. The pods wear the deck's dither too, so they leave
  // the island and fade over the taxi with the car they are bolted to.
  let lamps = null;
  const beams = [];
  if (lights) {
    lamps = new THREE.Group();
    lamps.name = 'ltrainLamps';
    const heads = new THREE.Mesh(lampPair(HEAD_R, LAMP_X, HEAD_Z),
      fadeMaterial(unlitMaterial({ color: color('headlight') })));
    heads.name = 'ltrainHeadlights';
    const tails = new THREE.Mesh(lampPair(TAIL_R, -LAMP_X, TAIL_Z),
      fadeMaterial(unlitMaterial({ color: color('lightRed') })));
    tails.name = 'ltrainTaillights';
    lamps.add(heads, tails);
    const beamMaterial = coneMaterial();
    beamMaterial.uniforms.uStrength.value = 0;
    for (const s of [-1, 1]) {
      const beam = new THREE.Mesh(coneGeometry(), beamMaterial);
      beam.name = 'ltrainBeam';
      beam.position.set(LAMP_X, LAMP_Y, s * HEAD_Z);
      beam.quaternion.copy(coneQuat(s));
      beam.scale.setScalar(BEAM_SCALE);
      beam.renderOrder = 1;
      beam.frustumCulled = false;
      beams.push(beam);
      lamps.add(beam);
    }
    body.add(lamps);
  }

  // --- The intro ---
  const spans = deckSpans(plan);
  let introT = 1e6;
  let introEnd = 0;
  /**
   * Each bent's and each span's start time, for a wave from `from` (a world `{ x, z }`) on the city
   * entry's levers (`{ wave, grow, overshoot }`, its `tuning()`). Pure, so the probe can read it.
   */
  function introSchedule(from, { wave = 0.015, grow = 0.3 } = {}) {
    const rise = plan.columns.map((x) => {
      const w = plan.world(x);
      return Math.hypot(w.x - from.x, w.z - from.z) * wave;
    });
    // The deck waits on the island's bents only: the ones out past the coast are fading into the
    // haze, and waiting on them would leave a finished row of pillars standing there for no reason.
    const onIsland = (a) => Math.abs(a) < COAST_FROM(Math.sign(a) || 1);
    const island = plan.columns.map((x, k) => (onIsland(x) ? rise[k] : 0));
    const firstDrop = Math.max(...island) + grow + DROP_PAUSE;
    // From the end nearer the taxi. Spans before the first one on the island all come down with it.
    const dir = plan.alongOf(from.x, from.z) <= 0 ? 1 : -1;
    const order = spans.map((_, k) => k).sort((a, b) => dir * (spans[a].from - spans[b].from));
    const firstIsland = order.findIndex((k) => onIsland((spans[k].from + spans[k].to) / 2));
    const drop = new Array(spans.length);
    order.forEach((k, rank) => { drop[k] = firstDrop + SPAN_STAGGER * Math.max(0, rank - firstIsland); });
    const end = Math.max(...drop) + DROP_DUR;
    return { rise, drop, end };
  }
  const writeIntro = (mesh, times, kind, anchor) => {
    const at = mesh.geometry.attributes.aLIntro;
    const idx = mesh.geometry.attributes.span;
    for (let i = 0; i < at.count; i++) {
      const k = idx.getX(i);
      at.setXYZ(i, times[k], kind, anchor ? anchor[k] : 0);
    }
    at.needsUpdate = true;
  };
  const intro_ = intro ? {
    /** Run it from the top, from `from`, on the city entry's levers. */
    start(from, levers = {}) {
      const { rise, drop, end } = introSchedule(from, levers);
      writeIntro(columns, rise, INTRO_KIND.rise, plan.columns);
      writeIntro(deck, drop, INTRO_KIND.drop, null);
      if (truss) writeIntro(truss, drop, INTRO_KIND.drop, null);
      INTRO_UNIFORMS.uLGrow.value = levers.grow ?? 0.3;
      INTRO_UNIFORMS.uLOver.value = levers.overshoot ?? 3.9;
      introT = 0;
      introEnd = end;
      INTRO_UNIFORMS.uLIntroT.value = introT;
    },
    update(dt) {
      if (introT >= introEnd) return;
      introT = Math.min(introEnd, introT + dt);
      INTRO_UNIFORMS.uLIntroT.value = introT;
    },
    /** Land it — shot mode, the title screen. */
    settle() {
      introT = introEnd;
      INTRO_UNIFORMS.uLIntroT.value = 1e6;
    },
    running: () => introT < introEnd,
    schedule: introSchedule,
  } : null;

  // --- Running it ---
  const state = {
    phase: 'wait',
    dir: rng.chance(0.5) ? 1 : -1,
    x: 0,
    t: 0,
    speed: 0,
    wait: rng.range(1, 4),
    /** Bumped once per departure — the hook a rumble or a horn would count. */
    runs: 0,
  };
  const runLength = plan.to - plan.from;
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
    const trackZ = TRACK_OFF;
    body.position.set(state.x, RAIL_TOP, trackZ);
    body.visible = state.phase === 'run';
    if (lamps) lamps.rotation.y = state.dir > 0 ? 0 : Math.PI;
  };

  /**
   * The beams' level, 0..1 — how dark it is where the train is (`main.js` hands it the larger of
   * the running-light level and the night). Faded off the island on the same band the deck is,
   * from the nose's x, since a cone is additive and has no dither to lose it over the sky.
   */
  let beamLevel = 0;
  function setBeams(level) {
    beamLevel = THREE.MathUtils.clamp(level, 0, 1);
    if (!beams.length) return;
    const nose = state.x + state.dir * TRAIN_LEN / 2;
    const keep = 1 - smoothstep01((Math.abs(nose) - COAST_FROM(Math.sign(nose) || 1)) / COAST_BAND);
    beams[0].material.uniforms.uStrength.value = BEAM_STRENGTH * beamLevel * keep;
  }

  function depart() {
    state.phase = 'run';
    state.t = 0;
    state.runs += 1;
  }

  function update(dt) {
    if (state.phase === 'wait') {
      // No train on a line that is still being built.
      if (!intro_?.running()) state.wait -= dt;
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
        state.x = state.dir > 0 ? plan.from + s : plan.to - s;
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
    const onIsland = Math.abs(state.x) < COAST_FROM(Math.sign(state.x));
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
    // The train is symmetric and only ever translated, so a bogie is the same offset along the line
    // whichever way it is running. Yaw is a sim heading: 0 runs +x, and a north-south line's
    // forward (`a` growing) is -z, a quarter turn back.
    const base = plan.axis === 'z' ? Math.PI / 2 : 0;
    const yaw = base + (state.dir > 0 ? 0 : Math.PI);
    const count = rng.int(SPARK_COUNT[0], SPARK_COUNT[1]);
    // Off the camera's side of the truck (local +z, which is +z or +x in the world, both towards a
    // view looking in from +x +z): thrown from under the car on the rail itself, the first cut's
    // sparks were hidden by the body they came out of.
    const side = CAR_W / 2 + 0.05;
    const at = plan.world(state.x + bogieX, TRACK_OFF + side);
    sparks.burst(at.x, RAIL_TOP + 0.08, at.z, yaw, count, state.speed,
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
      if (Math.abs((plan.axis === 'z' ? fx : fz) - plan.c) > reach) continue;
      slots[n++].set(fx, fz, p.strength ?? 1);
    }
    for (; n < FADE_SLOTS; n++) slots[n].set(0, 0, 0);
  }

  /**
   * Shot mode: park a train mid-run level with `target` (the frame's, a world `{ x, z }`) so a
   * still has one in it. The fare loop ticks once and freezes, so anything driven off sim time
   * needs telling (CLAUDE.md).
   */
  function settle(target = { x: 0, z: 0 }) {
    state.phase = 'run';
    const s = THREE.MathUtils.clamp(plan.alongOf(target.x, target.z) - plan.from, 0, runLength);
    // Invert `along` on the cruise segment, which is where any on-island x lands.
    state.t = RAMP + (s - SPEED * RAMP / 2) / SPEED;
    state.x = state.dir > 0 ? plan.from + s : plan.to - s;
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
    /** The lit pods and their beams, or null under `?trainlights=classic`. The pods go in the bloom. */
    lamps,
    setBeams,
    update,
    settle,
    setFadePoints,
    /**
     * The L's own intro (bents rise, then the spans are laid), or null under `?trainintro=classic`,
     * where the entrance wave grows the whole structure from the middle of its median instead.
     */
    intro: intro_,
    entryObjects: intro ? [] : [{ object: group, x: plan.x, z: plan.z, rand: 0.5 }],
    /**
     * Where a rumble would play from: the train's middle while it runs, null while the line is
     * empty. The level is its speed as a share of cruise, so it swells in and out with the ramps.
     */
    emitter: () => (state.phase === 'run'
      ? { ...plan.world(state.x, TRACK_OFF), y: RAIL_TOP, level: state.speed / SPEED }
      : null),
    runTime,
  };
}

/** For the probe: everything the clearance claims rest on, as numbers. */
export const LTRAIN_DIMENSIONS = {
  DECK_TOP, DECK_UNDERSIDE, DECK_HALF_W, TRACK_OFF, RAIL_TOP, TRAIN_LEN, CAR_W, ROOF_TOP,
  COLUMN_W, FOOTING_W, MEDIAN_W, FADE_LIFT, GRID_I, CAP_UNDERSIDE,
};
