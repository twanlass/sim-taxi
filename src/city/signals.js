import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import {
  GRID, HALF_ROAD, LANE, lineCoord, isXAxis, dirSign, dirYaw, opposite,
  laneOffsetCoord, nextIntersection, isSegmentClosed, isUnsignalised,
} from './grid.js';

// Every signalised approach: one entry per (junction, incoming direction). This is the same
// enumeration the stop bars ran on — moved here so each visual style shares one source of truth.
export function collectApproaches() {
  const out = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (isUnsignalised(i, j)) continue;         // ring junctions have no phase to display
      for (let d = 0; d < 4; d++) {
        // Only worth a signal if traffic can actually arrive on this approach.
        if (!nextIntersection(opposite(d), i, j)) continue;
        if (isSegmentClosed(i, j, opposite(d))) continue;
        out.push({ i, j, d });
      }
    }
  }
  return out;
}

// Unit vectors keyed by direction: FWD[d] is the way the driver is going, RIGHT[d] is the
// driver's right. Matches the LANE offset convention in grid.js — a +X driver sits on the +Z side
// of the centreline.
const FWD = [
  { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 },
];
const RIGHT = [
  { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 },
];

/** Which lens is lit for this approach: 0 red, 1 yellow, 2 green. */
function phaseSlot(a, t, lightPhase) {
  const phase = lightPhase(a.i, a.j, t);
  const mine = phase.axis === (isXAxis(a.d) ? 'x' : 'z');
  if (!mine) return 0;
  return phase.yellow ? 1 : 2;
}

const SLOT_COLOR = [PALETTE.lightRed, PALETTE.lightYellow, PALETTE.lightGreen];

/**
 * Factory. Style is a URL-selectable string; the return shape is the same for every style so the
 * update loop in traffic.js doesn't have to know which one is running.
 */
export function createSignalVisual(style, scene) {
  const approaches = collectApproaches();
  switch (style) {
    case 'overhead': return overheadSignals(scene, approaches);
    case 'post':     return postSignals(scene, approaches);
    case 'bollard':  return bollardSignals(scene, approaches);
    default:         return barSignals(scene, approaches);
  }
}

// --- Default: painted stop bar on the tarmac -------------------------------
//
// The signal lives on the road, not on a pole. Corner-mounted heads were unreadable from this
// camera: one head served two opposing approaches, it sat nearer the block corner than the road
// it governed, and nothing about it said which direction it applied to. A bar painted across
// the lane you are driving, at the point you would stop, removes both ambiguities — there is
// exactly one bar for your approach and it is directly in front of you.

function barSignals(scene, approaches) {
  const BAR_DISTANCE = HALF_ROAD + 2.05;

  const barGeo = bakeColor(new THREE.PlaneGeometry(0.7, 3.6), new THREE.Color(1, 1, 1));
  barGeo.rotateX(-Math.PI / 2);

  const mesh = new THREE.InstancedMesh(barGeo, propMaterial(), approaches.length);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.name = 'stopBars';

  const dummy = new THREE.Object3D();
  const stored = approaches.map((a) => {
    const back = -dirSign(a.d) * BAR_DISTANCE;
    const lane = laneOffsetCoord(a.d, a.i, a.j);
    return {
      a,
      x: isXAxis(a.d) ? lineCoord(a.i) + back : lane,
      z: isXAxis(a.d) ? lane : lineCoord(a.j) + back,
      turned: !isXAxis(a.d),
    };
  });
  stored.forEach((b, i) => {
    dummy.position.set(b.x, 0.05, b.z);
    dummy.rotation.set(0, b.turned ? Math.PI / 2 : 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  const c = new THREE.Color();
  return {
    style: 'bar',
    mesh,
    update(t, lightPhase) {
      for (let i = 0; i < stored.length; i++) {
        c.set(SLOT_COLOR[phaseSlot(stored[i].a, t, lightPhase)]);
        mesh.setColorAt(i, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

// --- Three-lens instanced helper -------------------------------------------
//
// The two "proper" signal styles (overhead and post) share the same head: a small dark box with
// three lens positions on the front face, one lit at a time. The heads sit at different heights
// and orientations, but the per-frame job is identical, so it lives here once.
function threeLensHeads(scene, heads, lensRadius) {
  const geo = bakeColor(new THREE.SphereGeometry(lensRadius, 8, 6), new THREE.Color(1, 1, 1));

  // Three passes: one instanced mesh per lens slot. A dark "off" colour on the two inactive
  // lenses reads correctly against the dark housing without going invisible.
  const meshes = [0, 1, 2].map(() => {
    const m = new THREE.InstancedMesh(geo, propMaterial(), heads.length);
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    scene.add(m);
    return m;
  });
  meshes[0].name = 'signalLensRed';
  meshes[1].name = 'signalLensYellow';
  meshes[2].name = 'signalLensGreen';

  const dummy = new THREE.Object3D();
  heads.forEach((head, i) => {
    for (let s = 0; s < 3; s++) {
      dummy.position.set(head.lens[s].x, head.lens[s].y, head.lens[s].z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      meshes[s].setMatrixAt(i, dummy.matrix);
    }
  });
  meshes.forEach((m) => { m.instanceMatrix.needsUpdate = true; });

  const on = SLOT_COLOR.map((hex) => new THREE.Color(hex));
  const off = new THREE.Color(PALETTE.lightOff);
  return {
    update(t, lightPhase) {
      for (let i = 0; i < heads.length; i++) {
        const slot = phaseSlot(heads[i].a, t, lightPhase);
        meshes[0].setColorAt(i, slot === 0 ? on[0] : off);
        meshes[1].setColorAt(i, slot === 1 ? on[1] : off);
        meshes[2].setColorAt(i, slot === 2 ? on[2] : off);
      }
      meshes.forEach((m) => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    },
  };
}

// --- Overhead mast-arm signal ---------------------------------------------
//
// Pole on the far-right corner past each intersection, horizontal mast arm reaching over the
// driver's lane, three-lens housing hanging from the arm end facing the approaching driver.
// This is the "traditional US intersection" read — the one you see on every arterial.

function overheadSignals(scene, approaches) {
  const POLE_H = 5.5;
  const POLE_R = 0.11;
  const ARM_Y = 5.35;
  const ARM_T = 0.14;
  const HEAD_TOP = 4.95;
  const HEAD_H = 1.15;
  const HEAD_W = 0.5;
  const HEAD_D = 0.36;
  const LENS_R = 0.16;

  const staticParts = [];
  const heads = [];

  for (const a of approaches) {
    const cx = lineCoord(a.i);
    const cz = lineCoord(a.j);
    const fwd = FWD[a.d];
    const right = RIGHT[a.d];

    // Pole sits past the intersection on the driver's right, half a metre onto the sidewalk.
    const poleX = cx + fwd.x * HALF_ROAD + right.x * (HALF_ROAD + 0.5);
    const poleZ = cz + fwd.z * HALF_ROAD + right.z * (HALF_ROAD + 0.5);
    const pole = new THREE.CylinderGeometry(POLE_R, POLE_R * 1.4, POLE_H, 6);
    pole.translate(poleX, POLE_H / 2, poleZ);
    staticParts.push(bakeColor(pole, color('pole')));

    // Head hangs over the driver's lane centre, just past the intersection edge.
    const headX = cx + fwd.x * HALF_ROAD + right.x * LANE;
    const headZ = cz + fwd.z * HALF_ROAD + right.z * LANE;

    // Mast arm: horizontal box from the top of the pole to above the head.
    const dx = headX - poleX;
    const dz = headZ - poleZ;
    const armLen = Math.hypot(dx, dz);
    const armAng = Math.atan2(dz, dx);
    const arm = new THREE.BoxGeometry(armLen, ARM_T, ARM_T);
    arm.translate(armLen / 2, 0, 0);
    arm.rotateY(-armAng);
    arm.translate(poleX, ARM_Y, poleZ);
    staticParts.push(bakeColor(arm, color('pole')));

    // Short drop from the arm to the top of the housing.
    const drop = new THREE.BoxGeometry(0.09, ARM_Y - HEAD_TOP + 0.02, 0.09);
    drop.translate(headX, (ARM_Y + HEAD_TOP) / 2, headZ);
    staticParts.push(bakeColor(drop, color('pole')));

    // Housing body: dark box with its front (+X in local coords) rotated to face the driver.
    const yaw = dirYaw(opposite(a.d));
    const body = new THREE.BoxGeometry(HEAD_D, HEAD_H, HEAD_W);
    body.translate(0, HEAD_TOP - HEAD_H / 2, 0);
    body.rotateY(yaw);
    body.translate(headX, 0, headZ);
    staticParts.push(bakeColor(body, color('rooftop')));

    // Visor cap so the housing reads as a signal from above, not a plain box.
    const visor = new THREE.BoxGeometry(HEAD_D + 0.16, 0.07, HEAD_W + 0.1);
    visor.translate(0, HEAD_TOP + 0.035, 0);
    visor.rotateY(yaw);
    visor.translate(headX, 0, headZ);
    staticParts.push(bakeColor(visor, color('rooftop')));

    // Lens positions on the front face — front is the -fwd direction (facing the driver), and
    // the three lenses stack vertically at even spacing.
    const midY = HEAD_TOP - HEAD_H / 2;
    const spacing = HEAD_H * 0.29;
    const fx = headX - fwd.x * (HEAD_D / 2 + 0.02);
    const fz = headZ - fwd.z * (HEAD_D / 2 + 0.02);
    heads.push({
      a,
      lens: [
        { x: fx, y: midY + spacing, z: fz },
        { x: fx, y: midY,           z: fz },
        { x: fx, y: midY - spacing, z: fz },
      ],
    });
  }

  const merged = mergeGeometries(staticParts, false);
  staticParts.forEach((p) => p.dispose());
  const structure = new THREE.Mesh(merged, propMaterial());
  structure.castShadow = true;
  structure.receiveShadow = true;
  structure.name = 'signalOverhead';
  scene.add(structure);

  const lenses = threeLensHeads(scene, heads, LENS_R);
  return { style: 'overhead', mesh: structure, update: lenses.update };
}

// --- Corner pedestal signal -----------------------------------------------
//
// Short post on the near-right corner (before the intersection) with a compact three-lens head
// on top facing the driver. Modern European style — the head sits at driver eye-line rather than
// swinging over the road, which reads cleaner but is easier to miss from far away.

function postSignals(scene, approaches) {
  const POLE_H = 2.75;
  const POLE_R = 0.09;
  const HEAD_H = 1.05;
  const HEAD_W = 0.34;
  const HEAD_D = 0.28;
  const LENS_R = 0.13;

  const staticParts = [];
  const heads = [];

  for (const a of approaches) {
    const cx = lineCoord(a.i);
    const cz = lineCoord(a.j);
    const fwd = FWD[a.d];
    const right = RIGHT[a.d];

    // Near-right corner: before the intersection along the approach, driver's right on the kerb.
    const poleX = cx - fwd.x * HALF_ROAD + right.x * (HALF_ROAD + 0.55);
    const poleZ = cz - fwd.z * HALF_ROAD + right.z * (HALF_ROAD + 0.55);

    const pole = new THREE.CylinderGeometry(POLE_R, POLE_R * 1.3, POLE_H, 6);
    pole.translate(poleX, POLE_H / 2, poleZ);
    staticParts.push(bakeColor(pole, color('pole')));

    // Housing sits on top of the pole, oriented to face the driver.
    const yaw = dirYaw(opposite(a.d));
    const headTop = POLE_H + HEAD_H;
    const body = new THREE.BoxGeometry(HEAD_D, HEAD_H, HEAD_W);
    body.translate(0, POLE_H + HEAD_H / 2, 0);
    body.rotateY(yaw);
    body.translate(poleX, 0, poleZ);
    staticParts.push(bakeColor(body, color('rooftop')));

    // Small cap so the top of the head reads as a hood rather than a bare box.
    const cap = new THREE.BoxGeometry(HEAD_D + 0.08, 0.05, HEAD_W + 0.06);
    cap.translate(0, headTop + 0.025, 0);
    cap.rotateY(yaw);
    cap.translate(poleX, 0, poleZ);
    staticParts.push(bakeColor(cap, color('rooftop')));

    const midY = POLE_H + HEAD_H / 2;
    const spacing = HEAD_H * 0.28;
    const fx = poleX - fwd.x * (HEAD_D / 2 + 0.02);
    const fz = poleZ - fwd.z * (HEAD_D / 2 + 0.02);
    heads.push({
      a,
      lens: [
        { x: fx, y: midY + spacing, z: fz },
        { x: fx, y: midY,           z: fz },
        { x: fx, y: midY - spacing, z: fz },
      ],
    });
  }

  const merged = mergeGeometries(staticParts, false);
  staticParts.forEach((p) => p.dispose());
  const structure = new THREE.Mesh(merged, propMaterial());
  structure.castShadow = true;
  structure.receiveShadow = true;
  structure.name = 'signalPost';
  scene.add(structure);

  const lenses = threeLensHeads(scene, heads, LENS_R);
  return { style: 'post', mesh: structure, update: lenses.update };
}

// --- Glowing bollard ------------------------------------------------------
//
// One chunky bollard at each stop line with a domed top that glows the current phase colour.
// No pole, no arm, no lenses — the whole cap changes colour. Very much a toy-city read that
// leans into the low-poly aesthetic rather than mimicking a real intersection.

function bollardSignals(scene, approaches) {
  const BODY_H = 1.0;
  const BODY_R = 0.34;
  const DOME_R = BODY_R;
  const BAR_DISTANCE = HALF_ROAD + 2.05;

  const staticParts = [];
  const heads = [];

  for (const a of approaches) {
    const back = -dirSign(a.d) * BAR_DISTANCE;
    const lane = laneOffsetCoord(a.d, a.i, a.j);
    const x = isXAxis(a.d) ? lineCoord(a.i) + back : lane;
    const z = isXAxis(a.d) ? lane : lineCoord(a.j) + back;

    // Dark body: short cylinder standing on the tarmac.
    const body = new THREE.CylinderGeometry(BODY_R, BODY_R * 1.15, BODY_H, 8);
    body.translate(x, BODY_H / 2, z);
    staticParts.push(bakeColor(body, color('lightOff')));

    // A slim collar just below the dome sells the "cap sitting on a post" silhouette.
    const collar = new THREE.CylinderGeometry(BODY_R * 1.08, BODY_R * 1.08, 0.08, 8);
    collar.translate(x, BODY_H - 0.04, z);
    staticParts.push(bakeColor(collar, color('pole')));

    heads.push({ a, x, y: BODY_H, z });
  }

  const merged = mergeGeometries(staticParts, false);
  staticParts.forEach((p) => p.dispose());
  const structure = new THREE.Mesh(merged, propMaterial());
  structure.castShadow = true;
  structure.receiveShadow = true;
  structure.name = 'signalBollard';
  scene.add(structure);

  // Dome: hemisphere, white-baked so per-instance colour tints it directly.
  const domeGeo = new THREE.SphereGeometry(DOME_R, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeInstance = new THREE.InstancedMesh(
    bakeColor(domeGeo, new THREE.Color(1, 1, 1)),
    propMaterial(),
    heads.length,
  );
  domeInstance.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  domeInstance.castShadow = true;
  domeInstance.name = 'signalBollardCap';

  const dummy = new THREE.Object3D();
  heads.forEach((h, i) => {
    dummy.position.set(h.x, h.y, h.z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    domeInstance.setMatrixAt(i, dummy.matrix);
  });
  domeInstance.instanceMatrix.needsUpdate = true;
  scene.add(domeInstance);

  const c = new THREE.Color();
  return {
    style: 'bollard',
    mesh: structure,
    update(t, lightPhase) {
      for (let i = 0; i < heads.length; i++) {
        c.set(SLOT_COLOR[phaseSlot(heads[i].a, t, lightPhase)]);
        domeInstance.setColorAt(i, c);
      }
      if (domeInstance.instanceColor) domeInstance.instanceColor.needsUpdate = true;
    },
  };
}
