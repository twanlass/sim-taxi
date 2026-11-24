/**
 * Turns three's single-assignment WGSL `var`s into `let`s, so Safari will compile the city.
 *
 * **Why this exists.** WebKit's WGSL compiler enforces the spec's limit on a function's storage:
 * the `var`s declared in one function may add up to 8192 bytes and no more
 * (`maximumCombinedFunctionVariablesSize`, Source/WebGPU/WGSL/GlobalVariableRewriter.cpp), and a
 * shader over it fails to compile — "The combined byte size of all variables in this function
 * exceeds 8192 bytes". Tint, which Chrome uses, does not check it, so nothing on a desktop or in
 * headless Chromium ever sees it. On an iPhone it took the first city material over the line,
 * the device error handler in main.js dropped the occlusion pass, and the city did not draw.
 *
 * Three's node builder declares a `var` for **every** cached node — 1,240 of them in the fragment
 * of the busiest material measured (8,528 bytes: 580 f32, 457 vec2, 151 vec3, 33 vec4), with the
 * plain lit materials at ~6,064 and the rest of the 230 modules close behind. Almost all of them
 * are written exactly once and only read after that, which is what `let` is, and `let` is not
 * storage: WebKit counts only the `var` flavour, and the GPU compilers fold both to the same
 * registers either way. So this rewrites, per function, each `var name : T;` that:
 *
 *   - has exactly one write, a whole statement on its own line `name = expr;` whose expr does not
 *     read `name` (three emits one statement per line; a `.x =`, `[i] =`, `+=`, `++` or `&name`
 *     anywhere is another write and leaves the var alone);
 *   - is read only after that line, and only inside the block the write sits in (a var written in
 *     an `if` and read past it has to stay a var, and a read on an `} else {` line counts as past
 *     it);
 *
 * into `let name : T = expr;` at the write, and drops the declaration. Anything it cannot prove
 * stays exactly as three wrote it, so the worst a miss costs is bytes, not a wrong picture.
 * Measured on the same capture (headless Chromium, 230 modules, 2026-11-23): the busiest function
 * went from 8,528 bytes to 580, and a shot-mode frame drew pixel-identical with and without it. What
 * is left is vars written in more than one place, which three needs for its `If`s and loops.
 * tools/probe.mjs holds the rewrite to its rules on a small module.
 */

const DECL = /^\s*var\s+(\w+)\s*:\s*([^;=]+?)\s*;\s*$/;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The depth at the start of each line, and the lowest depth each line touches. */
function depths(lines) {
  const start = [];
  const low = [];
  let depth = 0;
  for (const line of lines) {
    start.push(depth);
    let min = depth;
    const code = line.replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth < min) min = depth; }
    }
    low.push(min);
  }
  return { start, low };
}

/**
 * Rewrite one function's lines in place. `from`/`to` are the lines of its body, braces excluded.
 *
 * Indexed rather than scanned: the first cut tested every line of the body against three fresh
 * regexes for every `var`, and with ~1,200 vars over ~2,000 lines in the busiest functions that was
 * quadratic — 1.5 s of the WebGPU warm-up's JavaScript, headless (2026-11-23), more than three's
 * own WGSL generation. Each identifier's lines are now collected in one pass, a `var` only looks at
 * the lines that name it, and where each line's block ends is worked out once. Same output, byte for
 * byte, over the 120 modules a boot builds.
 */
function rewriteBody(lines, from, to, depth) {
  const decls = [];
  // Every line each identifier appears on, in order. `\bname\b` holds on a line exactly when one of
  // its maximal `\w` runs is `name`, which is what this collects.
  const seen = new Map();
  for (let i = from; i < to; i++) {
    const line = lines[i];
    const m = line.match(DECL);
    if (m && !m[2].startsWith('array')) decls.push({ line: i, name: m[1], type: m[2] });
    for (const [word] of line.matchAll(/\w+/g)) {
      let at = seen.get(word);
      if (!at) seen.set(word, (at = []));
      if (at[at.length - 1] !== i) at.push(i);
    }
  }
  // The block a line sits in ends on the first later line that dips below its starting depth.
  // Walked backwards, holding for each depth the nearest later line that dips below it.
  let blockEnd = null;
  const endOf = (line) => {
    if (!blockEnd) {
      blockEnd = new Int32Array(to - from);
      let deepest = 0;
      for (let i = from; i < to; i++) deepest = Math.max(deepest, depth.start[i]);
      const below = new Int32Array(deepest + 1).fill(to);
      for (let i = to - 1; i >= from; i--) {
        blockEnd[i - from] = below[depth.start[i]];
        for (let k = Math.max(0, depth.low[i] + 1); k <= deepest; k++) below[k] = i;
      }
    }
    return blockEnd[line - from];
  };
  let saved = 0;
  for (const { line: declLine, name, type } of decls) {
    const word = new RegExp(`\\b${escape(name)}\\b`);
    const plain = new RegExp(`^(\\s*)${escape(name)}\\s*=(?!=)\\s*(.*);\\s*$`);
    const write = new RegExp(
      `(\\b${escape(name)}\\b(\\s*(\\.\\w+|\\[[^\\]]*\\]))*\\s*(<<|>>|[-+*/%&|^])?=(?!=))|(\\b${escape(name)}\\b\\s*(\\+\\+|--))|((^|[^&])&\\s*${escape(name)}\\b)`);
    let assign = -1;
    let ok = true;
    const uses = [];
    for (const i of seen.get(name)) {
      // Lines already rewritten above can have lost the name; the index is only a shortlist.
      if (i === declLine || !word.test(lines[i])) continue;
      const m = lines[i].match(plain);
      if (m && !word.test(m[2])) {
        if (assign !== -1) ok = false;
        else assign = i;
        if (!ok) break;
        continue;
      }
      if (write.test(lines[i])) { ok = false; break; }
      uses.push(i);
    }
    if (!ok || assign === -1) continue;
    const end = endOf(assign);
    if (!uses.every((i) => i > assign && i < end)) continue;
    const [, indent, expr] = lines[assign].match(plain);
    lines[assign] = `${indent}let ${name} : ${type} = ${expr};`;
    lines[declLine] = '';
    saved++;
  }
  return saved;
}

/** The WGSL module with every provably single-assignment function-scope `var` made a `let`. */
export function varsToLets(code) {
  if (typeof code !== 'string' || !code.includes('var')) return code;
  const lines = code.split('\n');
  const depth = depths(lines);
  // Each function: from the line holding `fn` to its closing brace at depth 0.
  for (let i = 0; i < lines.length; i++) {
    if (depth.start[i] !== 0 || !/^\s*fn\s/.test(lines[i])) continue;
    let open = i;
    while (open < lines.length && !lines[open].includes('{')) open++;
    let close = open + 1;
    while (close < lines.length && depth.low[close] > 0) close++;
    if (close >= lines.length) break;
    rewriteBody(lines, open + 1, close, depth);
    i = close;
  }
  return lines.join('\n');
}

/**
 * The combined size, in bytes, of the `var`s each function declares — WebKit's count, for the
 * check. Unknown types count 16. Returns `[{ fn, bytes }]`.
 */
export function functionVarBytes(code) {
  const size = (t) => {
    t = t.replace(/\s/g, '');
    let m;
    if ((m = t.match(/^array<(.+),(\d+)u?>$/))) { const e = size(m[1]); return (e === 12 ? 16 : e) * Number(m[2]); }
    if (/^(f32|i32|u32|bool)$/.test(t)) return 4;
    if (t === 'f16') return 2;
    if ((m = t.match(/^vec(\d)<(\w+)>$/))) return Number(m[1]) * (m[2] === 'f16' ? 2 : 4);
    if ((m = t.match(/^mat(\d)x(\d)<f32>$/))) return Number(m[1]) * (m[2] === '3' ? 16 : Number(m[2]) * 4);
    return 16;
  };
  const out = [];
  const re = /\bfn\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index);
    let depth = 0;
    let k = open;
    for (; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}' && --depth === 0) break;
    }
    let bytes = 0;
    for (const v of code.slice(open, k).matchAll(/\bvar\s+\w+\s*(?::\s*([^=;]+))?/g)) bytes += v[1] ? size(v[1]) : 16;
    out.push({ fn: m[1], bytes });
  }
  return out;
}

/**
 * Run `varsToLets` over every shader `renderer` builds from here on. Patches the node builder's
 * class once, through the first builder the backend hands out (three does not export the class).
 */
export function installVarsToLets(renderer) {
  const backend = renderer.backend;
  const create = backend.createNodeBuilder.bind(backend);
  let patched = false;
  backend.createNodeBuilder = (...args) => {
    const builder = create(...args);
    if (!patched) {
      patched = true;
      const proto = Object.getPrototypeOf(builder);
      const buildCode = proto.buildCode;
      // Remembered by source: a boot builds ~640 shader stages and only ~250 of them are distinct
      // (the same vertex stage under dozens of materials, the same material under several
      // passes), and the rewrite is a pure function of the text. Measured headless (2026-11-24):
      // ~1 s of rewriting a boot down to the distinct ones. The map lives as long as the renderer,
      // and holds about what three's own program cache does.
      const seen = new Map();
      const rewrite = (code) => {
        let out = seen.get(code);
        if (out === undefined) { out = varsToLets(code); seen.set(code, out); }
        return out;
      };
      proto.buildCode = function () {
        buildCode.call(this);
        for (const key of ['vertexShader', 'fragmentShader', 'computeShader']) {
          if (typeof this[key] === 'string') this[key] = rewrite(this[key]);
        }
      };
    }
    return builder;
  };
}
