import * as THREE from 'three';
import { AO_UNIFORMS } from '../util/geo.js';

/**
 * Screen-space ambient occlusion, in the one form this game can afford on a phone.
 *
 * Not a sampled hemisphere and not a port of three's SSAOPass. Two properties of this project
 * make a much cheaper estimator correct here:
 *
 *   1. **The camera is orthographic.** Depth is linear in view space, so a packed depth value
 *      times `far - near` *is* a distance in world units. No `linearizeDepth`, no perspective
 *      divide, and — the part that matters — a screen offset is a constant world distance
 *      wherever it lands, so the sample radius can be stated in world units and converted with
 *      nothing but the frustum width. (`docs/rendering.md` already records that effects have to
 *      be sized against this camera; here that falls out for free.)
 *   2. **The scene is about ten draw calls.** The expensive half of a normal SSAO prepass is
 *      re-submitting the scene; there is barely a scene to re-submit.
 *
 * The estimator is a **depth Laplacian**, taken as opposed pairs of taps. On any plane, however
 * steeply it recedes from this camera, the two taps of a pair sit an equal distance either side
 * of the centre and cancel *exactly* — which is what lets this run with no normal buffer at all.
 * Only a concave crease leaves the centre farther from the camera than the average of its
 * neighbours. Convex edges go negative and clamp to zero, so this only ever darkens.
 *
 * That also means the taps are **fixed, not jittered**: there is no noise to blur out, so there
 * is no blur pass, and a frozen shot renders the same frame every time. Upsampling from half
 * resolution is done by the hardware's bilinear filter, which is the only softening it needs.
 *
 * Cost on the machines this is for: a half-res depth prepass (~10 draw calls, no colour), one
 * half-res fullscreen pass of 8 taps, and one texture fetch per lit fragment in the main render.
 * The main render still targets the default framebuffer, so MSAA survives untouched and the
 * stencil ghost outlines in `geometry/ghostoutline.js` never see a render target.
 */

/**
 * The layer AO occluders live on. Opt-in rather than opt-out: the depth prepass must contain the
 * solid world and *nothing else*. A translucent marker stamped into it would wear an AO edge of
 * its own, and the sky dome would cost a screen of fill to say "far away".
 *
 * Layer 0 is left exactly as it was, so the main render is unaffected by any of this.
 */
export const AO_LAYER = 1;

// Half resolution. The signal is a soft contact darkening a good few pixels wide; there is
// nothing in it that survives to a single pixel, so full res would be four times the bandwidth
// for a result the bilinear upsample hides anyway.
const RESOLUTION_SCALE = 0.5;

// Sample radii, in world units. The broad ring is what reads as ambient occlusion; the tight one
// puts a darker core in the crease so the contact still reads once the broad ring has been
// softened by the upsample.
//
// 1.0 is not a free choice — see MAX_DEPTH_DIFF below, which has to fit between two numbers this
// radius sets. At play zoom it is about 7.7px, which is the width of the band it draws.
export const RING_BROAD = 1.0;
export const RING_TIGHT = 0.4;

// A 90-degree inner corner peaks at 1.09 x radius for this camera's 33-degree elevation, so a
// falloff a hair above the radius saturates a right angle and leaves shallower creases partial.
export const FALLOFF = 1.15;

// Past this many radii apart, a tap is on the far side of a silhouette rather than across a
// crease, and the pair says nothing about the surface under the centre pixel. The window is
// bounded on *both* sides, which is what fixes RING_BROAD at 1.0 rather than something larger:
//
//   - it has to clear `cot(elevation)` = 1.54, the depth a tap moves through on flat ground, or
//     open road would reject itself and there would be no AO anywhere;
//   - times RING_BROAD it has to stay under `carHeight / sin(elevation)` = 2.93, the depth jump
//     across the roofline of an ambient car, or every car would trail a second shadow up-screen
//     that the sun never cast.
//
// Both bounds fall out of VIEW_DIR, so `tools/probe.mjs` recomputes them from the camera rather
// than trusting these numbers — change the camera's elevation and the window moves.
export const MAX_DEPTH_DIFF = 2.0;

// Where the ink starts and where it saturates, in **world units of departure from flatness across
// one texel**. Both look modes draw off this one ramp — Crayon Mode breaks it up into a stroke and
// Cartoon Mode re-thresholds it into a hard line — so it is deliberately generous at the low end
// and each of them takes what it wants from there. A vertical step of `h` world units reads here at about `0.92 * h`,
// which is the elevation's `1 / (2 sin 33 degrees)`. That one conversion places both ends:
//
//   - **0.15 sits between the road paint and the kerb.** A stop bar is 0.05 units of paint (0.05
//     here) and takes no ink at all, which is right — its edge is not a contact, and inking it
//     sprinkles the open road. A kerb is 0.35 (0.32), and it does take ink, faintly: the line
//     where the pavement meets the tarmac is one of the first things anyone draws in a street.
//   - **0.90 is under everything that should read as a silhouette.** A car's roofline is 1.6 units
//     (1.47), so it saturates. Against the sky one tap lands on the far plane and the term runs to
//     hundreds, with nowhere further to go.
//
// Because the tap is a texel rather than a world radius, a *smooth* surface's contribution shrinks
// as the player zooms in — one texel spans less world — while a *step* keeps registering the same.
// That asymmetry is the whole reason a facet-covered tree canopy stops inking as moss and a
// building's corner does not.
//
// Stated here and interpolated into the shader, so `tools/probe.mjs` asserts the numbers that
// actually run — and recomputes the features from `VIEW_DIR` rather than trusting these, the way
// the rejection window above is checked.
export const EDGE_LOW = 0.15;
export const EDGE_HIGH = 0.90;

// Below one texel the two taps of a pair land on the same sample and the Laplacian is identically
// zero; above the ceiling the eight taps spread into a smudge and stop reading as a contact.
//
// The ceiling is a texel budget, not a world-unit one — held fixed while world-units-per-texel
// keeps growing as the player zooms in, so the *world-space* radius it clamps to grows right along
// with it. A wall standing behind a car cancels its own depth Laplacian far more weakly than flat
// ground does (its depth barely changes per screen unit, where ground's changes at `cot(elevation)`
// — see `MAX_DEPTH_DIFF` below), so once the clamped radius reached far enough up that wall, the
// broad ring's down-tap kept dipping onto the car's roof pixels above where the two should have
// cancelled, and painted a false crease climbing the wall — a shadow the sun never cast, worst at
// `camera.js`'s own `MIN_ZOOM` (14, the closest a player can actually scroll in) on an ordinary,
// non-Retina display. Halving the ceiling keeps that climb inside a couple of pixels rather than a
// car's height.
const MIN_RADIUS_TEXELS = 1.0;
const MAX_RADIUS_TEXELS = 6.0;

/**
 * The prepass's draw list, in enrolment order — every mesh `markOccluder` has taken.
 *
 * Kept as a list rather than left to `scene.overrideMaterial` because an override is
 * all-or-nothing, and one occluder in this game does not hold still: the city's entrance animation
 * lives entirely in a vertex shader (`game/cityentry.js`), so a mesh drawn with the *shared* depth
 * material stands at its finished size in the depth buffer while the colour pass shows it a third
 * grown. The AO texture is sampled in screen space, so what that produced was a contact crease
 * traced around a building that was not there yet, painted onto the bare road under it.
 *
 * Walking the list instead means each mesh can name its own depth material — see
 * `setOccluderDepthMaterial`. It costs two property writes per occluder per frame, on a list
 * measured at 36 entries in an ordinary run — nothing beside the pass it is setting up.
 */
const occluders = new Set();

/** The draw list, for `tools/probe.mjs`. Read it; `markOccluder` is what writes it. */
export function occluderList() {
  return occluders;
}

/**
 * Put `root` and everything under it into the depth prepass.
 *
 * The filter is the rule, not a convenience: **an AO occluder is an opaque, colour-writing mesh.**
 * Everything that fails it would corrupt the prepass rather than contribute to it — the ghost
 * outline's mask writes no colour and its rim is an inflated hull flagged `transparent`, and the
 * prepass swaps a mesh's material out wholesale, which strips both of those flags and lets them
 * stamp depth as if they were the car. The invisible raycast boxes on the taxi and the markers are
 * the same story.
 *
 * The other half of the rule is that anything lit by `propMaterial()` has to be in here. A mesh
 * that *receives* AO without *casting* it samples the occlusion of whatever stands behind it —
 * a rider in front of a building would have that building's contact line painted across them.
 */
export function markOccluder(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const material = object.material;
    if (!material || material.transparent || material.visible === false) return;
    if (material.colorWrite === false) return;
    object.layers.enable(AO_LAYER);
    occluders.add(object);
  });
  return root;
}

/**
 * Take `root` back out again. The draw list holds a hard reference to every mesh in it, so
 * anything that disposes an occluder has to say so — `game/roadwork.js` tears its slab down and
 * builds no replacement, and without this the prepass would go on swapping materials on a mesh
 * whose geometry has been freed.
 */
export function unmarkOccluder(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.layers.disable(AO_LAYER);
    occluders.delete(object);
  });
  return root;
}

/**
 * Give one mesh its own material for the depth prepass, for when the shared one draws the wrong
 * shape — which today means anything whose geometry is computed in its vertex shader.
 *
 * This deliberately does **not** reuse `mesh.customDepthMaterial`, tempting as that is: the two
 * passes want the same patched shader, but three's shadow map *mutates* that material on every
 * frame it renders — `WebGLShadowMap.getDepthMaterial` assigns `result.side` from its `shadowSide`
 * table, which flips a FrontSide material to BackSide. Sharing the instance would leave the AO
 * prepass drawing back faces, i.e. stamping the depth of each building's *far* wall. Two instances
 * carrying the same patch is a second program and no ambiguity.
 *
 * Pass `null` to go back to the shared material.
 */
export function setOccluderDepthMaterial(mesh, material) {
  mesh.userData.aoDepthMaterial = material || null;
  return mesh;
}

const AO_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const AO_FRAGMENT = /* glsl */ `
#include <packing>

uniform sampler2D tDepth;
uniform vec2 uTight;        // uv offset of the tight ring, x and y separately (the frustum is not square)
uniform vec2 uBroad;
uniform vec2 uEdge;         // one texel, for the line — the only offset here that is not a world radius
uniform float uTightWorld;  // the same radii in world units, which is what the thresholds scale off
uniform float uBroadWorld;
uniform float uDepthScale;  // far - near: packed depth [0,1] times this is a world distance
uniform float uStrength;
varying vec2 vUv;

// Declared in JS above and interpolated in, so the numbers the probe asserts against are the
// numbers the shader actually runs.
const float FALLOFF = ${FALLOFF.toFixed(4)};
const float MAX_DEPTH_DIFF = ${MAX_DEPTH_DIFF.toFixed(4)};
const float EDGE_LOW = ${EDGE_LOW.toFixed(4)};
const float EDGE_HIGH = ${EDGE_HIGH.toFixed(4)};

float viewDepth(vec2 uv) {
  return unpackRGBAToDepth(texture2D(tDepth, uv)) * uDepthScale;
}

/** One opposed pair of taps: the depth Laplacian, clamped to its concave half. */
float pair(float z0, vec2 offset, float radius) {
  float a = z0 - viewDepth(vUv + offset);
  float b = z0 - viewDepth(vUv - offset);
  float valid = step(abs(a), radius * MAX_DEPTH_DIFF) * step(abs(b), radius * MAX_DEPTH_DIFF);
  return valid * clamp((a + b) * 0.5 / (radius * FALLOFF), 0.0, 1.0);
}

/**
 * Crayon Mode's line: the same Laplacian, at one texel.
 *
 * **Unsigned, and the sum rather than either tap.** Under this camera flat ground recedes by
 * cot(elevation) = 1.54 world units per unit of radius, so abs(a) on its own is large everywhere
 * and a one-sided test inks the open road solid. a + b is what cancels on any plane however
 * steeply it recedes — the same property the occlusion above is built on — so what survives is
 * silhouettes (one tap on the far plane, enormous), convex arrises (negative, which the occlusion
 * clamp throws away and a drawing wants most of all) and creases.
 *
 * **And it is left in world units rather than divided by the radius.** That is the difference
 * between a pen and a smudge. A depth Laplacian at radius R answers over a band 2R wide, so the
 * occlusion rings — 1.0 and 0.4 *world* units, which is 15px and 6px at the close framing —
 * traced every silhouette in the city with a fifteen-pixel fringe. Read at one texel instead, the
 * band is one texel: about two CSS pixels, at every zoom, which is what a drawn line is. The
 * thresholds then mean a step in world units, so a hard edge inks the same wherever the camera
 * is and a smooth slope inks nowhere, however close it is looked at.
 */
float edgeAt(float z0, vec2 offset) {
  float a = z0 - viewDepth(vUv + offset);
  float b = z0 - viewDepth(vUv - offset);
  return abs(a + b) * 0.5;
}

/** Probabilistic OR. Saturating rather than additive, so a corner does not read twice as dark. */
float either(float a, float b) { return a + b - a * b; }

/**
 * Two answers, sharing one centre tap.
 *
 * r is the occlusion this pass has always produced, and its arithmetic below is byte-for-byte
 * what it was before the second output existed — deliberately, because every contact shadow in
 * the game is that expression. g is the ink both look modes draw with, and nothing read g or b before
 * this: util/geo.js takes .r.
 *
 * The line costs **four extra taps**, not none. Reusing the occlusion's own rings was free and
 * wrong — see edgeAt — and the honest price of a line that is a line is one more pair in each
 * axis at the smallest offset the buffer has. Thirteen fetches on a half-res pass rather than
 * nine, and uEdge is the only offset here stated in *texels* rather than world units.
 */
void main() {
  float z0 = viewDepth(vUv);

  float tight = either(
    pair(z0, vec2(uTight.x, 0.0), uTightWorld),
    pair(z0, vec2(0.0, uTight.y), uTightWorld));

  // The broad ring is turned 45 degrees against the tight one. Two orthogonal pairs are a
  // five-point Laplacian and a crease running exactly along one of their axes is caught by the
  // other pair alone; between the two rings all four screen orientations are covered.
  vec2 d = uBroad * 0.70710678;
  float broad = either(
    pair(z0, vec2(d.x, d.y), uBroadWorld),
    pair(z0, vec2(d.x, -d.y), uBroadWorld));

  // The strongest of the two axes, not their sum: a corner is one edge seen by both, and adding
  // them draws it twice as heavily as the straight run leading into it.
  float edge = max(
    edgeAt(z0, vec2(uEdge.x, 0.0)),
    edgeAt(z0, vec2(0.0, uEdge.y)));

  gl_FragColor = vec4(
    1.0 - uStrength * either(tight, broad),
    smoothstep(EDGE_LOW, EDGE_HIGH, edge),
    1.0,
    1.0);
}
`;

/**
 * @param renderer  the one WebGLRenderer
 * @param enabled   false leaves every method a no-op and allocates nothing. `util/geo.js` decides
 *                  the same thing for the materials, and both read the same URL flag — with AO
 *                  off the shader patch is never installed, so the fetch is absent rather than
 *                  multiplied by one.
 * @param strength  how far occlusion pulls the indirect term down. 1.0 would take a saturated
 *                  crease to black ambient.
 * @param edges     run the pass for the ink channel even with occlusion off.
 * @param depth      run it for the depth buffer alone, which `game/bloom.js` tests its lamps
 *                   against so a brake light behind a building does not bloom through it.
 *
 * The extra flags exist because **Android defaults to `?safe`, which sets `?ao=off`** — so on the
 * platform most likely to be asked for a stylised look, the depth buffer the line is traced out of
 * would not have been built. `?crayon`, `?cartoon` and the bloom all ask for it. One pass with
 * several consumers rather than a prepass each: it is the same nine fetches and the same depth
 * target however many of them are on. With occlusion off the strength uniform is pinned to 0, so
 * `r` comes out a flat 1.0 and a material that somehow read it is unaffected.
 *
 * `depth` is the weakest of the three: it wants the depth target and nothing else, so it does not
 * even need the AO resolve. It gets it anyway — one half-res fullscreen pass, against the
 * bookkeeping of a second code path through `render()` that nothing else would exercise.
 */
export function createAmbientOcclusion(
  renderer, { enabled = true, strength = 0.6, edges = false, depth = false } = {}) {
  // `enabled` stays the answer to "is there occlusion", which is what the ⚙️ panel gates its
  // strength slider on. `active` is the answer to "does the pass run".
  const active = enabled || edges || depth;
  const state = { enabled, edges, depth, strength };

  if (!active) {
    return {
      state,
      render: () => {},
      setStrength: () => {},
      dispose: () => {},
      target: () => null,
      depth: () => null,
      depthSize: () => null,
    };
  }

  // Packed into RGBA8 rather than kept as a depth texture or a half float: 24 bits of depth over
  // a 1399-unit frustum is sub-millimetre, where a half float's ten-bit mantissa would quantise
  // to 0.4 units — coarser than the creases this is looking for. NearestFilter is not optional,
  // because a bilinear blend of two packed depths unpacks to nothing meaningful.
  const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    stencilBuffer: false,
  });
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  // Linear filtering here *is* the blur. A jittered SSAO needs a bilateral pass to hide its noise;
  // fixed taps have none, so the hardware's upsample is the whole of the softening.
  const aoTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const uniforms = {
    tDepth: { value: depthTarget.texture },
    uTight: { value: new THREE.Vector2() },
    uBroad: { value: new THREE.Vector2() },
    uEdge: { value: new THREE.Vector2() },
    uTightWorld: { value: RING_TIGHT },
    uBroadWorld: { value: RING_BROAD },
    uDepthScale: { value: 1 },
    uStrength: { value: enabled ? strength : 0 },
  };

  const aoScene = new THREE.Scene();
  const aoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const aoQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: AO_VERTEX,
      fragmentShader: AO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    }),
  );
  aoQuad.frustumCulled = false;
  aoScene.add(aoQuad);

  AO_UNIFORMS.tAmbientOcclusion.value = aoTarget.texture;

  const drawingBuffer = new THREE.Vector2();
  const clearColor = new THREE.Color();
  let width = 0;
  let height = 0;

  // Swap scratch, reused frame to frame so the pass allocates nothing. `swapped` is a snapshot of
  // the draw list rather than a second walk of the Set: restoring has to touch exactly the meshes
  // that were swapped, in the order their materials were saved.
  const swapped = [];
  const savedMaterials = [];

  /**
   * Sized off the drawing buffer every frame rather than off a resize event. It is two
   * comparisons, and it covers the cases an event does not: a pixel-ratio change on a monitor
   * swap, and shot mode, which never resizes but can be re-rendered through `__taxi.redraw()`
   * after the viewport has moved under it.
   */
  function resizeIfNeeded() {
    renderer.getDrawingBufferSize(drawingBuffer);
    const w = Math.max(1, Math.round(drawingBuffer.x * RESOLUTION_SCALE));
    const h = Math.max(1, Math.round(drawingBuffer.y * RESOLUTION_SCALE));
    if (w === width && h === height) return;
    width = w;
    height = h;
    depthTarget.setSize(w, h);
    aoTarget.setSize(w, h);
    // The lookup is in normalised screen space, so this is the *full* buffer size — the AO
    // texture's own resolution never enters into it.
    AO_UNIFORMS.uAOTexel.value.set(1 / drawingBuffer.x, 1 / drawingBuffer.y);
  }

  /**
   * A world radius as a uv offset. Under an orthographic camera the frustum spans exactly
   * `right - left` world units across the full 0..1 of uv, so this is a division and nothing else
   * — and it re-reads the camera every frame, which is what keeps the AO the same physical size
   * through the wreck close-up and the desktop zoom wheel.
   */
  function ringOffset(camera, radius, out) {
    const spanX = camera.right - camera.left;
    const spanY = camera.top - camera.bottom;
    const minX = MIN_RADIUS_TEXELS / width;
    const minY = MIN_RADIUS_TEXELS / height;
    out.set(
      Math.min(Math.max(radius / spanX, minX), MAX_RADIUS_TEXELS / width),
      Math.min(Math.max(radius / spanY, minY), MAX_RADIUS_TEXELS / height),
    );
    return out;
  }

  return {
    state,

    /** The AO texture, for anything that wants to look at it. */
    target: () => aoTarget.texture,

    /**
     * The half-res packed-depth texture the pass builds on its way to that — the solid world and
     * nothing else, `packDepthToRGBA(gl_FragCoord.z)`, cleared to the far plane.
     *
     * `game/bloom.js` reads it to reject a lamp standing behind a building. Sharing it is what
     * keeps the bloom from needing a depth prepass of its own; the price is that a consumer has to
     * ask for the pass to run at all (`depth` above), and that the buffer is half res, so a test
     * against it is a texel out at a silhouette. Both fine for something that is about to be
     * blurred across sixteen pixels.
     */
    depth: () => depthTarget.texture,

    /** ...and its size in texels, which is what turns a `gl_FragCoord` into a uv for it. */
    depthSize: () => ({ width, height }),

    setStrength(value) {
      state.strength = value;
      // Held at zero when occlusion is off and the pass is only here for the line — the panel
      // disables the slider in that case, but a caller reaching past it shouldn't be able to
      // switch on a term no material was compiled to read.
      uniforms.uStrength.value = enabled ? value : 0;
    },

    /**
     * Refresh the AO texture for this frame. Called immediately before the main render, which is
     * left entirely alone — it still draws to the default framebuffer with its own MSAA and its
     * own stencil buffer.
     */
    render(scene, camera) {
      resizeIfNeeded();

      const savedMask = camera.layers.mask;
      const savedOverride = scene.overrideMaterial;
      const savedShadowAutoUpdate = renderer.shadowMap.autoUpdate;
      const savedAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);

      // The shadow map is a property of the sun, not of this pass — left on, three would rebuild
      // all 2048x2048 of it a second time per frame for a render that never reads it.
      renderer.shadowMap.autoUpdate = false;
      // Cleared, not set: the depth material is chosen per mesh below, and an override left on by
      // anything else would silently outrank every one of those choices.
      scene.overrideMaterial = null;
      camera.layers.set(AO_LAYER);

      // The draw list, swapped onto its depth materials. The layer mask is still what decides who
      // renders; this decides what they render *as*.
      let count = 0;
      for (const mesh of occluders) {
        swapped[count] = mesh;
        savedMaterials[count] = mesh.material;
        mesh.material = mesh.userData.aoDepthMaterial || depthMaterial;
        count += 1;
      }

      // packDepthToRGBA(1.0) is exactly white, so a white clear is the far plane — which is what
      // makes empty sky reject every tap that reaches it instead of creasing against the skyline.
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(depthTarget);
      renderer.render(scene, camera);

      for (let i = 0; i < count; i += 1) {
        swapped[i].material = savedMaterials[i];
        // Dropped rather than left behind: a stale entry here would keep a disposed mesh and its
        // material alive until the next frame overwrote the slot.
        swapped[i] = null;
        savedMaterials[i] = null;
      }

      scene.overrideMaterial = savedOverride;
      camera.layers.mask = savedMask;
      renderer.shadowMap.autoUpdate = savedShadowAutoUpdate;
      renderer.setClearColor(clearColor, savedAlpha);

      ringOffset(camera, RING_TIGHT, uniforms.uTight.value);
      ringOffset(camera, RING_BROAD, uniforms.uBroad.value);
      // One texel of the *half-res* buffer, which is one device pixel of the frame. Not a world
      // radius, and not clamped by the two above: this is a pen nib, and a pen does not get wider
      // because the camera zoomed out.
      uniforms.uEdge.value.set(1 / width, 1 / height);
      uniforms.uDepthScale.value = camera.far - camera.near;

      renderer.setRenderTarget(aoTarget);
      renderer.render(aoScene, aoCamera);
      renderer.setRenderTarget(null);
    },

    dispose() {
      depthTarget.dispose();
      aoTarget.dispose();
      depthMaterial.dispose();
      aoQuad.geometry.dispose();
      aoQuad.material.dispose();
      AO_UNIFORMS.tAmbientOcclusion.value = null;
    },
  };
}
