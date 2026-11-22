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
import { dot, max, mix, positionWorld, smoothstep, sRGBTransferEOTF, sRGBTransferOETF, vec3 } from 'three/tsl';

// Set by util/geo.js, which owns SHADOW_UNIFORMS; a setter rather than an import because geo.js
// imports this file.
// `clouds` is `() => cloudLight | null`, asked as a material is built: weather is decided after
// this module loads (`setCloudShadows`), and a city without it compiles none of the field.
// `paving` is the same shape: `() => paving | null`, the painterly look's junction (util/gpupaving.js).
const shared = { shadowColor: null, shadowTint: null, shadeKnee: 0.45, clouds: () => null, paving: () => null };
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
  finish({ context, material }) {
    const { reflectedLight, outgoingLight } = context;
    // Cloud shadows first (CLOUD_LIGHT), so a covered patch goes cool under the tint below.
    const cloudLight = shared.clouds();
    let sunlit = reflectedLight.directDiffuse;
    let skylit = reflectedLight.indirectDiffuse;
    if (cloudLight) {
      const { sun, sky } = cloudLight();
      sunlit = sunlit.mul(sun).toVar();
      skylit = skylit.mul(sky).toVar();
      outgoingLight.addAssign(sunlit.sub(reflectedLight.directDiffuse));
    }
    const direct = dot(sunlit, LUMA);
    const indirect = dot(skylit, LUMA);
    const shade = smoothstep(shared.shadeKnee, 1.0, indirect.div(max(direct.add(indirect), 1e-4)));
    const tinted = mix(skylit, shared.shadowColor.mul(indirect), shade.mul(shared.shadowTint)).toVar();
    outgoingLight.addAssign(tinted.sub(reflectedLight.indirectDiffuse));
    // The two halves of the diffuse light as they now stand, for a subclass that needs the light
    // on the surface (the window streaks, util/gpupaint.js).
    this.sunlit = sunlit;
    this.fill = tinted;
    // The paved junction, on the ground only (`userData.brush` 2, tagged in main.js before the
    // first compile). A display-space multiply in the GLSL, so: encode, pave, decode.
    const paving = material.userData.brush === 2 ? shared.paving() : null;
    if (paving) {
      outgoingLight.assign(sRGBTransferEOTF(paving(sRGBTransferOETF(outgoingLight), positionWorld)));
    }
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
//
// `lightingFactory`: a material that needs more at the lighting seams (the water does) hands in a
// function from this model's class to a subclass of it. On the instance, so `copy` carries it;
// `Material.clone()` copies parameters and would otherwise hand back a plain prop.
const propMaterial = (Base, specular) => class extends Base {
  setupLightingModel() {
    const Model = this.lightingFactory ? this.lightingFactory(PropLightingModel) : PropLightingModel;
    return new Model(specular);
  }

  copy(source) {
    super.copy(source);
    this.lightingFactory = source.lightingFactory;
    return this;
  }

  // three builds a material's nodes once per cache key and hands that build to every material
  // with the same key, and nothing decided in `setupLightingModel` is in the key unless it is
  // put there. Without this the ground never built its own: it drew with a plain prop's nodes and
  // the paved junction was missing, with `finish` never once called for it.
  customProgramCacheKey() {
    return `brush${this.userData.brush ?? 0}${this.lightingFactory ? this.uuid : ''}`;
  }
};

export class PropLambertNodeMaterial extends propMaterial(MeshLambertNodeMaterial, false) {
  static get type() { return 'PropLambertNodeMaterial'; }
}

export class PropPhongNodeMaterial extends propMaterial(MeshPhongNodeMaterial, true) {
  static get type() { return 'PropPhongNodeMaterial'; }
}

Object.defineProperty(PropLambertNodeMaterial.prototype, 'shadowSide', webglShadowSide);
Object.defineProperty(PropPhongNodeMaterial.prototype, 'shadowSide', webglShadowSide);
