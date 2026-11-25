/**
 * Memoised type queries for three's node builder, so the warm-up stops re-walking the same graphs.
 *
 * **Why this exists.** Under WebGPU the boot is not waiting on the GPU. It is waiting on three
 * turning every material's node graph into WGSL, in JavaScript, before a pipeline can be asked for
 * — ~310 builds on a boot, and a CPU profile of one (headless, 2026-11-24) put **~70% of the whole
 * boot** inside `NodeBuilder.build`. Most of that is one question asked over and over:
 * `getNodeType`. It is not cached anywhere. An `OperatorNode` answers it by asking both its
 * inputs, a `MathNode` by asking all three, a `VarNode` by asking what it wraps, and `generate`
 * asks it again of itself and of each input on the way down — so a node deep in a lit material is
 * asked once for every path from the output down to it, and a material's graph is a DAG with a lot
 * of paths. The leaves of that recursion are `getTypeLength`/`getComponentType`/`isMatrix`, each a
 * fresh regex over a type name: in the profile `getTypeLength` alone was the single hottest
 * function in the boot, ahead of the garbage collector.
 *
 * Two layers, both answers the builder would have given anyway:
 *
 *   - **The type-name helpers** (`getTypeLength`, `getComponentType`, `getVectorType`, `isMatrix`,
 *     `isVector`) are pure functions of a string. A `Map` per helper.
 *   - **`getNodeType(builder)`**, per node, during the `analyze` and `generate` stages only, keyed
 *     on everything the answer can read: the stage, the shader stage, the builder's node cache
 *     (`setCache` swaps it inside functions and `cache()` nodes), its context object (contexts are
 *     replaced, never mutated, by `ContextNode`), and the sub-build it is in. `setup` is left
 *     alone: a node's `outputNode` — which `Node.getNodeType` reads — is assigned *during* setup,
 *     so an answer cached there could be from before it existed. A call with an explicit `output`
 *     (`OperatorNode` takes one) is passed straight through.
 *
 * Each class's own `getNodeType` is wrapped where it is defined, the first time one of its nodes
 * reaches `addNode`, with its own table — so a subclass calling `super.getNodeType` gets the
 * superclass's answer and not its own back from the cache.
 *
 * **How it was checked.** Every WGSL module the boot creates, with and without this, captured in
 * headless Chromium and compared: identical, module for module (tools/boottime.mjs `--compare`).
 * `?nodememo=classic` turns it off for an A/B.
 */

const PURE = ['getTypeLength', 'getComponentType', 'getVectorType', 'isMatrix', 'isVector'];
const MEMO_STAGES = new Set(['analyze', 'generate']);

export function installNodeMemo(renderer) {
  const backend = renderer.backend;
  const create = backend.createNodeBuilder.bind(backend);
  let patched = false;
  backend.createNodeBuilder = (...args) => {
    const builder = create(...args);
    if (!patched) {
      patched = true;
      patchBuilder(builder);
    }
    return builder;
  };
}

function patchBuilder(builder) {
  // The base class, wherever WGSLNodeBuilder or GLSLNodeBuilder sit above it.
  let base = Object.getPrototypeOf(builder);
  while (Object.getPrototypeOf(base) && Object.getPrototypeOf(base) !== Object.prototype) {
    base = Object.getPrototypeOf(base);
  }
  for (const name of PURE) {
    // Only where the base defines it and no subclass overrides it, so the memo can never stand in
    // for a backend-specific answer.
    if (typeof base[name] !== 'function') continue;
    let owner = Object.getPrototypeOf(builder);
    while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    if (owner !== base) continue;
    const original = base[name];
    const memo = new Map();
    base[name] = function memoised(type) {
      if (typeof type !== 'string' || arguments.length > 1) return original.apply(this, arguments);
      let value = memo.get(type);
      if (value === undefined && !memo.has(type)) {
        value = original.call(this, type);
        memo.set(type, value);
      }
      return value;
    };
  }

  // Compared field by field rather than folded into a string: this runs millions of times a boot,
  // and the first cut — a template-literal key per call — spent more in building keys than the
  // lookups saved (668 ms self in the profile, against ~2 s of `getNodeType` it replaced).
  const sameAsk = (hit, b) => hit.builder === b && hit.buildStage === b.buildStage
    && hit.shaderStage === b.shaderStage && hit.cache === b.cache && hit.context === b.context
    && hit.subBuild === subBuildOf(b);
  const subBuildOf = (b) => (b.subBuildLayers.length === 0 ? '' : b.subBuildLayers.join(','));

  const wrapped = new WeakSet();
  const wrapClass = (node) => {
    for (let proto = Object.getPrototypeOf(node); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      if (wrapped.has(proto)) break;
      wrapped.add(proto);
      if (!Object.prototype.hasOwnProperty.call(proto, 'getNodeType')) continue;
      const original = proto.getNodeType;
      // node -> the last answer and the state it was asked under. One slot, not a map of
      // keys — a node is asked in long runs under the same key and then moves on, and a WeakMap of
      // Maps costs more to build than the misses it would save.
      const memo = new WeakMap();
      proto.getNodeType = function memoGetNodeType(b, output) {
        if (output !== undefined && output !== null) return original.call(this, b, output);
        if (!b || !MEMO_STAGES.has(b.buildStage) || !b.subBuildLayers) return original.call(this, b);
        const hit = memo.get(this);
        if (hit !== undefined && sameAsk(hit, b)) return hit.type;
        // The state it was asked under, read before the call in case the call moves any of it.
        const ask = {
          builder: b, buildStage: b.buildStage, shaderStage: b.shaderStage, cache: b.cache,
          context: b.context, subBuild: subBuildOf(b), type: undefined,
        };
        ask.type = original.call(this, b);
        memo.set(this, ask);
        return ask.type;
      };
    }
  };

  const addNode = base.addNode;
  base.addNode = function memoAddNode(node) {
    if (node) wrapClass(node);
    return addNode.apply(this, arguments);
  };
}
