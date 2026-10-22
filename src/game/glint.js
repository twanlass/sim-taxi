import * as THREE from 'three';
import { color } from '../palette.js';
import { BILLBOARD, VIEW_DIR } from './camera.js';

// A glint off the taxi's front-right fender as it leaves the garage: one four-point star that pops on
// the corner by the headlight and is gone in about half a second. It plays on the way out of the
// run's opening and on the way out of every repair, which is the point of it — the car rolling out
// of the door looking new.
//
// **A star on a quad, not a highlight in the paint.** The paint version is the obvious one and it
// does not read: that corner is about 5×5 pixels at play zoom, and even at the door's zoom (15
// against 52) a specular hotspot on it is a slightly paler patch of yellow. A glint is a shape the
// eye knows — two thin crossed streaks and a hot core — and it has to stand off the surface to be
// one. It is still drawn by a shader rather than a texture: the streaks are two falloffs in the
// fragment, so there is nothing to load and the edges stay crisp at any zoom.
//
// **It fires as the nose clears the curtain**, not at the kerb. That is the last moment the camera is
// still on the door (`DOOR_ZOOM`); by the kerb drop it has started pulling out to play zoom and the
// car is shrinking under it. The camera looks down the (+X, +Z) diagonal and the taxi leaves heading
// +X, so the front-right corner is the corner nearest the lens — the one place on the car that is
// always in view on the way out.
//
// `?glint=classic` builds none of it.

// Where the glint sits on the car, in the taxi group's own frame (+X the nose, +Z its right; the
// group's TAXI_SCALE is applied on top by `localToWorld`). The top of the nose at its outer corner:
// the body's shoulder line, just above the headlight.
const CORNER = new THREE.Vector3(1.62, 1.12, 0.78);
// Pulled toward the camera so the quad clears the body it is sitting on. Under an orthographic
// projection this moves nothing on screen; it only stops the bonnet's depth eating half the star.
const STANDOFF = 1.5;

// The whole life, in seconds, and where in it the star is at full size. Quick up, slower down:
// a glint is a flash that catches the eye and then lingers for a beat, not a pulse.
const LIFE = 0.55;
const PEAK = 0.14;
// Radius of the star's long arms at the peak, in world units. At DOOR_ZOOM a world unit is ~27px on
// a phone, so this is a star about 60px across — big enough to read as the event, small against a
// car that fills a third of the frame.
const SIZE = 1.1;
// A small turn across the life, so the arms sweep rather than sit — about 25°.
const SPIN = 0.45;
// Tilt at rest, so the cross is not a plus sign squared to the screen.
const TILT = 0.3;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Two streaks along the quad's axes, each a thin falloff across and a long one along, plus a short
// diagonal pair at half length and a hot core. Additive, so "colour times strength" is the light.
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  float streak(vec2 p, float len, float width) {
    float along = 1.0 - smoothstep(0.0, len, abs(p.x));
    float across = 1.0 - smoothstep(0.0, width * (1.0 - abs(p.x) / len), abs(p.y));
    return along * along * across;
  }
  void main() {
    vec2 p = vUv;
    vec2 d = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p;
    float a = streak(p, 1.0, 0.07) + streak(p.yx, 1.0, 0.07)
      + 0.55 * (streak(d, 0.45, 0.05) + streak(d.yx, 0.45, 0.05));
    float r = length(p);
    a += 0.9 * (1.0 - smoothstep(0.0, 0.16, r));
    a += 0.25 * (1.0 - smoothstep(0.0, 0.42, r));
    gl_FragColor = vec4(uColor * min(a, 1.4) * uStrength, 1.0);
  }
`;

/**
 * @param scene     the scene the star is drawn in
 * @param taxiGroup the player's car mesh, which the star rides
 */
export function createGlint({ scene, taxiGroup }) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color('glint') }, uStrength: { value: 0 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'taxi-glint';
  mesh.frustumCulled = false;
  // With the sparks and the repair glow: light, drawn over what it lands on.
  mesh.renderOrder = 6;
  // Hidden by material rather than by `visible`, the way bloom.js asks of anything that switches —
  // and there is no light under it, so nothing else in the scene notices either way.
  material.visible = false;
  scene.add(mesh);

  const at = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 0, 1);
  let t = Infinity;

  /** Play it once, from the start. */
  function fire() {
    t = 0;
  }

  function update(dt) {
    if (t >= LIFE) {
      material.visible = false;
      return;
    }
    t += dt;
    const k = Math.min(1, t / LIFE);
    // Up on an ease-out to PEAK, then down on a slower ease-in to nothing.
    const level = t < PEAK
      ? 1 - (1 - t / PEAK) ** 2
      : (1 - (t - PEAK) / (LIFE - PEAK)) ** 1.6;
    if (!(level > 0)) {
      material.visible = false;
      return;
    }
    taxiGroup.updateWorldMatrix(true, false);
    at.copy(CORNER);
    taxiGroup.localToWorld(at);
    mesh.position.copy(at).addScaledVector(VIEW_DIR, STANDOFF);
    mesh.quaternion.copy(BILLBOARD).multiply(spin.setFromAxisAngle(axis, TILT + SPIN * k));
    mesh.scale.setScalar(SIZE * (0.35 + 0.65 * level));
    material.uniforms.uStrength.value = level;
    material.visible = true;
  }

  return {
    fire,
    update,
    /** True while the star is up — for the headless check. */
    active: () => t < LIFE,
    mesh,
  };
}
