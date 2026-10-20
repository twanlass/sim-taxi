import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, setFinish, FINISH, vehiclePaintOn } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { coneGeometry, coneMaterial, coneQuat } from '../geometry/lights.js';
import {
  GRID_I, GRID_J, lineX, lineZ, isArterialX, isArterialZ, laneOffX, laneOffZ, medianRuns, MEDIAN_W,
  LTRAIN_NS, LTRAIN_WEST, MEDIAN_END_GAP, PITCH, HALF_ROAD, halfRoadZ, halfRoadX, WEST_EDGE, WEST_COLUMNS,
  HALF_SPAN_X, HALF_SPAN_Z,
} from '../city/grid.js';
import { EDGE_FADE, KERB_H } from '../city/ground.js';
import { coastWest, coastEast, coastNorth, coastSouth } from '../city/grid.js';
import { WATER_Y } from '../city/river.js';
import { harborLandAt } from '../city/harborplan.js';
import { VIEW_DIR } from './camera.js';
import { sinkShadowCaster } from './scene.js';
import { markOccluder, setOccluderDepthMaterial } from './ssao.js';

// The elevated train (on by default, `?ltrain=classic`): a Chicago-style L on a steel structure, with
// one train shuttling along it. It comes in off the north park down the north-south arterial, turns
// west at the east-west arterial and runs out along that one's median, through the west edge's high
// rises and off the island (Tyler, 2026-10-14: "make a right turn and head out of town through the
// west side high rises. Doesn't make sense fading off into the ocean"). `?ltrainwest=classic` keeps
// the straight north-south line that crossed the river on a truss and ran on to the south shore;
// `?lroute=classic` puts it back on the east-west arterial, beside the river.
//
// **Everything is built along a path.** `a` below is distance along the line, growing towards its
// north end (towards the east on the classic east-west line), and `o` is the offset across it,
// positive on the camera's side. `planLTrain` turns the line into a path of straight pieces and one
// quarter circle (`plan.frame`, `plan.world`, `plan.alongOf`), and every member, bent and car is
// placed off it, so a straight line and one with a corner in it are the same code.
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
// when a building hides it, and that works through the deck too, so the deck stays solid over the
// taxi like a building does. A fare marker has no outline, and a deck across a rider's kerb is a
// fare the player cannot see, so the structure and the train dither out over the pins — see
// `FADE_*` below. (`?trainfade=classic` in main.js adds the taxi back as a fade point.)
//
// The train is four cars, each set on the path by its two trucks, so a car rounds the corner as a
// chord across the curve rather than as a bent box. It runs off one end of the island, waits, and
// comes back the other way — a shuttle reads as one train on a line that goes somewhere.

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
/** The first offshore column's centre, past the ring road's kerb. */
const RING_CLEAR = 0.65;

/**
 * Where the island ends on each side, as a distance from the origin. With the harbor
 * (`?harbor=classic` to drop it) the east coast is out past the piers, with the west edge the west
 * one is out past the high rises, and with the north park the north one is past its wood.
 */
const COAST = {
  west: () => -coastWest(),
  east: () => coastEast(),
  north: () => -coastNorth(),
  south: () => coastSouth(),
};
/** How far off the map an end of the line runs, so a train can vanish into the haze whole. */
const LINE_END = (end) => COAST[end]() + EDGE_FADE + TRAIN_LEN / 2 + 2;

/**
 * The corner's radius when the line has no median to measure it off: the far nose of an ordinary
 * block's island, which is where the bents either side of the curve stand.
 */
const CORNER_R = PITCH - HALF_ROAD - MEDIAN_END_GAP - COLUMN_NOSE;
/** The longest chord a curved member is drawn with. */
const ARC_STEP = 0.9;

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
const LAMP_X = CAR_LEN / 2 + 0.06 - LAMP_D / 2;
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
// `COAST_*` below), so the line dissolves off the island with the asphalt under it. And up to `FADE_SLOTS` points on the ground the player needs to see — the fare pins
// (and the taxi under `?trainfade=classic`) — each projected *up the sightline* to the deck: the part of the deck hiding a point is not
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
const COAST_FROM = (end) => COAST[end]() - 5;
const COAST_BAND = EDGE_FADE * 0.6;

const FADE_UNIFORMS = {
  uLFade: { value: Array.from({ length: FADE_SLOTS }, () => new THREE.Vector3(0, 0, 0)) },
  // All four coasts, as distances from the origin (west, east, north, south): a line with a corner in
  // it leaves the island over two of them, and testing all four costs nothing a line that leaves
  // over the other two can notice.
  uLCoast: { value: new THREE.Vector4(COAST_FROM('west'), COAST_FROM('east'), COAST_FROM('north'), COAST_FROM('south')) },
  uLCoastBand: { value: COAST_BAND },
  uLRadius: { value: new THREE.Vector3(FADE_IN, FADE_OUT, FADE_FLOOR) },
};

/** The coast fade at a world point, as the shader computes it: 1 on the island, 0 gone. */
function coastKeep(x, z) {
  const c = FADE_UNIFORMS.uLCoast.value;
  const past = Math.max(-x - c.x, x - c.y, -z - c.z, z - c.w);
  const e = THREE.MathUtils.clamp(past / COAST_BAND, 0, 1);
  return 1 - e * e * (3 - 2 * e);
}

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
uniform vec4 uLCoast;
uniform float uLCoastBand;
uniform vec3 uLRadius;
${BAYER}`)
      .replace(CLIP_FRAGMENT, `${CLIP_FRAGMENT}
{
  // Off the island: the same smoothstep the ground fades on, past whichever coast is nearest.
  // uLCoast is the west, east, north and south coasts' distances from the origin.
  float past = max(max(-vLWorld.x - uLCoast.x, vLWorld.x - uLCoast.y),
                   max(-vLWorld.z - uLCoast.z, vLWorld.z - uLCoast.w));
  float edge = clamp(past / uLCoastBand, 0.0, 1.0);
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
// for the life of the run. Each vertex carries `aLIntro` = (its start time, its kind, and its bent's
// foot in x and z); the start times are rewritten on `start()`, because they depend on where the
// taxi is.
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
attribute vec4 aLIntro;
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
  // A bent: the city entry's rise, about its own foot. aLIntro.zw is where that foot stands.
  float t = clamp((uLIntroT - aLIntro.x) / uLGrow, 0.0, 1.0);
  float b = t - 1.0;
  float s = 1.0 + (uLOver + 1.0) * b * b * b + uLOver * b * b;
  transformed.y = ${KERB_H.toFixed(4)} + (transformed.y - ${KERB_H.toFixed(4)}) * s;
  float xz = mix(${RISE_XZ_FROM.toFixed(4)}, 1.0, s);
  transformed.xz = aLIntro.zw + (transformed.xz - aLIntro.zw) * xz;
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
  geo.setAttribute('aLIntro', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
  return geo;
}

// --- Plan ---------------------------------------------------------------------------------------

/**
 * A path of straight pieces and circular arcs, laid end to end by `a`. A straight piece starts at
 * (x, z) heading (hx, hz); an arc has its centre, its radius, its angle at `a0` and which way it
 * turns. Off either end the end pieces carry straight on, which only a straight piece can.
 */
function makePath(segs) {
  const segAt = (a) => {
    for (const s of segs) if (a <= s.a1) return s;
    return segs[segs.length - 1];
  };
  function frame(a) {
    const s = segAt(a);
    if (s.kind === 'line') {
      const t = a - s.a0;
      return { x: s.x + s.hx * t, z: s.z + s.hz * t, hx: s.hx, hz: s.hz };
    }
    const phi = s.t0 + s.turn * (a - s.a0) / s.r;
    return {
      x: s.cx + s.r * Math.cos(phi), z: s.cz + s.r * Math.sin(phi),
      hx: -s.turn * Math.sin(phi), hz: s.turn * Math.cos(phi),
    };
  }
  /** World (x, z) of the point `a` along the line and `o` across it, towards the camera. */
  function world(a, o = 0) {
    const f = frame(a);
    // The normal is the heading turned a quarter clockwise seen from above: south off an
    // eastbound piece, east off a northbound one — the camera's side either way.
    return { x: f.x - f.hz * o, z: f.z + f.hx * o };
  }
  /** The heading at `a` as a yaw about +y, the way three turns local +x onto it. */
  const yaw = (a) => {
    const f = frame(a);
    return Math.atan2(-f.hz, f.hx);
  };
  /** The nearest point of the line to (x, z): its `a`, and how far off it is. */
  function nearest(x, z) {
    let best = { a: segs[0].a0, d: Infinity };
    for (const s of segs) {
      let a;
      if (s.kind === 'line') {
        // The two end pieces carry on past the ends of the line, the way `frame` does.
        const lo = s === segs[0] ? -Infinity : 0;
        const hi = s === segs[segs.length - 1] ? Infinity : s.a1 - s.a0;
        const t = THREE.MathUtils.clamp((x - s.x) * s.hx + (z - s.z) * s.hz, lo, hi);
        a = s.a0 + t;
      } else {
        let du = Math.atan2(z - s.cz, x - s.cx) - s.t0;
        du = Math.atan2(Math.sin(du), Math.cos(du)) * s.turn;
        a = s.a0 + THREE.MathUtils.clamp(du, 0, (s.a1 - s.a0) / s.r) * s.r;
      }
      const p = world(a);
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best.d) best = { a, d };
    }
    return best;
  }
  /**
   * The `a` values a lengthwise member from `a0` to `a1` is drawn through: its two ends, every
   * joint between pieces, and chords no longer than `ARC_STEP` round a curve. A straight run is two
   * points, so a straight span is the same box it always was.
   */
  function samples(a0, a1) {
    const out = [a0];
    for (const s of segs) {
      const lo = Math.max(a0, s.a0);
      const hi = Math.min(a1, s.a1);
      if (hi <= lo) continue;
      if (s.kind === 'arc') {
        const n = Math.ceil((hi - lo) / ARC_STEP);
        for (let k = 1; k < n; k++) out.push(lo + (hi - lo) * k / n);
      }
      if (hi < a1) out.push(hi);
    }
    out.push(a1);
    return out.filter((a, k) => k === 0 || a > out[k - 1] + 1e-6);
  }
  /** Is [a0, a1] all on one straight piece? */
  const straight = (a0, a1) => segs.some((s) => s.kind === 'line'
    && a0 >= s.a0 - 1e-6 && a1 <= s.a1 + 1e-6);
  return {
    segs, frame, world, yaw, nearest, samples, straight,
    alongOf: (x, z) => nearest(x, z).a,
  };
}

/**
 * Where the line runs and where its columns stand. Pure: reads the grid, builds nothing, so the
 * probe can sweep it over seeds.
 *
 * Returns null on a city with no arterial to stand it on, which today's layout never builds — but
 * an L with nowhere to stand should be absent rather than wrong.
 *
 * `columns` and `from`/`to` are distances along the line (`a`, see the top of the file).
 */
export function planLTrain() {
  let iz = null;
  let jx = null;
  // Interior lines only: a ring road has no median.
  for (let i = 1; i < GRID_I; i++) if (isArterialZ(i)) { iz = i; break; }
  for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) { jx = j; break; }
  if (LTRAIN_WEST && iz !== null && jx !== null && jx > 0 && jx < GRID_J) return planWest(iz, jx);
  return planStraight(LTRAIN_NS ? iz : jx);
}

/** The straight line the L ran on before it turned: down the north-south arterial, or along the east-west one. */
function planStraight(line) {
  if (line === null) return null;
  const ns = LTRAIN_NS;
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
  const ends = ns ? ['south', 'north'] : ['west', 'east'];
  // The first one stands just past the ring road's far kerb. It used to be OFFSHORE_PITCH on from
  // the last island's nose, which put it 0.65 past that kerb on 8-unit streets — and *on* the kerb
  // once the streets widened (`?streets=`), because the ring road's kerb moves out by more than the
  // last island does. Measured off the kerb, it lands at the same 0.65 on every width.
  const ringFrom = Math.max(...columns.map(Math.abs), 0);
  const ringKerb = ns
    ? HALF_SPAN_Z + Math.max(halfRoadX(0), halfRoadX(GRID_J))
    : HALF_SPAN_X + Math.max(halfRoadZ(0), halfRoadZ(GRID_I));
  const firstOffshore = Math.max(ringFrom + OFFSHORE_PITCH, ringKerb + RING_CLEAR);
  for (const side of [-1, 1]) {
    const end = LINE_END(ends[side < 0 ? 0 : 1]);
    for (let x = firstOffshore; x < end; x += OFFSHORE_PITCH) columns.push(side * x);
  }
  columns.sort((a, b) => a - b);
  const from = -LINE_END(ends[0]);
  const to = LINE_END(ends[1]);
  const path = makePath([ns
    ? { kind: 'line', a0: from, a1: to, x: c, z: -from, hx: 0, hz: -1 }
    : { kind: 'line', a0: from, a1: to, x: from, z: c, hx: 1, hz: 0 }]);
  const focus = path.world(ns ? 0 : 10);
  return {
    ...path,
    route: ns ? 'ns' : 'ew',
    line,
    axis: ns ? 'z' : 'x',
    c,
    // The world point at the median's middle, where the group stands.
    x: ns ? c : 0,
    z: ns ? 0 : c,
    focus,
    // The intro lays the deck from whichever half of the line the taxi is on.
    introMid: 0,
    from,
    to,
    columns,
    laneOff: ns ? laneOffZ(line) : laneOffX(line),
  };
}

/**
 * The line with its corner: in off the north park down the north-south arterial (`iz`), a quarter
 * turn right at the east-west one (`jx`), and out west along its median to the coast.
 *
 * **The corner is a quarter circle across the junction, on no columns of its own.** Nothing can
 * stand in a junction box, where the turning traffic sweeps, so the curve runs from a bent on one
 * leg to a bent on the other. Those are the far noses of the two islands next to the junction —
 * the near noses would stand under the curve, off its centreline — which puts the radius at the
 * island's far nose: 13.65 on an ordinary block, against the train's 5.2-unit cars. That is the
 * ratio of the tightest real L curves (the Loop's, about 90 ft against 48-ft cars), and it keeps
 * each car's ends on the deck: the chord between its trucks bows 0.11 in at the middle and its ends
 * swing 0.13 out, against 0.47 of deck either side of the body. The curve's inner edge comes 0.5
 * over the corner of the block inside it, 6.4 up; that corner is a kerb a rider can stand on, which
 * the deck's fade already looks after.
 *
 * **Out west it keeps the city's rhythm.** The streets past the west ring road are scenery with no
 * islands, but the line pretends they have them: a bent at each nose of where an island would be,
 * so the spacing of the columns does not change where the traffic stops. The first stands just
 * behind the ring road's barricade, which leaves its middle cone out for it (city/westedge.js).
 */
function planWest(iz, jx) {
  const cx = lineX(iz);
  const cz = lineZ(jx);
  // Each leg's islands, as distances from the junction's centre.
  const north = medianRuns().filter((r) => r.axis === 'z' && r.line === iz && r.to < cz)
    .map((r) => ({ near: cz - r.to, far: cz - r.from }));
  const west = medianRuns().filter((r) => r.axis === 'x' && r.line === jx && r.to < cx)
    .map((r) => ({ near: cx - r.to, far: cx - r.from }));
  if (WEST_EDGE) {
    for (let c = 1; c <= WEST_COLUMNS; c++) {
      const east = c === 1 ? lineX(0) - halfRoadZ(0) : lineX(-c + 1) - HALF_ROAD;
      const westEnd = lineX(-c) + HALF_ROAD;
      west.push({ near: cx - east + MEDIAN_END_GAP, far: cx - westEnd - MEDIAN_END_GAP });
    }
  }
  // The radius: the nearer of the two far noses next to the junction.
  const farNose = (runs) => runs.filter((r) => r.near < PITCH).map((r) => r.far - COLUMN_NOSE);
  const noses = [...farNose(north), ...farNose(west)];
  const r = noses.length ? Math.min(...noses) : CORNER_R;
  const bents = (runs) => runs.flatMap((run) => [run.near + COLUMN_NOSE, run.far - COLUMN_NOSE])
    .filter((d) => d >= r - 1e-6);
  const nd = bents(north);
  const wd = bents(west);
  // A park district built over the road next to the junction leaves that leg no island, and the
  // curve would run on into a 34-unit span. The road is lawn there, so a bent stands on it where
  // the curve meets the straight.
  if (!north.some((run) => run.near < PITCH)) nd.push(r);
  if (!west.some((run) => run.near < PITCH)) wd.push(r);
  // On past the last island at the offshore pitch, to where each end runs off into the haze.
  const nEnd = cz + LINE_END('north');
  const wEnd = cx + LINE_END('west');
  // Not before the north ring road's far kerb, for the reason `planStraight` gives.
  const northKerb = cz - (lineZ(0) - halfRoadX(0));
  for (let d = Math.max(Math.max(r, ...nd) + OFFSHORE_PITCH, northKerb + RING_CLEAR); d < nEnd; d += OFFSHORE_PITCH) nd.push(d);
  for (let d = Math.max(r, ...wd) + OFFSHORE_PITCH; d < wEnd; d += OFFSHORE_PITCH) wd.push(d);

  // `a` is 0 at the middle of the curve, negative out along the west leg and positive up the north.
  const half = r * Math.PI / 4;
  const from = -half - (wEnd - r);
  const to = half + (nEnd - r);
  const path = makePath([
    { kind: 'line', a0: from, a1: -half, x: cx - wEnd, z: cz, hx: 1, hz: 0 },
    { kind: 'arc', a0: -half, a1: half, cx: cx - r, cz: cz - r, r, t0: Math.PI / 2, turn: -1 },
    { kind: 'line', a0: half, a1: to, x: cx, z: cz - r, hx: 0, hz: -1 },
  ]);
  const columns = [...wd.map((d) => -half - (d - r)), ...nd.map((d) => half + (d - r))].sort((a, b) => a - b);
  const focus = path.world(0);
  // The middle of the line's island stretch, for the intro to pick which end to lay from.
  const onIsland = columns.filter((a) => {
    const w = path.world(a);
    return coastKeep(w.x, w.z) >= 1;
  });
  return {
    ...path,
    route: 'west',
    line: iz,
    lineX: jx,
    axis: null,
    c: null,
    corner: { x: cx, z: cz, r },
    x: focus.x,
    z: focus.z,
    focus,
    introMid: onIsland.length ? (onIsland[0] + onIsland[onIsland.length - 1]) / 2 : 0,
    from,
    to,
    columns,
    laneOff: Math.min(laneOffZ(iz), laneOffX(jx)),
  };
}

// --- Geometry -----------------------------------------------------------------------------------
//
// Built in world coordinates less the group's own position (`plan.x`, `plan.z`), which stands at
// the line's focus so that `?trainintro=classic` can grow the whole structure from there.

const box = (w, h, d, x, y, z, color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, color);
};
const boxPart = box;

/** A box laid across the line at `a`: `len` along it, `across` over it, centred `o` off it at height `y`. */
function crossBox(plan, a, o, len, h, across, y, colour) {
  const g = new THREE.BoxGeometry(len, h, across);
  g.rotateY(plan.yaw(a));
  const w = plan.world(a, o);
  g.translate(w.x - plan.x, y, w.z - plan.z);
  return bakeColor(g, colour);
}

/**
 * A lengthwise member from `a0` to `a1`: a rectangle `w` across, centred `o` off the line, from `y0`
 * to `y1`, swept along the path. Each section is set off along the line's own normal, which mitres
 * the joints round a curve for free; on a straight it is one section at each end, a plain box.
 *
 * **Every triangle's winding is checked against the face it belongs to**, not written in an order
 * believed to be right (CLAUDE.md: the roadworks ramp and the bridge deck both shipped inside out).
 */
function sweepBox(plan, a0, a1, o, w, y0, y1, colour) {
  const as = plan.samples(a0, a1);
  const rings = as.map((a) => {
    const f = plan.frame(a);
    const pt = (off, y) => {
      const p = plan.world(a, off);
      return new THREE.Vector3(p.x - plan.x, y, p.z - plan.z);
    };
    return {
      v: [pt(o - w / 2, y0), pt(o + w / 2, y0), pt(o + w / 2, y1), pt(o - w / 2, y1)],
      n: new THREE.Vector3(-f.hz, 0, f.hx),
      h: new THREE.Vector3(f.hx, 0, f.hz),
    };
  });
  const pos = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const tri = (p, q, r, out) => {
    e1.subVectors(q, p);
    e2.subVectors(r, p);
    const flip = e1.cross(e2).dot(out) < 0;
    for (const v of flip ? [p, r, q] : [p, q, r]) pos.push(v.x, v.y, v.z);
  };
  const quad = (p, q, r, s, out) => {
    tri(p, q, r, out);
    tri(p, r, s, out);
  };
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k].v;
    const B = rings[k + 1].v;
    const n = rings[k].n.clone().add(rings[k + 1].n);
    quad(A[0], A[1], B[1], B[0], down);
    quad(A[3], A[2], B[2], B[3], up);
    quad(A[0], A[3], B[3], B[0], n.clone().negate());
    quad(A[1], A[2], B[2], B[1], n);
  }
  const first = rings[0];
  const last = rings[rings.length - 1];
  quad(first.v[0], first.v[1], first.v[2], first.v[3], first.h.clone().negate());
  quad(last.v[0], last.v[1], last.v[2], last.v[3], last.h);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return bakeColor(geo, colour);
}

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
 * The deck and its track. One merged geometry, with each vertex's span index in `span`. The
 * lengthwise members — girders, stringers and rails — are cut at every bent, which leaves butt
 * joints over the caps and nothing coplanar overlapping; the cross members go to the span their `a`
 * falls in.
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
  const inSpan = (a) => a >= span.from && a < span.to;
  const steel = PALETTE.ltrainSteel;
  const dark = PALETTE.ltrainSteelDark;
  const run = (o, w, y0, y1, colour) => parts.push(sweepBox(plan, span.from, span.to, o, w, y0, y1, colour));

  // Two fascia girders, a stringer under each rail and floor beams across — and **no slab**. An
  // L deck is open steel with ties on it, and from a camera looking down at 33 degrees that is the
  // difference between a structure and a roof: through the ties you see the median and the deck's
  // own striped shadow below.
  for (const s of [-1, 1]) run(s * (DECK_HALF_W - GIRDER_W / 2), GIRDER_W, DECK_TOP - GIRDER_D, DECK_TOP, steel);
  for (const t of TRACKS) {
    for (const r of [-GAUGE / 2, GAUGE / 2]) run(t + r, STRINGER_W, DECK_TOP - STRINGER_D, DECK_TOP, dark);
  }
  for (let a = plan.from + FLOOR_PITCH / 2; a < plan.to; a += FLOOR_PITCH) {
    if (!inSpan(a)) continue;
    parts.push(crossBox(plan, a, 0, FLOOR_W, FLOOR_D, DECK_HALF_W * 2 - GIRDER_W * 2,
      DECK_TOP - STRINGER_D - FLOOR_D / 2 + 0.02, dark));
  }
  // Stiffeners standing proud of each girder's outer face: the rhythm that makes a long plate read
  // as riveted steel rather than as a grey bar.
  for (let a = plan.from + STIFFENER_PITCH / 2; a < plan.to; a += STIFFENER_PITCH) {
    if (!inSpan(a)) continue;
    for (const s of [-1, 1]) {
      parts.push(crossBox(plan, a, s * (DECK_HALF_W + 0.025), 0.12, GIRDER_D, 0.05, DECK_TOP - GIRDER_D / 2, dark));
    }
  }
  // The track: open ties and two rails per side.
  for (const t of TRACKS) {
    for (let a = plan.from + TIE_PITCH / 2; a < plan.to; a += TIE_PITCH) {
      if (!inSpan(a)) continue;
      parts.push(crossBox(plan, a, t, TIE_W, TIE_H, TIE_LEN, DECK_TOP + TIE_H / 2, PALETTE.ltrainTie));
    }
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      run(t + r, RAIL_W, DECK_TOP + TIE_H, DECK_TOP + TIE_H + RAIL_H, PALETTE.ltrainRail);
    }
  }
  return mergeGeometries(parts, false);
}

// --- The river truss ----------------------------------------------------------------------------
//
// The straight north-south line (`?ltrainwest=classic`) crosses the river, and the river has no
// median: the road bridge under it runs junction to junction, so the bents either side stand 34
// units apart against the 7 to 13 of every other span. A plate girder that long reads as a plank
// balanced on two posts. So any straight span past `TRUSS_FROM` gets a through truss — a Warren
// girder each side, standing up past the train's roof (8.35) and braced across the top — which is
// what a real L does over a river, and which gives the crossing a landmark. Every member stays
// outside the train's half-width (0.88) and above its roof, so the train runs through it untouched.
// The corner is never trussed: a curved truss is not a thing anyone builds, and its 21-unit arc
// reads as a girder bridge over the junction.
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
  // A point `a` along the line, `o` across it, at height `y`, in the group's frame.
  const P = (a, y, o) => {
    const w = plan.world(a, o);
    return [w.x - plan.x, y, w.z - plan.z];
  };
  for (let n = 1; n < plan.columns.length; n++) {
    const a0 = plan.columns[n - 1];
    const a1 = plan.columns[n];
    if (a1 - a0 < TRUSS_FROM || !plan.straight(a0, a1)) continue;
    const parts = [];
    const panels = Math.max(2, Math.round((a1 - a0) / TRUSS_PANEL));
    const step = (a1 - a0) / panels;
    for (const side of [-1, 1]) {
      const z = side * zs;
      // The top chord runs between the first and last panel points; the end posts are inclined.
      parts.push(strut(P(a0, lo, z), P(a0 + step, hi, z), TRUSS_W * 1.3, steel));
      parts.push(strut(P(a1, lo, z), P(a1 - step, hi, z), TRUSS_W * 1.3, steel));
      parts.push(strut(P(a0 + step, hi, z), P(a1 - step, hi, z), TRUSS_W * 1.3, steel));
      for (let k = 1; k < panels - 1; k++) {
        // Warren diagonals: down to the deck and back up, panel by panel, with a vertical at each
        // top panel point.
        const x0 = a0 + k * step;
        const x1 = x0 + step;
        parts.push(strut(P(x0, hi, z), P(x0, lo, z), TRUSS_W * 0.8, dark));
        parts.push(strut(k % 2 ? P(x0, hi, z) : P(x0, lo, z), k % 2 ? P(x1, lo, z) : P(x1, hi, z), TRUSS_W, steel));
      }
    }
    // Lateral bracing over the top: a strut across at each panel point clear of the train's roof.
    for (let k = 1; k < panels; k++) {
      parts.push(strut(P(a0 + k * step, hi, -zs), P(a0 + k * step, hi, zs), TRUSS_W * 0.8, dark));
    }
    // Laid with the span it stands on: `deckSpans` puts the run before the first bent at 0, so the
    // span between bents n-1 and n is n.
    const geo = mergeGeometries(parts, false);
    geo.setAttribute('span', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(n), 1));
    geos.push(geo);
  }
  return geos.length ? mergeGeometries(geos, false) : null;
}

/** The columns, each a footing, a shaft and a hammerhead cap under the girders, turned square to the line. */
function buildColumns(plan) {
  const base = KERB_H;
  const capY = DECK_UNDERSIDE - CAP_H / 2;
  const geos = [];
  for (const a of plan.columns) {
    const parts = [];
    // Out over the harbor's sea a column stands in the water, on a footing at the waterline, rather
    // than on ground that is not there.
    const w = plan.world(a);
    const foot = harborLandAt(w.x, w.z) ? base : WATER_Y + 0.25;
    const h = capY - CAP_H / 2 - foot;
    parts.push(box(FOOTING_W, FOOTING_H, FOOTING_W, 0, foot + FOOTING_H / 2 - 0.05, 0, PALETTE.ltrainFooting));
    parts.push(box(COLUMN_W, h, COLUMN_W, 0, foot + h / 2, 0, PALETTE.ltrainSteel));
    parts.push(box(CAP_W, CAP_H, DECK_HALF_W * 2 - 0.1, 0, capY, 0, PALETTE.ltrainSteelDark));
    // Knee braces from the shaft out under each arm of the cap: what makes a T read as a bent
    // carrying weight rather than as a sign post.
    for (const s of [-1, 1]) {
      const z0 = s * COLUMN_W / 2;
      const y0 = capY - CAP_H / 2 - BRACE_DROP;
      const z1 = s * BRACE_REACH;
      const y1 = capY - CAP_H / 2;
      const brace = new THREE.BoxGeometry(0.22, Math.hypot(z1 - z0, y1 - y0), 0.22);
      brace.rotateX(Math.atan2(z1 - z0, y1 - y0));
      brace.translate(0, (y0 + y1) / 2, (z0 + z1) / 2);
      parts.push(bakeColor(brace, PALETTE.ltrainSteel));
    }
    const geo = mergeGeometries(parts, false);
    geo.rotateY(plan.yaw(a));
    geo.translate(w.x - plan.x, 0, w.z - plan.z);
    geo.setAttribute('span', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(geos.length), 1));
    geos.push(geo);
  }
  return mergeGeometries(geos, false);
}

/** One car, nose along +x, centred on its own origin, floor at y = 0 (the railhead). */
function buildCar() {
  const parts = [];
  // Tagged for the cars' paint the train wears (`createLTrain`): the running gear is metal, the
  // glazing glass, everything else paint.
  const box = (w, h, d, x, y, z, color) => setFinish(boxPart(w, h, d, x, y, z, color),
    color === PALETTE.ltrainUnder ? FINISH.METAL : color === PALETTE.ltrainGlass ? FINISH.GLASS : FINISH.PAINT);
  // Running gear: a dark skirt and a truck at each end.
  parts.push(box(CAR_LEN - 0.8, 0.22, CAR_W - 0.35, 0, 0.19, 0, PALETTE.ltrainUnder));
  for (const e of [-1, 1]) parts.push(box(1.1, 0.3, CAR_W - 0.2, e * BOGIE_AT, 0.15, 0, PALETTE.ltrainUnder));
  // Body, roof and the air-con pod on it.
  parts.push(box(CAR_LEN, BODY_H, CAR_W, 0, 0.3 + BODY_H / 2, 0, PALETTE.ltrainBody));
  parts.push(box(CAR_LEN - 0.3, 0.15, CAR_W - 0.3, 0, 0.3 + BODY_H + 0.075, 0, PALETTE.ltrainRoof));
  parts.push(box(1.4, 0.16, 1.0, 0, 0.3 + BODY_H + 0.15 + 0.08, 0, PALETTE.ltrainRoof));
  // The window band down each side and the stripe under it, standing a hair proud of the body.
  // Sides only: the camera never sees the far side's band, but a train is symmetric and costs
  // eight boxes either way.
  for (const s of [-1, 1]) {
    parts.push(box(CAR_LEN - 0.7, 0.42, 0.04, 0, 0.3 + BODY_H - 0.38, s * (CAR_W / 2 + 0.02), PALETTE.ltrainGlass));
    parts.push(box(CAR_LEN + 0.02, 0.12, 0.03, 0, 0.3 + 0.42, s * (CAR_W / 2 + 0.015), PALETTE.ltrainStripe));
  }
  // An end window at each end of every car — the train shuttles, so either end may be the front.
  for (const e of [-1, 1]) {
    parts.push(box(0.04, 0.5, CAR_W - 0.5, e * (CAR_LEN / 2 + 0.02), 0.3 + BODY_H - 0.4, 0, PALETTE.ltrainGlass));
  }
  return mergeGeometries(parts, false);
}

/**
 * The train alone, off its deck, for the model workshop's bench (src/workshop/catalog.js): the
 * same car geometry and paint `createLTrain` uses, CARS of them nose to tail at CAR_GAP on a
 * straight, without the coast fade or the entrance, which both need the city to mean anything.
 */
export function createTrainMesh() {
  const group = new THREE.Group();
  group.name = 'ltrain';
  const carGeo = buildCar();
  const material = vehiclePaintOn()
    ? propMaterial({ gloss: { geometry: carGeo, amount: 0.55 } })
    : propMaterial();
  for (let n = 0; n < CARS; n++) {
    const car = new THREE.Mesh(carGeo, material);
    car.castShadow = true;
    car.receiveShadow = true;
    car.position.x = (n - (CARS - 1) / 2) * (CAR_LEN + CAR_GAP);
    group.add(car);
  }
  return group;
}

// --- The line -----------------------------------------------------------------------------------

/**
 * Build the L and its train. Returns null where `planLTrain` does.
 *
 * `rng` is a run-seed stream: which way the first train goes and how long the line stands empty
 * is the situation, not the map.
 */
export function createLTrain(scene, rng, { sparks = null, lights = true, intro = true } = {}) {
  const plan = planLTrain();
  if (!plan) return null;

  // Standing at the line's focus, unturned, so the city's entrance can grow it as one object from
  // there (`?trainintro=classic`). Everything in it is built in world coordinates less that.
  const group = new THREE.Group();
  group.name = 'ltrain';
  group.position.set(plan.x, 0, plan.z);
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
  // coast, so the coast fade has nothing to do there either. Only the straight north-south line
  // (`?ltrainwest=classic`) crosses the river; the line that turns west never reaches it.
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

  // The train: four cars on one geometry, each placed by its own two trucks (`place` below).
  const body = new THREE.Group();
  body.name = 'ltrainCars';
  const carGeo = addIntro(buildCar());
  // The cars wear the cars' paint, on a material of their own carrying the same fade and intro as
  // the deck's; `?vehiclepaint=classic` puts them back on the deck's plain one. At the cargo box's
  // 0.55 of the paint's reflection, for the cargo box's reason: a long flat side bends to grazing
  // along most of its length, and at full strength the whole train went to a band of sky.
  let carMaterial = material;
  if (vehiclePaintOn()) {
    carMaterial = fadeMaterial(propMaterial({ gloss: { geometry: carGeo, amount: 0.55 } }));
    if (intro) introMaterial(carMaterial);
  }
  const cars = [];
  for (let n = 0; n < CARS; n++) {
    const car = new THREE.Mesh(carGeo, carMaterial);
    car.castShadow = true;
    car.receiveShadow = true;
    cars.push(car);
    body.add(car);
  }
  group.add(body);

  markOccluder(group);
  if (intro) {
    setOccluderDepthMaterial(deck, introDepth());
    setOccluderDepthMaterial(columns, introDepth());
    if (truss) setOccluderDepthMaterial(truss, introDepth());
  }

  // Lamps on the end cars, set on them every frame by `place`, and hidden with them between runs.
  // Added after `markOccluder`: a lamp has no business in the AO prepass. The pods wear the deck's
  // dither too, so they leave the island and fade over the taxi with the car they are bolted to.
  // The headlights (and their beams) ride the leading car's outer end and the tails the trailing
  // one's; a car is symmetric, so turning a pair half round puts it on the other end.
  let lamps = null;
  let headEnd = null;
  let tailEnd = null;
  const beams = [];
  if (lights) {
    lamps = new THREE.Group();
    lamps.name = 'ltrainLamps';
    headEnd = new THREE.Group();
    tailEnd = new THREE.Group();
    const heads = new THREE.Mesh(lampPair(HEAD_R, LAMP_X, HEAD_Z),
      fadeMaterial(unlitMaterial({ color: color('headlight') })));
    heads.name = 'ltrainHeadlights';
    const tails = new THREE.Mesh(lampPair(TAIL_R, -LAMP_X, TAIL_Z),
      fadeMaterial(unlitMaterial({ color: color('lightRed') })));
    tails.name = 'ltrainTaillights';
    headEnd.add(heads);
    tailEnd.add(tails);
    lamps.add(headEnd, tailEnd);
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
      headEnd.add(beam);
    }
    group.add(lamps);
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
    const onIsland = (a) => {
      const w = plan.world(a);
      return coastKeep(w.x, w.z) >= 1;
    };
    const island = plan.columns.map((x, k) => (onIsland(x) ? rise[k] : 0));
    const firstDrop = Math.max(...island) + grow + DROP_PAUSE;
    // From the end nearer the taxi. Spans before the first one on the island all come down with it.
    const dir = plan.alongOf(from.x, from.z) <= plan.introMid ? 1 : -1;
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
      at.setXYZW(i, times[k], kind, anchor ? anchor[k].x : 0, anchor ? anchor[k].z : 0);
    }
    at.needsUpdate = true;
  };
  // Each bent's foot in the group's frame, which the rise swells about.
  const feet = plan.columns.map((a) => {
    const w = plan.world(a);
    return { x: w.x - plan.x, z: w.z - plan.z };
  });
  const intro_ = intro ? {
    /** Run it from the top, from `from`, on the city entry's levers. */
    start(from, levers = {}) {
      const { rise, drop, end } = introSchedule(from, levers);
      writeIntro(columns, rise, INTRO_KIND.rise, feet);
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

  // Each car stands on the chord between its two trucks, which on a straight is just the line and
  // round the corner is what a real car does: its middle bows in a little and its ends swing out.
  const place = () => {
    const running = state.phase === 'run';
    body.visible = running;
    if (lamps) lamps.visible = running;
    if (!running) return;
    for (let n = 0; n < CARS; n++) {
      const mid = state.x - TRAIN_LEN / 2 + CAR_LEN / 2 + n * (CAR_LEN + CAR_GAP);
      const p0 = plan.world(mid - BOGIE_AT, TRACK_OFF);
      const p1 = plan.world(mid + BOGIE_AT, TRACK_OFF);
      cars[n].position.set((p0.x + p1.x) / 2 - plan.x, RAIL_TOP, (p0.z + p1.z) / 2 - plan.z);
      cars[n].rotation.y = Math.atan2(-(p1.z - p0.z), p1.x - p0.x);
    }
    if (lamps) {
      const lead = cars[state.dir > 0 ? CARS - 1 : 0];
      const trail = cars[state.dir > 0 ? 0 : CARS - 1];
      const flip = state.dir > 0 ? 0 : Math.PI;
      headEnd.position.copy(lead.position);
      headEnd.rotation.y = lead.rotation.y + flip;
      tailEnd.position.copy(trail.position);
      tailEnd.rotation.y = trail.rotation.y + flip;
    }
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
    const nose = plan.world(state.x + state.dir * TRAIN_LEN / 2);
    beams[0].material.uniforms.uStrength.value = BEAM_STRENGTH * beamLevel * coastKeep(nose.x, nose.z);
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
    const mid = plan.world(state.x);
    const onIsland = coastKeep(mid.x, mid.z) >= 1;
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
    // running. Yaw is a sim heading: 0 runs +x, and the line's own at that bogie (`a` growing) is
    // turned half round when the train runs the other way.
    const yaw = plan.yaw(state.x + bogieX) + (state.dir > 0 ? 0 : Math.PI);
    const count = rng.int(SPARK_COUNT[0], SPARK_COUNT[1]);
    // Off the camera's side of the truck (local +z, which is +z or +x in the world, both towards a
    // view looking in from +x +z): thrown from under the car on the rail itself, the first cut's
    // sparks were hidden by the body they came out of.
    const side = CAR_W / 2 + 0.05;
    const at = plan.world(state.x + bogieX, TRACK_OFF + side);
    // The shower was gated on the train's middle, and its bogies and its later pulses run on past
    // that: on wider streets (`?streets=`) the line is longer and a pulse landed 4 units out over
    // the north coast's fade. The pulse that would land off the island is dropped.
    if (coastKeep(at.x, at.z) < 1) return;
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
      if (plan.nearest(fx, fz).d > reach) continue;
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
    cars,
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
  COLUMN_W, FOOTING_W, MEDIAN_W, FADE_LIFT, GRID_I, CAP_UNDERSIDE, CAR_LEN,
};
