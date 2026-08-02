import * as THREE from 'three';
import { PALETTE } from '../palette.js';

// Pickup and drop-off markers.
//
// A marker is two pieces with different jobs:
//   - a flat timer ring sitting on the road at the intersection centre. It says "drive here", and
//     being on the carriageway means nothing can occlude it.
//   - a tall pin on the pavement corner, for silhouette.
//
// The first version put everything on the pavement corner, where it landed inside a park and
// disappeared behind the trees.

const PIN_H = 8.5;

// The head hops rather than the whole pin. Lifting the post too would pull its foot off the
// pavement and leave a visible gap; the head has 0.8 units of overlap with the post top to play
// with, so anything up to about 0.5 stays seated.
const BOUNCE_HEIGHT = 0.45;
const BOUNCE_RATE = 3.4;

/**
 * A black outline, drawn as an inverted hull: the same shape a little larger, with only its back
 * faces rendered. The enlarged back faces sit behind the real surface everywhere except around
 * the silhouette, which is exactly where the rim shows.
 *
 * Cheaper than a post-processing edge pass, and it needs no render targets — this is one small
 * object, not a whole-scene effect.
 */
function outlineHull(geometry, scale) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
  );
  mesh.scale.copy(scale);
  return mesh;
}

/**
 * A thin static target ring. The countdown itself lives in game/timerring.js and travels with the
 * fare, so this only has to say "here" — it never drains.
 */
function targetRing(colorHex) {
  const geo = new THREE.TorusGeometry(3.5, 0.16, 6, 48);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), depthWrite: false }),
  );
  mesh.position.y = 0.08;
  mesh.renderOrder = 4;
  return mesh;
}

function marker(bodyColor, postColor, kind, buildStanding, withRing = true) {
  const group = new THREE.Group();
  group.name = kind;

  // The waiting rider gets no ring of its own — the fare's travelling timer sits under them.
  const ring = withRing ? targetRing(bodyColor) : null;
  if (ring) group.add(ring);

  // Everything that stands up lives in here, so the caller can shift it to a pavement corner
  // while the ring stays centred on the junction.
  const postGroup = new THREE.Group();
  group.add(postGroup);

  // A marker can stand up as a signpost or as a figure; the ring below is identical either way.
  let standing = null;
  if (buildStanding) {
    standing = buildStanding();
    postGroup.add(standing.group);
  }

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, PIN_H, 6),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(postColor), flatShading: true }),
  );
  post.position.y = PIN_H / 2;
  post.visible = !buildStanding;
  postGroup.add(post);

  // Widened but not lengthened — a uniform scale would push the outline's end caps past the
  // post's own, and both ends are meant to stay tucked (one in the ground, one inside the head).
  post.add(outlineHull(post.geometry, new THREE.Vector3(1.6, 1, 1.6)));

  // Octahedron: reads clearly from straight above, unlike a sphere, and matches the crystal
  // vocabulary already used elsewhere in these prototypes.
  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.9, 0),
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(bodyColor),
      emissive: new THREE.Color(bodyColor),
      emissiveIntensity: 0.35,
      flatShading: true,
    }),
  );
  const headBaseY = PIN_H + 1.1;
  head.position.y = headBaseY;
  head.castShadow = true;
  head.visible = !buildStanding;
  postGroup.add(head);

  // Child of the head, so it inherits the bounce for free.
  head.add(outlineHull(head.geometry, new THREE.Vector3(1.12, 1.12, 1.12)));

  for (const part of [post, head]) part.userData.pickable = kind;

  // `Math.abs(sin)` rather than a plain sine: it never dips below the rest position, and the
  // sharp cusp at the bottom of each cycle reads as a landing instead of a float.
  let bounce = 0;
  function update(dt) {
    if (!group.visible || !head.visible) return;
    bounce += dt;
    head.position.y = headBaseY + Math.abs(Math.sin(bounce * BOUNCE_RATE)) * BOUNCE_HEIGHT;
  }

  /** Retint the whole marker — used when a fare colour is assigned at pickup. */
  const setColor = (hex, postHex) => {
    const c = new THREE.Color(hex);
    if (ring) ring.material.color.copy(c);
    head.material.color.copy(c);
    head.material.emissive.copy(c);
    post.material.color.set(postHex ?? hex);
  };

  // Oversized invisible hit volume spanning both pieces — at full zoom-out the visible geometry
  // is only a few pixels across and would be miserable to tap.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(9, PIN_H + 6, 9),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = (PIN_H + 6) / 2;
  hit.userData.pickable = kind;
  group.add(hit);

  return { group, ring, postGroup, head, setColor, standing, update };
}

export const createPassengerPin = (buildStanding) =>
  marker(PALETTE.passenger, PALETTE.passengerPost, 'passenger', buildStanding, false);

export const createDestinationPin = () =>
  marker(PALETTE.destination, PALETTE.destinationPost, 'destination');
