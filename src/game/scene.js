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
  // No fog. Three's fog is a function of view-space depth, and an orthographic camera sits a
  // fixed 400 units back from the whole scene — so distance-based fog whites out the entire
  // city uniformly rather than fading its far edge. Depth cueing for this view would have to
  // come from height or screen position, not camera distance.
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

  return { scene, sun, hemi, sky: sky.material };
}
