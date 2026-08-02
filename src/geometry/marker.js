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
  head.position.y = PIN_H + 1.1;
  head.castShadow = true;
  head.visible = !buildStanding;
  postGroup.add(head);

  for (const part of [post, head]) part.userData.pickable = kind;

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

  return { group, ring, postGroup, head, setColor, standing };
}

export const createPassengerPin = (buildStanding) =>
  marker(PALETTE.passenger, PALETTE.passengerPost, 'passenger', buildStanding, false);

export const createDestinationPin = () =>
  marker(PALETTE.destination, PALETTE.destinationPost, 'destination');
