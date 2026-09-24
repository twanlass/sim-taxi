import * as THREE from 'three';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';

// The starburst a bump pops at the point of contact — a cartoon "POW" rather than a simulated one.
//
// Sparks and a puff of dust were the first answer and they undersold it: both are a few pixels at
// play zoom, both are the same vocabulary a jump landing already speaks, and neither says *two
// cars just touched here*. A spiky flat star in the screen plane does, at a glance, from across
// the map. It is the one stylised graphic in the crash vocabulary on purpose — the wreck has the
// fireball, the bump gets the comic panel.
//
// Three stacked stars — a dark rim, the yellow body, a pale core — each a flat ShapeGeometry facing
// the camera. Drawn over everything (no depth test): it marks where the hit was, and a burst half
// buried in the car that made it is a burst nobody reads. A small pool, recycled oldest-first;
// two bumps inside its short life is already a lot.

const POOL = 4;
const LIFE = 0.32;          // s
const POP = 0.06;           // s out to the overshoot
const SPIKES = 9;
// World units, on an ortho camera where 1 unit ≈ 7.7px at play zoom: a 1.6 radius is a 25px star
// for a nudge, growing to ~2.6 (40px) for a hit in the overdrive band.
const BASE_R = 1.6;
const R_PER_UNIT = 0.035;
const MAX_R = 2.6;
const LIFT = 1.4;           // above the road, so it sits over the two roofs rather than under them

function starShape(outer, inner, rng) {
  const shape = new THREE.Shape();
  for (let n = 0; n < SPIKES * 2; n++) {
    const a = (n / (SPIKES * 2)) * Math.PI * 2;
    // Uneven spikes: a regular star reads as a badge, a ragged one as an impact.
    const r = n % 2 === 0 ? outer * (0.78 + 0.22 * rng(n)) : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (n === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

// Fixed per-spike jitter rather than an rng stream: the shape is baked once at boot and drawing a
// seed for it would shift every stream downstream of wherever it was taken from.
const ragged = (n) => (Math.sin(n * 12.9898) * 43758.5453) % 1 * 0.5 + 0.5;

export function createImpact(scene, camera) {
  const layers = [
    { shape: starShape(1.18, 0.62, ragged), tint: 'impactRim', z: 0 },
    { shape: starShape(1.0, 0.52, ragged), tint: 'impactBody', z: 0.01 },
    { shape: starShape(0.5, 0.28, (n) => ragged(n + 7)), tint: 'impactCore', z: 0.02 },
  ].map(({ shape, tint, z }) => ({ geometry: new THREE.ShapeGeometry(shape), tint, z }));

  const slots = [];
  for (let n = 0; n < POOL; n++) {
    const group = new THREE.Group();
    const spin = new THREE.Group();
    group.add(spin);
    const materials = [];
    layers.forEach(({ geometry, tint, z }, order) => {
      const material = unlitMaterial({
        color: color(tint), transparent: true, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = z;
      mesh.renderOrder = 20 + order;
      mesh.frustumCulled = false;
      spin.add(mesh);
      materials.push(material);
    });
    group.visible = false;
    scene.add(group);
    slots.push({ group, spin, materials, age: LIFE, r: BASE_R });
  }
  let next = 0;

  function fire(x, z, closing = 0) {
    const slot = slots[next];
    next = (next + 1) % POOL;
    slot.age = 0;
    slot.r = Math.min(MAX_R, BASE_R + closing * R_PER_UNIT);
    slot.group.position.set(x, LIFT, z);
    slot.spin.rotation.z = Math.random() * Math.PI * 2;
    slot.group.visible = true;
  }

  function update(dt) {
    for (const slot of slots) {
      if (slot.age >= LIFE) continue;
      slot.age += dt;
      if (slot.age >= LIFE) { slot.group.visible = false; continue; }
      const t = slot.age;
      // Pops out past full size, settles back, and shrinks a little as it fades — a panel that
      // slams in and is gone, rather than a shape that grows and dissolves.
      const k = t < POP ? 1.2 * (t / POP) : 1.2 - 0.35 * ((t - POP) / (LIFE - POP));
      slot.group.scale.setScalar(slot.r * k);
      slot.group.quaternion.copy(camera.quaternion);
      slot.spin.rotation.z += dt * 1.5;
      const fade = Math.min(1, (LIFE - t) / (LIFE * 0.4));
      for (const material of slot.materials) material.opacity = fade;
    }
  }

  return { fire, update };
}
