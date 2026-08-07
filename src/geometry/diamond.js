import * as THREE from 'three';

// The geodesic diamond — the one shape this game uses to mean "a fare is here".
//
// It began as the drop-off pin's head and is now worn by both ends of a trip: teal over the
// junction the taxi is driving to, urgency-coloured over a rider still waiting on the kerb. Sharing
// the model is the whole point rather than a saving. The two markers say the same kind of thing, so
// they should be the same object in two colours; the player learns one silhouette and reads the
// colour for the difference, instead of learning a crystal for one end of the job and a slab of
// bars for the other.
//
// Octahedron: it reads clearly from straight above, unlike a sphere, and matches the crystal
// vocabulary used elsewhere in these prototypes.

export const DIAMOND_R = 1.9;

// One geometry for every diamond on the board — the shape never varies, only its colour and where
// it floats. The outline hulls share it too; they differ from the surface they wrap only by scale.
const GEO = new THREE.OctahedronGeometry(DIAMOND_R, 0);

// The outline's thickness, as a multiple of the diamond. At play zoom (1 world unit ≈ 7.7px) 1.12
// is about 1.7px of rim, which is the weight the marker pins have carried since they had posts.
export const RIM_SCALE = 1.12;

const BLACK = 0x000000;

// The fixed camera sees the face turned *away* from the sun, and pure Lambert on its own shades
// that face a long way down. The emissive lift keeps the crystal reading as its own hue rather
// than as a dark facet.
const EMISSIVE = 0.35;

/**
 * A black outline, drawn as an inverted hull: the same shape a little larger, with only its back
 * faces rendered. The enlarged back faces sit behind the real surface everywhere except around
 * the silhouette, which is exactly where the rim shows.
 *
 * Cheaper than a post-processing edge pass, and it needs no render targets — these are small
 * objects, not a whole-scene effect.
 */
export function outlineHull(geometry, scale) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: BLACK, side: THREE.BackSide }),
  );
  mesh.scale.setScalar(scale);
  return mesh;
}

/**
 * One diamond: the crystal and the outline that wraps it.
 *
 * The hull is a *child* of the mesh, so it inherits any animation — the bounce below, or a group
 * the caller moves — for free.
 */
export function createDiamond(colorHex) {
  const color = new THREE.Color(colorHex);
  const mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
  }));
  mesh.castShadow = true;

  const rim = outlineHull(GEO, RIM_SCALE);
  mesh.add(rim);

  return {
    mesh,
    rim,
    /** Colour and emissive move together — they are the same hue at two strengths. */
    setColor(value) {
      mesh.material.color.set(value);
      mesh.material.emissive.set(value);
    },
    /** Repaint and re-weight the outline. Used to mark a rider the taxi has been sent at. */
    setRim(value, scale = RIM_SCALE) {
      rim.material.color.set(value);
      rim.scale.setScalar(scale);
    },
  };
}

// The diamond hops around its rest height. `Math.abs(sin)` rather than a plain sine: it never dips
// below the rest position, and the sharp cusp at the bottom of each cycle reads as a landing
// instead of a float.
export const BOUNCE_HEIGHT = 0.45;
export const BOUNCE_RATE = 3.4;

/** Height above the rest position at time `t` seconds. */
export const bounceOffset = (t) => Math.abs(Math.sin(t * BOUNCE_RATE)) * BOUNCE_HEIGHT;
