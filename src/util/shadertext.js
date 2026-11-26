/**
 * Two materials that draw the same thing compile to the same WGSL text, so the GPU driver
 * compiles that shader once instead of twice.
 *
 * **Why.** On a cold boot the driver compiles each *distinct* shader module once, and on an
 * M-series Mac that costs ~110 ms even for a 5 KB fragment shader and ~340 ms for the biggest
 * (tools/shadercost.mjs, 2026-11-26: 115 fragment modules, 17.8 s compiled one at a time). A second
 * pipeline that reuses a module is close to free. So every pair of modules that differ by nothing
 * that matters is a tenth of a second or more of first load, and three writes a lot of them:
 *
 *   - **Varying locations with holes.** three gives each varying `@location(i)` with `i` its index
 *     in the list of *all* varyings, including ones that never leave the vertex stage. An instanced
 *     mesh keeps an extra one of those, which shifts every location after it, and its fragment
 *     shader comes out as `@location( 2 ) v_positionView` where the plain mesh's says `( 1 )`.
 *     Renumbered here in the order they were written. Both stages are built from the same list in
 *     the same order (`getVaryings`), so they stay matched.
 *   - **Names off a per-build counter.** `nodeUniformN`, `nodeVarN`, `nodeVaryingN` and
 *     `NodeBuffer_N` count everything the build met, in both stages, so a vertex stage that needs
 *     one more (an instance matrix, a wave anchor) renames everything the fragment stage declares.
 *     Renumbered here per module and per family in order of first appearance. A name is only an
 *     identifier: buffers are laid out by member order, bound by `@binding` number, and stages
 *     matched by `@location`, none of which this touches.
 *
 * Off with `?shadertext=classic`.
 */

// No closing `\b`: `nodeUniform5_sampler` is one word to a regex, and it has to follow its texture.
import * as THREE from 'three';

const COUNTED = /\b(nodeUniform|nodeVarying|nodeVar|NodeBuffer_)(\d+)(?!\d)/g;

/** Renumber three's counter-named identifiers by order of first appearance, per family. */
export function canonicalUniforms(code) {
  const names = new Map();
  const counts = new Map();
  return code.replace(COUNTED, (_, family, n) => {
    const key = family + n;
    let fresh = names.get(key);
    if (fresh === undefined) {
      fresh = counts.get(family) ?? 0;
      counts.set(family, fresh + 1);
      names.set(key, fresh);
    }
    return family + fresh;
  });
}

export function installShaderText(renderer) {
  const backend = renderer.backend;
  const create = backend.createNodeBuilder.bind(backend);
  let patched = false;
  backend.createNodeBuilder = (...args) => {
    const builder = create(...args);
    if (!patched) {
      patched = true;
      const owner = (name) => {
        let proto = Object.getPrototypeOf(builder);
        while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
        return proto;
      };
      const varyingsOwner = owner('getVaryings');
      const getVaryings = varyingsOwner.getVaryings;
      varyingsOwner.getVaryings = function compactVaryings(shaderStage) {
        let next = 0;
        return getVaryings.call(this, shaderStage).replace(/@location\( \d+ \)/g, () => `@location( ${next++} )`);
      };
      // An instanced mesh with no per-instance colour is handed a white one before it builds, so it
      // compiles the same shader as its tinted twin (x 1 is no change): six fragment modules of
      // 99 on a headless boot differed by nothing else.
      const buildOwner = owner('build');
      const build = buildOwner.build;
      buildOwner.build = function whiteInstances(...rest) {
        const object = this.object;
        if (object?.isInstancedMesh && !object.instanceColor) {
          const n = object.instanceMatrix.count;
          object.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
        }
        return build.apply(this, rest);
      };
      const codeOwner = owner('buildCode');
      const buildCode = codeOwner.buildCode;
      codeOwner.buildCode = function canonicalCode() {
        buildCode.call(this);
        if (this.vertexShader) this.vertexShader = canonicalUniforms(this.vertexShader);
        if (this.fragmentShader) this.fragmentShader = canonicalUniforms(this.fragmentShader);
        if (this.computeShader) this.computeShader = canonicalUniforms(this.computeShader);
      };
    }
    return builder;
  };
}
