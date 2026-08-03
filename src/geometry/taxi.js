import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { ABOVE_RING } from '../game/timerring.js';
import { wheelGeometries } from '../sim/traffic.js';

// The player's taxi. Built as its own Group rather than an instance in the traffic InstancedMesh
// for two reasons: it needs to be raycast against for selection, and it needs a selection ring
// that toggles independently of every other vehicle.

const CAR_LEN = 3.4;
const CAR_W = 1.7;
const TAXI_SCALE = 1.18;

// World-space distance from the taxi origin back to the bumper — used by the tailpipe flame burst
// (main.js). Kept here rather than in flames.js so both offsets follow if the mesh ever resizes.
export const TAXI_TAILPIPE_BACK = (CAR_LEN / 2) * TAXI_SCALE;
export const TAXI_TAILPIPE_HEIGHT = 0.42;

export function createTaxiMesh() {
  const group = new THREE.Group();
  group.name = 'taxi';

  const parts = [];

  // Proportions match the ambient cars so the taxi reads as the same class of vehicle.
  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78, 0);
  parts.push(bakeColor(body, color('taxiBody')));

  const cabin = new THREE.BoxGeometry(CAR_LEN * 0.5, 0.6, CAR_W * 0.86);
  cabin.translate(-0.2, 1.45, 0);
  parts.push(bakeColor(cabin, color('carGlass')));



  // Chequer stripe along each flank.
  for (const side of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(CAR_LEN * 0.82, 0.22, 0.06);
    stripe.translate(0, 0.82, side * (CAR_W / 2 + 0.02));
    parts.push(bakeColor(stripe, color('taxiTrim')));
  }

  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const shell = new THREE.Mesh(merged, propMaterial());
  shell.castShadow = true;
  // Once a fare is aboard, the timer ring flies here and sits on the road around the car — so the
  // car has to draw over it, for the same reason the rider does. See ABOVE_RING.
  shell.renderOrder = ABOVE_RING;
  // Marks this subtree as the taxi for the picker, which raycasts recursively.
  shell.userData.pickable = 'taxi';
  group.add(shell);

  // The selection indicator, and the taxi's only one. Rings are reserved for fares now — the
  // rider's clock is a ring, so using one here too would say two different things with the same
  // shape. A filled pool underneath is unambiguous and never competes with the timer.
  // Built at final world size because it is *not* parented to the car — see below.
  const diskGeo = new THREE.CircleGeometry(2.9 * TAXI_SCALE, 32);
  diskGeo.rotateX(-Math.PI / 2);
  const disk = new THREE.Mesh(
    diskGeo,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.select),
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      // Depth-tested, unlike the fare ring. Without this the pool ignores the depth buffer and
      // paints straight over the car it is supposed to be sitting beneath.
      side: THREE.DoubleSide,
    }),
  );
  disk.renderOrder = 5;
  disk.name = 'taxiSelection';
  disk.visible = false;   // shown only while selected
  // Deliberately not added to the car group. The body now rolls hard through corners, and a
  // decal that rolls with it dips below the road surface and z-fights against it. The sim keeps
  // it flat under the car instead.

  // A generous invisible hit volume. The taxi is only a few units long on a fixed camera that
  // shows the whole city, so picking the visible mesh alone is a frustratingly small target.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(5.5, 4, 5.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = 1.4;
  hit.userData.pickable = 'taxi';
  group.add(hit);

  // Roof sign — reads as "taxi" at this zoom, and carries the fare colour while someone is
  // aboard. The countdown ring can't do that job any more: it is colour-coded by time remaining,
  // so fare identity needs somewhere else to live.
  const signGeo = new THREE.BoxGeometry(0.75, 0.34, 0.4);
  signGeo.translate(-0.1, 1.92, 0);
  const sign = new THREE.Mesh(
    signGeo,
    new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE.taxiSign), flatShading: true }),
  );
  sign.castShadow = true;
  sign.renderOrder = ABOVE_RING;
  sign.userData.pickable = 'taxi';
  group.add(sign);

  // Slightly oversized against ambient traffic. The player has to find this car at a glance in a
  // street full of identically shaped vehicles.
  group.scale.setScalar(TAXI_SCALE);
  group.rotation.order = 'YXZ';   // so roll applies about the car's own long axis

  /** null clears the highlight; a hex string lights the roof sign in that fare's colour. */
  const setFareColor = (hex) => {
    sign.material.color.set(hex ?? PALETTE.taxiSign);
  };

  return { group, selection: disk, sign, setFareColor };
}
