/**
 * Small pieces the WebGPU twins of hand-written `ShaderMaterial`s share.
 *
 * A twin keeps the GLSL material's `uniforms` bag as its own (`material.uniforms`): every caller
 * that writes `material.uniforms.uX.value` goes on working, and the nodes read the same slots.
 */
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, materialOpacity, uniform, varying } from 'three/tsl';

/**
 * Every slot of a bag whose name passes `pick`, as nodes under the same names.
 *
 * Each is read from **the material being drawn**, as it is drawn, not from the bag in hand. three
 * builds the nodes once for every material with the same cache key, so three glints made from one
 * recipe are one build; a node that closed over its own bag would give all three the first one's
 * strength. It also means a slot's object may be swapped as well as mutated.
 */
export const liveUniforms = (bag, pick = () => true) => Object.fromEntries(
  Object.entries(bag).filter(([name]) => pick(name)).map(([name, slot]) => [
    name,
    uniform(slot.value).onObjectUpdate(({ material }) => material.uniforms[name].value),
  ]));

/**
 * A twin for the commonest kind: an unlit effect whose GLSL wrote its own colour and alpha.
 * `build(u)` answers `{ color, opacity }` from the uniform nodes.
 *
 * `display: true` is for a shader with no colour-space chunk, which wrote its numbers to the
 * canvas as they stood (the additive glows): the twin then does the same and is not graded.
 * Without it the colour is linear and takes the encode and the grade like any marker.
 */
export function unlitTwin(source, build, { display = false } = {}) {
  const material = new MeshBasicNodeMaterial({
    transparent: source.transparent,
    depthWrite: source.depthWrite,
    depthTest: source.depthTest,
    blending: source.blending,
    side: source.side,
    premultipliedAlpha: source.premultipliedAlpha,
    fog: false,
  });
  material.uniforms = source.uniforms;
  material.visible = source.visible;
  material.userData.display = display;
  const { color, opacity } = build(liveUniforms(source.uniforms, (name) => source.uniforms[name].value !== null
    && !source.uniforms[name].value?.isTexture));
  material.colorNode = color;
  if (opacity !== undefined) material.opacityNode = opacity;
  return material;
}

/**
 * A per-instance alpha from the `aAlpha` attribute: the three-line patch every mote pool carries
 * (dust, flames, sparks, spray, the wake...), for WebGPURenderer. `instanceColor` is RGB only on
 * both renderers. Set on the built-in material itself: three copies every property across when it
 * converts one to a node material, and node properties are part of the cache key.
 *
 * `userData.ported` tells game/gpucompat.js the `onBeforeCompile` beside it is accounted for.
 */
export function instanceAlpha(material, name = 'aAlpha') {
  material.opacityNode = materialOpacity.mul(varying(attribute(name, 'float')));
  material.userData.ported = true;
  return material;
}
