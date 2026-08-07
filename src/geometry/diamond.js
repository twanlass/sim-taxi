import * as THREE from 'three';

// The geodesic diamond — the marker floating over a waiting rider.
//
// It began as the drop-off pin's head, and for a spell both ends of a trip wore one: teal over the
// junction the taxi was driving to, urgency-coloured over a rider on the kerb. The drop-off has
// since gone back to being a ring on the road and nothing else, because a second crystal reporting
// no state was a silhouette the player had to tell apart from the one that did. So a diamond on the
// board now means exactly one thing: a clock is running here.
//
// It stays its own module rather than folding into riderdiamond.js — the shape, its outline and its
// bounce are a vocabulary, and the next marker that wants to be one of these should take it from
// here rather than re-deriving it.
//
// Octahedron: it reads clearly from straight above, unlike a sphere, and matches the crystal
// vocabulary used elsewhere in these prototypes.

export const DIAMOND_R = 1.9;

// One geometry for every diamond on the board — the shape never varies, only its colour and where
// it floats. The outline hulls share it too; they differ from the surface they wrap only by scale.
const GEO = new THREE.OctahedronGeometry(DIAMOND_R, 0);

// The outline's thickness, as a multiple of the diamond. At play zoom (1 world unit ≈ 7.7px) 1.12
// is about 1.7px of rim, which is the weight the marker pins carried back when they had posts.
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
    /**
     * Re-weight the outline. Used to ink a rider the taxi has been sent at.
     *
     * Weight rather than colour, because the crystal underneath is already using colour to say
     * something: a yellow rim was tried and it disappears into the yellow urgency level, which is
     * the exact half of the clock where "am I already going to this one?" gets asked most.
     */
    setRim(scale) {
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

// A one-shot "something just changed" kick: the diamond swells and hops, then settles.
//
// The colour it snaps to is the news, and a hue change on a 29px shape at the edge of the eye is
// easy to miss entirely — especially the ones that matter, which land while the player is watching
// the road rather than the kerb. Motion is what gets the glance; the colour is what pays it off.
export const KICK_TIME = 0.36;      // long enough to register, short enough not to read as idling
export const KICK_SCALE = 0.1;      // peak swell, so 29px goes to ~32px
export const KICK_HOP = 0.55;       // extra lift at the peak, ~4px on top of the resting bounce

/**
 * Kick envelope for `t` seconds since the change: 0 → 1 → 0 over KICK_TIME, 0 outside it.
 *
 * Asymmetric on purpose — the exponent pushes the peak early, so it snaps up and eases down. A
 * symmetric half-sine swells as slowly as it settles, which reads as a throb rather than a knock.
 */
export function kickEnvelope(t) {
  if (!(t >= 0) || t >= KICK_TIME) return 0;
  return Math.sin(Math.PI * (t / KICK_TIME) ** 0.65);
}
