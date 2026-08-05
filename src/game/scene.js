import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { SPAN } from '../city/grid.js';

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
    // `colorspace_fragment` is not optional, exactly as in game/routeline.js: a ShaderMaterial
    // gets none of the built-in chunks, and `new THREE.Color('#8CC4E8')` is converted sRGB → linear
    // on the way in. Without the conversion back on the way out, every sky colour in the game
    // rendered darker and far more saturated than the hex it was written as.
    //
    // It only became obvious once the cycle was switched on by default. Sunset's `#F09A60` came
    // out as rgb(222, 82, 29), and since this camera looks *down* — so the visible dome is almost
    // all within a few degrees of the horizon, where `h` is about 0.1 and the mix is 80% the
    // bottom colour — dusk filled the entire frame with brick red. The daytime sky was wrong by
    // the same amount all along; it just happened to be wrong in a direction that still looked
    // like a sky.
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, 90.0, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), exponent)), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'sky';
  return sky;
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

export function createScene() {
  const scene = new THREE.Scene();
  // Fog starts off (`scene.fog = null`) and only exists while the weather says so — see
  // game/weather.js, which owns the near/far range as well as the colour.
  //
  // Fog on an orthographic camera was written off once, and the reasoning was half right. Three's
  // fog is a function of view-space depth, and this camera sits a fixed 400 units back from the
  // whole scene, so a range anchored near zero really does wash the city out uniformly. But the
  // city is ~140 units across the view diagonal, so depth genuinely varies 400 ± 70 — a range
  // anchored *at the standoff distance* fades the far edge and leaves the near one clear, which
  // is exactly the depth cue that was thought unavailable.
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
  sun.castShadow = true;

  // The shadow frustum has to cover the entire city; there's no player to centre it on.
  // A low sun throws shadows far longer than the city is wide, so the shadow frustum has to
  // cover well past the buildings casting them.
  const extent = SPAN * 1.05;
  sun.shadow.mapSize.set(2048, 2048);
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

  // The moon. A second directional light on its own arc, off (intensity 0) all day and taking over
  // after dusk — see game/daylight.js for the curve. Night used to be lit by the hemisphere fill
  // alone, and a hemisphere light has no direction to speak of: every roof, road and car got the
  // same flat wash and the whole city turned into a silhouette. One raking cool light gives every
  // surface a lit side and a dark side again, which is what makes shapes readable at 1am.
  //
  // **It casts no shadows, deliberately.** A second shadow map is a second full depth pass every
  // frame for the twelve hours of the day it contributes nothing to, and toggling `castShadow` to
  // dodge that recompiles every material in the scene at dusk. Shadowless also happens to be the
  // better look: moonlight through a real night sky is diffuse, and hard-edged black shadows at
  // 0.9 intensity read as a second sun rather than as moonlight.
  const moon = new THREE.DirectionalLight(PALETTE.moon, 0);
  moon.position.set(-SPAN, SPAN, SPAN * 0.6);
  scene.add(moon);
  scene.add(moon.target);

  return { scene, sun, moon, hemi, sky: sky.material };
}
