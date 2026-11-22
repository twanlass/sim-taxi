/**
 * Small pieces the WebGPU twins of hand-written `ShaderMaterial`s share.
 *
 * A twin keeps the GLSL material's `uniforms` bag as its own: every caller that writes
 * `material.uniforms.uX.value` goes on working, and the nodes read the same slots.
 */
import { uniform } from 'three/tsl';

/**
 * One uniform slot as a node. A number is copied in each render, since a write to `slot.value`
 * replaces it; a Color, vector or matrix is held by reference, since those are mutated in place
 * (and must be: a slot whose object is swapped for a new one is not followed).
 */
export const live = (slot) => (typeof slot.value === 'number'
  ? uniform(slot.value).onRenderUpdate(() => slot.value)
  : uniform(slot.value));

/** Every slot of a bag whose name passes `pick`, as nodes under the same names. */
export const liveUniforms = (bag, pick = () => true) => Object.fromEntries(
  Object.entries(bag).filter(([name]) => pick(name)).map(([name, slot]) => [name, live(slot)]));
