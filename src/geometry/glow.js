import * as THREE from 'three';
import { BILLBOARD, VIEW_DIR } from '../game/camera.js';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { lightPodAnchor } from './lights.js';

/**
 * Bokeh glow — a soft additive disc over every self-lit thing in the game: a car's brake pods and
 * blinkers, the drive-through's lit windows, the depot's strip light, a cruiser's light bar.
 *
 * **It is not a bloom pass, and it deliberately is not one.** The argument `docs/rendering.md`
 * makes against an `EffectComposer` has not moved: the frame's MSAA and the stencil buffer the
 * ghost outlines stamp into (`geometry/ghostoutline.js`) both live in the default framebuffer, and
 * routing the city through a render target to blur-and-composite it back costs both. A real bloom
 * would also have nothing to work with — this game has no HDR anywhere in it. Every emissive
 * surface here is a `MeshBasicMaterial` or a Lambert with `emissiveIntensity` a shade over 1, so a
 * bright-pass threshold would find either nothing or the whole sky, depending on where it was put.
 *
 * So the glow is *authored* rather than extracted: each light says how big its halo is, and the
 * halo is one camera-facing quad drawn additively. The same answer the helicopter's beacon already
 * reached on its own (`geometry/helicopter.js` builds a `halo` mesh around its `lamp` for exactly
 * this reason) — this generalises it, and collapses every one of them into a single draw call.
 *
 * Two properties of this camera are what make that cheap enough to be the *right* answer rather
 * than a shortcut:
 *
 *   1. **It never rotates.** Facing the camera is a constant quaternion (`BILLBOARD`), not a
 *      per-frame lookAt, so a halo costs a matrix compose and nothing else.
 *   2. **It is orthographic.** A world-unit radius is the same number of pixels wherever the halo
 *      lands, so "how big is this glow" is answerable once and stays answered as the player pans.
 *
 * Everything is in **one InstancedMesh with one material**, written immediate-mode: emitters call
 * `add()` while the frame updates and `commit()` uploads whatever landed. That is the same
 * one-mesh-one-material habit `bakeColor()` gives the city, arrived at from the other end.
 */

// --- What a halo is made of ------------------------------------------------------------------

/**
 * How far a halo is pushed **toward the camera**, in world units, from the light it belongs to.
 *
 * Without it a halo is eaten by its own vehicle. The quad lies in the screen plane, so every pixel
 * of it sits at the light's own view-space depth — and two points that land on the *same screen
 * pixel* under this orthographic camera differ by a multiple of `VIEW_DIR`, so a world unit of
 * height between them is `1 / VIEW_DIR.y` = 1.83 units of depth. A brake pod at `LIGHT_Y` = 0.87
 * therefore has its own car's roofline (2.07) standing 2.20 units in front of it, directly
 * up-screen of the pod on any car driving away from the camera. Depth-tested flush, the top of
 * every brake halo is clipped off against the boot lid.
 *
 2.4 clears that with margin, and it buys the other half of the same problem for free: it also
 * lets a halo hang 2.4 * 0.545 = 1.3 units *below* the road before the tarmac in front of it starts
 * cutting a chord across the disc. A pod halo at radius 1.1 drops 0.92 of a unit — so the disc
 * clears the road too, and with room to spare.
 *
 * Both numbers are recomputed in `tools/probe.mjs` from `VIEW_DIR` and the car mesh's own bounding
 * box rather than trusted here. That is not ceremony: the first cut of this shipped at 1.6 against
 * a roofline that actually needs 2.20, so every brake halo in the game had its top bitten off by
 * the boot lid it was sitting under — and there is no way to see a depth number in a screenshot,
 * only a halo that looks a bit lopsided.
 *
 * What it must not do is reach past something genuinely in front, and at this size it cannot: a
 * building standing between the camera and a car is a whole block toward the camera, which is
 * twelve units of depth, not two.
 *
 * **A box truck needs its own number**, and this is the same lesson as the one about `LANE` meaning
 * two things: the constant is a vehicle's roofline, and a vehicle's roofline is not one number. A
 * truck's cargo box tops out at 3.50 against a car's 2.07, which is 4.82 units of clearance — so
 * on the car's standoff the box bites a flat chord out of the top of every truck's brake halo.
 * Raising the shared number to cover it would push every car's halo two and a half units further
 * forward for nothing, which is where shining through the near corner of a low building starts to
 * become possible. Two numbers, each measured against the mesh it belongs to.
 *
 * The taxi takes the car's, and its roof sign is deliberately not cleared: it is one narrow box on
 * the centreline, so what it costs is a nick out of one side of one halo, and covering it would
 * mean 6.17.
 *
 * **This is the vehicle number, and only vehicles want it.** A light fixed to a building is mounted
 * on the surface that ought to occlude it, and 1.6 is more than enough to step *through* that
 * surface: the depot's strip light hangs 1.3 units back inside its bay, which is 0.77 units of
 * depth behind the shutter, so a standoff of 1.6 would shine the bay out through a closed door.
 * A light fixed to a building therefore stands off by 0 and lets the geometry decide, which is
 * also what makes the
 * bay light come on as the shutter rises without anyone having to animate it.
 */
export const GLOW_STANDOFF = 2.4;

/** ...and the box truck's, off its cargo box rather than its cab. See GLOW_STANDOFF. */
export const TRUCK_GLOW_STANDOFF = 4.9;

/** A car's brake or indicator pod. Two pods to a light, so this is per *pod*, not per lamp. */
export const POD_GLOW_R = 1.1;

/**
 * Where the halos land in the transparent queue.
 *
 * **Zero, under everything** — the existing ladder is the crayon page 1, skid marks 2, dust 3, the
 * route band 4, the drag handle 5, flames 6, the fare rings 7-9. A halo is part of the *picture*
 * and not a read-out, so the crayon page washes over it exactly as it washes over the city
 * (`game/crayon.js`), and no fare's timer ring is ever tinted by a passing indicator.
 *
 * Order costs nothing to give away here: additive blending is commutative and the pass writes no
 * depth, so where these sort among themselves cannot change a pixel.
 */
export const GLOW_ORDER = 0;

/**
 * Instances the field can hold.
 *
 * The fleet is the ceiling and it is a known one: six pods to a vehicle (two brake, two per
 * indicating side) against the ⚙️ panel's 40-car top is 240, plus the taxi's six, the cruiser's two
 * and a handful of scenery lights. 512 is double the worst case anyone can dial up, at
 * 4 vertices and 3 floats of colour an instance — 30KB of buffer for headroom nobody has to think
 * about again. Beyond it `add()` drops the halo rather than growing: a missing glow is a missing
 * glow, and reallocating a buffer mid-frame is a hitch.
 */
export const GLOW_CAPACITY = 512;

/** Live tuning — every number here is a judgement about a whole frame. See the ⚙️ panel. */
export const GLOW_DEFAULTS = {
  // A multiplier on every radius, so the whole effect can be pushed and pulled with one hand
  // without renegotiating what a brake light is worth against a shopfront.
  size: 1,
  // Peak alpha at the centre of a halo, and the number that was wrong first. At 1 a brake light's
  // core lands on grey tarmac at roughly (1.0, 0.89, 0.84) once the road under it is added in —
  // which is a *white* core, not a red one, and at 1.1 units of radius that white ball is wider
  // than the car wearing it. The blend saturates long before the alpha does, so the useful range
  // is well under 1: 0.6 keeps the hue in the middle of the halo and lets the white come back on
  // its own where two lamps overlap, which is where a real lens actually blooms out.
  gain: 0.6,
  // The bloom skirt's exponent. Low is a wide soft wash, high is a tight point. At 3.4 the halo is
  // down to a tenth of its peak halfway out, so the ramp lands inside the radius instead of piling
  // up against the rim — which is the same mistake as fading a cloud on `dot(normal, view)`
  // (geometry/cloud.js): a profile that spends its whole range in the last tenth reads as a hard
  // edge, not as soft.
  falloff: 3.4,
  // How much of a bokeh disc is mixed into that skirt — a flat plateau with a defined rim, the way
  // an out-of-focus highlight resolves. Small, and it has to be: the plateau is *flat*, so this is
  // very nearly an alpha floor across the whole disc, and 0.35 of one is a sticker with a soft
  // edge. At 0.1 it does the one thing it is here for — it puts a definite edge on the halo, which
  // is what says lens rather than airbrush — without lifting the middle of it.
  bokeh: 0.1,
};

/** How wide the bokeh disc's rim is, as a fraction of the radius. Fixed: it is what makes a disc
 *  a disc, and a slider on it only ever turns the disc back into the skirt beside it. Over half
 *  the radius, so what it contributes is mostly ramp — a narrow rim on a flat plateau is the
 *  sticker the `bokeh` default above had to be pulled back from. */
const BOKEH_RIM = 0.55;

const BRAKE_GLOW = color('lightRed');
const SIGNAL_GLOW = color('turnSignal');

// --- The material ------------------------------------------------------------------------------

const glsl = (n) => n.toFixed(4);

/**
 * The halo's falloff, patched into an ordinary `MeshBasicMaterial`.
 *
 * A patch rather than a `ShaderMaterial` because instancing is the whole point: three's
 * `USE_INSTANCING_COLOR` path is what carries a per-instance hue *and* its brightness in one
 * attribute, and re-deriving that by hand is how a raw shader loses it. (Brightness rides in the
 * colour because `instanceColor` is RGB only and there is no per-instance alpha without a custom
 * attribute — see the note in `sim/traffic.js`. Under additive blending that is not a compromise:
 * dimming an additive light *is* multiplying its colour, so the level folds in exactly.)
 *
 * A texture would have done the falloff too. It is analytic instead because the profile is the one
 * thing being judged here — a baked sprite has to be re-baked to answer "is this too tight", and
 * the ⚙️ panel's whole job is to answer that with the game running.
 */
function patchGlow(material) {
  // Three builds the program cache key from the material's parameters, *before* `onBeforeCompile`
  // runs, so a patched basic material collides with every unpatched one sharing those parameters
  // and `acquireProgram` hands back whichever compiled first. This project is full of unpatched
  // `MeshBasicMaterial`s (`unlitMaterial()`), which is precisely the collision that once drew the
  // diamond's fill with a building's shader. See CLAUDE.md.
  material.customProgramCacheKey = () => 'glow';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, GLOW_UNIFORMS);

    // The quad's own local XY, in [-1, 1]. Taken from `position` rather than from a uv, because a
    // `MeshBasicMaterial` with no map compiles without `USE_UV` at all and `vUv` does not exist.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGlowXY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlowXY = position.xy * 2.0;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vGlowXY;
uniform float uGlowGain;
uniform float uGlowFalloff;
uniform float uGlowBokeh;`)
      // After `<color_fragment>`, which is where `instanceColor` has just multiplied the hue and
      // its level into `diffuseColor`. The falloff is alpha, and alpha is the additive blend's
      // source factor, so this scales the light's contribution and nothing else.
      .replace('#include <color_fragment>', `#include <color_fragment>
\tfloat gd = 1.0 - min(length(vGlowXY), 1.0);
\tfloat skirt = pow(gd, uGlowFalloff);
\tfloat disc = smoothstep(0.0, ${glsl(BOKEH_RIM)}, gd);
\tdiffuseColor.a *= min(mix(skirt, disc, uGlowBokeh) * uGlowGain, 1.0);`);
  };
}

/** The bag the patch reads, written by `set()` below. One set of numbers for every halo. */
export const GLOW_UNIFORMS = {
  uGlowGain: { value: GLOW_DEFAULTS.gain },
  uGlowFalloff: { value: GLOW_DEFAULTS.falloff },
  uGlowBokeh: { value: GLOW_DEFAULTS.bokeh },
};

export function glowMaterial() {
  // Through the helper, like every other unlit material in the game — and here the `fog: false` it
  // carries is load-bearing rather than a house rule. Three's fog mixes the fragment *toward* the
  // fog colour; an additive pass mixing toward a pale sky adds a grey square to the frame wherever
  // a quad's alpha survives it, which is the whole quad.
  const material = unlitMaterial({
    color: 0xffffff,           // the hue is the instance's; this is the identity it multiplies
    transparent: true,         // for the queue, not for the blend — see `blending`
    blending: THREE.AdditiveBlending,
    // A light does not hide what is behind it, and two halos over one car must not fight.
    depthWrite: false,
  });
  patchGlow(material);
  return material;
}

// --- The field ---------------------------------------------------------------------------------

/**
 * A slot range one emitter owns, and the whole of the field's bookkeeping.
 *
 * The obvious design here — one immediate-mode stream, rewound at the top of the frame and sealed
 * before the render — was written first and was wrong, in the way this project keeps finding:
 * **the sim does not tick once per render.** `traffic.warmup()` runs twelve seconds of city before
 * the first frame, shot mode auto-plays whole fares between one render and the next, and the
 * opening vignette steps the world on its own. Every one of those rounds emitted a full set of
 * halos into a stream that only a render would rewind, so a screenshot came back with the cursor
 * pinned at capacity and five hundred stale halos in it — lights standing in the road over cars
 * that had driven away minutes of sim time ago. Same family as the frozen `settle()` traps in
 * CLAUDE.md, and it does not show up in the live loop at all.
 *
 * A lane fixes it by *owning* its slots rather than queueing for them: `begin()` rewinds only this
 * emitter's own cursor, so re-emitting is idempotent however many times a tick runs between two
 * frames, and no emitter can be clobbered by one that happens to run before it. There is no frame
 * boundary to get wrong because there is no shared cursor to rewind.
 */
function createLane(field, base, size) {
  let cursor = 0;
  // How far the lane reached last round, so `end()` only has to blank what has actually gone dark
  // rather than sweeping its whole capacity: a lane sized for forty cars is mostly empty most of
  // the time, and clearing 240 slots a frame to retire one indicator is work for nothing.
  let high = 0;

  return {
    begin() { cursor = 0; },
    add(x, y, z, radius, hue, level, standoff = GLOW_STANDOFF) {
      if (level <= 0 || cursor >= size) return;
      field.write(base + cursor, x, y, z, radius, hue, level, standoff);
      cursor += 1;
    },
    end() {
      for (let i = cursor; i < high; i++) field.blank(base + i);
      high = cursor;
      field.uploaded();
    },
  };
}

const NO_LANE = { begin: () => {}, add: () => {}, end: () => {} };

const NO_FIELD = {
  enabled: false,
  mesh: null,
  lane: () => NO_LANE,
  state: { enabled: false, ...GLOW_DEFAULTS },
  set: () => {},
};

let enabled = false;
let field = null;

/**
 * On or off, decided once from `?glow` before anything is built. A flag rather than a live toggle
 * for the ordinary reason: with it off there is no mesh, no material and no program, and the
 * emitters dotted through `sim/` compile down to a branch on a frozen boolean.
 */
export function setGlow(on) {
  enabled = Boolean(on);
}

/**
 * The one field, shared by everything that emits into it.
 *
 * A module-level singleton, the way `cityNetwork()` is one, and for the same reason: the emitters
 * are in `sim/traffic.js` and `sim/police.js`, which may not import from `game/`, and threading a
 * handle down through every constructor in between to reach them buys nothing. With the flag off
 * this hands back an inert stub, so the headless tools — which build traffic and police cars by the
 * thousand — never allocate one.
 */
export function glowField() {
  if (!enabled) return NO_FIELD;
  if (!field) field = createGlowField();
  return field;
}

/** For `tools/probe.mjs`, which builds more than one city in a process. */
export function resetGlowField() {
  field = null;
}

const pos = new THREE.Vector3();
const scale = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const tint = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function createGlowField(capacity = GLOW_CAPACITY) {
  const state = { enabled: true, ...GLOW_DEFAULTS };

  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMaterial(), capacity);
  mesh.name = 'glow';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = GLOW_ORDER;
  mesh.count = 0;
  // An InstancedMesh computes its bounding sphere once, from the matrices as they stood on the
  // first frame it was culled, and never again — the trap the ambient trucks paid for. This one
  // moves every frame and half of it is collapsed to nothing at any moment, so it can never be
  // culled at all. See CLAUDE.md.
  mesh.frustumCulled = false;

  let taken = 0;

  return {
    enabled: true,
    mesh,
    state,

    /**
     * Reserve `size` slots for one emitter, once, at construction. See `createLane`.
     *
     * Slots are never handed back: an emitter that exists is an emitter that will be drawing again
     * next frame. A request past the end of the buffer is clamped rather than grown — reallocating
     * an instanced buffer mid-run is a hitch, and the ceiling is a known one (see GLOW_CAPACITY),
     * so a lane that gets clamped is a sign the ceiling moved rather than a case to handle.
     */
    lane(size) {
      const base = taken;
      const room = Math.max(0, Math.min(size, capacity - base));
      taken += room;
      // Collapse the whole range up front. Three initialises every instance matrix to the
      // **identity**, not to zeros, so a slot nobody has written yet is a full-size halo standing
      // at the world origin — 72 of them stacked on one another in the middle of the map, which is
      // what `tools/probe.mjs` caught. A lane only ever blanks back to its own high-water mark, so
      // slots past the busiest round it has ever had are never reached any other way.
      for (let i = base; i < base + room; i++) this.blank(i);
      this.uploaded();
      // `count` covers every slot ever allocated, and it stays there. The unused ones are collapsed
      // to a zero scale, which is four degenerate vertices and not one fragment — far cheaper than
      // keeping a live high-water mark across lanes that fill and empty independently.
      mesh.count = taken;
      return room > 0 ? createLane(this, base, room) : NO_LANE;
    },

    /** @private — a lane's write. */
    write(slot, x, y, z, radius, hue, level, standoff) {
      pos.set(x, y, z).addScaledVector(VIEW_DIR, standoff);
      scale.setScalar(radius * state.size * 2);
      matrix.compose(pos, BILLBOARD, scale);
      mesh.setMatrixAt(slot, matrix);
      tint.copy(hue).multiplyScalar(level);
      mesh.setColorAt(slot, tint);
    },

    /** @private — a lane retiring a slot. Collapsed rather than blacked out: a zero-scale quad
     *  costs four degenerate vertices, where a black one still rasterises its whole disc. */
    blank(slot) {
      mesh.setMatrixAt(slot, ZERO);
    },

    /** @private — a lane has finished writing. */
    uploaded() {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    },

    /** Live tuning — the ⚙️ panel, and `window.__taxi.glow`. */
    set(key, value) {
      if (!(key in state)) return;
      state[key] = value;
      if (key === 'gain') GLOW_UNIFORMS.uGlowGain.value = value;
      else if (key === 'falloff') GLOW_UNIFORMS.uGlowFalloff.value = value;
      else if (key === 'bokeh') GLOW_UNIFORMS.uGlowBokeh.value = value;
      // `size` is read by `write()` on the next round — nothing to push.
    },

    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

// --- Vehicle halos -----------------------------------------------------------------------------

const anchor = new THREE.Vector3();

/**
 * One halo per lit pod, from a vehicle's world matrix and the three light levels `sim/traffic.js`
 * already computes for every car it draws.
 *
 * Here rather than in `sim/traffic.js` so the ambient fleet, the player's taxi and anything else
 * wearing `geometry/lights.js` pods all glow the same way — the same argument that put the pods
 * themselves in a shared module.
 *
 * The anchor is scaled by the level before it is transformed, and that is not a flourish: a pod is
 * lit by *scaling the mesh* (`instanceColor` is paint and cannot carry an on/off), so a half-lit
 * pod has physically collapsed halfway back toward the car's own origin. Multiplying the anchor by
 * the same level puts the halo on the pod as drawn rather than on the pod at full brightness.
 *
 * @param matrix  the vehicle's world matrix, including whatever scale it carries — the taxi's
 *                mesh is `TAXI_SCALE` bigger than `CAR_LEN` says (see CLAUDE.md), and going
 *                through the matrix is what keeps that from having to be remembered here.
 */
export function emitVehicleGlow(lane, vehicle, len, width, brake, left, right,
  standoff = GLOW_STANDOFF) {
  if (brake > 0) {
    emitPod(lane, vehicle, -1, -1, len, width, brake, BRAKE_GLOW, standoff);
    emitPod(lane, vehicle, -1, 1, len, width, brake, BRAKE_GLOW, standoff);
  }
  for (const [level, side] of [[left, -1], [right, 1]]) {
    if (level <= 0) continue;
    emitPod(lane, vehicle, 1, side, len, width, level, SIGNAL_GLOW, standoff);
    emitPod(lane, vehicle, -1, side, len, width, level, SIGNAL_GLOW, standoff);
  }
}

/** Slots one vehicle can take: two brake pods and two per indicating side. */
export const VEHICLE_GLOW_SLOTS = 6;

function emitPod(lane, vehicle, sx, sz, len, width, level, hue, standoff) {
  lightPodAnchor(sx, sz, len, width, anchor).multiplyScalar(level).applyMatrix4(vehicle);
  lane.add(anchor.x, anchor.y, anchor.z, POD_GLOW_R, hue, level, standoff);
}
