import * as THREE from 'three';

/**
 * Painterly blotches (prototype, `?painterly`): every big face is cut into small triangles so the
 * vertex colour has somewhere to vary, then each vertex's colour is nudged by a low-frequency 3D
 * noise keyed on its **world** position — value and a warm/cool hue shift, like a dry brush dragged
 * over a flat coat. All of it is baked once at build time, so the frame pays only for the extra
 * vertices.
 *
 * Keyed by world position, so two copies of a corner (non-indexed geometry) agree and the patches
 * run across face boundaries instead of restarting on each one.
 */

export const BLOTCH = {
  maxEdge: 1.6,   // world units: no subdivided edge is longer than this
  maxSplit: 12,   // per-triangle cap on subdivisions per edge
  scale: 0.42,    // blotch frequency, per world unit
  value: 0.5,    // luminance swing
  hue: 0.2,      // warm/cool swing
};

function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

function subdivide(geo, matrix) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(src.attributes);
  const attrs = names.map((n) => src.attributes[n]);
  const pos = src.attributes.position;
  const out = names.map(() => []);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, t + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, t + 2).applyMatrix4(matrix);
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const n = Math.min(BLOTCH.maxSplit, Math.max(1, Math.ceil(longest / BLOTCH.maxEdge)));
    // Barycentric lattice: n² small triangles, same winding as the parent.
    const emit = (i, j) => {
      const u = i / n, v = j / n, w = 1 - u - v;
      attrs.forEach((attr, k) => {
        for (let d = 0; d < attr.itemSize; d++) {
          out[k].push(w * attr.getComponent(t, d) + u * attr.getComponent(t + 1, d) + v * attr.getComponent(t + 2, d));
        }
      });
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n - j; i++) {
        emit(i, j); emit(i + 1, j); emit(i, j + 1);
        if (i + j < n - 1) { emit(i + 1, j); emit(i + 1, j + 1); emit(i, j + 1); }
      }
    }
  }

  const geoOut = new THREE.BufferGeometry();
  names.forEach((name, k) => {
    const attr = attrs[k];
    const Arr = attr.array.constructor;
    geoOut.setAttribute(name, new THREE.BufferAttribute(new Arr(out[k]), attr.itemSize, attr.normalized));
  });
  return geoOut;
}

/** Subdivide and blotch one static merged mesh in place. Returns the mesh. */
export function paintBlotches(mesh) {
  if (!mesh?.geometry?.attributes?.color || mesh.isInstancedMesh) return mesh;
  mesh.updateMatrixWorld(true);
  const before = mesh.geometry.attributes.position.count;
  const geo = subdivide(mesh.geometry, mesh.matrixWorld);
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const nrm = geo.attributes.normal;
  if (nrm) {
    const v = new THREE.Vector3();
    for (let i = 0; i < nrm.count; i++) { v.fromBufferAttribute(nrm, i).normalize(); nrm.setXYZ(i, v.x, v.y, v.z); }
  }
  const p = new THREE.Vector3();
  const s = BLOTCH.scale;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const v = (noise3(p.x * s, p.y * s, p.z * s) - 0.5) * 1.3
      + (noise3(p.x * s * 2.7 + 17, p.y * s * 2.7, p.z * s * 2.7) - 0.5) * 0.7;
    const h = noise3(p.x * s * 0.6 + 41, p.y * s * 0.6 + 9, p.z * s * 0.6) - 0.5;
    const k = 1 + v * BLOTCH.value * 2;
    col.setXYZ(i,
      Math.max(0, col.getX(i) * k * (1 + h * BLOTCH.hue * 4)),
      Math.max(0, col.getY(i) * k * (1 + h * BLOTCH.hue * 1.2)),
      Math.max(0, col.getZ(i) * k * (1 - h * BLOTCH.hue * 4)));
  }
  mesh.geometry.dispose();
  mesh.geometry = geo;
  mesh.userData.painterly = { before, after: pos.count };
  return mesh;
}
