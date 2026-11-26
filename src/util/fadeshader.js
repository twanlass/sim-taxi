/**
 * One fragment shader for a material whether it is drawn opaque or faded.
 *
 * three's node materials write the alpha two ways (`NodeMaterial.setupDiffuseColor`): opaque, it
 * is pinned to 1 so the see-through canvas never shows the page; transparent, a fragment at alpha 0
 * is discarded. Two different texts, so a rider who fades on getting in, a parcel, a burger bag and
 * a wreck's shell each compile a second fragment shader for the faded state, and on a cold boot
 * the driver pays for each (~110 to 340 ms a module on an M-series Mac, tools/shadercost.mjs,
 * 2026-11-26).
 *
 * Here both states write `alpha = transparent ? alpha : 1`, off a uniform. The same text either
 * way, and the same pixels: opaque is pinned exactly as before, and faded drops the discard, which
 * only ever removed a fragment that the source-alpha blend was about to add at zero weight. That
 * holds only where the faded state writes no depth (a discarded fragment writes none; a blended
 * one at zero would), which is how everything in the game fades (`depthWrite: false`), so anything
 * else keeps three's own branch. No discard is added to any opaque shader, so a tile-based GPU
 * keeps its hidden-surface removal.
 *
 * Off with `?fadeshader=classic`.
 */
import { NodeMaterial } from 'three/webgpu';
import { NormalBlending } from 'three';
import { Fn, diffuseColor, float, materialOpacity, property, select, uniform } from 'three/tsl';

// One node for every material: three reads it per object drawn.
const seeThrough = uniform(0).onObjectUpdate(({ material }) => (material?.transparent ? 1 : 0));
/** The alpha three computed, kept before its opaque branch pins it to 1. */
const fadeAlpha = property('float', 'fadeAlpha');

let installed = false;
export function installFadeShader() {
  if (installed) return;
  installed = true;
  const setup = NodeMaterial.prototype.setupDiffuseColor;
  NodeMaterial.prototype.setupDiffuseColor = function oneFadeShader(builder) {
    const plain = this.blending === NormalBlending && this.alphaToCoverage === false
      && this.alphaTestNode === null && !(this.alphaTest > 0) && this.alphaHash !== true;
    if (!plain || (this.transparent && this.depthWrite)) return setup.call(this, builder);
    // three's opaque branch, whatever the state, with the alpha kept on the way past: the opacity
    // node is where three multiplies the colour's alpha by the opacity, so it is the one seam
    // between the alpha being known and being pinned.
    const was = this.transparent;
    const opacityNode = this.opacityNode;
    const opacity = opacityNode ? float(opacityNode) : materialOpacity;
    this.opacityNode = Fn(() => {
      fadeAlpha.assign(diffuseColor.a.mul(opacity));
      return opacity;
    })();
    this.transparent = false;
    try {
      setup.call(this, builder);
    } finally {
      this.transparent = was;
      this.opacityNode = opacityNode;
    }
    diffuseColor.a.assign(select(seeThrough.greaterThan(0.5), fadeAlpha, float(1)));
  };
}
