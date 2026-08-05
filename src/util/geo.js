import * as THREE from 'three';

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
 * Same normalisation as bakeColor(), but the colour is scaled per vertex by `weightAt`.
 *
 * This is how every soft-edged light in the game is drawn: a lamp's pool on the tarmac, a
 * headlight beam fading out ahead of the car, the cone of air under a street lamp. All of them are
 * a solid additive colour multiplied down to black at the edge, and vertex interpolation across a
 * ten-segment fan is a free radial gradient — no texture, no shader, and it still merges into the
 * one mesh with everything else wearing the same material.
 *
 * `weightAt(x, y, z)` reads whatever coordinates the geometry has at the moment it is baked, so a
 * caller either bakes at the origin and translates afterwards, or translates first and writes the
 * offset into the weight function. Both appear below; the second is easier to read when the same
 * centre also fixes the falloff radius.
 */
export function bakeGradient(geometry, colorInput, weightAt) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;

  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }

  const c = colorInput instanceof THREE.Color ? colorInput : new THREE.Color(colorInput);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const w = Math.max(0, weightAt(pos.getX(i), pos.getY(i), pos.getZ(i)));
    colors[i * 3] = c.r * w;
    colors[i * 3 + 1] = c.g * w;
    colors[i * 3 + 2] = c.b * w;
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

/** The shared material for every merged prop mesh. */
export function propMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

/**
 * The shared material for anything that *emits* light rather than being lit by it — window
 * squares, lamp heads and their pools on the road, headlight lenses, beams, tail lights.
 *
 * Unlit on purpose. A night light drawn with a Lambert material would be shaded by the very
 * darkness it is meant to be pushing back, which is exactly backwards. `opacity` is the single
 * knob the day/night cycle turns: 0 through the middle of the day, 1 after dusk.
 *
 * `fog: false` on all of them, additive or not. Three's fog mixes the fragment toward the fog
 * colour *before* blending, so an additive light in fog comes out brighter the further away it is
 * — the opposite of what fog is for. Lights are small and mostly near the ground, where the fog
 * gradient across the city is worth a couple of percent anyway.
 */
export function glowMaterial({ additive = true, opacity = 0 } = {}) {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}
