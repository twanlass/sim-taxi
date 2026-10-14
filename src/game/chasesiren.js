import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';
import { unlitMaterial } from '../util/geo.js';

// The chase siren: a low-poly 🚨 in the top-right of the HUD for as long as the police are after the
// taxi — a patrol chase (game/patrol.js) or a getaway (game/robbery.js). Tyler's idea (2026-10-14),
// circled on a phone screenshot: the city already says "chase" with the strobing bar and the wash
// over the frame edge (game/sirenglow.js), but both of those are about where the cop *is*, and a
// cop that has dropped round a corner takes them both with it while the chase is still very much on.
// This is the one cue that is about the state rather than the car.
//
// ## Where it sits
//
// On the cash row, level with the cash and just left of the pause (Tyler, 2026-10-14). The first cut
// sat top centre, which is the combo meter's spot, and stepping aside whenever a meter came up was
// two things fighting over one place; the corner by the pause is nobody's. Inside
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
//     the base nearly black. The lens is mostly emissive anyway.
//   - **It draws only while it is up**, and for the length of its exit. Nothing renders between
//     chases, so between chases it costs nothing.
//
// ## The flash
//
// A beacon is a lamp with a reflector turning round it, and what you see from any one place is a
// flash once a turn as the reflector's mouth swings past you. That is what this does, literally: the
// reflector is a half-cylinder turning inside a translucent lens, and the lens's glow and the rays
// either side of it are driven off how squarely that mouth faces the camera. So the light is never
// out of step with the thing making it.
//
// ## Losing them
//
// A patrol chase ends lost once the gap has held past ESCAPE_HOLD or the cop has gone SIGHT_HOLD
// without seeing the taxi (game/patrol.js). Both are counted up as they happen, so the siren reads the
// larger of the two fractions as `losing` and **cools** with it: the reflector slows to a third of its
// pace, the flash dims, and the lamp fades toward half. A siren winding down is the player watching
// the escape work. If the cop finds them again the counts fall back and it winds up again. When the
// chase is finally lost it spins down and fades out over COOL_MS; a chase that ends in the cuffs just
// pops away, since the arrest has its own beat and nothing was escaped.

/** Canvas size in CSS px. Wider than tall: the rays reach out to either side of the lens. */
const W = 72;
const H = 52;

/** One turn of the reflector, in ms. A real rotator is ~2–3 turns a second; this is a touch slower so the flash reads as a pulse at 50px rather than a flicker. */
const TURN_MS = 720;

/** Exit lengths — must match the `#chase-siren` transitions in index.html, since this keeps drawing until they end. */
const OUT_MS = 320;
const COOL_MS = 1200;
/** How far `losing` slows the turn (×3 the period at 1) and fades the lamp (to 0.5 at 1). */
const COOL_SLOW = 2;
const COOL_FADE = 0.5;

/** The wobble it arrives with: a lamp slammed onto a roof. */
const WOBBLE_MS = 700;
const WOBBLE = 0.32;

// Geometry, in the icon's own units: base 0.62 in radius at the bottom, the lens 0.46 on top of it.
const BASE_R = 0.62;
const BASE_H = 0.26;
const LIP_R = 0.66;
const LIP_H = 0.07;
// The lens: straight sides and a flat top with a chamfered edge, so it stands as a block the way
// 🚨's does. It was a hemisphere first, stretched a quarter taller, and Tyler asked for it squarer,
// like the emoji: at 50px a rounded dome reads as a blob rather than a lamp.
const LENS_R = 0.46;
const LENS_H = 0.6;
const CHAMFER = 0.1;
const DOME_Y = BASE_H + LIP_H;
// Where the rays fan from: the lens's middle, in the camera-facing plane.
const RAY_Y = DOME_Y + (LENS_H + CHAMFER) * 0.5;

// Framing. The camera looks down 22° — enough to see the lens and the base are drums, not
// so much that the rays (which stand in the screen plane) foreshorten against it.
const ELEVATION = THREE.MathUtils.degToRad(22);
const HALF_W = 1.18;
const HALF_H = HALF_W * (H / W);
const CENTRE_Y = 0.48;

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
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 6),
    unlitMaterial({ color: PALETTE.chaseSirenLamp }));
  lamp.position.y = 0.3;
  const reflector = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.5, 8, 1, true, Math.PI / 2, Math.PI),
    new THREE.MeshLambertMaterial({ color: PALETTE.chaseSirenLip, side: THREE.DoubleSide, flatShading: true }));
  reflector.position.y = 0.3;
  rotor.add(lamp, reflector);
  group.add(rotor);

  // The lens: an eight-sided drum with a chamfered lid, translucent enough that the rotor shows
  // through it. Emissive carries the flash.
  const domeMat = new THREE.MeshLambertMaterial({
    color: PALETTE.lightRed, emissive: PALETTE.lightRed, emissiveIntensity: 0.2,
    transparent: true, opacity: 0.68, flatShading: true, depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(LENS_R, LENS_R, LENS_H, 8), domeMat);
  dome.position.y = DOME_Y + LENS_H / 2;
  dome.renderOrder = 1;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(LENS_R - CHAMFER, LENS_R, CHAMFER, 8), domeMat);
  lid.position.y = DOME_Y + LENS_H + CHAMFER / 2;
  lid.renderOrder = 1;
  group.add(dome, lid);

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
      // Leaving the lens on a line from its centre, angled up or down; mirrored for the left side.
      pivot.position.set(side * Math.cos(a) * 0.64, Math.sin(a) * 0.5, 0);
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
  let outMs = OUT_MS;
  let cooling = false;
  // The reflector's yaw, integrated rather than read off the clock, because its rate changes.
  let yaw = 0;
  let lastAt = 0;
  // `losing` eased, so a cop catching sight again does not snap the lamp back to full in a frame.
  let cool = 0;

  function draw(now) {
    const t = now - onAt;
    const dt = Math.min(0.1, (now - lastAt) / 1000);
    lastAt = now;
    // Spinning down through the cooldown exit: the rate falls to nothing over COOL_MS.
    const spinDown = cooling ? Math.max(0, 1 - (now - offAt) / COOL_MS) : 1;
    yaw += (dt * 1000 / (TURN_MS * (1 + COOL_SLOW * cool))) * Math.PI * 2 * spinDown;
    // How squarely the reflector's mouth faces the camera: cos of its yaw. Squared past a threshold,
    // so the flash is a short bright pulse with the lens dim between, the way a rotator looks, rather
    // than a sine breathing up and down. Cooling takes the edge off it.
    siren.rotor.rotation.y = yaw;
    const face = Math.max(0, (Math.cos(yaw) - 0.25) / 0.75);
    const flash = face * face * (1 - 0.5 * cool);
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
     * Once a frame. `active` is whether the police are after the taxi right now; `losing` (0–1) how
     * near they are to losing it; `caught` whether the chase just ended in an arrest, which takes the
     * quick exit rather than the cooldown. The element's classes carry the pop in and the two ways
     * out (index.html), and this draws for as long as any of it is on screen. Wall time rather than
     * sim time, like the rest of the HUD.
     */
    update(active, { losing = 0, caught = false } = {}) {
      const now = performance.now();
      if (active !== on) {
        on = active;
        if (on) {
          onAt = now;
          lastAt = now;
          cool = 0;
          cooling = false;
        } else {
          offAt = now;
          cooling = !caught;
          outMs = cooling ? COOL_MS : OUT_MS;
        }
        el.classList.toggle('is-on', on);
        el.classList.toggle('is-cooling', !on && cooling);
        el.setAttribute('aria-hidden', String(!on));
      }
      if (on) {
        // Eased toward the target at ~4/s: quick enough to follow the patrol's own counters.
        const k = Math.min(1, ((now - lastAt) / 1000) * 4);
        cool += (Math.max(0, Math.min(1, losing)) - cool) * k;
        canvas.style.opacity = String(1 - COOL_FADE * cool);
      }
      if (on || now - offAt < outMs) draw(now);
    },
    /** For tools: is it up. */
    isOn: () => on,
  };
}
