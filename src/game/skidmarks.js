import * as THREE from 'three';

// Rubber left on the road when the taxi throws it around a corner in crazy mode.
//
// One geometry, one draw call, used as a ring buffer: quads are stamped in place and fade by
// alpha rather than being created and destroyed, so a long boost costs nothing extra.
//
// Alpha rides in a four-component colour attribute. three.js switches the shader to
// USE_COLOR_ALPHA based on the attribute's itemSize, which is the only way to vary transparency
// per-quad inside a single mesh — instanced colour is RGB only.

// Sized against the actual camera, not against the car. At the play zoom one world unit is
// roughly 7.7 screen pixels, so the first pass — 0.3 wide — was a two-pixel smear of near-black
// on dark tarmac. It was rendering correctly the whole time and was simply too small to see.
const MAX_MARKS = 320;
const LIFE = 3.6;
const START_ALPHA = 0.85;
const MARK_LENGTH = 1.5;
const MARK_WIDTH = 0.58;

export function createSkidMarks(scene) {
  const positions = new Float32Array(MAX_MARKS * 6 * 3);
  const colors = new Float32Array(MAX_MARKS * 6 * 4);
  const life = new Float32Array(MAX_MARKS);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 2;   // over the tarmac, under the cars and every game marker
  mesh.frustumCulled = false;
  scene.add(mesh);

  let next = 0;

  /** Stamp one mark, centred at (x, z) and lying along `yaw`. */
  function add(x, z, yaw) {
    const slot = next;
    next = (next + 1) % MAX_MARKS;
    life[slot] = LIFE;

    const fx = Math.cos(yaw) * (MARK_LENGTH / 2);
    const fz = -Math.sin(yaw) * (MARK_LENGTH / 2);
    const rx = Math.sin(yaw) * (MARK_WIDTH / 2);
    const rz = Math.cos(yaw) * (MARK_WIDTH / 2);

    const corners = [
      [x - fx - rx, z - fz - rz], [x + fx - rx, z + fz - rz], [x + fx + rx, z + fz + rz],
      [x - fx - rx, z - fz - rz], [x + fx + rx, z + fz + rz], [x - fx + rx, z - fz + rz],
    ];

    let p = slot * 18;
    for (const [cx, cz] of corners) {
      positions[p++] = cx;
      positions[p++] = 0.035;   // just clear of the road markings
      positions[p++] = cz;
    }
    geometry.attributes.position.needsUpdate = true;
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_MARKS; slot++) {
      if (life[slot] <= 0) continue;
      life[slot] -= dt;
      // Write one final zero-alpha frame as it expires, or the last visible value sticks forever.
      const alpha = Math.max(0, life[slot] / LIFE) * START_ALPHA;
      let c = slot * 24;
      for (let v = 0; v < 6; v++) {
        colors[c] = 0; colors[c + 1] = 0; colors[c + 2] = 0; colors[c + 3] = alpha;
        c += 4;
      }
      touched = true;
    }
    if (touched) geometry.attributes.color.needsUpdate = true;
  }

  return { mesh, add, update };
}
