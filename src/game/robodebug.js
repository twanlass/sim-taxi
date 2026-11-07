import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { routePath } from './routeline.js';

// `?robodebug`: every robo-taxi's plan drawn on the map, for reading what the robots are doing
// rather than guessing (Tyler, 2026-11-07). A flat ribbon down the lane path it is going to drive —
// the same `routePath` the taxi's band is built from — from the car to its goal, and a post standing
// on the goal: cyan while it hunts (the post on the rider it has claimed, or on a random junction
// while there is nobody to take), magenta while it carries a rider to their drop-off. Nothing
// while it stands at a corner. Drawn on top of everything, because a debug line hidden behind a
// tower answers nothing.
//
// All of them, all the time, rather than one picked with a tap: the tap belongs to the fares, and
// two lines are not too many to read.

const MAX_POINTS = 400;
const RIBBON_Y = 0.35;
const RIBBON_HALF = 0.22;
const POST_H = 4;
const POST_HALF = 0.18;

export function createRoboDebug(scene, robotaxis) {
  const colours = { hunt: PALETTE.roboDebugHunt, ride: PALETTE.roboDebugRide };
  const views = robotaxis.state.robos.map(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 18), 3));
    const material = unlitMaterial({ color: colours.hunt, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const ribbon = new THREE.Mesh(geometry, material);
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 50;
    const post = new THREE.Mesh(new THREE.BoxGeometry(POST_HALF * 2, POST_H, POST_HALF * 2), material);
    post.renderOrder = 50;
    ribbon.visible = false;
    post.visible = false;
    scene.add(ribbon, post);
    return { ribbon, post, material };
  });

  function update() {
    robotaxis.state.robos.forEach((robo, k) => {
      const view = views[k];
      const colour = colours[robo.phase];
      const car = robo.car;
      const show = Boolean(car && colour && robo.goal);
      view.ribbon.visible = show;
      view.post.visible = show;
      if (!show) return;
      view.material.color.set(colour);
      view.post.position.set(robo.goal.x, POST_H / 2, robo.goal.z);

      const pts = [{ x: car.x, z: car.z }, ...(car.route?.length ? routePath(car, car.route, { onward: false }) : []),
        { x: robo.goal.x, z: robo.goal.z }];
      const pos = view.ribbon.geometry.attributes.position;
      let n = 0;
      for (let p = 0; p + 1 < pts.length && n < MAX_POINTS; p++) {
        const a = pts[p];
        const b = pts[p + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-4) continue;
        // Across the segment, so each one is a flat quad on the road. Wound to face up.
        const ox = (-dz / l) * RIBBON_HALF;
        const oz = (dx / l) * RIBBON_HALF;
        const quad = [
          [a.x - ox, a.z - oz], [a.x + ox, a.z + oz], [b.x - ox, b.z - oz],
          [b.x - ox, b.z - oz], [a.x + ox, a.z + oz], [b.x + ox, b.z + oz],
        ];
        quad.forEach(([x, z], v) => pos.setXYZ(n * 6 + v, x, RIBBON_Y, z));
        n += 1;
      }
      view.ribbon.geometry.setDrawRange(0, n * 6);
      pos.needsUpdate = true;
    });
  }

  return { update };
}
