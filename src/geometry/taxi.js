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

  // Ghost silhouette. The taxi frequently ducks behind buildings on the 3/4 view and the player
  // loses track of where it is; the ghost pass draws the same geometry only where something is in
  // front of it (depthFunc: GreaterDepth — the fragment writes only where an occluder has already
  // put a nearer value in the depth buffer).
  //
  // Rendered as a solid opaque white fill with a black inverted-hull outline, so it reads as one
  // silhouette rather than a stack of six semi-transparent boxes. Both materials still declare
  // transparent: true — not for alpha compositing, but so main.js can lerp `opacity` between 0 and
  // 1 for a soft fade when the occlusion state flips, instead of the ghost popping in.
  //
  // Coplanar z-fighting between shell and fill is impossible because the whole group is gated
  // hidden by the sampled-raycast occlusion check in main.js unless the taxi is >50% occluded.
  const ghostFillMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });
  const ghostOutlineMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });

  const ghostGroup = new THREE.Group();
  ghostGroup.name = 'taxiGhostGroup';
  ghostGroup.visible = false;   // main.js flips this on when the taxi is >50% occluded

  // Widened but not lengthened. Same discipline as the pin outline: uniform scale on merged
  // geometry with baked-in translations would drift every part outward from its correct height as
  // well as sideways; scaling x/z only keeps every part on the road plane it belongs to and still
  // paints a visible rim on the 3/4 view where the horizontal silhouette is what reads.
  const shellOutline = new THREE.Mesh(merged, ghostOutlineMat);
  shellOutline.scale.set(1.06, 1, 1.06);
  shellOutline.renderOrder = ABOVE_RING;
  shellOutline.name = 'taxiShellGhostOutline';
  ghostGroup.add(shellOutline);

  const shellFill = new THREE.Mesh(merged, ghostFillMat);
  shellFill.renderOrder = ABOVE_RING + 1;   // over the outline in the transparent queue
  shellFill.name = 'taxiShellGhost';
  ghostGroup.add(shellFill);

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

  // The roof sign is what makes a taxi silhouette read as a taxi from above, so it joins the ghost
  // pass. Same fill+outline treatment as the shell.
  const signOutline = new THREE.Mesh(signGeo, ghostOutlineMat);
  signOutline.scale.set(1.18, 1, 1.18);   // small box, needs relatively more x/z widening to read
  signOutline.renderOrder = ABOVE_RING;
  signOutline.name = 'taxiSignGhostOutline';
  ghostGroup.add(signOutline);

  const signGhost = new THREE.Mesh(signGeo, ghostFillMat);
  signGhost.renderOrder = ABOVE_RING + 1;
  signGhost.name = 'taxiSignGhost';
  ghostGroup.add(signGhost);
  group.add(ghostGroup);

  // Slightly oversized against ambient traffic. The player has to find this car at a glance in a
  // street full of identically shaped vehicles.
  group.scale.setScalar(TAXI_SCALE);
  group.rotation.order = 'YXZ';   // so roll applies about the car's own long axis

  /** null clears the highlight; a hex string lights the roof sign in that fare's colour. */
  const setFareColor = (hex) => {
    sign.material.color.set(hex ?? PALETTE.taxiSign);
  };

  return {
    group,
    selection: disk,
    sign,
    ghost: ghostGroup,
    ghostMaterials: [ghostFillMat, ghostOutlineMat],
    setFareColor,
  };
}
