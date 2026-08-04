import * as THREE from 'three';
import {
  GRID, PITCH, ROAD_W, HALF_ROAD, HALF_SPAN, lineCoord,
  dirYaw, nextIntersection, segmentKey,
} from '../city/grid.js';
import { KERB_H } from '../city/ground.js';

// Editor-mode overlay. Draws two layers on top of the city:
//
//  - Invisible pick planes (blocks and road segments) that the editor's raycaster hits so it
//    knows what the cursor is over. Kept invisible because the city geometry underneath already
//    reads perfectly — a coloured wash would fight it.
//  - Visible feedback: a hover highlight on the picked target, an "X" on each closed road, arrows
//    on each arterial line pointing the coordinated direction, and a pin at the taxi start.
//
// The whole thing sits under one Group so entering / leaving editor mode is a single `visible`
// flip; nothing about the city or the sim knows about it.

const HOVER_Y = KERB_H + 0.05;   // just above the block platform, below any prop
const MARK_Y = 0.03;             // paint layer, same plane as lane markings

export function createEditorOverlay() {
  const group = new THREE.Group();
  group.name = 'editor-overlay';
  group.visible = false;

  // --- Pick planes ---------------------------------------------------------

  const blockPicks = new THREE.Group();
  const segmentPicks = new THREE.Group();
  const intersectionPicks = new THREE.Group();
  group.add(blockPicks, segmentPicks, intersectionPicks);

  const pickMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const x0 = lineCoord(bi) + HALF_ROAD;
      const z0 = lineCoord(bj) + HALF_ROAD;
      const size = PITCH - ROAD_W;
      const geo = new THREE.PlaneGeometry(size, size);
      geo.rotateX(-Math.PI / 2);
      geo.translate(x0 + size / 2, KERB_H + 0.001, z0 + size / 2);
      const m = new THREE.Mesh(geo, pickMat);
      m.userData = { pickable: 'block', bi, bj };
      blockPicks.add(m);
    }
  }

  // Segments: one per (from-intersection, direction). We only add the "positive" half of each
  // pair (d = +X and d = +Z) so a segment isn't picked twice from either end.
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      for (const d of [0, 1]) {
        const next = nextIntersection(d, i, j);
        if (!next) continue;
        const x0 = lineCoord(i);
        const z0 = lineCoord(j);
        const x1 = lineCoord(next.i);
        const z1 = lineCoord(next.j);
        const w = d === 0 ? PITCH - ROAD_W : ROAD_W - 0.4;
        const h = d === 1 ? PITCH - ROAD_W : ROAD_W - 0.4;
        const geo = new THREE.PlaneGeometry(w, h);
        geo.rotateX(-Math.PI / 2);
        geo.translate((x0 + x1) / 2, KERB_H + 0.001, (z0 + z1) / 2);
        const m = new THREE.Mesh(geo, pickMat);
        m.userData = { pickable: 'segment', key: segmentKey(i, j, next.i, next.j), i, j, d };
        segmentPicks.add(m);
      }
    }
  }

  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      const geo = new THREE.PlaneGeometry(ROAD_W - 0.4, ROAD_W - 0.4);
      geo.rotateX(-Math.PI / 2);
      geo.translate(lineCoord(i), KERB_H + 0.001, lineCoord(j));
      const m = new THREE.Mesh(geo, pickMat);
      m.userData = { pickable: 'intersection', i, j };
      intersectionPicks.add(m);
    }
  }

  // --- Visible feedback ---------------------------------------------------

  const feedback = new THREE.Group();
  feedback.name = 'editor-feedback';
  group.add(feedback);

  const hoverMat = new THREE.MeshBasicMaterial({
    color: 0xF5C130, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
  });
  const hoverBlockGeo = new THREE.PlaneGeometry(PITCH - ROAD_W, PITCH - ROAD_W);
  hoverBlockGeo.rotateX(-Math.PI / 2);
  const hoverBlock = new THREE.Mesh(hoverBlockGeo, hoverMat);
  hoverBlock.visible = false;
  feedback.add(hoverBlock);

  const hoverSegX = new THREE.Mesh(new THREE.PlaneGeometry(PITCH - ROAD_W, ROAD_W - 0.4), hoverMat);
  hoverSegX.geometry.rotateX(-Math.PI / 2);
  hoverSegX.visible = false;
  feedback.add(hoverSegX);

  const hoverSegZ = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W - 0.4, PITCH - ROAD_W), hoverMat);
  hoverSegZ.geometry.rotateX(-Math.PI / 2);
  hoverSegZ.visible = false;
  feedback.add(hoverSegZ);

  const hoverIntersection = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_W - 0.6, ROAD_W - 0.6),
    hoverMat,
  );
  hoverIntersection.geometry.rotateX(-Math.PI / 2);
  hoverIntersection.visible = false;
  feedback.add(hoverIntersection);

  // Persistent state layer (closures, arterials, taxi start). Rebuilt whenever the editor's
  // state changes — cheap because it's a few dozen small meshes.
  const state = new THREE.Group();
  state.name = 'editor-state';
  feedback.add(state);

  const closedMat = new THREE.MeshBasicMaterial({
    color: 0xE24B4B, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  });
  const arterialMat = new THREE.MeshBasicMaterial({
    color: 0x6BE08A, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
  });
  const taxiMat = new THREE.MeshBasicMaterial({
    color: 0xF5C130, side: THREE.DoubleSide, depthWrite: false,
  });

  function clearGroup(g) {
    while (g.children.length) {
      const child = g.children.pop();
      child.geometry?.dispose?.();
    }
  }

  /** X mark on a closed road segment. */
  function addClosedMark(i, j, d) {
    const next = nextIntersection(d, i, j);
    if (!next) return;
    const cx = (lineCoord(i) + lineCoord(next.i)) / 2;
    const cz = (lineCoord(j) + lineCoord(next.j)) / 2;
    const len = PITCH - ROAD_W - 2;
    for (const rot of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.PlaneGeometry(len, 0.6);
      bar.rotateX(-Math.PI / 2);
      bar.rotateY(rot);
      bar.translate(cx, HOVER_Y + 0.02, cz);
      state.add(new THREE.Mesh(bar, closedMat));
    }
  }

  /**
   * A row of arrows along an arterial line, pointing in the coordinated direction. Drawn as
   * chevrons on the pavement so it's clear which way traffic gets the wave.
   */
  function addArterialArrows(axis, line, sign) {
    // Lines running along X sit at z = lineCoord(line), spanning the whole city in x.
    const runsAlongX = axis === 'x';
    const chevronCount = GRID;
    for (let n = 0; n < chevronCount; n++) {
      const t = (n + 0.5) / chevronCount;
      const along = -HALF_SPAN + t * HALF_SPAN * 2;
      const cx = runsAlongX ? along : lineCoord(line);
      const cz = runsAlongX ? lineCoord(line) : along;
      const yaw = runsAlongX
        ? (sign > 0 ? -Math.PI / 2 : Math.PI / 2)
        : (sign > 0 ? 0 : Math.PI);
      state.add(makeChevron(cx, cz, yaw));
    }
  }

  function makeChevron(x, z, yaw) {
    // Triangle points along +X before the yaw is applied.
    const shape = new THREE.Shape();
    shape.moveTo(1.4, 0);
    shape.lineTo(-0.8, 0.9);
    shape.lineTo(-0.3, 0);
    shape.lineTo(-0.8, -0.9);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(yaw);
    geo.translate(x, MARK_Y + 0.03, z);
    return new THREE.Mesh(geo, arterialMat);
  }

  function addTaxiPin(i, j, d) {
    const x = lineCoord(i);
    const z = lineCoord(j);
    const ring = new THREE.RingGeometry(1.4, 1.9, 20);
    ring.rotateX(-Math.PI / 2);
    ring.translate(x, HOVER_Y + 0.01, z);
    state.add(new THREE.Mesh(ring, taxiMat));

    // A wedge pointing in the taxi's initial heading.
    const shape = new THREE.Shape();
    shape.moveTo(1.6, 0);
    shape.lineTo(0.2, 0.9);
    shape.lineTo(0.2, -0.9);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(dirYaw(d));
    geo.translate(x, HOVER_Y + 0.02, z);
    state.add(new THREE.Mesh(geo, taxiMat));
  }

  /**
   * Rebuild the state layer from a fresh editor snapshot. Cheap enough to redo on every edit —
   * the layer is at most a few dozen quads.
   */
  function syncState(editorState) {
    clearGroup(state);

    // Closures.
    for (const key of editorState.closed) {
      // A segmentKey is "i,j|i,j" with the endpoints sorted. Recover a from-intersection + d.
      const [a, b] = key.split('|');
      const [ai, aj] = a.split(',').map(Number);
      const [bi, bj] = b.split(',').map(Number);
      const d = bi > ai ? 0 : bj > aj ? 1 : bi < ai ? 2 : 3;
      addClosedMark(ai, aj, d);
    }

    // Arterials.
    for (const j of editorState.arterialX) {
      addArterialArrows('x', j, editorState.dirX.get(j) ?? 1);
    }
    for (const i of editorState.arterialZ) {
      addArterialArrows('z', i, editorState.dirZ.get(i) ?? 1);
    }

    if (editorState.taxiStart) {
      const { i, j, d } = editorState.taxiStart;
      addTaxiPin(i, j, d);
    }
  }

  function setHover(kind, data) {
    hoverBlock.visible = false;
    hoverSegX.visible = false;
    hoverSegZ.visible = false;
    hoverIntersection.visible = false;
    if (!kind) return;

    if (kind === 'block') {
      const x0 = lineCoord(data.bi) + HALF_ROAD;
      const z0 = lineCoord(data.bj) + HALF_ROAD;
      const size = PITCH - ROAD_W;
      hoverBlock.position.set(x0 + size / 2, HOVER_Y, z0 + size / 2);
      hoverBlock.visible = true;
    } else if (kind === 'segment') {
      const next = nextIntersection(data.d, data.i, data.j);
      if (!next) return;
      const cx = (lineCoord(data.i) + lineCoord(next.i)) / 2;
      const cz = (lineCoord(data.j) + lineCoord(next.j)) / 2;
      const hover = data.d === 0 ? hoverSegX : hoverSegZ;
      hover.position.set(cx, HOVER_Y, cz);
      hover.visible = true;
    } else if (kind === 'intersection') {
      hoverIntersection.position.set(lineCoord(data.i), HOVER_Y, lineCoord(data.j));
      hoverIntersection.visible = true;
    }
  }

  return {
    group,
    pickTargets: [blockPicks, segmentPicks, intersectionPicks],
    syncState,
    setHover,
    show(v) { group.visible = v; },
    dispose() {
      clearGroup(state);
      hoverBlock.geometry.dispose();
      hoverSegX.geometry.dispose();
      hoverSegZ.geometry.dispose();
      hoverIntersection.geometry.dispose();
      for (const g of [blockPicks, segmentPicks, intersectionPicks]) {
        g.children.forEach((c) => c.geometry.dispose());
      }
    },
  };
}
