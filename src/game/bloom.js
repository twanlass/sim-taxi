import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';

/**
 * Bloom, out of an emissive-only pass rather than out of the frame.
 *
 * The lamps in this game — brake pods, indicators, a cruiser's light bar, the drive-through's lit
 * windows, the depot's strip light — are a handful of pixels each, and what they are missing is
 * the spill a real lens puts around a bright source. This draws that spill.
 *
 * **It is not a bright-pass over the finished frame, and it cannot be.** Measured on a shipped
 * frame at golden hour: ordinary sunlit surfaces top out around 0.78, the lamps sit at 1.0, and so
 * do the fare ring, the route band and the taxi's roof sign. So a luminance threshold picks the
 * read-outs out along with the lights — and a fare's ring is a clock, not decoration — while
 * `game/daylight.js` swings `sun.intensity` from 0 to 3.84 over a day and walks every other
 * surface up and down underneath whatever threshold you picked. There is no number that separates
 * a brake light from a white kerb stripe at noon.
 *
 * So selection is **explicit**, the way `markOccluder()` already is for the AO prepass: a mesh is
 * in the bloom because something called `markEmissive()` on it. That is also what makes the pass
 * cheap — every emissive thing in this game is already its own mesh (the light pods have to be, so
 * they can be switched by scale; the lamps have to be, so they can be unlit) — so the pass is a
 * dozen draw calls at half resolution with no material surgery anywhere.
 *
 * ### Why this and not an EffectComposer
 *
 * The [no-composer argument](../../docs/rendering.md) is unchanged — the frame's MSAA and the
 * stencil buffer the ghost outlines stamp into both live in the default framebuffer — but for
 * bloom specifically there is a second and larger reason. A composer implies HDR, HDR implies tone
 * mapping, and tone mapping means re-judging every colour in `palette.js`, the sky dome's
 * gradient, `hazeColor()` and the shadow tint, all of which were picked against `NoToneMapping`.
 * It also moves the sRGB encode out of the materials and into an output pass, which breaks Crayon
 * and Cartoon Mode outright: both deliberately mix their ink **in display space**, after
 * `<colorspace_fragment>` has run.
 *
 * `game/hdr.js` is that route, behind `?hdr`, so the two can be looked at side by side. This one
 * keeps the main render exactly where it is: the spill is composited as one more **object in the
 * scene**, the same trick `game/crayon.js` uses for its page, so the frame never enters a target.
 *
 * ### The HDR that is worth having
 *
 * All of it, and only, in the emissive target: half-float, and a lamp writes its own colour times
 * an intensity well over 1. That is what gives the spill a shape — a core that whitens where two
 * lamps overlap, and a skirt that falls off rather than a flat disc — without a byte of float
 * anywhere near the main frame. About 1.3MB of buffer at DPR 2 on a phone, against the ~10.7MB an
 * RGBA16F frame would cost on a budget `game/recovery.js` exists to climb *down* from.
 */

/**
 * The layer emissive meshes live on. Layer 0 is the ordinary scene and layer 1 is the AO prepass
 * (`AO_LAYER` in game/ssao.js); this is the third, and like the AO one it is **opt-in**: the pass
 * has to contain the lamps and nothing else.
 */
export const BLOOM_LAYER = 2;

/**
 * Where the composite lands in the transparent queue.
 *
 * **Zero, under everything.** The existing ladder is the crayon page 1, skid marks 2, dust 3, the
 * route band 4, the drag handle 5, flames 6, the fare rings 7-9. Bloom is light in the picture and
 * not a read-out, so the crayon page washes over it exactly as it washes over the city, and no
 * fare's timer ring is ever lifted by a passing indicator.
 */
export const BLOOM_ORDER = 0;

/**
 * Emissive intensities, per kind of lamp, in multiples of the lamp's own drawn colour.
 *
 * These are the whole of the HDR in this game, so they are the numbers that decide what the bloom
 * looks like — the blur chain only decides how far it reaches. A lamp at 1.0 is exactly as bright
 * as its own pixels and spills a faint smudge; the useful range starts around 2 and a core
 * saturates somewhere past 4.
 *
 * They differ by lamp because the lamps differ in *area*, and spill is a total rather than a peak:
 * a brake pod is four pixels and a menu board forty times that, so equal intensities would put a
 * wash over the drive-through and a hint on a car.
 */
export const BLOOM_INTENSITY = {
  /** Brake and indicator pods, on every vehicle including the taxi. Small and numerous. */
  pod: 3.4,
  /** A cruiser's light bar — the brightest thing in the game, and it should be. */
  siren: 4.2,
  /** A lit window or menu board. Large, so a much lower intensity spends the same total: at the
   *  pod's 3.4 the drive-through's two panels wash out the whole building they are set into. */
  window: 1.15,
  /** The depot's strip light, seen through an open door. */
  bay: 1.6,
  /** The Loco Mode plume and its kickoff burst. Fire, so it can afford to be the hottest thing on
   *  the road — and it is already fading in and out on its own, which the pass follows. */
  flame: 3.8,
  /** The wreck's fireball. Hotter again and for a second and a half only, which is the one moment
   *  in this game where blowing the frame out is the point rather than a cost. Its hue lives
   *  entirely in `instanceColor` — see the note in `markEmissive` about why that needs nothing
   *  special here. */
  blast: 4.6,
  /** A fare's crystal. **A read-out, and that is the whole argument for keeping this low.** Its hue
   *  is the time remaining, and bloom desaturates toward white as it saturates — so a crystal
   *  pushed hard stops reporting the clock at exactly the moment the clock matters most. 1.4 is a
   *  lift on the crystal's own facets rather than a halo around it. */
  crystal: 1.4,
  /** ...and the disc and drop-off ring under it, on the same argument, lower again: a ring is a
   *  thin line and a thin line is what a blur destroys first. */
  ring: 1.0,
  /**
   * The route band. **Zero, and that is a measured answer rather than a cautious one.**
   *
   * The case *for* it is real: the band is the third member of the one-trip-one-hue trio
   * (gameplay.md), and it is now the only one of the three not lifted. So it was tried, at 0.6 —
   * already the lowest number in this table, a sixth of a brake pod's.
   *
   * It fails on **area**, which is the one thing this pass is least forgiving of, because spill is
   * a total rather than a peak. Isolated on shot 10 — the same frame with `path` at 0.6 against
   * `path` at 0, so this is the band and nothing else — it lifted **4.1% of the frame by a mean of
   * 52/255**, where every lamp in the city put together moves a fraction of one percent. The band
   * stops being a translucent wash you can read the road markings through and becomes an opaque
   * green swathe with the tarmac gone underneath it.
   *
   * And it fails a second way that is worse, because it is the read-out failure in its purest
   * form: the band's **alpha encodes distance along the route** — the head gap, the two end fades,
   * the reveal sweep — and an additive accumulate saturates exactly where that alpha is highest.
   * The gradient the band uses to say "this end is where you are" flattens into one blown-out
   * white-green patch.
   *
   * Left wired rather than deleted, so the judgement stays one drag of the **Path** slider away
   * instead of a paragraph — and so `setEmissiveMaterial` keeps a real caller. At 0 it costs
   * nothing: `refreshEmissive` retires an emitter whose kind is dialled to zero.
   */
  path: 0,
};

/** The keys of `BLOOM_INTENSITY`, in panel order — the ⚙️ panel builds a row per kind off this. */
export const BLOOM_KINDS = Object.keys(BLOOM_INTENSITY);

// Resolution of the emissive target, as a fraction of the drawing buffer.
//
// Half, and it is not a free choice: the depth this pass tests its lamps against is the half-res
// prepass in `game/ssao.js`, and matching it exactly makes the lookup a 1:1 texel fetch with no
// filtering question at all — that buffer is packed depth and `NearestFilter`, so it *cannot* be
// filtered, because a bilinear blend of two packed depths unpacks to nothing meaningful.
const EMISSIVE_SCALE = 0.5;

// Levels in the blur chain, each half the one above it — so the finest is a quarter of the frame
// and the coarsest a sixteenth. That is what sets how far the spill reaches: at DPR 2 on a phone
// the coarsest level's texel is about 16 device pixels, which is a wide soft skirt under a core
// four pixels across.
//
// Three rather than four because a fourth level's texels are wider than the widest lamp in the
// game, so it contributes a flat lift over the whole frame — which reads as the picture being
// washed out rather than as anything glowing.
const LEVELS = 3;

// What each level of the chain contributes on the way back up, relative to the one below it. See
// the note by UP_FRAGMENT: at 1.0 the three levels sum to a flat lift over the whole frame. 0.55
// leaves the finest level dominant and the widest one a tail, which is what reads as a glow with
// a core rather than as haze. Live in the ⚙️ panel as **Reach**, because it is the one number that
// decides tight-and-hot against wide-and-soft and no still frame settles that.
const LEVEL_WEIGHT = 0.55;

// Depth bias for the occlusion test, in NDC. Two things need paying for, both small: the prepass is
// half res, so at a silhouette the depth being tested against is up to a texel out; and **some
// lamps are in the prepass themselves** — the drive-through's lit windows are enrolled as AO
// occluders (they are opaque, colour-writing meshes standing on a wall), so without a bias each
// one fails its own test and the joint goes dark. 2e-4 of NDC is 0.28 world units over the
// 1399-unit frustum: comfortably past both, and far short of the depth to anything that could
// stand in front of a lamp.
const DEPTH_BIAS = 2e-4;

/**
 * The depth the emissive pass rejects against, shared the way `AO_UNIFORMS` is (util/geo.js).
 *
 * Module state rather than instance state because the *materials* are built by `markEmissive()`
 * while the city is being constructed, which can be before this module's pass exists at all — the
 * same split the AO module has between its draw list and its pass.
 */
export const BLOOM_UNIFORMS = {
  tBloomDepth: { value: null },
  uBloomDepthTexel: { value: new THREE.Vector2(1, 1) },
  uBloomDepthBias: { value: DEPTH_BIAS },
};

/** Live tuning — the ⚙️ panel. */
export const BLOOM_DEFAULTS = {
  // How much of the blurred spill reaches the frame. The intensities above set what glows and by
  // how much relative to everything else; this is the one master over all of them.
  strength: 0.7,
  // A multiplier on every `BLOOM_INTENSITY`, so the whole HDR range can be pushed and pulled with
  // one hand without renegotiating a brake light against a shopfront.
  intensity: 1,
  // How much each level of the blur chain contributes relative to the one below it. See
  // LEVEL_WEIGHT — low is a tight hot core, high is a wide wash that becomes a fog at 1.
  reach: LEVEL_WEIGHT,
};

const emissive = new Set();

/** The draw list, for `tools/probe.mjs`. Read it; `markEmissive` is what writes it. */
export function emissiveList() {
  return emissive;
}

/**
 * Reject a lamp fragment the solid world is standing in front of.
 *
 * Patched into every emissive material rather than solved with a depth buffer of this pass's own,
 * because `game/ssao.js` has already drawn exactly this: the solid world, at exactly this
 * resolution, cleared to the far plane. The alternative is a second prepass over the same three
 * dozen meshes for the same answer.
 *
 * `gl_FragCoord.z` is the same NDC depth `MeshDepthMaterial` packed, and this pass renders at the
 * prepass's own size, so the lookup is texel-for-texel and needs no scaling.
 */
// The two halves of the occlusion reject, kept as strings so the chunk path and the hand-written
// fallback below inject the *same* code rather than two that drift apart. `unpackRGBAToDepth` comes
// from three's `packing` chunk on the first path and is spelled out on the second, which is the
// only difference between them.
const DECLARE = `uniform sampler2D tBloomDepth;
uniform vec2 uBloomDepthTexel;
uniform float uBloomDepthBias;
float bloomUnpackDepth(vec4 rgba) {
  return dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}`;

const REJECT = `\tif (gl_FragCoord.z > bloomUnpackDepth(texture2D(tBloomDepth, gl_FragCoord.xy * uBloomDepthTexel)) + uBloomDepthBias) discard;`;

let patchSeq = 0;

function patchEmissiveDepth(material, inherited = null) {
  // Three builds the program cache key from the material's parameters, *before* `onBeforeCompile`
  // runs, so a patched basic material collides with every unpatched one sharing those parameters
  // and `acquireProgram` hands back whichever compiled first — the trap that once drew the
  // diamond's fill with a building's shader. See CLAUDE.md.
  //
  // Unique per material rather than one constant for the pass, because `inherited` means two of
  // these can carry *different* source patches while sharing every parameter three hashes.
  const key = `bloom-emissive-${patchSeq++}`;
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader, renderer) => {
    // The source's own patch first, so this runs on top of whatever it did rather than being
    // overwritten by it. That is what lets an effect with a shader of its own — the Loco kickoff
    // burst multiplies in a per-instance `aAlpha` — bloom as the shape it actually draws instead
    // of as every particle at full strength.
    inherited?.(shader, renderer);
    Object.assign(shader.uniforms, BLOOM_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${DECLARE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${REJECT}`);

    // A hand-written shader has none of three's chunks to hook — `game/routeline.js`'s band is one
    // — so fall back to the two anchors every GLSL fragment shader does have. Never a blind
    // `replace`: a hook that silently matched nothing leaves a lamp shining through the building in
    // front of it, which is the sort of thing nobody notices for a month. See CLAUDE.md.
    if (!shader.fragmentShader.includes(REJECT)) {
      const before = shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace(/void\s+main\s*\(\s*\)\s*\{/, (head) => `${DECLARE}\n${head}\n${REJECT}`);
      if (shader.fragmentShader === before) {
        throw new Error('bloom: no place to inject the depth reject into this fragment shader');
      }
    }
  };
  return material;
}

/**
 * What a material is contributing as *light*, in the two forms this game writes it.
 *
 * There are only two, and both are read off the mesh rather than configured:
 *
 *   - **`unlitMaterial()`** — the colour *is* the light. Either flat (`material.color`, the
 *     cruiser's bar) or baked per vertex (`vertexColors`, the drive-through's windows and the
 *     depot's strip). A basic material multiplies `diffuse` by `vColor`, so putting the intensity
 *     in `color` covers both with one branch.
 *   - **A Lambert carrying an emissive** — the light pods, the fare's crystal.
 *     `emissive * emissiveIntensity` is what that material actually adds to the frame.
 *
 * So **nothing needs a special material to be bloomed.** If it is unlit it already qualifies, and
 * if it is lit it qualifies to the extent it has an emissive. What it needs is to be *named*.
 */
function readLight(material, out) {
  return material.emissive
    ? out.copy(material.emissive).multiplyScalar(material.emissiveIntensity ?? 1)
    : out.copy(material.color);
}

/**
 * Re-derive one mesh's emissive-pass material from its live one.
 *
 * **Run every frame, not once at mark time, and that is the whole of what makes this usable.** A
 * snapshot taken when the mesh was built is wrong for everything in this game that is worth
 * glowing:
 *
 *   - the Loco plume animates its **opacity** as the flame breathes (`material.opacity = heat` in
 *     game/locoflame.js), so a snapshot blooms a flame that is not burning;
 *   - a fare's crystal and its ring are **repainted** as the clock runs down — their hue *is* the
 *     time remaining — so a snapshot blooms last week's urgency;
 *   - the cruiser's bar strobes, and the police fade their whole skin out at the map edge.
 *
 * It costs a colour copy and a multiply per marked mesh per frame, on a list of a few dozen.
 */
export function refreshEmissive(mesh, master = 1) {
  const bloom = mesh.userData.bloomMaterial;
  const live = mesh.material;
  if (!bloom || !live || live === bloom) return bloom;
  const intensity = (BLOOM_INTENSITY[mesh.userData.bloomKind] ?? 1) * master;

  // **A kind dialled to zero is switched off on the material, never by skipping the swap.**
  //
  // That distinction cost an evening. The pass is gated by a *layer*, so a marked mesh is drawn
  // whatever this function decides — and an earlier version returned null here and let the render
  // loop `continue`, which did not skip the draw at all. It skipped the *swap*, so the mesh went
  // into the emissive target wearing its **own** material: full strength, no intensity, and none
  // of the depth reject. The route band at zero came out brighter than it had been at 0.6, and
  // climbing the building in front of it, which is precisely the shape of "off" going wrong.
  //
  // Three honours `material.visible` when it builds the render list, so this is the switch.
  bloom.visible = live.visible && intensity > 0;
  if (!bloom.visible) return bloom;

  // An owner-supplied material knows its own shape — see `setEmissiveMaterial`.
  if (mesh.userData.bloomSync) {
    mesh.userData.bloomSync(bloom, live, intensity);
    return bloom;
  }
  readLight(live, bloom.color).multiplyScalar(intensity);
  // Carried, so a thing that is fading out of the frame fades out of the bloom with it.
  bloom.opacity = live.opacity;
  bloom.transparent = live.transparent;
  return bloom;
}

/**
 * An outline hung off a lamp, which is not itself a lamp.
 *
 * The exclusion `markEmissive`'s traversal needs, and the same shape as the rule
 * [`markOccluder`](./ssao.js) carries for its own prepass. Every vehicle part in the game wears a
 * ghost outline (`geometry/ghostoutline.js`) and may wear a Cartoon Mode hull on top of that — two
 * child meshes each, attached to the part rather than beside it. **The taxi's three light pods
 * therefore carry six children between them**, and a traversal that took them would bloom an
 * inflated hull of the pod and a mask that writes no colour at all: a soft rectangle floating
 * around each of the taxi's lights, three times the size they are.
 *
 * Two tests, because the two halves fail differently. A mask is `colorWrite: false` — it has no
 * colour to *be* light, which is the same argument the AO prepass makes about it. A rim does write
 * colour, so it is caught by name, the way `setGhostOutlines` and Cartoon Mode's own sweep already
 * identify them.
 */
const OUTLINE_NAMES = new Set(['ghostMask', 'ghostRim', 'toonOutline', 'toonOutlineMask']);

function isOutline(object) {
  return object.material.colorWrite === false || OUTLINE_NAMES.has(object.name);
}

/**
 * Put `root` and every mesh under it in the bloom, at the intensity `kind` names.
 *
 * `kind` is a key into `BLOOM_INTENSITY` rather than a number, which is what lets the ⚙️ panel move
 * a whole class of lamp at once — and what stops "how bright is a brake light" being answered in
 * six places.
 *
 * **Traverses**, like `markOccluder`, because most of the things worth glowing are groups: the
 * plume is three coplanar tongues, a fare's disc is a rim, a fill and a sweep.
 *
 * Called either from `main.js` (for anything `sim/` or `city/` owns, since neither may import from
 * `game/`) or by the owning module directly where it is already in `game/` — the same split
 * `markOccluder` has, where `game/roadwork.js` marks its own slab.
 */
export function markEmissive(root, kind = 'pod') {
  root.traverse((object) => {
    if (!object.isMesh || !object.material || Array.isArray(object.material)) return;
    if (isOutline(object)) return;
    const live = object.material;
    // A material this cannot read light off — a hand-written `ShaderMaterial`, which has neither a
    // `color` nor an `emissive` — is skipped rather than guessed at. There is no general answer to
    // "what colour is this shader's light", so the owner supplies one: see `setEmissiveMaterial`,
    // which is how `game/routeline.js`'s band gets in. Silent, because a traversal over a group
    // legitimately meets meshes that are not lamps.
    if (!live.color && !live.emissive) return;
    // Through the helper, like every other unlit material in the game — and the `fog: false` it
    // carries is the point here rather than a formality: haze mixes toward the sky colour, and a
    // lamp faded into the sky is not a lamp.
    //
    // Everything else is copied off the source so the lamp draws in the emissive target the shape
    // it draws on screen: `side` because the plume is DoubleSide and a single-sided copy is
    // invisible on half the compass, `blending` and `depthWrite` because the transparent effects
    // are layered rather than solid.
    object.userData.bloomMaterial = patchEmissiveDepth(unlitMaterial({
      vertexColors: Boolean(live.vertexColors),
      toneMapped: false,
      side: live.side,
      blending: live.blending,
      depthWrite: live.depthWrite,
      transparent: live.transparent,
    }), live.onBeforeCompile || null);
    object.userData.bloomKind = kind;
    object.userData.bloomSync = null;
    object.layers.enable(BLOOM_LAYER);
    emissive.add(object);
    // Correct from the moment it is built rather than only after the first frame: a headless
    // caller (`tools/probe.mjs`) never reaches a render, and a material that cannot be asserted
    // until something has drawn is a material nothing can check.
    refreshEmissive(object);
  });
  return root;
}

/**
 * Put `mesh` in the bloom with a material of its own, for the case `markEmissive` cannot read.
 *
 * The escape hatch, and the same shape `setOccluderDepthMaterial` (game/ssao.js) is for the AO
 * prepass: a hand-written `ShaderMaterial` has no `color` and no `emissive`, so nothing generic can
 * say what it is contributing as light. The owner does know, so the owner supplies both the
 * material and — in `sync` — how to keep it in step with the live one each frame.
 *
 * The material handed in is patched for the depth reject here rather than by the caller, so an
 * emitter cannot forget it and shine through the building in front of it.
 *
 * @param material  what to draw this mesh as in the emissive pass. Usually a clone of its own.
 * @param sync      `(bloomMaterial, liveMaterial, intensity)`, called once per frame before the
 *                  pass draws. This is where a custom shader's uniforms are carried across and its
 *                  light is scaled into HDR — the equivalent of what `refreshEmissive` does for the
 *                  two ordinary material shapes.
 */
export function setEmissiveMaterial(mesh, material, kind = 'pod', sync = null) {
  mesh.userData.bloomMaterial = patchEmissiveDepth(material);
  mesh.userData.bloomKind = kind;
  mesh.userData.bloomSync = sync;
  mesh.layers.enable(BLOOM_LAYER);
  emissive.add(mesh);
  refreshEmissive(mesh);
  return mesh;
}

/** Take it back out again, and free the materials — the same contract `unmarkOccluder` has. */
export function unmarkEmissive(root) {
  root.traverse((object) => {
    if (!emissive.has(object)) return;
    object.layers.disable(BLOOM_LAYER);
    object.userData.bloomMaterial?.dispose();
    object.userData.bloomMaterial = null;
    emissive.delete(object);
  });
  return root;
}

/** Fullscreen-quad vertex shader: clip space written directly, no matrices, never resized. */
const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// A four-tap box, taken on the diagonals half a source texel out so every tap is a bilinear
// average of four — sixteen source texels for four fetches. The standard downsample, and the
// reason a chain of these is smooth where a chain of nearest halvings crawls as the camera pans.
const DOWN_FRAGMENT = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = sum * 0.25;
}
`;

// The 3x3 tent on the way back up, 1-2-1 weighted, added into the finer level already in the
// target. Summing the levels rather than taking the widest is where the long soft skirt under a
// tight core comes from — one Gaussian of any radius has only one falloff.
//
// `uWeight` is what keeps that sum from becoming a fog. A box downsample preserves the *average*
// of what it reads, so every level of the chain carries the same average as the one above it, and
// adding three of them at full strength lifts the whole frame by three times the mean brightness
// of the lamps — which is a pink wash over the road, not a glow. Each level therefore comes in at
// a fraction of the one below it, so the coarse levels contribute a tail rather than an equal
// share. (This is the same thing UnrealBloomPass spells as its `radius` lerp.)
const UP_FRAGMENT = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(0.0, -1.0)) * 2.0;
  sum += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(-1.0, 0.0)) * 2.0;
  sum += texture2D(tSource, vUv) * 4.0;
  sum += texture2D(tSource, vUv + uTexel * vec2(1.0, 0.0)) * 2.0;
  sum += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0));
  sum += texture2D(tSource, vUv + uTexel * vec2(0.0, 1.0)) * 2.0;
  sum += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = sum * (uWeight / 16.0);
}
`;

/**
 * The composite, drawn as an ordinary object in the main scene.
 *
 * Two things it has to do that a plain additive blit would not:
 *
 *   - **Roll the HDR off.** The chain holds values well past 1 and the frame it is going into does
 *     not. `1 - exp(-x)` is the cheapest curve that saturates rather than clips, which is the whole
 *     difference between a core that goes white and one that goes flat.
 *   - **Encode.** It lands on a frame that is already in display space, so the spill has to be too,
 *     or the same number reads twice as bright in the shadows as it does in the sun. Written out
 *     rather than taken from `<colorspace_fragment>`, whose `linearToOutputTexel` three only
 *     declares for its own `ShaderLib` entries.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uStrength;

vec3 encodeSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055,
    step(vec3(0.0031308), c));
}

void main() {
  vec3 spill = texture2D(tBloom, gl_FragCoord.xy / uResolution).rgb * uStrength;
  gl_FragColor = vec4(encodeSRGB(vec3(1.0) - exp(-spill)), 1.0);
}
`;

const BLIT_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * @param renderer   the one WebGLRenderer
 * @param enabled    false leaves every method a no-op and allocates nothing
 * @param depth      `() => texture` for `game/ssao.js`'s half-res packed depth, with `depthSize`
 *                   for its dimensions. Without them a lamp behind a building blooms through it,
 *                   which is why `main.js` asks the AO module to run its prepass whenever this is
 *                   on — see the `depth` flag on `createAmbientOcclusion`.
 */
export function createBloom(renderer, { enabled = true, depth = null, depthSize = null } = {}) {
  const state = { enabled, ...BLOOM_DEFAULTS };

  if (!enabled) {
    return {
      state,
      overlay: null,
      render: () => {},
      set: () => {},
      dispose: () => {},
      target: () => null,
    };
  }

  // Half float is what makes this a bloom rather than a blur of clipped pixels — the whole point is
  // that a lamp writes past 1 and the falloff has somewhere to come down from. It is not
  // guaranteed: `EXT_color_buffer_half_float` is what makes an RGBA16F target renderable, and a
  // device without it gets RGBA8 and a bloom whose cores are flat. Visibly worse, and working,
  // which is the trade every other fallback in this project makes.
  const hdr = renderer.extensions.has('EXT_color_buffer_half_float')
    || renderer.extensions.has('EXT_color_buffer_float');
  state.hdr = hdr;

  const makeTarget = (withDepth) => new THREE.WebGLRenderTarget(1, 1, {
    type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Clamped, not wrapped: without it the coarsest level's tent reaches off one edge of the screen
    // and a brake light on the left of the frame lifts the right of it.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: withDepth,
    stencilBuffer: false,
  });

  // Level 0 keeps a depth buffer of its own, doing a different job from the scene-depth test in the
  // shader: this one sorts the lamps *against each other*, so the near and far faces of a light
  // bar's box do not both write and double their own brightness.
  const emissiveTarget = makeTarget(true);
  const chain = Array.from({ length: LEVELS }, () => makeTarget(false));

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  const passScene = new THREE.Scene();
  passScene.add(quad);
  const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const blitUniforms = {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uWeight: { value: state.reach },
  };
  const downMaterial = new THREE.RawShaderMaterial({
    uniforms: blitUniforms,
    vertexShader: BLIT_VERTEX,
    fragmentShader: `precision highp float;\n${DOWN_FRAGMENT}`,
    depthTest: false,
    depthWrite: false,
    // Explicit: the chain runs with `autoClear` off (see `render`), so a downsample has to be the
    // thing that replaces the target's contents rather than blending with the frame before last.
    blending: THREE.NoBlending,
  });
  const upMaterial = new THREE.RawShaderMaterial({
    uniforms: blitUniforms,
    vertexShader: BLIT_VERTEX,
    fragmentShader: `precision highp float;\n${UP_FRAGMENT}`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const compositeUniforms = {
    tBloom: { value: chain[0].texture },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uStrength: { value: state.strength },
  };

  /**
   * The composite, as an ordinary object in the main scene — hoisted out of a render target and
   * into the transparent queue, exactly as `game/crayon.js` hoists its page. This is the whole
   * reason the frame keeps its MSAA and the ghost outlines keep their stencil.
   */
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: compositeUniforms,
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  overlay.name = 'bloom';
  overlay.renderOrder = BLOOM_ORDER;
  overlay.frustumCulled = false;

  const drawingBuffer = new THREE.Vector2();
  const clearColor = new THREE.Color();
  const swapped = [];
  const savedMaterials = [];
  let width = 0;
  let height = 0;

  /**
   * Sized off the drawing buffer every frame rather than off a resize event — two comparisons, and
   * it covers what an event does not: a pixel-ratio change on a monitor swap, and shot mode, which
   * never resizes but can be re-rendered through `__taxi.redraw()` after the viewport has moved.
   */
  function resizeIfNeeded() {
    renderer.getDrawingBufferSize(drawingBuffer);
    const w = Math.max(1, Math.round(drawingBuffer.x * EMISSIVE_SCALE));
    const h = Math.max(1, Math.round(drawingBuffer.y * EMISSIVE_SCALE));
    if (w === width && h === height) return;
    width = w;
    height = h;
    emissiveTarget.setSize(w, h);
    for (let i = 0; i < chain.length; i++) {
      chain[i].setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)));
    }
    // The composite samples in normalised screen space, so this is the *full* buffer size — the
    // bloom texture's own resolution never enters into it.
    compositeUniforms.uResolution.value.copy(drawingBuffer);
  }

  function blit(material, source, target) {
    blitUniforms.tSource.value = source.texture;
    blitUniforms.uTexel.value.set(1 / source.width, 1 / source.height);
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(passScene, passCamera);
  }

  return {
    state,

    /** The composite quad, for `main.js` to add to the scene. Null when the pass is off. */
    overlay,

    /** The finished spill, for `tools/probe.mjs` and anything that wants to look at it. */
    target: () => chain[0].texture,

    /** The emissive pass's own output, before any blur — what the lamps actually wrote. */
    emissiveTarget: () => emissiveTarget.texture,

    /**
     * Redraw the spill for this frame. Called from `renderFrame()` immediately before the main
     * render — which is left entirely alone: still the default framebuffer, still its own MSAA,
     * still its own stencil buffer.
     *
     * It has to run before *every* render rather than once per frame loop, for the reason the AO
     * prepass does: shot mode and `__taxi.redraw()` both reach a render without ever running the
     * loop, and a frozen shot would composite whatever the last live frame left in the texture.
     */
    render(scene, camera) {
      resizeIfNeeded();

      if (depth) {
        const size = depthSize?.();
        BLOOM_UNIFORMS.tBloomDepth.value = depth();
        if (size) BLOOM_UNIFORMS.uBloomDepthTexel.value.set(1 / size.width, 1 / size.height);
      }

      const savedMask = camera.layers.mask;
      const savedOverride = scene.overrideMaterial;
      const savedShadowAutoUpdate = renderer.shadowMap.autoUpdate;
      const savedAutoClear = renderer.autoClear;
      const savedAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);

      // Same argument the AO prepass makes: left on, three rebuilds all 2048x2048 of the sun's
      // shadow map a second time per frame for a render that never reads it.
      renderer.shadowMap.autoUpdate = false;
      // Cleared, not set: the material is chosen per mesh below, and an override left on by
      // anything else would silently outrank every one of those choices.
      scene.overrideMaterial = null;
      camera.layers.set(BLOOM_LAYER);

      let count = 0;
      for (const mesh of emissive) {
        // Read off the *live* material and then swap — see `refreshEmissive` for why every frame.
        //
        // **Every marked mesh is swapped, with no early `continue`.** The pass is layer-gated, so a
        // mesh left unswapped is not a mesh left undrawn — it is one drawn with its own material,
        // at full strength and with no depth reject. `refreshEmissive` switches an emitter off on
        // the material instead, which three honours when it builds the render list.
        const material = refreshEmissive(mesh, state.intensity);
        if (!material) continue;    // no bloom material at all: nothing to swap in
        swapped[count] = mesh;
        savedMaterials[count] = mesh.material;
        mesh.material = material;
        count += 1;
      }

      // Black, so everything the lamps do not cover contributes nothing to the sum.
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(emissiveTarget);
      renderer.render(scene, camera);

      for (let i = 0; i < count; i += 1) {
        swapped[i].material = savedMaterials[i];
        // Dropped rather than left behind: a stale entry would keep a disposed mesh and its
        // material alive until the next frame overwrote the slot.
        swapped[i] = null;
        savedMaterials[i] = null;
      }

      scene.overrideMaterial = savedOverride;
      camera.layers.mask = savedMask;
      renderer.shadowMap.autoUpdate = savedShadowAutoUpdate;

      // **`autoClear` off for the whole chain, and that is load-bearing on the way back up**: an
      // upsample adds into the level already in its target, and `render()` would wipe that first.
      // The downsamples replace rather than blend (`NoBlending` above), so they need no clear.
      renderer.autoClear = false;
      let source = emissiveTarget;
      for (let i = 0; i < chain.length; i++) {
        blit(downMaterial, source, chain[i]);
        source = chain[i];
      }
      for (let i = chain.length - 1; i > 0; i--) {
        blit(upMaterial, chain[i], chain[i - 1]);
      }
      renderer.autoClear = savedAutoClear;

      renderer.setRenderTarget(null);
      renderer.setClearColor(clearColor, savedAlpha);
    },

    /**
     * Live tuning — the ⚙️ panel, and `window.__taxi.bloom`.
     *
     * Takes both the pass's own numbers and any key of `BLOOM_INTENSITY`, so a caller can move one
     * class of lamp (`set('siren', 6)`) without touching the rest.
     */
    set(key, value) {
      if (key in BLOOM_INTENSITY) {
        BLOOM_INTENSITY[key] = value;
        return;
      }
      if (!(key in state)) return;
      state[key] = value;
      if (key === 'strength') compositeUniforms.uStrength.value = value;
      else if (key === 'reach') blitUniforms.uWeight.value = value;
      // `intensity` is re-applied by `render()` on the next pass — nothing to push.
    },

    dispose() {
      emissiveTarget.dispose();
      chain.forEach((target) => target.dispose());
      quad.geometry.dispose();
      downMaterial.dispose();
      upMaterial.dispose();
      overlay.geometry.dispose();
      overlay.material.dispose();
      BLOOM_UNIFORMS.tBloomDepth.value = null;
    },
  };
}
