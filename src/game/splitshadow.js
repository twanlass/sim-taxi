import * as THREE from 'three';
import { ShadowBaseNode, ShadowNode } from 'three/webgpu';
import { Fn, add, min, nodeObject, reference, renderGroup, texture, vec2 } from 'three/tsl';

/**
 * The sun's shadow as two maps: the standing city, drawn once, and everything that moves, drawn
 * every frame. WebGPU only; `?shadowsplit=classic` (and the WebGL renderer) keep the one 2048² map
 * that redrew the whole island every frame. See docs/rendering.md, "Two shadow maps".
 *
 * **Why it pays.** The sun does not move during a run (`daylight.setCycling(false)` in main.js), so
 * the buildings' shadows come out identical on every frame — and the single map redrew all of them
 * 60 times a second anyway, for the sake of the cars. Shadows were the most expensive thing on the
 * phone (shadows > AO ≈ MSAA > bloom, and the slowdown there is thermal), so a pass that does the
 * same work every frame for the same answer is the place to take it back.
 *
 * **Why it is sharper.** Drawn once, the static map can afford 4096² — 0.066 units a texel against
 * 0.132 — and both maps are read through a 4-tap filter on a hardware-bilinear comparison sampler
 * (`tapFilter`) instead of three's 16-tap PCFSoft. The edge is narrower, and the receivers do 8
 * comparisons a pixel where they did 16. Hard edges usually shimmer, but these cannot: the static
 * map's sun, camera and casters are all still, and the dynamic map is world-fixed, not
 * camera-fitted. How wide the edge is stays a look decision — `setSoftness`, the ⚙️ panel's
 * `Shadow softness`, in world units so the two maps' edges match.
 *
 * **Why the dynamic map is not fitted to the camera.** It was the obvious second step and it buys
 * nothing here: at play zoom a portrait phone sees 104 units of view-plane height, which is ~190
 * units of ground at this 33° camera — most of the island. A camera-fitted 2048² map would have
 * landed within a few percent of the island-wide one's texel, and paid for it with a frustum that
 * moves every frame, which is what makes shadow edges crawl.
 *
 * **What is static.** Classified automatically, because a hand list across 30 builders would rot:
 * a plain `Mesh` that casts, whose world matrix is the identity. Every merged city builder bakes its
 * geometry in world space with an identity transform (the city entrance wave depends on exactly
 * that — CLAUDE.md), while everything that moves carries a transform of its own. Measured on a
 * phone-sized shot (seed-pinned, 2026-11-27): 70 meshes classify static, among them every building,
 * the river walls, the bridges and the landmarks. The one big structure the rule misses is the L
 * train's deck, truss and columns, which sit under a placed group; they opt in with
 * `userData.staticShadow` (game/ltrain.js). `userData.dynamicShadow` opts out. The rule is then
 * *checked* every frame rather than trusted: a static mesh whose matrix changes, or whose vertices
 * are rewritten (the garage door rolls up that way), is demoted to the dynamic map for good and the
 * static map redrawn; one that is hidden, shown, detached or stops
 * casting just redraws it (and is demoted after `MAX_TOGGLES`, so something that flickers cannot
 * keep redrawing the city). New meshes are classified every `SCAN_FRAMES` until the run starts
 * (`settle`), and drawn per frame after that. Anything that is not
 * classified static is drawn in the dynamic map, so the failure mode of a wrong guess is cost,
 * never a missing or frozen shadow.
 *
 * Static casters are put on `STATIC_SHADOW_LAYER`, which the static map's camera renders alone.
 * The dynamic map renders with the main camera's layers, and turns the static casters'
 * `castShadow` off for the length of its own pass (`renderShadow`), which three's shadow render
 * function checks per object.
 */

export const STATIC_SHADOW_LAYER = 6;

const SCAN_FRAMES = 60;
// Frames after the first one drawn before the static set closes, unless `settle()` closes it first.
// The city is built before the first frame, so this only has to outlast the warm-up's slices.
const PROMOTE_FRAMES = 300;
const MAX_TOGGLES = 4;
// World units of filter spread. One static texel: crisp, and still smooth on a slope.
const DEFAULT_SOFTNESS = 0.066;
const IDENTITY_EPS = 1e-6;

/**
 * Four taps on a rotated grid, each a hardware 2×2 bilinear comparison (the depth texture is
 * sampled through a linear comparison sampler — `PartShadowNode.setupRenderTarget`). `shadow.radius`
 * is the spread in texels: 0 is a single bilinear tap, a one-texel edge; 1 spreads the taps
 * ±0.75 texel.
 */
const tapFilter = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const radius = reference('radius', 'float', shadow).setGroup(renderGroup);
  const step = vec2(1).div(mapSize).mul(radius);
  const tap = (x, y) => texture(depthTexture, shadowCoord.xy.add(step.mul(vec2(x, y)))).compare(shadowCoord.z);
  return add(tap(-0.25, -0.75), tap(0.75, -0.25), tap(0.25, 0.75), tap(-0.75, 0.25)).mul(0.25);
});

/** A three ShadowNode with a linear comparison sampler and hooks around its own pass. */
class PartShadowNode extends ShadowNode {
  constructor(light, shadow, hooks = {}) {
    super(light, shadow);
    this.hooks = hooks;
  }

  setupRenderTarget(shadow, builder) {
    const target = super.setupRenderTarget(shadow, builder);
    target.depthTexture.minFilter = THREE.LinearFilter;
    target.depthTexture.magFilter = THREE.LinearFilter;
    return target;
  }

  renderShadow(frame) {
    this.hooks.before?.();
    try {
      super.renderShadow(frame);
    } finally {
      this.hooks.after?.();
    }
    this.hooks.drawn?.();
  }
}

/** A stand-in light for one of the two maps: placed where the sun is, aimed where it aims. */
function proxyLight(sun, size) {
  const light = new THREE.Object3D();
  light.target = new THREE.Object3D();
  light.castShadow = true;
  light.shadow = sun.shadow.clone();
  light.shadow.mapSize.set(size, size);
  return light;
}

function isIdentity(m) {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > IDENTITY_EPS) return false;
  }
  return true;
}

/** Visible all the way up, and still in a scene. */
function shown(mesh) {
  for (let o = mesh; o; o = o.parent) {
    if (!o.visible) return false;
    if (!o.parent) return o.isScene === true;
  }
  return false;
}

/**
 * @param sun          the scene's DirectionalLight; its own `shadow` stops being drawn into
 * @param staticSize   texels a side for the standing city's map
 * @param dynamicSize  texels a side for the per-frame map
 * @param busy         returns true while something animates static geometry in its vertex shader
 *                     (the city entrance and the L's intro, both `?entry=classic` only) — the
 *                     static map is redrawn every frame until it says false
 */
export function createSplitShadow(sun, { staticSize = 4096, dynamicSize = 2048, busy = () => false } = {}) {
  const staticLight = proxyLight(sun, staticSize);
  const dynamicLight = proxyLight(sun, dynamicSize);
  const staticShadow = staticLight.shadow;
  const dynamicShadow = dynamicLight.shadow;
  staticShadow.autoUpdate = false;
  staticShadow.needsUpdate = true;
  staticShadow.camera.layers.set(STATIC_SHADOW_LAYER);
  // Redrawn whenever the sun's own map would have been: the wet-road mirror (game/rain.js) turns
  // `sun.shadow.autoUpdate` off around its pass to reuse the frame's map, and that has to reach
  // this one or the mirror pays a second shadow pass.
  Object.defineProperty(dynamicShadow, 'autoUpdate', { get: () => sun.shadow.autoUpdate, set() {} });

  /** @type {{ mesh: THREE.Mesh, matrix: THREE.Matrix4, on: boolean, toggles: number }[]} */
  let statics = [];
  const demoted = new WeakSet();
  const known = new WeakSet();
  let framesToScan = 0;
  let framesToClose = PROMOTE_FRAMES;
  let promoting = true;
  let lastFrame = -1;
  let sceneRef = null;
  let dirtyReason = 'boot';
  const sunPos = new THREE.Vector3();
  const sunAim = new THREE.Vector3();
  const stats = { statics: 0, demoted: 0, staticDraws: 0, lastReason: '', joined: [], open: true };
  let softness = DEFAULT_SOFTNESS;

  function applySoftness() {
    const extent = staticShadow.camera.right - staticShadow.camera.left;
    staticShadow.radius = softness / (extent / staticShadow.mapSize.x);
    dynamicShadow.radius = softness / (extent / dynamicShadow.mapSize.x);
  }
  applySoftness();

  function dirty(reason) {
    if (!dirtyReason) dirtyReason = reason;
  }

  function scan(scene) {
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || known.has(o)) return;
      if (!o.castShadow || !shown(o)) return;   // classified once it first casts and is drawn
      known.add(o);
      // Closed after boot. Measured on a Mac's GPU (2026-11-27): left open, something joined the set
      // about every 15s on the title screen, and each join redraws the whole 4096² map. What turns
      // up later (roadworks, pooled props) is cheaper drawn per frame than redrawing the city for it.
      if (!promoting) return;
      if (demoted.has(o) || o.userData.dynamicShadow) return;
      if (!o.userData.staticShadow && !isIdentity(o.matrixWorld)) return;
      o.layers.enable(STATIC_SHADOW_LAYER);
      statics.push({
        mesh: o, matrix: o.matrixWorld.clone(), geometry: o.geometry,
        version: o.geometry.attributes.position?.version ?? 0, on: true, toggles: 0,
      });
      dirty('new static');
      stats.joined.push(o.name || o.parent?.name || o.geometry.type);
      if (stats.joined.length > 8) stats.joined.shift();
    });
    framesToScan = SCAN_FRAMES;
  }

  function demote(entry) {
    entry.mesh.layers.disable(STATIC_SHADOW_LAYER);
    demoted.add(entry.mesh);
    stats.demoted += 1;
  }

  /** Once a frame: follow the sun, keep the static set honest, and say whether to redraw it. */
  function check(scene) {
    scene.updateMatrixWorld();
    for (const light of [staticLight, dynamicLight]) {
      light.position.copy(sun.position);
      light.target.position.copy(sun.target.position);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
    }
    if (!sunPos.equals(sun.position) || !sunAim.equals(sun.target.position)) {
      sunPos.copy(sun.position);
      sunAim.copy(sun.target.position);
      dirty('sun');
    }
    if (framesToScan-- <= 0) scan(scene);
    if (promoting && framesToClose-- <= 0) settle();

    let kept = 0;
    for (let i = 0; i < statics.length; i++) {
      const entry = statics[i];
      const { mesh } = entry;
      // Moved, or its vertices rewritten on the CPU (the garage door rolls up that way).
      if (!entry.matrix.equals(mesh.matrixWorld) || mesh.geometry !== entry.geometry
        || (mesh.geometry.attributes.position?.version ?? 0) !== entry.version) {
        demote(entry);
        dirty('static moved');
        continue;
      }
      const on = mesh.castShadow && shown(mesh);
      if (on !== entry.on) {
        entry.on = on;
        entry.toggles += 1;
        dirty('static shown/hidden');
        if (entry.toggles > MAX_TOGGLES) { demote(entry); continue; }
      }
      statics[kept++] = entry;
    }
    statics.length = kept;
    stats.statics = kept;

    if (busy()) dirty('intro');
    if (dirtyReason) {
      staticShadow.needsUpdate = true;
      stats.lastReason = dirtyReason;
      dirtyReason = '';
    }
  }

  /** Close the static set: from now on a new caster is drawn per frame, however still it stands. */
  function settle() {
    if (!promoting) return;
    scan(sceneRef ?? new THREE.Scene());
    promoting = false;
    stats.open = false;
  }

  // The dynamic pass draws every caster except the static ones.
  const hidden = [];
  const hideStatics = () => {
    for (const { mesh } of statics) {
      if (mesh.castShadow) { mesh.castShadow = false; hidden.push(mesh); }
    }
  };
  const restoreStatics = () => {
    for (const mesh of hidden) mesh.castShadow = true;
    hidden.length = 0;
  };

  class SplitShadowNode extends ShadowBaseNode {
    constructor() {
      super(sun);
      this.parts = null;
    }

    setup(builder) {
      if (!this.parts) {
        this.parts = [
          nodeObject(new PartShadowNode(staticLight, staticShadow, { drawn: () => { stats.staticDraws += 1; } })),
          nodeObject(new PartShadowNode(dynamicLight, dynamicShadow, { before: hideStatics, after: restoreStatics })),
        ];
      }
      return Fn((b) => {
        this.setupShadowPosition(b);
        return min(this.parts[0], this.parts[1]);
      })();
    }

    updateBefore(frame) {
      if (frame.frameId === lastFrame) return;
      lastFrame = frame.frameId;
      sceneRef = frame.scene;
      check(frame.scene);
    }
  }

  staticShadow.filterNode = tapFilter;
  dynamicShadow.filterNode = tapFilter;
  sun.shadow.shadowNode = new SplitShadowNode();

  return {
    /** World units of edge spread, both maps. 0 is a one-texel edge. */
    setSoftness(value) { softness = Math.max(0, value); applySoftness(); },
    softness: () => softness,
    /** The run has started: close the static set (it closes by itself `PROMOTE_FRAMES` in otherwise). */
    settle,
    /** Redraw the standing city's map on the next frame. */
    invalidate(reason = 'asked') { dirty(reason); },
    /** Whether a mesh is drawn into the static map. */
    isStatic: (mesh) => mesh.layers.isEnabled(STATIC_SHADOW_LAYER),
    stats: () => ({ ...stats, staticSize: staticShadow.mapSize.x, dynamicSize: dynamicShadow.mapSize.x }),
    /** For the probe: run one frame's bookkeeping, and the dynamic pass's hide and restore, without a GPU. */
    debug: {
      check: (scene) => { sceneRef = scene; check(scene); },
      hide: hideStatics,
      restore: restoreStatics,
      staticShadow,
      dynamicShadow,
    },
  };
}
