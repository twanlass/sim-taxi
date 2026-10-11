import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import {
  GRID_I, GRID_J, lineZ, isArterialX, laneOffX, medianRuns, MEDIAN_W,
} from '../city/grid.js';
import { SLAB_X, EDGE_FADE, KERB_H } from '../city/ground.js';
import { VIEW_DIR } from './camera.js';
import { sinkShadowCaster } from './scene.js';
import { markOccluder } from './ssao.js';

// The elevated train (`?ltrain=on`): a Chicago-style L on a steel structure down the east-west
// arterial, with one train shuttling along it.
//
// **Columns on the arterial's planted median, deck over the whole street.** The columns need
// somewhere to stand that no car drives on, and the median is the only such strip that runs the
// width of the city. The deck then cantilevers out over both carriageways on a hammerhead cap, so
// the traffic drives *under* the line rather than beside it.
//
// **High enough to read as high.** The first cut kept the deck low (3.3) and over the median alone,
// on the camera's arithmetic: the view climbs 0.92 per unit in both x and z, so anything `h` tall
// hides about `1.09h` of ground behind it on each axis. That was the right number and the wrong
// answer — at play zoom a low deck beside the lanes projected onto the road as one more strip of
// paving, and it read as a railway cut through the city at street level (Tyler, 2026-10-11). What
// says *raised* from this camera is cars visibly going in under it and a tall shadow-casting column
// with daylight either side, so the deck is at 6.4 and the cost — more ground hidden behind it — is
// paid by the fade below rather than by keeping it low.
//
// **Faded where it covers something that matters.** The taxi already has its ghost outline for
// when a building hides it, but a fare marker does not, and a deck across a rider's kerb is a fare
// the player cannot see. So the structure and the train dither out over whatever it is hiding — see
// `FADE_*` below.
//
// The train is one merged mesh on a straight line, so it moves by translation alone: no curve to
// follow, no per-car transform. It runs off one end of the island, waits, and comes back on the
// other track — a shuttle reads as one train on a line that goes somewhere, which a loop on a
// straight line could not.

// --- The structure ------------------------------------------------------------------------------

/** Top of the deck, where the ties sit. See the camera note above for why it is this high. */
export const DECK_TOP = 6.4;
/** Plate girder depth, so the underside is `DECK_TOP - GIRDER_D`. */
const GIRDER_D = 0.6;
export const DECK_UNDERSIDE = DECK_TOP - GIRDER_D;

/**
 * The two tracks' offsets either side of the median's centreline.
 *
 * Right-hand running, like the traffic under it: an eastbound train is on the +z track, the same
 * side `laneOffsetCoord` puts an eastbound car.
 */
export const TRACK_OFF = 2.2;

/**
 * Half the deck's width, girder face to girder face.
 *
 * Out over the lanes (centred 3.33 off the middle), so a car in either carriageway is under the
 * deck, and short of the kerb (5.33) so the pavement and the fares on it stay open to the sky.
 * Everything under it clears by height instead: the probe holds the cap's underside above the
 * tallest vehicle and the street lamps' arms.
 */
export const DECK_HALF_W = 4.1;

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
const BRACE_REACH = 2.2;
const CAP_H = 0.45;
/** Underside of the hammerhead cap — the lowest thing over a lane. */
export const CAP_UNDERSIDE = DECK_TOP - GIRDER_D - CAP_H;

/**
 * Past the coast, the line keeps going and fades with the ground — a viaduct that stopped dead at
 * the ring road would be a model on a table. Columns stand out there at this pitch.
 */
const OFFSHORE_PITCH = 11;

/** How far off each end of the map the line runs, so a train can vanish into the haze whole. */
const LINE_END = () => SLAB_X / 2 + EDGE_FADE + TRAIN_LEN / 2 + 2;

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
const COAST_FROM = SLAB_X / 2 - 5;
const COAST_BAND = EDGE_FADE * 0.6;

const FADE_UNIFORMS = {
  uLFade: { value: Array.from({ length: FADE_SLOTS }, () => new THREE.Vector3(0, 0, 0)) },
  uLCoast: { value: new THREE.Vector2(COAST_FROM, COAST_BAND) },
  uLRadius: { value: new THREE.Vector3(FADE_IN, FADE_OUT, FADE_FLOOR) },
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
uniform vec2 uLCoast;
uniform vec3 uLRadius;
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
  float edge = clamp((abs(vLWorld.x) - uLCoast.x) / uLCoast.y, 0.0, 1.0);
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
  // nearest bents either side. Out past the ring road it walks off the island on its own pitch.
  const ringFrom = Math.max(...columns.map(Math.abs), 0);
  for (let x = ringFrom + OFFSHORE_PITCH; x < LINE_END(); x += OFFSHORE_PITCH) columns.push(x, -x);
  columns.sort((a, b) => a - b);

  return {
    line,
    z,
    from: -LINE_END(),
    to: LINE_END(),
    columns,
    // Eastbound on +z, westbound on -z: right-hand running, like the cars underneath.
    tracks: { east: z + TRACK_OFF, west: z - TRACK_OFF },
    laneOff: laneOffX(line),
  };
}

// --- Geometry -----------------------------------------------------------------------------------

const box = (w, h, d, x, y, z, color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, color);
};

/** The deck and its track, in the group's frame (centred on the median, so z is across it). */
function buildDeck(plan) {
  const parts = [];
  const len = plan.to - plan.from;
  const mid = (plan.from + plan.to) / 2;
  const steel = PALETTE.ltrainSteel;
  const dark = PALETTE.ltrainSteelDark;

  // Two fascia girders, a stringer under each rail and floor beams across — and **no slab**. An
  // L deck is open steel with ties on it, and from a camera looking down at 33 degrees that is the
  // difference between a structure the traffic is driving under and a roof over the street: through
  // the ties you see the cars, the lane paint and the deck's own striped shadow below.
  for (const s of [-1, 1]) {
    parts.push(box(len, GIRDER_D, GIRDER_W, mid, DECK_TOP - GIRDER_D / 2, s * (DECK_HALF_W - GIRDER_W / 2), steel));
  }
  for (const t of [-TRACK_OFF, TRACK_OFF]) {
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      parts.push(box(len, STRINGER_D, STRINGER_W, mid, DECK_TOP - STRINGER_D / 2, t + r, dark));
    }
  }
  for (let x = plan.from + FLOOR_PITCH / 2; x < plan.to; x += FLOOR_PITCH) {
    parts.push(box(FLOOR_W, FLOOR_D, DECK_HALF_W * 2 - GIRDER_W * 2, x, DECK_TOP - STRINGER_D - FLOOR_D / 2 + 0.02, 0, dark));
  }
  // Stiffeners standing proud of each girder's outer face: the rhythm that makes a long plate read
  // as riveted steel rather than as a grey bar.
  for (let x = plan.from + STIFFENER_PITCH / 2; x < plan.to; x += STIFFENER_PITCH) {
    for (const s of [-1, 1]) {
      parts.push(box(0.12, GIRDER_D, 0.05, x, DECK_TOP - GIRDER_D / 2, s * (DECK_HALF_W + 0.025), dark));
    }
  }
  // The track: open ties and two rails per side.
  for (const t of [-TRACK_OFF, TRACK_OFF]) {
    for (let x = plan.from + TIE_PITCH / 2; x < plan.to; x += TIE_PITCH) {
      parts.push(box(TIE_W, TIE_H, TIE_LEN, x, DECK_TOP + TIE_H / 2, t, PALETTE.ltrainTie));
    }
    for (const r of [-GAUGE / 2, GAUGE / 2]) {
      parts.push(box(len, RAIL_H, RAIL_W, mid, DECK_TOP + TIE_H + RAIL_H / 2, t + r, PALETTE.ltrainRail));
    }
  }
  return mergeGeometries(parts, false);
}

/** The columns, each a footing, a shaft and a hammerhead cap under the girders. */
function buildColumns(plan) {
  const parts = [];
  const base = KERB_H;
  const capY = DECK_UNDERSIDE - CAP_H / 2;
  const shaftH = capY - CAP_H / 2 - base;
  for (const x of plan.columns) {
    parts.push(box(FOOTING_W, FOOTING_H, FOOTING_W, x, base + FOOTING_H / 2 - 0.05, 0, PALETTE.ltrainFooting));
    parts.push(box(COLUMN_W, shaftH, COLUMN_W, x, base + shaftH / 2, 0, PALETTE.ltrainSteel));
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
  }
  return mergeGeometries(parts, false);
}

/** One train, nose along +x, centred on its own origin, floor at y = 0 (the railhead). */
function buildTrain() {
  const parts = [];
  const half = TRAIN_LEN / 2;
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
export function createLTrain(scene, rng) {
  const plan = planLTrain();
  if (!plan) return null;

  // Centred on the median so the city's entrance can grow it as one object from its middle.
  const group = new THREE.Group();
  group.name = 'ltrain';
  group.position.set(0, 0, plan.z);
  scene.add(group);

  const material = fadeMaterial(propMaterial());

  const deck = new THREE.Mesh(buildDeck(plan), material);
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

  const body = new THREE.Mesh(buildTrain(), material);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  markOccluder(group);

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
    const trackZ = state.dir > 0 ? TRACK_OFF : -TRACK_OFF;
    body.position.set(state.x, RAIL_TOP, trackZ);
    body.visible = state.phase === 'run';
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
        state.x = state.dir > 0 ? plan.from + s : plan.to - s;
        state.speed = (along(state.t + 1e-3) - s) / 1e-3;
      }
    }
    place();
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
    const s = THREE.MathUtils.clamp(x - plan.from, 0, runLength);
    // Invert `along` on the cruise segment, which is where any on-island x lands.
    state.t = RAMP + (s - SPEED * RAMP / 2) / SPEED;
    state.x = state.dir > 0 ? plan.from + s : plan.to - s;
    state.speed = SPEED;
    place();
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
      ? { x: state.x, z: plan.z + (state.dir > 0 ? TRACK_OFF : -TRACK_OFF), y: RAIL_TOP, level: state.speed / SPEED }
      : null),
    runTime,
  };
}

/** For the probe: everything the clearance claims rest on, as numbers. */
export const LTRAIN_DIMENSIONS = {
  DECK_TOP, DECK_UNDERSIDE, DECK_HALF_W, TRACK_OFF, RAIL_TOP, TRAIN_LEN, CAR_W, ROOF_TOP,
  COLUMN_W, FOOTING_W, MEDIAN_W, FADE_LIFT, GRID_I, CAP_UNDERSIDE,
};
