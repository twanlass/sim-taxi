import * as THREE from 'three';

/**
 * Who the draw calls are, and which of them could be one — the ⚙️ panel's **Draw calls** section.
 *
 * **What a draw call is here.** One per (object, material) pair per pass: a `Mesh` with one
 * material is one call, a multi-material mesh is one per geometry group, and an `InstancedMesh` is
 * one however many instances it draws. So the number of meshes is only half the story — two meshes
 * are two calls even when they share everything — and the passes multiply it: the main render, the
 * movers' shadow map every frame (the standing city's map is drawn once; game/splitshadow.js), the
 * wet road's mirror under `?rain`, and the full-screen quads after.
 *
 * **What can become one.** Draws that share a *material* (same shader, same uniforms) are the
 * candidates. If they also share a *geometry*, they can be instanced into one call whatever they
 * do; if their geometries differ, they can be merged into one only while they stand still, because
 * a merged mesh has one transform. Draws that share a *shader* but not a material (two
 * `propMaterial()`s that differ only in colour) are the next ring out: they merge once the colour
 * moves into vertex colours and the two materials become one.
 *
 * **How it counts.** One hook on the backend's draw (`backend.draw` on WebGPU, `renderBufferDirect`
 * on WebGL), switched on only while the section is counting, and a frame boundary from the render
 * path (`frameStart`, game/renderpath.js). Grouping keys off the object's *own* material, never
 * the draw's: the shadow pass draws everything with one depth material, and keying on that would
 * lump the whole shadow map into one group.
 *
 * **What moves.** Read off the world matrices: a mesh whose matrix changes between two samples is
 * marked moving for good. A mesh caught standing still at a red light reads static until it pulls
 * away, so give the count a few seconds of play before trusting the savings column.
 */

const PASS_ORDER = ['main', 'shadow', 'post', 'other'];

// The inspector the render path reports frames to — one per page, made by the ⚙️ panel's boot.
let active = null;

/** The top of a frame, from game/renderpath.js. Costs a null check when nothing is counting. */
export function drawCallFrameStart() {
  active?.frameStart();
}

/** One pass label per draw, from the render target the backend is drawing into. */
function passOf(renderer, object) {
  if (object.isQuadMesh || object.isFullscreenQuad) return 'post';
  const target = renderer.getRenderTarget();
  if (!target) return 'main';
  const name = target.texture?.name ?? '';
  if (name === 'ShadowMap' || name.endsWith('.shadowMap')) return `shadow ${target.width}`;
  if (target.textures?.[0]?.name === 'output') return 'main';
  return `other ${target.width}×${target.height}`;
}

const passRank = (p) => {
  const i = PASS_ORDER.indexOf(p.split(' ')[0]);
  return i < 0 ? 9 : i;
};

/** The material a draw belongs to: the object's own, so the shadow pass's override is seen through. */
function ownMaterial(object, group) {
  const m = object.material;
  if (!Array.isArray(m)) return m;
  return m[group?.materialIndex ?? 0] ?? m[0];
}

/** What a shader key is made of: the program a material compiles to, give or take its uniforms. */
function shaderKey(material) {
  let custom = '';
  try { custom = material.customProgramCacheKey?.() ?? ''; } catch { /* a patched material */ }
  return [material.type, material.side, material.transparent ? 't' : 'o', material.vertexColors ? 'vc' : '',
    material.map ? 'map' : '', material.alphaTest > 0 ? 'cut' : '', custom.length > 64 ? hash(custom) : custom].join('|');
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** The object's name path, for a row's label: the first named ancestors, outermost first. */
function namePath(object, scene) {
  const path = [];
  for (let o = object; o && o !== scene && path.length < 3; o = o.parent) if (o.name) path.unshift(o.name);
  return path.join('/');
}

// Distinct hues for neighbouring keys: the golden-angle walk round the wheel.
function hueFor(index) {
  const c = new THREE.Color();
  c.setHSL(((index * 0.618034) % 1), 0.75, index % 2 ? 0.5 : 0.62);
  return c;
}

export function createDrawCallInspector({ renderer, scene }) {
  const gpu = Boolean(renderer.backend);
  let counting = false;
  // The frame being counted, and the last one finished — the panel reads `last`.
  let frame = null;
  let last = null;
  // Kept across frames: the shadow map of the standing city is drawn once, so it would otherwise
  // be missing from every frame but the first.
  const onceSeen = new Map();
  const moving = new WeakSet();
  // Every object drawn since counting started, at the most draws per pass it has needed in one
  // frame — what the groups are built from, so a tube man culled this frame is still on the list.
  let seen = new Map();
  let stats = { frames: 0, sum: 0, peak: 0 };
  const lastMatrix = new WeakMap();
  // Moving in its own frame, not just carried: a taxi's parts move with the taxi but not against
  // each other, so they merge under it; a tube man's arms do not.
  const flexing = new WeakSet();
  const lastLocal = new WeakMap();

  // --- the hook ---------------------------------------------------------------------------------
  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
    if (gpu) {
      const backend = renderer.backend;
      const draw = backend.draw.bind(backend);
      backend.draw = (renderObject, info) => {
        if (counting && frame) tally(renderObject.object, renderObject.group);
        return draw(renderObject, info);
      };
    } else {
      const draw = renderer.renderBufferDirect;
      renderer.renderBufferDirect = function (cam, sc, geometry, material, object, group) {
        if (counting && frame) tally(object, group);
        return draw.call(this, cam, sc, geometry, material, object, group);
      };
    }
  }

  function tally(object, group) {
    const pass = passOf(renderer, object);
    const material = ownMaterial(object, group);
    frame.total++;
    frame.passes.set(pass, (frame.passes.get(pass) ?? 0) + 1);
    let rec = frame.draws.get(object);
    if (!rec) frame.draws.set(object, rec = { object, material, passes: new Map() });
    rec.passes.set(pass, (rec.passes.get(pass) ?? 0) + 1);
  }

  /** Called by the render path at the top of every frame; a no-op unless counting. */
  function frameStart() {
    if (!counting) return;
    if (frame) finish();
    frame = { total: 0, passes: new Map(), draws: new Map() };
  }

  function finish() {
    // A pass that drew nothing this frame but has before is a once-a-while map (the static city's
    // shadow); keep its last count so the report can say what it costs when it does redraw.
    for (const [pass, n] of frame.passes) onceSeen.set(pass, n);
    stats.frames++;
    stats.sum += frame.total;
    stats.peak = Math.max(stats.peak, frame.total);
    for (const rec of frame.draws.values()) {
      let kept = seen.get(rec.object);
      if (!kept) seen.set(rec.object, kept = { object: rec.object, material: rec.material, passes: new Map() });
      for (const [p, n] of rec.passes) kept.passes.set(p, Math.max(kept.passes.get(p) ?? 0, n));
      watch(rec.object, rec.object.matrixWorld.elements, lastMatrix, moving);
      watch(rec.object, rec.object.matrix.elements, lastLocal, flexing);
    }
    last = frame;
  }

  function watch(object, m, store, flag) {
    const prev = store.get(object);
    if (!prev) { store.set(object, Float32Array.from(m)); return; }
    for (let i = 0; i < 16; i++) if (Math.abs(prev[i] - m[i]) > 1e-5) { flag.add(object); break; }
    prev.set(m);
  }

  function setCounting(on) {
    if (on) install();
    if (on && !counting) { seen = new Map(); stats = { frames: 0, sum: 0, peak: 0 }; }
    counting = on;
    if (!on) frame = null;
  }

  // --- grouping and the report ------------------------------------------------------------------
  const keyOf = {
    material: (rec) => rec.material.uuid,
    shader: (rec) => shaderKey(rec.material),
  };

  /**
   * The frame's draws grouped by `mode` ('material' or 'shader'), biggest first, each with what it
   * would save. Per pass, a group's draws split three ways: meshes sharing one geometry instance
   * into one call; the static rest merge into one; the moving rest stay as they are.
   */
  function groups(mode = 'material') {
    if (!last) return [];
    const byKey = new Map();
    for (const rec of seen.values()) {
      const key = keyOf[mode](rec);
      let g = byKey.get(key);
      if (!g) byKey.set(key, g = { key, recs: [], draws: 0, passes: new Map(), labels: new Map() });
      g.recs.push(rec);
      for (const [pass, n] of rec.passes) {
        g.draws += n;
        g.passes.set(pass, (g.passes.get(pass) ?? 0) + n);
      }
      const label = namePath(rec.object, scene) || `${rec.material.type.replace('Material', '')}${rec.material.name ? ` ${rec.material.name}` : ''}`;
      g.labels.set(label, (g.labels.get(label) ?? 0) + 1);
    }
    for (const g of byKey.values()) {
      const geoms = new Set(g.recs.map((r) => r.object.geometry?.uuid));
      g.meshes = g.recs.length;
      g.geometries = geoms.size;
      g.instanced = g.recs.filter((r) => r.object.isInstancedMesh).length;
      g.moving = g.recs.filter((r) => moving.has(r.object)).length;
      g.label = [...g.labels].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ');
      g.type = g.recs[0].material.type.replace('Material', '');
      g.save = 0;
      for (const pass of g.passes.keys()) {
        // Only passes that draw every frame: the standing city's shadow map redraws once in a while,
        // and a draw saved there is not a draw saved a frame.
        if (last && !last.passes.has(pass)) continue;
        const recs = g.recs.filter((r) => r.passes.has(pass));
        const byGeom = new Map();
        for (const r of recs) {
          const k = r.object.geometry?.uuid;
          byGeom.set(k, [...(byGeom.get(k) ?? []), r]);
        }
        // What is left merges by what it moves with: the still ones into one mesh, the ones riding
        // a parent rigidly into one mesh under that parent, and anything bending on its own not at all.
        const rigid = new Map();
        for (const list of byGeom.values()) {
          if (list.length > 1) { g.save += list.length - 1; continue; } // instance them
          const o = list[0].object;
          const under = !moving.has(o) ? 'still' : !flexing.has(o) && o.parent ? o.parent.uuid : o.uuid;
          rigid.set(under, (rigid.get(under) ?? 0) + 1);
        }
        for (const n of rigid.values()) g.save += n - 1;
      }
      g.kind = g.instanced === g.meshes ? 'instanced' : g.moving === 0 ? 'static' : g.moving === g.meshes ? 'moving' : 'mixed';
    }
    return [...byKey.values()].sort((a, b) => b.draws - a.draws);
  }

  function passList() {
    if (!last) return [];
    const passes = new Map(last.passes);
    for (const [p, n] of onceSeen) if (!passes.has(p)) passes.set(`${p} (last drawn)`, n);
    return [...passes].sort((a, b) => passRank(a[0]) - passRank(b[0]) || b[1] - a[1]);
  }

  /** Plain text for a thread or a console: the per-pass counts and the top groups. */
  function report(mode = 'material', top = 20) {
    const gs = groups(mode);
    const save = gs.reduce((a, g) => a + g.save, 0);
    const lines = [
      `draw calls ${last?.total ?? 0} this frame (avg ${Math.round(stats.sum / Math.max(1, stats.frames))}, peak ${stats.peak} over ${stats.frames} frames) · ${passList().map(([p, n]) => `${p} ${n}`).join(' · ')}`,
      `grouped by ${mode}, everything drawn while counting: ${gs.length} groups · est. saving: ${save} draws in a frame that drew them all`,
      'draws\tmeshes\tgeoms\tkind\tsave\ttype\tlabel',
      ...gs.slice(0, top).map((g) => [g.draws, g.meshes, g.geometries, g.kind, g.save, g.type, g.label].join('\t')),
    ];
    return lines.join('\n');
  }

  // --- the tint ---------------------------------------------------------------------------------
  // Substituted at the draw, in the main pass only, and never assigned to an object: plenty of
  // per-frame code reads `mesh.material.userData` (the L train's beams do), and a swapped material
  // would hand it something else. Lambert rather than Basic so a city of one colour still shows its
  // shape; a transparent original gets a see-through tint, or the edge fog's floor would paint over
  // the island. Instance colours are parked for the length of the draw, or they would multiply into
  // the group's colour and turn the traffic into mud. Masks (`colorWrite: false`, the ghost
  // outlines' stencil) draw as they are.
  const tints = new Map();       // colour|side|transparent -> material
  let tintMode = 'off';
  let focus = null;
  let colours = new Map();       // group key -> colour, fixed when the tint is applied
  const GREY = new THREE.Color(0x3a3a40);

  /** A group's colour, handing the next hue to a group first drawn after the tint went on. */
  function colourFor(key) {
    let c = colours.get(key);
    if (!c) colours.set(key, c = hueFor(colours.size));
    return c;
  }

  function tintFor(material) {
    if (tintMode === 'off' || !material || material.colorWrite === false) return null;
    const key = keyOf[tintMode]({ material });
    const c = focus && key !== focus ? GREY : colourFor(key);
    const see = material.transparent === true;
    const k = `${c.getHexString()}|${material.side}|${see}`;
    let m = tints.get(k);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: c, side: material.side, transparent: see, opacity: see ? 0.35 : 1, depthWrite: !see });
      tints.set(k, m);
    }
    return m;
  }

  /**
   * True for a draw of the city itself, where the tint goes: the game's scene, not a shadow map and
   * not a full-screen pass. Keyed on the scene rather than the target because WebGL's CRT draws the
   * city into a target and its screen quad to the canvas, and tinting that quad paints the frame out.
   */
  const mainPass = (sc) => sc === scene && scene.overrideMaterial == null && !passOf(renderer, {}).startsWith('shadow');

  function drawTinted(object, tint, draw) {
    const parked = object.instanceColor;
    if (parked) object.instanceColor = null;
    try { return draw(tint); } finally { if (parked) object.instanceColor = parked; }
  }

  let tintInstalled = false;
  function installTint() {
    if (tintInstalled) return;
    tintInstalled = true;
    if (gpu) {
      const prior = renderer.getRenderObjectFunction?.() ?? null;
      const base = prior ?? renderer.renderObject.bind(renderer);
      renderer.setRenderObjectFunction((object, sc, camera, geometry, material, ...rest) => {
        const tint = object.isMesh && !object.isQuadMesh && mainPass(sc) ? tintFor(material) : null;
        if (!tint) return base(object, sc, camera, geometry, material, ...rest);
        return drawTinted(object, tint, (m) => base(object, sc, camera, geometry, m, ...rest));
      });
    } else {
      // Layered over the census hook, which is installed first and so sees the object's own
      // material either way (it keys off `object.material`, not the draw's).
      const draw = renderer.renderBufferDirect;
      renderer.renderBufferDirect = function (cam, sc, geometry, material, object, group) {
        const tint = tintMode !== 'off' && object.isMesh && mainPass(sc) ? tintFor(material) : null;
        if (!tint) return draw.call(this, cam, sc, geometry, material, object, group);
        return drawTinted(object, tint, (m) => draw.call(this, cam, sc, geometry, m, object, group));
      };
    }
  }

  /** Tint the main pass by group, from the last counted frame; `focusKey` greys out the rest. */
  function setTint(mode, focusKey = null) {
    tintMode = mode;
    focus = focusKey;
    if (mode === 'off') return;
    install();
    installTint();
    colours = new Map(groups(mode).map((g, i) => [g.key, hueFor(i)]));
  }

  active = { frameStart };
  return {
    frameStart,
    setCounting,
    counting: () => counting,
    total: () => last?.total ?? 0,
    stats: () => ({ ...stats, avg: stats.sum / Math.max(1, stats.frames) }),
    passes: passList,
    groups,
    report,
    setTint,
    tintMode: () => tintMode,
    focus: () => focus,
    /** The colour a group is drawn in right now, for the panel's chips. */
    colourOf: (key) => (tintMode === 'off' ? null : colourFor(key)),
  };
}
