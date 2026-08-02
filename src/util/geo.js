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
