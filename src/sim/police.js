import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { GRID, HALF_SPAN, lineCoord, isSegmentClosed } from '../city/grid.js';
import { setPriorityCorridor, ROAD_Y } from './traffic.js';

// A police car running a priority corridor across the city: every signal on its road goes green,
// every crossing road goes red, and the traffic model reacts on its own because the override lives
// inside lightPhase.
//
// It drives the *centreline*, straddling both lanes. That is partly character — an emergency
// vehicle overtaking down the middle — and partly practical: it sidesteps the lane-following and
// collision machinery entirely, so it can move at twice the speed of traffic without needing to
// queue behind anyone or clip them.

const SPEED = 19;
const RUN_MARGIN = 26;          // how far off-map it starts and ends

// Boosting inside this radius while the police car is on a run ends the run — reckless driving in
// front of a cop. Two blocks in world units (PITCH = 20 in src/city/grid.js), which is close
// enough that the siren is already on top of the taxi before the bust fires — it reads as being
// caught rather than teleporting into custody.
export const POLICE_BUST_RANGE = 40;

// The car used to appear and vanish at full opacity out past the edge of the asphalt, against
// bare background — a hard pop at both ends of every run. It now dissolves across this band,
// reaching fully invisible before it hits the turnaround, so the disappearance never lands on a
// single frame.
const FADE_BAND = 18;

/** 1 while over the city, easing to 0 as the car runs off the slab. */
function edgeFade(s) {
  const beyond = Math.abs(s) - HALF_SPAN;
  if (beyond <= 0) return 1;
  return Math.max(0, 1 - beyond / FADE_BAND);
}

function policeGeometry() {
  const parts = [];

  const body = new THREE.BoxGeometry(3.6, 0.8, 1.8);
  body.translate(0, 0.78, 0);
  parts.push(bakeColor(body, color('policeBody')));

  const roof = new THREE.BoxGeometry(1.9, 0.62, 1.6);
  roof.translate(-0.2, 1.46, 0);
  parts.push(bakeColor(roof, color('policeRoof')));

  const stripe = new THREE.BoxGeometry(3.62, 0.3, 1.82);
  stripe.translate(0, 0.62, 0);
  parts.push(bakeColor(stripe, color('policeRoof')));

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 8);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(sx * 1.08, 0.32, sz * 0.88);
      parts.push(bakeColor(wheel, new THREE.Color(0.16, 0.16, 0.18)));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function lightBar(group) {
  const make = (hex, z) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.26, 0.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex) }),
    );
    mesh.position.set(-0.2, 1.9, z);
    group.add(mesh);
    return mesh;
  };

  // Actual lights, not just glowing boxes. The bar alone is a couple of pixels; what sells a
  // siren is the colour washing across the tarmac and the fronts of nearby buildings as it goes
  // past. No shadows — these are cheap fill, and shadow-casting point lights are not.
  const lamp = (hex, z) => {
    const light = new THREE.PointLight(new THREE.Color(hex), 0, 34, 1.7);
    light.position.set(-0.2, 2.1, z);
    group.add(light);
    return light;
  };

  return {
    red: make(PALETTE.lightRed, -0.42),
    blue: make('#4D9BFF', 0.42),
    redLamp: lamp(PALETTE.lightRed, -0.42),
    blueLamp: lamp('#4D9BFF', 0.42),
  };
}

export function createPolice(rng, scene) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(policeGeometry(), propMaterial());
  group.add(body);
  const lights = lightBar(group);
  group.visible = false;
  scene.add(group);

  // Every material this car owns. `propMaterial()` hands back a fresh instance per call, so
  // making these transparent affects the police car alone and not the merged prop meshes.
  const skin = [body.material, lights.red.material, lights.blue.material];
  for (const material of skin) material.transparent = true;

  const state = {
    active: false,
    axis: 'x',
    line: 0,
    dir: 1,
    s: 0,
    cooldown: rng.range(5, 12),
    runs: 0,
    flash: 0,
  };

  /**
   * A park district builds over the road that used to run between its two blocks. The police car
   * drives a whole line end to end, so a corridor down a line with a closed segment sends it
   * straight through the trees.
   */
  const lineIsClear = (axis, line) => {
    for (let k = 0; k < GRID; k++) {
      const closed = axis === 'x' ? isSegmentClosed(k, line, 0) : isSegmentClosed(line, k, 1);
      if (closed) return false;
    }
    return true;
  };

  function start() {
    let axis = null;
    let line = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tryAxis = rng.chance(0.5) ? 'x' : 'z';
      const tryLine = rng.int(0, GRID);
      if (lineIsClear(tryAxis, tryLine)) { axis = tryAxis; line = tryLine; break; }
    }
    if (axis === null) { state.cooldown = 6; return; }   // nothing clear right now; try later

    state.axis = axis;
    state.line = line;
    state.dir = rng.chance(0.5) ? 1 : -1;
    state.s = state.dir > 0 ? -HALF_SPAN - RUN_MARGIN : HALF_SPAN + RUN_MARGIN;
    state.active = true;
    state.runs += 1;
    group.visible = true;
    place();   // otherwise it is drawn at last run's position for one frame
    setPriorityCorridor({ axis: state.axis, line: state.line });
  }

  function place() {
    const c = lineCoord(state.line);
    if (state.axis === 'x') {
      group.position.set(state.s, ROAD_Y, c);
      group.rotation.y = state.dir > 0 ? 0 : Math.PI;
    } else {
      group.position.set(c, ROAD_Y, state.s);
      group.rotation.y = state.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
  }

  function stop() {
    lights.redLamp.intensity = 0;
    lights.blueLamp.intensity = 0;
    state.active = false;
    group.visible = false;
    setPriorityCorridor(null);
    state.cooldown = rng.range(16, 30);
  }

  function update(dt) {
    state.flash += dt;

    if (!state.active) {
      state.cooldown -= dt;
      if (state.cooldown <= 0) start();
      return;
    }

    state.s += state.dir * SPEED * dt;
    const past = state.dir > 0
      ? state.s > HALF_SPAN + RUN_MARGIN
      : state.s < -HALF_SPAN - RUN_MARGIN;
    if (past) { stop(); return; }

    place();

    // The lamps fade with the bodywork. Leaving them at full strength would keep washing colour
    // across the tarmac from a car that is no longer there.
    const fade = edgeFade(state.s);
    for (const material of skin) material.opacity = fade;

    // Alternating bar, six changes a second.
    const on = Math.floor(state.flash * 6) % 2 === 0;
    lights.red.visible = on;
    lights.blue.visible = !on;
    // Never fully dark on either side — a hard on/off strobe reads as flicker rather than a
    // siren, so the off colour keeps a low glow.
    lights.redLamp.intensity = (on ? 90 : 14) * fade;
    lights.blueLamp.intensity = (on ? 14 : 90) * fade;
  }

  return { state, update, group };
}
