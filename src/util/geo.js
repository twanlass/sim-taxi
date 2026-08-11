import * as THREE from 'three';

/**
 * The Euler order every body in the game poses with, and it is not the default.
 *
 * Everything that leans writes `rotation.set(roll, yaw, pitch, BODY_EULER_ORDER)`. Three composes
 * the default 'XYZ' as Rx·Ry·Rz, which puts the roll *outside* the yaw and so turns it about the
 * **world** X axis — which is the body's own long axis only when it happens to be heading east.
 * Drive north or south and the roll renders as pitch and the lean vanishes; drive west and it
 * leans the wrong way. 'YXZ' is Ry·Rx·Rz: yaw first, roll about the body, the same lean at every
 * heading.
 *
 * The two orders agree *exactly* at yaw 0, which is why this survived so long — and why the
 * passing lab, whose road runs due east, showed a lane-change bank that the game did not.
 * `tools/probe.mjs` asserts the constant reaches every body that leans.
 */
export const BODY_EULER_ORDER = 'YXZ';

/**
 * Normalizes a geometry into the form the whole project agrees on:
 *   - non-indexed, so computeVertexNormals() yields genuinely flat facets
 *   - a baked `color` attribute instead of a per-instance material
 *   - no uv/tangent attributes, which merge cleanly only when every input has them
 *
 * Baking colour into vertices is what lets hundreds of props collapse into a single merged
 * mesh sharing one material — the alternative (a material per tree) is both slower and
 * fiddlier to vary.
 */
export function bakeColor(geometry, colorInput) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;

  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }

  const c = colorInput instanceof THREE.Color ? colorInput : new THREE.Color(colorInput);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  return geo;
}

/**
 * Randomly displace every vertex — turns a regular solid into something hand-chiselled.
 *
 * Displacement is keyed by *position*, not by vertex index. Three's polyhedron geometries
 * (Icosahedron and friends) are non-indexed: every triangle carries its own copy of each corner.
 * Offsetting those copies independently pulls the shared corners apart and tears visible holes in
 * what should be a closed surface — which is exactly what the tree canopies were doing.
 */
export function jitterVertices(geometry, rng, amount) {
  const pos = geometry.attributes.position;
  const offsets = new Map();
  const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const id = key(x, y, z);

    let offset = offsets.get(id);
    if (!offset) {
      offset = [rng.jitter(amount), rng.jitter(amount), rng.jitter(amount)];
      offsets.set(id, offset);
    }
    pos.setXYZ(i, x + offset[0], y + offset[1], z + offset[2]);
  }

  pos.needsUpdate = true;
  return geometry;
}

/**
 * The one shared uniform bag every AO-lit material reads.
 *
 * `game/ssao.js` writes the texture and the texel size into it once, and every patched material
 * is handed these *same uniform objects* rather than copies — so one write reaches all of them.
 * Three reads `.value` at draw time, which is what makes that work.
 */
export const AO_UNIFORMS = {
  tAmbientOcclusion: { value: null },
  uAOTexel: { value: new THREE.Vector2(1, 1) },
};

let aoEnabled = false;

/**
 * Switch screen-space ambient occlusion on for every `propMaterial()` built after this call.
 * `main.js` calls it before any geometry is meshed.
 *
 * A build-time switch rather than a uniform on purpose: with AO off the patch is never installed,
 * so the extra texture fetch is *absent* rather than multiplied by one. Live tuning is the
 * strength uniform in `ssao.js`, which is a debug-panel concern and only exists when AO is on.
 */
export function setAmbientOcclusion(enabled) {
  aoEnabled = enabled;
}

export function ambientOcclusionEnabled() {
  return aoEnabled;
}

/**
 * Multiply the screen-space AO texture into a Lambert material's indirect term.
 *
 * **Indirect only.** Occlusion is a statement about how much of the sky reaches a crease, not
 * about whether the sun does — and this game's whole look is one lit face per building at golden
 * hour. Folding AO into the direct term as well greys those faces off and buys nothing the sun's
 * own shadow map isn't already saying.
 */
function patchAmbientOcclusion(material) {
  // Without this the patch silently does nothing. Three builds the program cache key from the
  // material's *parameters*, before `onBeforeCompile` has touched the source, so a patched
  // flat-shaded Lambert collides with every unpatched one sharing those parameters and
  // `acquireProgram` hands back whichever compiled first. This city is nothing but flat-shaded
  // Lambert — it is the same trap that once drew the diamond's fill with a building's shader.
  material.customProgramCacheKey = () => 'prop-ssao';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tAmbientOcclusion;
uniform vec2 uAOTexel;`)
      // Three's own AO hook is the right seam: `reflectedLight` is complete by then and
      // `outgoingLight` has not been summed yet. Screen space, so the lookup is the fragment's
      // own position on screen — no uv, no second set of attributes.
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= texture2D(tAmbientOcclusion, gl_FragCoord.xy * uAOTexel).r;`);
  };
}

/** The shared material for every merged prop mesh. */
export function propMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  if (aoEnabled) patchAmbientOcclusion(material);
  return material;
}
