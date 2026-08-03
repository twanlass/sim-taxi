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

// World-space nudge along the view axis, applied to each ghost mesh's matrixWorld just before
// render (see the ghost material comment). Big enough to reliably beat the coplanar shell in the
// depth test on any surface orientation; small enough that the ghost silhouette lands on the
// shell's silhouette to within a hair. Along the exact view axis so the ortho projection maps it
// to zero screen offset — the ghost sits under the shell, not next to it.
const GHOST_DEPTH_NUDGE = 0.4;
const _ghostPos = new THREE.Vector3();
const _ghostAxis = new THREE.Vector3();
function pushGhostTowardCamera(mesh, camera) {
  // camera.getWorldDirection points from the camera into the scene; negate to point back toward
  // the viewer. For an orthographic camera every point in the scene sees the same view axis, so
  // one direction lookup covers all ghost meshes for this frame.
  camera.getWorldDirection(_ghostAxis).negate();
  _ghostPos.setFromMatrixPosition(mesh.matrixWorld).addScaledVector(_ghostAxis, GHOST_DEPTH_NUDGE);
  mesh.matrixWorld.setPosition(_ghostPos);
  // matrixWorld is regenerated from local × parent every frame, so this shift lives only for the
  // one render call.
}

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
  // front of it (depthFunc: GreaterDepth — the fragment passes only where an occluder has already
  // put a nearer value in the depth buffer). The gating is per-pixel, so no group-level occlusion
  // test and no fade are needed — the visible portion of the taxi renders normally and the ghost
  // only fills in the occluded pixels.
  //
  // Coplanar with the shell (same merged geometry), so `Greater` on equal depth is a FP coin-flip.
  // polygonOffset used to be the tie-breaker but doesn't survive this camera: the projection is
  // orthographic, and on the taxi's surfaces most nearly perpendicular to the view axis (which
  // rotates with the taxi's heading, so at some yaws it's the flanks, at others the front and
  // back) the factor × dz/dxy term collapses toward zero. Only polygonOffsetUnits contributes,
  // and one unit is a 24-bit-buffer least-significant-bit — a coin-flip against the coplanar
  // shell. The ghost was punching through the visible taxi on a park block with nothing in front
  // of it. Instead the ghost meshes shift themselves ~0.4 world units toward the camera in
  // `onBeforeRender` — see `pushGhostTowardCamera` — which gives a guaranteed depth offset
  // regardless of surface orientation, and along the view axis so the on-screen silhouette
  // doesn't drift out from under the shell in ortho.
  //
  // `transparent: true` isn't for blending — the fill is fully opaque — it's the only reliable way
  // to force the ghost into the transparent queue so it renders *after* opaque and tests against
  // the shell's depth. Left in the opaque queue the sort order between shell and ghost isn't
  // guaranteed, and a ghost-first draw sees ground/building depth in the buffer instead of shell
  // and the GreaterDepth test can pass on visible pixels.
  const ghostFillMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });

  const ghostGroup = new THREE.Group();
  ghostGroup.name = 'taxiGhostGroup';

  const shellFill = new THREE.Mesh(merged, ghostFillMat);
  shellFill.renderOrder = ABOVE_RING;
  shellFill.name = 'taxiShellGhost';
  shellFill.onBeforeRender = (_r, _s, camera) => pushGhostTowardCamera(shellFill, camera);
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
  // pass with the same fill treatment as the shell.
  const signGhost = new THREE.Mesh(signGeo, ghostFillMat);
  signGhost.renderOrder = ABOVE_RING;
  signGhost.name = 'taxiSignGhost';
  signGhost.onBeforeRender = (_r, _s, camera) => pushGhostTowardCamera(signGhost, camera);
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
    setFareColor,
  };
}
