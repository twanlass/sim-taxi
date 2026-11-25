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
import {
  diffuseColor, dot, max, mix, positionWorld, property, smoothstep, sRGBTransferEOTF, sRGBTransferOETF, uniform, vec3,
} from 'three/tsl';

// Set by util/geo.js, which owns SHADOW_UNIFORMS; a setter rather than an import because geo.js
// imports this file.
// `clouds` is `() => cloudLight | null`, asked as a material is built: weather is decided after
// this module loads (`setCloudShadows`), and a city without it compiles none of the field.
// `paving` is the same shape: `() => paving | null`, the painterly look's junction (util/gpupaving.js).
// `snow` is the same shape again: `() => cover | null`, the snow on whatever faces up (util/gpusnow.js).
const shared = {
  shadowColor: null, shadowTint: null, shadeKnee: 0.45, clouds: () => null, paving: () => null, snow: () => null,
};
export function bindPropNodes(nodes) {
  Object.assign(shared, nodes);
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * The share of a fragment's diffuse light that is fill rather than sun, for the frame's second
 * attachment (game/gpuframe.js), which is what ambient occlusion is allowed to take away. Written
 * by the prop lighting model; anything else leaves it at zero and is not occluded, as on WebGL,
 * where only a `propMaterial()` fetches the AO texture. A `propMaterial({ ao: false })` (the water)
 * leaves it at zero too.
 */
export const aoShare = property('float', 'aoShare');
/**
 * Whether this fragment is car paint that wears the rim line, and how much of the sun reaches it:
 * 0 on anything else, 0.5 in full shadow to 1 in full sun. The line itself is drawn by the frame's
 * last pass (game/gpuframe.js); only the paint (util/gpupaint.js) writes this.
 */
export const rimShare = property('float', 'rimShare');
/** The sun's own brightness, unshadowed: what `rimShare` measures the light on a fragment against. */
export const rimSunLuma = uniform(1);

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
    const fillShare = indirect.div(max(direct.add(indirect), 1e-4)).toVar();
    if (material.userData.ao !== false) aoShare.assign(fillShare);
    const shade = smoothstep(shared.shadeKnee, 1.0, fillShare);
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

  // `surfaces`: `[{ key, paint }]`, each a multiply on the diffuse colour where a GLSL patch
  // after `<color_fragment>` ran (the facade courses, city/facade.js). `paint()` answers the
  // factor; `key` goes in the cache key, for the reason given below.
  setupDiffuseColor(builder) {
    super.setupDiffuseColor(builder);
    for (const surface of this.surfaces ?? []) diffuseColor.rgb.mulAssign(surface.paint());
    // After the surfaces, as the GLSL runs after the facade's courses: snow covers the wall's paint.
    const snow = this.snowy() ? shared.snow() : null;
    if (snow) diffuseColor.rgb.assign(snow(diffuseColor.rgb));
  }

  // Not the vehicles (paint carries `gloss`) and not the water (city/riverwater.js says so).
  snowy() {
    return !this.gloss && this.userData.snow !== false && shared.snow() !== null;
  }

  copy(source) {
    super.copy(source);
    this.lightingFactory = source.lightingFactory;
    this.surfaces = source.surfaces;
    return this;
  }

  // three builds a material's nodes once per cache key and hands that build to every material
  // with the same key, and nothing decided in `setupLightingModel` is in the key unless it is
  // put there. Without this the ground never built its own: it drew with a plain prop's nodes and
  // the paved junction was missing, with `finish` never once called for it.
  customProgramCacheKey() {
    const surfaces = (this.surfaces ?? []).map((surface) => surface.key).join(',');
    const ao = this.userData.ao === false ? 'flat' : 'ao';
    return `brush${this.userData.brush ?? 0}|${ao}|${surfaces}|${this.lightingFactory ? this.uuid : ''}${this.snowy() ? '|snow' : ''}`;
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
