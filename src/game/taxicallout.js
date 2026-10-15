import * as THREE from 'three';
import { VIEW_DIR } from './camera.js';
import { PALETTE } from '../palette.js';

// "Which one is mine?" — three prototype answers, for looking at side by side.
//
// The taxi finder (game/taxifinder.js) already handles a car that is entirely off-frame. What it
// cannot help with is the car that is *on* the frame and still lost: a look across town at play
// zoom puts a 4-unit yellow car among a hundred others, and the eye has to hunt for it. These are
// in-world answers rather than HUD, each picked with `?callout=`:
//
//   halo    a ring painted on the road round the car, carrying the Loco tank (the outer arc) and
//           the car's health (the inner arc) — so it earns its pixels by being a gauge as well
//   ping    a sonar ring that pulses out of the car while the player has the camera, and not at all
//           while the camera is following it
//   beacon  a tall shaft of light out of the roof, up while the player has the camera
//   classic none of it
//
// PROTOTYPE: built to be looked at on a phone, not tuned. Sizes are guesses at play zoom 52.

const PARAM = new URLSearchParams(window.location.search).get('callout') ?? 'halo';
export const CALLOUT_MODE = ['halo', 'ping', 'beacon'].includes(PARAM) ? PARAM : 'classic';

// The ground plane's up-screen direction: the camera sits out along +VIEW_DIR, so up the screen on
// the road is the horizontal part of -VIEW_DIR. Arcs start there and run clockwise on screen.
const UP_SCREEN_YAW = Math.atan2(-VIEW_DIR.x, -VIEW_DIR.z);

const HALO_R = 5.0;        // outer radius, world units: the drawn car's half-diagonal is 2.79
const PING_R = 14;         // how far a ping travels before it is gone
const PING_LIFE = 0.9;     // seconds a ping takes to get there
const PING_EVERY = 2.4;    // seconds between pings while the camera is the player's
const BEACON_H = 34;       // tall enough to clear the city's ordinary towers at play zoom

const ringVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// One quad, drawn as rings by distance from its centre. Angle 0 is up-screen (the quad is turned so
// its +V is), running clockwise as seen from above-and-in-front, which is clockwise on screen.
const haloFrag = /* glsl */ `
  uniform float uFuel;
  uniform float uHp;
  uniform float uAlpha;
  uniform vec3 uFuelColor;
  varying vec2 vUv;
  float band(float r, float r0, float r1) {
    float aa = fwidth(r) * 1.2;
    return smoothstep(r0 - aa, r0 + aa, r) * (1.0 - smoothstep(r1 - aa, r1 + aa, r));
  }
  void main() {
    float r = length(vUv);
    float a = atan(vUv.x, vUv.y);
    float t = fract(a / 6.2831853 + 1.0);
    float outer = band(r, 0.82, 1.0);
    float inner = band(r, 0.70, 0.76);
    float fuelOn = step(t, uFuel);
    float hpOn = step(t, uHp);
    vec3 track = vec3(0.08, 0.08, 0.1);
    vec3 hpCol = mix(vec3(1.0, 0.25, 0.2), vec3(1.0), smoothstep(0.25, 0.6, uHp));
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    // Outer: Loco tank. Bare track where it is empty.
    col += outer * mix(track, uFuelColor, fuelOn);
    alpha += outer * mix(0.45, 1.0, fuelOn);
    // Inner: health.
    col += inner * mix(track, hpCol, hpOn);
    alpha += inner * mix(0.35, 0.95, hpOn);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col / max(alpha, 1e-3) * min(alpha, 1.0), min(alpha, 1.0) * uAlpha);
  }
`;

const pingFrag = /* glsl */ `
  uniform float uPhase;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    float front = uPhase;
    float w = 0.05 + 0.06 * uPhase;
    float d = abs(r - front);
    float aa = fwidth(r) * 1.5;
    float ring = 1.0 - smoothstep(w - aa, w + aa, d);
    float fade = (1.0 - uPhase) * (1.0 - uPhase);
    float a = ring * fade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const beaconVert = /* glsl */ `
  varying float vH;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vH = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beaconFrag = /* glsl */ `
  uniform float uAlpha;
  uniform vec3 uColor;
  varying float vH;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    // Soft at the column edges (the sine of the angle off the view axis, not its cosine), and
    // fading out toward the top.
    float facing = abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0)));
    float edge = smoothstep(0.0, 0.8, facing);
    float up = pow(1.0 - vH, 1.6);
    float a = edge * up * uAlpha * 0.75;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

function flatQuad(size, material) {
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  // +V of the plane is now -Z; turn it so +V points up-screen.
  geo.rotateY(UP_SCREEN_YAW + Math.PI);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

export function createTaxiCallout(scene, { maxHp }) {
  const group = new THREE.Group();
  group.name = 'taxi-callout';
  scene.add(group);
  if (CALLOUT_MODE === 'classic') {
    return { mode: CALLOUT_MODE, update() {}, settle() {} };
  }

  const yellow = new THREE.Color(PALETTE.taxiBody);
  const state = { taken: 0, pingT: 0, pingClock: 0 };

  let halo = null;
  let ping = null;
  let beacon = null;

  if (CALLOUT_MODE === 'halo') {
    halo = flatQuad(HALO_R * 2, new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: haloFrag,
      uniforms: {
        uFuel: { value: 1 }, uHp: { value: 1 }, uAlpha: { value: 1 },
        uFuelColor: { value: yellow },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    halo.position.y = 0.06;
    group.add(halo);
  }

  if (CALLOUT_MODE === 'ping') {
    ping = flatQuad(PING_R * 2, new THREE.ShaderMaterial({
      vertexShader: ringVert,
      fragmentShader: pingFrag,
      uniforms: { uPhase: { value: 1 }, uColor: { value: yellow } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    ping.position.y = 0.06;
    group.add(ping);
  }

  if (CALLOUT_MODE === 'beacon') {
    const geo = new THREE.CylinderGeometry(2.2, 1.4, BEACON_H, 24, 1, true);
    geo.translate(0, BEACON_H / 2 + 1.6, 0);
    // CylinderGeometry's uv.y already runs 0 at the bottom to 1 at the top, which is the fade's way up.
    beacon = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: beaconVert,
      fragmentShader: beaconFrag,
      uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.9, 0.55) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }));
    beacon.frustumCulled = false;
    beacon.renderOrder = 3;
    group.add(beacon);
  }

  function place(taxi) {
    group.position.set(taxi.x, 0, taxi.z);
    group.visible = !taxi.crashed && !taxi.staged;
  }

  return {
    mode: CALLOUT_MODE,
    /**
     * @param dt         seconds
     * @param taxi       traffic.taxi
     * @param fuel       0..1, the Loco tank
     * @param taken      true while the player owns the camera (has panned away from the follow)
     */
    update(dt, taxi, fuel, taken) {
      place(taxi);
      state.taken += ((taken ? 1 : 0) - state.taken) * Math.min(1, dt * 6);
      if (halo) {
        halo.material.uniforms.uFuel.value = fuel;
        halo.material.uniforms.uHp.value = Math.max(0, taxi.hp / maxHp);
      }
      if (ping) {
        if (taken) {
          state.pingClock -= dt;
          if (state.pingClock <= 0) { state.pingT = 0; state.pingClock = PING_EVERY; }
        } else {
          state.pingClock = 0.15; // first ping lands just after the player takes the camera
        }
        state.pingT = Math.min(1, state.pingT + dt / PING_LIFE);
        ping.material.uniforms.uPhase.value = state.pingT;
      }
      if (beacon) beacon.material.uniforms.uAlpha.value = state.taken;
    },
    /** Shot mode: one frame, so land every animation mid-flight. */
    settle(taxi, fuel, hp) {
      place(taxi);
      if (halo) {
        halo.material.uniforms.uFuel.value = fuel;
        halo.material.uniforms.uHp.value = hp;
      }
      if (ping) ping.material.uniforms.uPhase.value = 0.4;
      if (beacon) beacon.material.uniforms.uAlpha.value = 1;
    },
  };
}
