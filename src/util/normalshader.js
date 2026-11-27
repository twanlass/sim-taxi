/**
 * One fragment shader whether a material is flat-shaded or smooth, and whether it faces front or
 * back.
 *
 * three decides both at build time (`normalViewGeometry`, `directionToFaceDirection`): a flat
 * material takes its normal from screen-space derivatives and a smooth one from an interpolated
 * vertex normal, and a back-sided one negates the smooth normal. So a prop drawn flat and the same
 * prop drawn smooth, or a front and a back face of one recipe, are different shader text, and on a
 * cold boot the driver compiles each (~110 to 340 ms a module on an M-series Mac,
 * tools/shadercost.mjs, 2026-11-26).
 *
 * Here every such material is built as smooth and front-sided with the normal picked by uniforms:
 * `flat ? derivative normal : side * interpolated normal`. Both are computed and one is kept, so
 * the pixels are the ones three would have drawn either way. The cost is one varying a flat mesh
 * did not interpolate before. Left alone: double-sided materials (their sign is per fragment),
 * anything carrying its own normal (`normalNode`, a normal or bump map), and geometry with no
 * normal attribute to interpolate.
 *
 * Off with `?normalshader=classic`.
 */
import { BackSide, DoubleSide } from 'three';
import { MeshBasicNodeMaterial, NodeMaterial } from 'three/webgpu';
import { normalFlat, normalLocal, select, transformNormalToView, uniform } from 'three/tsl';

// One node each for every material: three reads them per object drawn.
const flat = uniform(0).onObjectUpdate(({ material }) => (material?.flatShading ? 1 : 0));
const side = uniform(1).onObjectUpdate(({ material }) => (material?.side === BackSide ? -1 : 1));
const normal = select(flat.greaterThan(0.5), normalFlat,
  transformNormalToView(normalLocal).toVarying('v_normalViewGeometry').normalize().mul(side));

// The builds are synchronous and one at a time, so "the build in progress" is a variable.
let active = false;

/**
 * Two seams, because neither alone reaches. `flatShading` is read during the builder's whole
 * setup stage (`normalViewGeometry` is evaluated wherever the graph first meets it), so it is
 * switched for the duration of `NodeBuilder.build`, on the material the build was handed, before a
 * stock Lambert or Basic is converted (`NodeMaterial.fromMaterial` copies it across). The normal
 * itself goes in at `setupNormal`, on the node material, whichever one that turned out to be.
 */
export function installNormalShader(renderer) {
  const patchSetup = (proto) => {
    const setupNormal = proto.setupNormal;
    proto.setupNormal = function maybeOneNormal(builder) {
      return active ? normal : setupNormal.call(this, builder);
    };
  };
  patchSetup(NodeMaterial.prototype);
  patchSetup(MeshBasicNodeMaterial.prototype);

  const backend = renderer.backend;
  const create = backend.createNodeBuilder.bind(backend);
  let patched = false;
  backend.createNodeBuilder = (...args) => {
    const builder = create(...args);
    if (!patched) {
      patched = true;
      let owner = Object.getPrototypeOf(builder);
      while (owner && !Object.prototype.hasOwnProperty.call(owner, 'build')) owner = Object.getPrototypeOf(owner);
      const build = owner.build;
      owner.build = function oneNormalShader(...rest) {
        const material = this.material;
        const ok = material && !material.normalNode && !material.normalMap && !material.bumpMap
          && material.side !== DoubleSide && this.geometry?.hasAttribute?.('normal')
          && !Object.prototype.hasOwnProperty.call(material, 'setupNormal')
          && (!material.isNodeMaterial || material.setupNormal === NodeMaterial.prototype.setupNormal
            || material.setupNormal === MeshBasicNodeMaterial.prototype.setupNormal);
        if (!ok || active) return build.apply(this, rest);
        const wasFlat = material.flatShading;
        material.flatShading = false;
        active = true;
        try {
          return build.apply(this, rest);
        } finally {
          active = false;
          material.flatShading = wasFlat;
        }
      };
    }
    return builder;
  };
}
