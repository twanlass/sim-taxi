import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Several jointed pieces, one draw: a `SkinnedMesh` with every vertex weighted wholly to its own
 * piece's bone. Rigid skinning is the same transform the pieces had as separate meshes, so nothing
 * looks different — but a tube man of fourteen pieces is one draw in each pass instead of fourteen
 * (⚙️ Visuals › Draw calls; game/drawcalls.js).
 *
 * Each piece is `{ geo, bone }`: `geo` built in the bone's own frame (exactly as it was built for a
 * mesh standing where the bone stands), `bone` a `THREE.Bone` already placed in the scene graph
 * where that mesh would have been. Every bone inverse is the identity, so a vertex lands at
 * `bone.matrixWorld · position`, and the default attached bind mode cancels the skinned mesh's own
 * world matrix — so it can be added under any group, moving or not.
 *
 * Not culled: the bounding sphere three would compute is the bind pose's, every piece piled at its
 * bone's origin. Everything this is used for is small. The piece geometries are disposed.
 */
export function rigidSkin(pieces, material, { name = '', castShadow = true, receiveShadow = true } = {}) {
  const geos = pieces.map(({ geo }, i) => {
    const n = geo.attributes.position.count;
    const index = new Uint16Array(n * 4);
    const weight = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) { index[v * 4] = i; weight[v * 4] = 1; }
    const g = geo.clone();
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    return g;
  });
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error(`rigidSkin(${name}): pieces do not share attributes`);
  geos.forEach((g) => g.dispose());
  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.frustumCulled = false;
  const bones = pieces.map((p) => p.bone);
  mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
  return mesh;
}
