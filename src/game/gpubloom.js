/**
 * Bloom for the WebGPU renderer. What blooms, and why selection is explicit rather than a bright
 * pass, is game/bloom.js; `markEmissive()` and `BLOOM_INTENSITY` are still the whole of the
 * interface, and nothing that calls them knows which renderer is drawing.
 *
 * **Not the WebGL arrangement.** There the marked meshes are drawn a second time, with a second
 * set of materials, into a half-resolution target, rejected by hand against the AO prepass's
 * depth. Here there is no second draw and no second material: the frame already goes into a target
 * with more than one attachment (game/gpuframe.js), and this adds one.
 *
 *   - Every node material writes `glowLight` on its way out (`installNodeGrade`, game/gpufog.js):
 *     the colour it drew, linear, times a per-object level. The level is the mesh's
 *     `BLOOM_INTENSITY` if it is marked and 0 if it is not, so an unmarked wall writes black and
 *     *occludes* the lamp behind it through the ordinary depth test. That is the depth reject, the
 *     layer, the material swap and `refreshEmissive` in one uniform.
 *   - A patch a live material carries (per-instance alpha, the entrance wave, a twin's whole
 *     shader) is in the glow for free, because the glow is that material's own output.
 *   - The chain is the WebGL one: the same box downsample, tent upsample and `LEVEL_WEIGHT`, off a
 *     half-resolution first level, so the spill reaches as far.
 *   - The composite is added in the frame's last pass rather than drawn as an object under the
 *     read-outs. So a fare ring over a lamp is lifted by the spill, where on WebGL it is not.
 *
 * One knowing difference in what glows: a *lit* marked mesh contributes all the light it shows,
 * where WebGL took its emissive colour alone. The haze is in neither.
 *
 * The attachment is eight bits, holding a quarter of the light: a lamp at the shipped master
 * (0.1) writes about 0.3, and the panel can take a level to 4 before it clips.
 *
 * **What still differs from WebGL, measured.** A lamp glows by what of it the camera sees. The
 * WebGL pass rejects against the AO prepass with a bias of 0.28 world units, so a pod tucked
 * round a fender writes its whole box (a turn signal seen side-on: a 4 by 10 pixel block there, a
 * 2 by 6 sliver here), and such lamps spill about a third as much. A sign that is not buried in
 * anything matches to the 8-bit step (the roof neon: 0, 5, 13 of 255 against 0.1, 4.7, 12.6).
 */
import * as THREE from 'three';
import { NodeMaterial, QuadMesh } from 'three/webgpu';
import {
  Fn, exp, float, property, sRGBTransferOETF, select, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { BLOOM_DEFAULTS, BLOOM_INTENSITY, emissiveList } from './bloom.js';

/** What a quarter of the attachment's range stands for. */
export const GLOW_RANGE = 4;

export const glowState = { enabled: false, ...BLOOM_DEFAULTS };
/** Before the first material is built: whether node materials write the glow at all. */
export function enableGlow() {
  glowState.enabled = true;
}

/** The light a fragment sends to the bloom, linear. Zero unless `writeGlow` ran. */
export const glowLight = property('vec3', 'glowLight');

const marked = emissiveList();
const levelOf = (object) => (marked.has(object)
  ? (BLOOM_INTENSITY[object.userData.bloomKind] ?? 1) * glowState.intensity * (object.userData.bloomScale ?? 1)
  : 0);
// One node for every material: three reads it per object drawn.
const level = uniform(0).onObjectUpdate(({ object }) => levelOf(object));

/**
 * Called from the output seam with the material's linear colour and the grade.
 *
 * **The grade is in the light, and on the linear value.** On WebGL the grade rides the end of
 * three's fog chunk, which the emissive pass's materials include like any other, so every lamp
 * there is graded as though its linear light were a display colour. An accident, and the look the
 * bloom was tuned against: the shipped grade lifts the low end by about half a stop, and leaving
 * it out halved the spill (the roof neon wrote 0.110 of blue for WebGL's 0.197, and the whole
 * emissive target summed to 0.47 of WebGL's).
 *
 * Behind a test on the level, which is a uniform: an unmarked fragment writes an exact zero and
 * skips the table read, where a graded black need not be black.
 */
export function writeGlow(linear, grade) {
  if (!glowState.enabled) return;
  // Into a variable first, out in the open: `select` is an if/else, and a node first met inside
  // one arm is declared there, so the material's own colour (which the rest of the output goes on
  // to use) came out unset everywhere else and the whole lit city drew black.
  const light = vec3(linear).mul(level).toVar();
  glowLight.assign(select(level.greaterThan(0), grade(light), vec3(0)));
}

/**
 * The blur chain over the frame's glow attachment. `render()` leaves the spill in the texture
 * `spill` names; `composite(at)` is the display-space light to add at a screen position.
 */
export function createGlowChain(renderer, source) {
  const LEVELS = 3;
  const make = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const half = make();
  const chain = Array.from({ length: LEVELS }, make);

  const from = texture(source);
  const texel = uniform(new THREE.Vector2());
  const weight = uniform(glowState.reach);
  const strength = uniform(glowState.strength);
  const tap = (x, y) => from.sample(uv().add(texel.mul(vec2(x, y))));
  const pass = (node, blending) => {
    const material = new NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;
    material.fog = false;
    material.userData.display = true;   // numbers in, numbers out
    material.blending = blending;
    material.transparent = blending !== THREE.NoBlending;
    material.fragmentNode = node;
    return new QuadMesh(material);
  };
  const box = () => tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25);
  const tent = () => tap(-1, -1).add(tap(0, -1).mul(2)).add(tap(1, -1))
    .add(tap(-1, 0).mul(2)).add(tap(0, 0).mul(4)).add(tap(1, 0).mul(2))
    .add(tap(-1, 1)).add(tap(0, 1).mul(2)).add(tap(1, 1));
  // Off the frame's attachment, whose alpha is whatever was blended there: the chain starts at 1.
  const first = pass(Fn(() => vec4(box().rgb, 1.0))(), THREE.NoBlending);
  const down = pass(Fn(() => box())(), THREE.NoBlending);
  // **The alpha is weighted too, and the blend multiplies by it.** That is the WebGL pass to the
  // letter: its upsample writes `sum * weight` in all four channels and three's additive blend is
  // source-alpha, so a level comes in at the weight *squared* (0.3 at the shipped 0.55), and at
  // more than that once the level under it has been added to and its alpha is past 1. Measured on
  // WebGL: the second level holds 1.32 times its own downsample after the add, not 1.55.
  const up = pass(Fn(() => tent().mul(weight.div(16)))(), THREE.AdditiveBlending);

  const blit = (quad, texture_, width, height, target) => {
    from.value = texture_;
    texel.value.set(1 / width, 1 / height);
    renderer.setRenderTarget(target);
    quad.render(renderer);
  };

  const spill = texture(chain[0].texture);
  return {
    resize(width, height) {
      const w = Math.max(1, Math.round(width / 2));
      const h = Math.max(1, Math.round(height / 2));
      if (half.width === w && half.height === h) return;
      half.setSize(w, h);
      chain.forEach((target, i) => target.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    },
    /** `width`, `height`: the size of `source`. Leaves the render target set to the last level. */
    render(width, height) {
      weight.value = glowState.reach;
      strength.value = glowState.strength;
      const auto = renderer.autoClear;
      blit(first, source, width, height, half);
      let last = half;
      for (const target of chain) {
        blit(down, last.texture, last.width, last.height, target);
        last = target;
      }
      // Added onto the level below, which still holds its own downsample.
      renderer.autoClear = false;
      for (let i = chain.length - 1; i > 0; i--) {
        blit(up, chain[i].texture, chain[i].width, chain[i].height, chain[i - 1]);
      }
      renderer.autoClear = auto;
    },
    /** COMPOSITE_FRAGMENT of game/bloom.js: the spill through a shoulder, display-encoded. */
    // The chain is linear, so the attachment's quarter is undone here, once.
    composite: (at) => sRGBTransferOETF(
      float(1).sub(exp(spill.sample(at).rgb.mul(strength.mul(GLOW_RANGE)).negate()))),
  };
}
