import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { SPAN } from '../city/grid.js';
import { DISTANCE, PLAY_ZOOM, DEPTH_PER_SCREEN_UNIT } from './camera.js';

function createSky() {
  const geometry = new THREE.SphereGeometry(900, 24, 12);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(PALETTE.skyTop) },
      bottomColor: { value: new THREE.Color(PALETTE.skyBottom) },
      exponent: { value: 0.7 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, 90.0, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), exponent)), 1.0);
      }
    `,
  });

  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'sky';
  return sky;
}

// --- Atmospheric perspective ----------------------------------------------------------------
//
// A soft haze over the back of the frame, so a block at the top of the screen sits behind some air
// and the one under the taxi doesn't. Without it every façade in the city is drawn at exactly the
// same contrast however far off it is, which is the one cue an orthographic projection cannot give
// you any other way — parallel lines stay parallel and distant blocks stay the same *size*, so
// nothing about the drawing says "further".
//
// **This is three's ordinary distance fog, and the note that used to sit here saying it couldn't be
// was wrong.** The claim was that an orthographic camera 400 units back whitens the whole city
// uniformly. What is actually true is that fog placed from *zero* does: over a scene sitting at
// depth 400 ± 65, `Fog(near = 0, far = 1000)` varies by a few percent across the entire map and
// reads as a flat wash. View-space depth under this camera is `DISTANCE - (p - target)·VIEW_DIR`,
// which spans 335 (near corner) to 465 (far corner) — a perfectly good gradient, once the near/far
// band is placed **around the standoff** rather than starting at the eye.
//
// Two properties of that make this better behaved here than fog usually is:
//
//   - Depth is a function of screen height alone (see DEPTH_PER_SCREEN_UNIT). So the haze is a
//     vertical gradient across the picture, not a pool centred on wherever the camera is aimed.
//   - The camera and its target move together, so the *frame's* depth band is fixed: the bottom
//     edge of the screen is always exactly `DISTANCE - zoom * DEPTH_PER_SCREEN_UNIT`, whatever the
//     player has panned to. Anchoring the near plane there means the near edge of the picture is
//     always perfectly clear, on every viewport and at any pan — the haze can never creep forward
//     onto the taxi.
//
// It is deliberately **linear** (three's `Fog`, a smoothstep between near and far) rather than
// `FogExp2`. Exponential fog is a distance from the *eye*, and this eye is 400 units away from
// everything: any density strong enough to read across the city also puts a several-percent wash on
// the nearest pixel, which is the flat-whitening the old note was afraid of. Linear fog has a hard
// zero, and smoothstep's ease-in spends most of the ramp on the far half of the frame — the near
// half stays untouched and the haze gathers behind it.

/**
 * How much haze the **top of the play frame** carries, as a mix fraction toward the horizon colour.
 *
 * Tuned against the city rather than by eye on a close-up: at play zoom the top of the frame sits at
 * depth 480 and the far corner of the map at 465, so this is very nearly the most haze anything in
 * the city can ever be wearing. On asphalt it is #636972 → #7E8690 — a value shift you read as
 * distance and not as a colour change. Past about 0.3 the back of the city starts reading as
 * *weather* rather than as air, which is a different game.
 */
export const HAZE_TOP = 0.22;

/** Inverse of `smoothstep(0, 1, t)`, which is the curve three's linear fog mixes on. */
const unSmoothstep = (y) => 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);

/**
 * The fog band for a given frustum half-height: zero haze at the bottom edge of the frame, exactly
 * `top` at the upper edge.
 *
 * `far` lands well past the city (about 847 against a frame that ends at 480) and that is the point
 * — it is the length of ramp needed for smoothstep to have climbed only `HAZE_TOP` by the time it
 * reaches the back of the frame, not a distance anything is drawn at.
 *
 * Exported so `tools/probe.mjs` can re-derive the band from a real frustum instead of trusting the
 * numbers, and so the ⚙️ panel can retune the strength live.
 */
export function hazeRange(top = HAZE_TOP, zoom = PLAY_ZOOM) {
  const half = zoom * DEPTH_PER_SCREEN_UNIT;
  const near = DISTANCE - half;
  // Zero haze wanted: put the far plane past anything the renderer will ever hand it.
  if (top <= 0) return { near, far: near + 1e6 };
  return { near, far: near + (2 * half) / unSmoothstep(Math.min(top, 0.999)) };
}

/** Retune the haze in place — the ⚙️ panel's slider, and nothing else. */
export function setHazeTop(fog, top) {
  const { near, far } = hazeRange(top);
  fog.near = near;
  fog.far = far;
}

// Captured from the in-game tweak panel. Expressed as elevation/azimuth rather than a raw
// position vector so these numbers mean the same thing here as they do on the sliders.
const SUN = {
  elevation: THREE.MathUtils.degToRad(28.5),   // ~16:24
  azimuth: THREE.MathUtils.degToRad(56),
  radius: SPAN * 1.2,
  intensity: 3.55,
  fill: 1.5,
};

/**
 * @param shadowMapSize  the sun's shadow map, in texels a side. 0 switches shadows off entirely
 *                       — `?shadows=off`, see `util/shot.js`. It is a *parameter* rather than a
 *                       constant because it is the second-largest allocation this renderer makes
 *                       after the drawing buffer, and on a device that comes up black the only
 *                       way to find out whether that matters is to ask for less of it.
 */
export function createScene({ shadowMapSize = 2048 } = {}) {
  const scene = new THREE.Scene();

  // The haze over the back of the frame — see the long note above for why this is a plain linear
  // fog and where its two planes come from. The colour is the horizon, and `daylight.js` keeps it
  // there all day: the far edge of the city has to fade into the sky it is standing in front of,
  // and that sky is `skyBottom` at every hour. `PALETTE.fog` is the parked 16:24 value, which is
  // what a scene built without a daylight module (the headless tools, a screenshot) gets to keep.
  const { near, far } = hazeRange();
  scene.fog = new THREE.Fog(PALETTE.fog, near, far);

  // Held onto so the debug panel can retint the gradient live; its ShaderMaterial uniforms are
  // the only handle on the sky colours.
  const sky = createSky();
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, SUN.fill);
  scene.add(hemi);

  // Angled across the grid rather than along it — a sun parallel to the streets throws shadows
  // that line up with the roads and the whole city flattens out.
  // Late afternoon, roughly 5pm. The sun sits at about 13 degrees rather than the 47 it had at
  // noon, which is what actually makes golden hour read: long raking shadows across the grid and
  // one lit face per building. The hemisphere fill drops so those shadows stay deep and warm
  // instead of being washed flat.
  const sun = new THREE.DirectionalLight(PALETTE.sun, SUN.intensity);
  sun.position.set(
    Math.cos(SUN.azimuth) * Math.cos(SUN.elevation) * SUN.radius,
    Math.sin(SUN.elevation) * SUN.radius,
    Math.sin(SUN.azimuth) * Math.cos(SUN.elevation) * SUN.radius,
  );
  sun.castShadow = shadowMapSize > 0;

  // The shadow frustum has to cover the entire city; there's no player to centre it on.
  // A low sun throws shadows far longer than the city is wide, so the shadow frustum has to
  // cover well past the buildings casting them.
  const extent = SPAN * 1.05;
  // Still set when shadows are off: `castShadow` is what decides whether the map is allocated at
  // all, and leaving the size configured means the debug panel can turn them back on live.
  sun.shadow.mapSize.set(Math.max(256, shadowMapSize), Math.max(256, shadowMapSize));
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SPAN * 3;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  scene.add(sun);
  scene.add(sun.target);

  return { scene, sun, hemi, sky: sky.material, fog: scene.fog };
}
