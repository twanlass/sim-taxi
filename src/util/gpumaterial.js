/**
 * `propMaterial()`'s WebGPU twin: the node materials every lit mesh wears under WebGPURenderer.
 *
 * The WebGL path patches three's Lambert and Phong GLSL at named chunks (`patchProp` in
 * util/geo.js). Node materials have no chunks; the same seams are methods. The one used here is
 * the lighting model's `finish`, which runs where `<lights_fragment_end>` did, with both halves of
 * the lighting still separate in `context.reflectedLight`.
 *
 * Ported so far: the shadow tint. Each material lists what it is still missing in
 * `userData.unported`, which `__taxi.unported()` reports (game/gpucompat.js).
 */
import { MeshLambertNodeMaterial, MeshPhongNodeMaterial, PhongLightingModel } from 'three/webgpu';
import { BackSide, DoubleSide, FrontSide } from 'three';
import { dot, max, mix, smoothstep, vec3 } from 'three/tsl';

// Set by util/geo.js, which owns SHADOW_UNIFORMS; a setter rather than an import because geo.js
// imports this file.
const shared = { shadowColor: null, shadowTint: null, shadeKnee: 0.45 };
export function bindPropNodes(nodes) {
  Object.assign(shared, nodes);
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * The shadow tint (SHADOW_LIGHT in util/geo.js, where the reasoning lives): shade is the share of
 * the light at a fragment that is fill rather than sun, and the fill is pushed toward the shadow
 * colour by that share.
 *
 * One difference in mechanics from the GLSL. There the patch rewrote `indirectDiffuse` before
 * three summed the light; here three has already summed it by the time `finish` runs, so the
 * change is added to the sum instead. Same arithmetic, one line later.
 */
class PropLightingModel extends PhongLightingModel {
  finish({ context }) {
    const { reflectedLight, outgoingLight } = context;
    const direct = dot(reflectedLight.directDiffuse, LUMA);
    const indirect = dot(reflectedLight.indirectDiffuse, LUMA);
    const shade = smoothstep(shared.shadeKnee, 1.0, indirect.div(max(direct.add(indirect), 1e-4)));
    const tinted = mix(reflectedLight.indirectDiffuse, shared.shadowColor.mul(indirect),
      shade.mul(shared.shadowTint));
    outgoingLight.addAssign(tinted.sub(reflectedLight.indirectDiffuse));
  }
}

/**
 * Which faces go into the sun's shadow map. three's WebGL shadow pass draws the *back* faces of a
 * front-sided material unless told otherwise, which is what keeps a lit face from shadowing
 * itself; the WebGPU pass draws whatever `material.side` says. Left at that, every roof and deck
 * in the city came out striped with acne and about 8% darker than on WebGL. An accessor rather
 * than a value because callers change `side` after `propMaterial()` returns.
 */
const webglShadowSide = {
  get() {
    if (this._shadowSide != null) return this._shadowSide;
    return this.side === FrontSide ? BackSide : this.side === BackSide ? FrontSide : DoubleSide;
  },
  set(value) { this._shadowSide = value; },
  configurable: true,
};

// The `type` is part of how three keys a node material's program, and a stock Lambert that three
// converted on the fly must not be handed this one's lighting, or the other way about.
export class PropLambertNodeMaterial extends MeshLambertNodeMaterial {
  static get type() { return 'PropLambertNodeMaterial'; }

  setupLightingModel() { return new PropLightingModel(false); }
}

export class PropPhongNodeMaterial extends MeshPhongNodeMaterial {
  static get type() { return 'PropPhongNodeMaterial'; }

  setupLightingModel() { return new PropLightingModel(true); }
}

Object.defineProperty(PropLambertNodeMaterial.prototype, 'shadowSide', webglShadowSide);
Object.defineProperty(PropPhongNodeMaterial.prototype, 'shadowSide', webglShadowSide);
