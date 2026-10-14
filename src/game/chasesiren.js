import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';
import { unlitMaterial } from '../util/geo.js';

// The chase siren: a low-poly 🚨 in the top-centre of the HUD for as long as the police are after the
// taxi — a patrol chase (game/patrol.js) or a getaway (game/robbery.js). Tyler's idea (2026-10-14),
// circled on a phone screenshot: the city already says "chase" with the strobing bar and the wash
// over the frame edge (game/sirenglow.js), but both of those are about where the cop *is*, and a
// cop that has dropped round a corner takes them both with it while the chase is still very much on.
// This is the one cue that is about the state rather than the car.
//
// ## Where it sits
//
// Centred under the cash row, which is where the combo meter lives — so it sits directly beneath the
// meter when there is a combo going and on its own under an empty row when there is not. Inside
// `#hud`, so it rides every rule that already hides the HUD (the title, the replay, shot mode, the
// slide in and out) without a line of its own in any of them.
//
// ## Same rig as the cargo chip
//
// A small WebGL context of its own drawing a real mesh (game/cargochip.js has the reasoning), so the
// thing turns and flashes as an object rather than as a sprite. Two differences:
//
//   - **Its own lights, not the city's.** The cargo chip mirrors the sun because it is a portrait
//     of something out on the street, and a box lit by a different afternoon would look pasted on.
//     This is an icon, not a portrait, and it has to read at night — when a mirrored sun would leave
//     the base nearly black. The dome is mostly emissive anyway.
//   - **It draws only while it is up**, and for the length of its exit. Nothing renders between
//     chases, so between chases it costs nothing.
//
// ## The flash
//
// A beacon is a lamp with a reflector turning round it, and what you see from any one place is a
// flash once a turn as the reflector's mouth swings past you. That is what this does, literally: the
// reflector is a half-cylinder turning inside a translucent dome, and the dome's glow and the rays
// either side of it are driven off how squarely that mouth faces the camera. So the light is never
// out of step with the thing making it.

/** Canvas size in CSS px. Wider than tall: the rays reach out to either side of the dome. */
const W = 72;
const H = 52;

/** One turn of the reflector, in ms. A real rotator is ~2–3 turns a second; this is a touch slower so the flash reads as a pulse at 50px rather than a flicker. */
const TURN_MS = 720;

/** Exit length — must match the `#chase-siren` transition in index.html, since this keeps drawing until it ends. */
const OUT_MS = 320;

/** The wobble it arrives with: a lamp slammed onto a roof. */
const WOBBLE_MS = 700;
const WOBBLE = 0.32;

// Geometry, in the icon's own units: base 0.62 across at the bottom, dome 0.5 radius on top.
const BASE_R = 0.62;
const BASE_H = 0.26;
const LIP_R = 0.66;
const LIP_H = 0.07;
const DOME_R = 0.5;
const DOME_Y = BASE_H + LIP_H;
const DOME_TALL = 1.25;
// Where the rays fan from: the dome's middle, in the camera-facing plane.
const RAY_Y = DOME_Y + DOME_R * DOME_TALL * 0.45;

// Framing. The camera looks down 22° — enough to see the dome is round and the base is a drum, not
// so much that the rays (which stand in the screen plane) foreshorten against it.
const ELEVATION = THREE.MathUtils.degToRad(22);
const HALF_W = 1.18;
const HALF_H = HALF_W * (H / W);
const CENTRE_Y = 0.5;

function buildSiren() {
  const group = new THREE.Group();
  const flat = (hex) => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });

  // The steel drum and its bright lip — eight sides, the low-poly count the city's own cylinders use.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(BASE_R * 0.92, BASE_R, BASE_H, 8),
    flat(PALETTE.chaseSirenBase));
  base.position.y = BASE_H / 2;
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(LIP_R, LIP_R, LIP_H, 8),
    flat(PALETTE.chaseSirenLip));
  lip.position.y = BASE_H + LIP_H / 2;
  group.add(base, lip);

  // The turning part: a lamp and a half-cylinder reflector behind it. The reflector covers theta
  // π/2 → 3π/2, which in three's cylinder is the −Z half — so at yaw 0 its mouth faces +Z, the camera.
  const rotor = new THREE.Group();
  rotor.position.y = DOME_Y;
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.3, 6),
    unlitMaterial({ color: PALETTE.chaseSirenLamp }));
  lamp.position.y = 0.17;
  const reflector = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.38, 8, 1, true, Math.PI / 2, Math.PI),
    new THREE.MeshLambertMaterial({ color: PALETTE.chaseSirenLip, side: THREE.DoubleSide, flatShading: true }));
  reflector.position.y = 0.17;
  rotor.add(lamp, reflector);
  group.add(rotor);

  // The dome: an eight-by-four hemisphere, translucent enough that the rotor shows through it, with
  // a knob on top as the emoji has. Emissive carries the flash.
  const domeMat = new THREE.MeshLambertMaterial({
    color: PALETTE.lightRed, emissive: PALETTE.lightRed, emissiveIntensity: 0.2,
    transparent: true, opacity: 0.68, flatShading: true, depthWrite: false,
  });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_R, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.y = DOME_Y;
  // Stretched up a quarter: the emoji's dome is a bullet, and a true hemisphere read as a jelly mould.
  dome.scale.y = DOME_TALL;
  dome.renderOrder = 1;
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.08, 6), domeMat);
  knob.position.y = DOME_Y + DOME_R * DOME_TALL + 0.03;
  knob.renderOrder = 1;
  group.add(dome, knob);

  // The emoji's rays, three a side, standing in the screen plane (the group is turned to face the
  // camera once in `createChaseSiren`). DoubleSide so their winding cannot hide them — see CLAUDE.md
  // on unlit triangles that do not draw.
  const rays = new THREE.Group();
  rays.position.y = RAY_Y;
  const rayMat = unlitMaterial({
    color: PALETTE.chaseSirenRay, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const rayGeo = new THREE.PlaneGeometry(0.34, 0.09);
  rayGeo.translate(0.17, 0, 0); // pivot at the inner end, so a ray grows outward
  const rayList = [];
  for (const side of [-1, 1]) {
    for (const deg of [34, 4, -26]) {
      const a = THREE.MathUtils.degToRad(deg);
      const pivot = new THREE.Group();
      // Leaving the dome on a line from its centre, angled up or down; mirrored for the left side.
      pivot.position.set(side * Math.cos(a) * 0.68, Math.sin(a) * 0.62, 0);
      pivot.rotation.z = side > 0 ? a : Math.PI - a;
      const ray = new THREE.Mesh(rayGeo, rayMat);
      ray.renderOrder = 2;
      pivot.add(ray);
      rays.add(pivot);
      rayList.push(pivot);
    }
  }
  group.add(rays);

  return { group, rotor, domeMat, rays, rayMat, rayList };
}

export function createChaseSiren() {
  const el = document.getElementById('chase-siren');
  if (!el) return { update: () => {} };

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  el.appendChild(canvas);

  // Honours the same budget flags as every other context on the page — see game/cargochip.js.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // A key from the upper left and a cool fill, fixed — see "Its own lights" above.
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-2, 4, 3);
  scene.add(key, new THREE.HemisphereLight(0xdfeeff, 0x3a3f48, 1.4));

  const siren = buildSiren();
  scene.add(siren.group);

  const camera = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 40);
  camera.position.set(0, CENTRE_Y + Math.sin(ELEVATION) * 10, Math.cos(ELEVATION) * 10);
  camera.lookAt(0, CENTRE_Y, 0);
  // Rays in the screen plane: face them along the view axis. lookAt on an Object3D points its +Z at
  // the target, which is the plane's front.
  siren.rays.lookAt(camera.position.x, RAY_Y + (camera.position.y - CENTRE_Y), camera.position.z);

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let on = false;
  let onAt = 0;
  let offAt = -Infinity;

  function draw(now) {
    const t = now - onAt;
    // The reflector's yaw, and how squarely its mouth faces the camera: cos of that yaw. Squared past
    // a threshold, so the flash is a short bright pulse with the dome dim between, the way a rotator
    // looks, rather than a sine breathing up and down.
    const yaw = (t / TURN_MS) * Math.PI * 2;
    siren.rotor.rotation.y = yaw;
    const face = Math.max(0, (Math.cos(yaw) - 0.25) / 0.75);
    const flash = face * face;
    siren.domeMat.emissiveIntensity = 0.2 + 1.8 * flash;
    siren.rayMat.opacity = flash;
    for (const ray of siren.rayList) ray.scale.x = 0.55 + 0.45 * flash;

    // The arrival wobble: a damped rock about the screen's depth axis. Reduced motion skips it; the
    // lamp still turns, since that is the information.
    const w = Math.min(1, t / WOBBLE_MS);
    siren.group.rotation.z = reducedMotion?.matches ? 0
      : Math.sin(t / 55) * WOBBLE * (1 - w) ** 2;

    renderer.render(scene, camera);
  }

  return {
    /**
     * Once a frame. `active` is whether the police are after the taxi right now; the element's
     * `is-on` class carries the pop in and out (index.html), and this draws for as long as any of
     * it is on screen. Wall time rather than sim time, like the rest of the HUD.
     */
    update(active) {
      const now = performance.now();
      if (active !== on) {
        on = active;
        if (on) onAt = now; else offAt = now;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-hidden', String(!on));
      }
      if (on || now - offAt < OUT_MS) draw(now);
    },
    /** For tools: is it up. */
    isOn: () => on,
  };
}
