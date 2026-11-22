import * as THREE from 'three';

/**
 * Skip shadow casters whose shadow cannot reach the view.
 *
 * The sun's shadow camera covers the whole city (`MAX_SPAN * 1.05` each way, game/scene.js) because
 * the shadow map is drawn once for the whole island and never moves with the player. So three's own
 * culling in the shadow pass, which tests each caster against *that* frustum, passes everything:
 * every basketball player, skater, tube man and street prop on the map is drawn into the shadow map
 * on every frame, on screen or not. `?perf`'s census on a run put the 2048² shadow pass at **135**
 * draws against **109** for the main pass, which only draws what is in view (2026-11-22). On an
 * iPhone, frame time tracks draw calls — about 34 ms at 300 calls and 50 ms at 900 — so a pass that
 * spends calls on shadows nobody can see is the cheapest place to cut.
 *
 * A caster is kept when the *capsule* from it to its shadow on the ground touches the camera's
 * frustum: its world bounding sphere, and the same sphere slid down the sun's rays to y = 0. At the
 * parked golden-hour sun (13°) a shadow runs 4.3 times as far as the thing casting it is tall, so a
 * prop off the top of the screen can still lay its shadow across it, and the capsule is what keeps
 * that one. `MARGIN` pays for the shadow's soft edge and the PCF kernel's reach.
 *
 * **Set back after the frame, not left.** Several things write `castShadow` themselves every frame
 * (the birds under their ceiling, the chopper's wash, a parked police car), so this never owns the
 * flag: `cull()` turns off only casters that are on, remembers which, and `restore()` turns exactly
 * those back on once the passes are drawn. Whoever set the flag finds it as they left it.
 *
 * **Not during the warm-up.** The boot draws everything once so that every program and Metal
 * pipeline is built behind the load (game/warmup.js), and a caster culled from that draw would
 * link its depth program on the frame it first came into view. `withAllCasters` holds the cull off.
 *
 * Only plain meshes are considered. An `InstancedMesh`'s bounding sphere is computed once and never
 * again (CLAUDE.md on moving instanced meshes), so it cannot be trusted to say where the instances
 * are; those keep casting, as does anything with `frustumCulled = false`. The list is rebuilt from
 * the scene every `REBUILD_FRAMES`, so a mesh added after boot is considered within a second or so,
 * and casts as before until then.
 */

const MARGIN = 3;
const REBUILD_FRAMES = 60;
// Sun lower than this (sin of ~3°) is treated as this, so a shadow's length stays finite at dusk.
const MIN_SUN_Y = 0.05;

export function createShadowCull(scene, sun) {
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const ground = new THREE.Vector3();
  const toSun = new THREE.Vector3();
  let meshes = [];
  let framesToRebuild = 0;
  const culled = [];
  let enabled = true;
  let last = { considered: 0, culled: 0 };
  let lastCulled = [];

  function rebuild() {
    meshes = [];
    scene.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh && o.frustumCulled !== false) meshes.push(o);
    });
    framesToRebuild = REBUILD_FRAMES;
  }

  /** Turn off `castShadow` on every caster whose shadow cannot reach what `camera` sees. */
  function cull(camera) {
    if (!enabled || holding || !sun.castShadow) return;
    if (framesToRebuild-- <= 0) rebuild();
    // The matrices as this frame will draw them. `render()` would bring them up to date a moment from
    // now, and a frame-old one is wrong for anything placed this frame: shot mode ticks once and
    // renders once, so every mover there was culled from where it had been built, and the L train
    // came out without its shadows. 0.05 ms for the whole scene (923 objects) on a desktop core.
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    toSun.subVectors(sun.position, sun.target.position).normalize();
    const sunY = Math.max(MIN_SUN_Y, toSun.y);

    let considered = 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (!mesh.castShadow || !mesh.visible || !mesh.parent) continue;
      const geometry = mesh.geometry;
      if (!geometry) continue;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      considered += 1;
      sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      // The sphere's lowest-reaching shadow: its top, slid down the sun's rays to the ground.
      const reach = Math.max(0, sphere.center.y + sphere.radius) / sunY;
      ground.copy(sphere.center).addScaledVector(toSun, -reach);
      ground.y = 0;
      // One sphere around the whole capsule, from the caster to its shadow.
      const half = sphere.center.distanceTo(ground) / 2;
      sphere.center.lerp(ground, 0.5);
      sphere.radius += half + MARGIN;
      if (frustum.intersectsSphere(sphere)) continue;
      mesh.castShadow = false;
      culled.push(mesh);
    }
    last = { considered, culled: culled.length };
    lastCulled = culled.slice();
  }

  /** Put back every flag `cull` turned off. Called once the frame's passes are drawn. */
  function restore() {
    for (let i = 0; i < culled.length; i++) culled[i].castShadow = true;
    culled.length = 0;
  }

  return {
    cull,
    restore,
    /** `?shadowcull=classic` and the probe: switch the cull off (every caster draws, as before). */
    setEnabled(on) { enabled = on; if (!on) restore(); },
    /** For the probe and `?perf`: how many casters the last frame looked at, and how many it skipped. */
    stats: () => last,
    /** For the probe: the meshes the last frame skipped, until `restore()` clears them. */
    debugCulled: () => lastCulled,
  };
}

let holding = 0;

/** Run `fn` with the cull held off, so every caster draws (the boot's warm-up). */
export function withAllCasters(fn) {
  holding += 1;
  try { return fn(); } finally { holding -= 1; }
}
