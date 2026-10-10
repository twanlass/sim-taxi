import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';

// The placed sounds' falloff, drawn on the ground while the ⚙️ panel is open: a warm circle where a
// sound is at full level and a cool one where it runs out, at each source of the one sound being
// edited in the panel (main.js filters by `audioFocus`), plus a mark at the listener (the middle of the screen — see `placeAt` in main.js). So a designer
// dragging "Full within" or "Silent past" sees the circle move with it, and can drive or pan in and
// out of it and hear what it does. Debug only: built with the panel, hidden whenever it is shut.
//
// A translucent disc for the full-level zone and a band at the edge where it runs out. Lines were
// tried first and at one pixel they vanished into the road at play zoom. No depth test, so a
// building cannot hide the circle it is standing in.

const SEGMENTS = 64;
const LIFT = 0.3;
const EAR_R = 1.2;
// The band's width as a fraction of its radius, so it scales with the mesh: 0.8 units at 40.
const BAND = 0.02;

// Both lie in XY facing +Z out of three, and the quarter turn about −X stands them face-up (+Y).
const flat = (geometry) => geometry.rotateX(-Math.PI / 2);

export function createSoundRings(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const disc = flat(new THREE.CircleGeometry(1, SEGMENTS));
  const band = flat(new THREE.RingGeometry(1 - BAND, 1, SEGMENTS));
  const mat = (color, opacity) => unlitMaterial({
    color, transparent: true, opacity, depthTest: false, depthWrite: false,
  });
  const nearMat = mat(PALETTE.soundNear, 0.18);
  const farMat = mat(PALETTE.soundFar, 0.75);
  const earMat = mat(PALETTE.soundEar, 0.9);

  const ear = new THREE.Mesh(disc, earMat);
  ear.scale.setScalar(EAR_R);
  ear.renderOrder = 999;
  group.add(ear);

  const pool = [];
  function ring(n) {
    while (pool.length <= n) {
      const near = new THREE.Mesh(disc, nearMat);
      const far = new THREE.Mesh(band, farMat);
      near.renderOrder = far.renderOrder = 999;
      group.add(near, far);
      pool.push({ near, far });
    }
    return pool[n];
  }

  /**
   * @param {boolean} on  The ⚙️ panel is open.
   * @param {{x:number,z:number}} listener
   * @param {{key:string,x:number,z:number}[]} sources
   * @param {Record<string,{near:number,far:number}>} place  `sfx.tuning().place`
   */
  function update(on, listener, sources, place) {
    group.visible = on;
    if (!on) return;
    ear.position.set(listener.x, LIFT, listener.z);
    let n = 0;
    for (const s of sources) {
      const p = place[s.key];
      if (!p) continue;
      const r = ring(n++);
      r.near.visible = r.far.visible = true;
      r.near.position.set(s.x, LIFT, s.z);
      r.far.position.set(s.x, LIFT, s.z);
      r.near.scale.setScalar(Math.max(0.01, p.near));
      r.far.scale.setScalar(p.far);
    }
    for (let k = n; k < pool.length; k++) pool[k].near.visible = pool[k].far.visible = false;
  }

  return { group, update };
}
