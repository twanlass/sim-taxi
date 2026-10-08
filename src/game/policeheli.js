import * as THREE from 'three';
import { createHelicopterMesh, SEARCHLIGHT } from '../geometry/helicopter.js';
import { BODY_EULER_ORDER } from '../util/geo.js';
import { color } from '../palette.js';
import { CRUISE_ALT, ROTOR_FLIGHT, heading } from './chopper.js';
import { VIEW_DIR } from './camera.js';
import { markEmissive } from './bloom.js';

// The police helicopter: a getaway's eye in the sky. It flies in once the taxi has made its first
// checkpoint, sits behind and above the cab with its searchlight on it for the rest of the run to
// the drop-off, then hangs over the robber on the corner through the arrest and follows the car
// that takes them away, before peeling off and leaving the island the way it came.
//
// **Cinematic, on purpose.** Nothing reads it: the cops do not route off it, the taxi cannot be
// lost to it or caught by it, and nothing collides with it. The getaway's rules are the robbery's
// (game/robbery.js); this is set dressing on them. Whether it should *do* something — make the
// police harder to shake while the light is on the cab — is an open design question, not a gap.
//
// **The light is faked.** A real `SpotLight` would light the taxi and the street properly, and it
// would also put one more light into every lit material's program key (see CLAUDE.md on lights
// and the prepasses) and light straight through every tower between it and the street, because
// nothing here renders a shadow map for it. So the beam is two additive meshes in the
// headlight-cone recipe (geometry/lights.js): a cone from the lamp to the ground, and a pool on
// the ground where it lands. A third, normally blended, darkens a ring round the pool in daylight,
// which is what lets the pool read against a sunlit street at all — an additive pool on a bright
// road is a few percent of brightness the eye does not see.
//
// It flies at the rooftop chopper's `CRUISE_ALT`, the one altitude that clears every tower and
// stays under the aeroplane, for the reasons written down there; the rooftop chopper holds off
// starting a visit while this one is up (`hold` in main.js), so the two never share that sky.

// --- Flight --------------------------------------------------------------------------
const ALT = CRUISE_ALT;
/** How far out it starts, from whatever it is coming for — off the island on any framing. */
const ENTRY_DIST = 110;
/** Where it can be seen: solid inside the first, gone beyond the second, measured from the map's middle. */
const FADE = [72, 102];
/**
 * Where it holds station relative to the thing it is watching: behind it along its heading, and
 * toward the camera. The camera sees height as up-screen (0.84 of a unit per unit), so a machine
 * straight over the taxi would sit 18 units up-screen of it; pulling it 9 toward the lens brings
 * it down about 5 of those, and the beam reads as coming *down* onto the cab rather than across
 * the city at it.
 */
const TRAIL = 6;
const TOWARD_CAMERA = 9;
const CAM_GROUND = new THREE.Vector2(VIEW_DIR.x, VIEW_DIR.z).normalize();
/** Over a robber: a slow circle about the station rather than parked dead still. */
const ORBIT_R = 3;
const ORBIT_RATE = 0.3;           // rad/s
/**
 * Speed. A boosting taxi tops out near 31 u/s (`DRIFT_EXIT` · cruise), so the ceiling has to sit
 * over that or the chase leaves it behind; the gain makes the lag — it closes a gap at 0.9 of its
 * length per second, which trails a Loco run by about a block and a slow one by a car length.
 */
const MAX_SPEED = 36;
const GAIN = 0.9;
const ACCEL = 15;
const LEAVE_SPEED = 26;
/** Attitude off acceleration: a lean into the turn and the nose down into a climb of speed. */
const ROLL_GAIN = 0.035;
const PITCH_GAIN = 0.03;
const PITCH_SPEED = 0.006;        // and nose-down with speed, as the rooftop chopper cruises
const ATTITUDE_MAX = 0.45;
const ATTITUDE_EASE = 3;
const TURN_RATE = 1.6;            // rad/s
/** The jitter every hovering helicopter has. Two sines a channel, as in game/chopper.js. */
const WOBBLE_ROLL = [[0.05, 1.5, 0], [0.025, 2.7, 1.3]];
const WOBBLE_PITCH = [[0.03, 1.1, 0.5], [0.016, 2.4, 2]];
const WOBBLE_YAW = [[0.04, 0.8, 1.7], [0.02, 1.9, 0.2]];

// --- The searchlight --------------------------------------------------------------------
/** The pool's radius on the ground. The taxi is four units long; this puts a car length of street round it. */
const SPOT_R = 3.2;
/** How briskly the operator keeps the light on the target — the pool lags a fast cab a little. */
const AIM_RATE = 4.5;
/** And the hand on it: a slow drift of the pool about its aim point, in units. */
const AIM_WOBBLE = [[0.45, 0.9, 0], [0.25, 2.1, 1.2]];
/** It switches on once the machine is this near the thing it is looking for (horizontally). */
const LIGHT_RANGE = 45;
const LIGHT_EASE = 2.5;           // per second
/** Above the pavement, so the pool sits over the kerb rather than under it. */
const POOL_LIFT = 0.32;
/**
 * Day and night. At night the beam and the pool carry the scene on their own; in full sun an
 * additive light is a few percent on a bright street, so the beam is driven harder and the ring
 * round the pool is darkened — the light reads by contrast with its surroundings, which is how a
 * searchlight is actually seen in daylight on film.
 */
const BEAM = { day: 0.75, night: 0.38 };
const POOL = { day: 1.0, night: 0.75 };
const SHADE = { day: 0.45, night: 0.12 };

// --- Rotor -----------------------------------------------------------------------------
const TAIL_RATIO = 4.6;

// --- Tail lamps ---------------------------------------------------------------------------
/**
 * Red, red, blue, blue: each lamp double-flashes, and the two take turns, once a cycle. A double
 * flash rather than the rooftop chopper's single blink because a single slow blink is what an
 * aircraft's anti-collision light does, and this one has to say *police*; it stops well short of
 * the cruiser's hunting strobe (`sirenOn`, 11 changes a second), which would be a second siren
 * fighting the cars' for attention at the top of the screen. Times are seconds into the cycle.
 */
const TAIL_CYCLE = 1.2;
const TAIL_FLASHES = { red: [[0, 0.09], [0.17, 0.26]], blue: [[0.6, 0.69], [0.77, 0.86]] };
const flashing = (list, t) => list.some(([on, off]) => t >= on && t < off);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ramp = (v, one, zero) => clamp((v - zero) / (one - zero), 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const waves = (list, t) => list.reduce((sum, [a, rate, phase]) => sum + a * Math.sin(t * rate + phase), 0);

/** A cone from the lamp (origin) to a unit-radius mouth at +X = 1, with `along` 0..1 for the fade. */
function beamGeometry() {
  const geo = new THREE.CylinderGeometry(0.05, 1, 1, 22, 4, true);
  geo.translate(0, -0.5, 0);
  geo.rotateZ(Math.PI / 2);
  const pos = geo.attributes.position;
  const along = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) along[i] = pos.getX(i);
  geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
  return geo;
}

function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color('headlightBeam') }, uStrength: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float along;
      varying float vAlong;
      varying vec3 vNormalView;
      void main() {
        vAlong = along;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // Brightest through the middle of the cone, soft at its silhouette (the headlight's reading of
    // a hollow cone as a volume), opening up off the lamp and thinning a little toward the ground.
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vAlong;
      varying vec3 vNormalView;
      void main() {
        float facing = abs(normalize(vNormalView).z);
        float a = smoothstep(0.0, 0.12, vAlong) * (1.0 - 0.45 * vAlong) * facing * facing;
        gl_FragColor = vec4(uColor * a * uStrength, 1.0);
      }
    `,
  });
}

/** A flat disc, radial falloff drawn by `fragment` off `vR` (0 at the middle, 1 at the rim). */
function discMaterial(fragment, blending) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color('headlightBeam') }, uStrength: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending,
    vertexShader: /* glsl */ `
      varying float vR;
      void main() {
        vR = length(position.xy);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: fragment,
  });
}

const POOL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying float vR;
  void main() {
    float a = (1.0 - smoothstep(0.72, 1.0, vR)) * (0.75 + 0.25 * (1.0 - vR));
    gl_FragColor = vec4(uColor * a * uStrength, 1.0);
  }
`;
// The shade ring: the disc is 1.9 pool radii across, dark from just inside the pool's rim to
// nothing at its own.
const SHADE_SCALE = 1.9;
const SHADE_FRAG = /* glsl */ `
  uniform float uStrength;
  varying float vR;
  void main() {
    float r = vR * 1.9;
    float a = smoothstep(0.8, 1.05, r) * (1.0 - smoothstep(1.05, 1.9, r));
    gl_FragColor = vec4(0.02, 0.03, 0.06, a * uStrength);
  }
`;

/**
 * @param scene
 * @param rng      `makeRng` — which side it comes in from.
 * @param groundY  `(x, z) => y` of the road surface there (the bridges are not at 0).
 */
export function createPoliceHeli(scene, rng, { groundY = () => 0 } = {}) {
  const state = {
    mode: 'away',               // 'away' | 'track' | 'out'
    sorties: 0,
    t: 0,
    x: 0, y: ALT, z: 0,
    vx: 0, vz: 0,
    yaw: 0, roll: 0, pitch: 0,
    rotor: 0,
    fade: 0,
    light: 0,                   // the searchlight, 0..1
    aim: { x: 0, z: 0 },
    seen: null,                 // what it was last given to watch, for the tools
  };

  const heli = createHelicopterMesh({ livery: 'police' });
  // The tail lamps glow at the cruisers' own 'siren' intensity — they are the same lamps, flown.
  for (const core of heli.tailCores) markEmissive(core, 'siren');
  heli.group.visible = false;
  heli.group.rotation.order = BODY_EULER_ORDER;
  scene.add(heli.group);

  const beam = new THREE.Mesh(beamGeometry(), beamMaterial());
  beam.name = 'heliBeam';
  beam.renderOrder = 2;
  beam.frustumCulled = false;
  // The radial reads `position.xy`, so the disc is laid flat by the mesh rather than baked flat.
  const flat = new THREE.CircleGeometry(1, 40);
  const pool = new THREE.Mesh(flat, discMaterial(POOL_FRAG, THREE.AdditiveBlending));
  pool.name = 'heliPool';
  pool.renderOrder = 2;
  const shade = new THREE.Mesh(flat, discMaterial(SHADE_FRAG, THREE.NormalBlending));
  shade.name = 'heliShade';
  shade.renderOrder = 1;
  const light = new THREE.Group();
  light.name = 'heliSearchlight';
  light.add(beam, pool, shade);
  light.visible = false;
  scene.add(light);

  const lamp = new THREE.Vector3();
  const up = new THREE.Vector3(1, 0, 0);
  const dir = new THREE.Vector3();
  let dark = 0;

  function begin(target) {
    // In from the far side of the city rather than from the camera's: a machine arriving from
    // up-screen is seen arriving, one from behind the lens appears out of the bottom of the frame
    // already overhead.
    const away = Math.atan2(-CAM_GROUND.y, -CAM_GROUND.x) + rng.range(-0.9, 0.9);
    state.x = target.x + Math.cos(away) * ENTRY_DIST;
    state.z = target.z + Math.sin(away) * ENTRY_DIST;
    state.y = ALT;
    const toward = Math.atan2(-(target.z - state.z), target.x - state.x);
    state.yaw = toward;
    const f = heading(toward);
    state.vx = f.x * MAX_SPEED * 0.8;
    state.vz = f.z * MAX_SPEED * 0.8;
    state.roll = 0;
    state.pitch = 0;
    state.light = 0;
    state.aim = { x: target.x, z: target.z };
    state.mode = 'track';
    state.sorties += 1;
    heli.group.visible = true;
  }

  /** Where it wants to be, for a target. */
  function station(target) {
    let x = target.x + CAM_GROUND.x * TOWARD_CAMERA;
    let z = target.z + CAM_GROUND.y * TOWARD_CAMERA;
    if (target.yaw !== undefined && target.moving) {
      const f = heading(target.yaw);
      x -= f.x * TRAIL;
      z -= f.z * TRAIL;
    } else {
      x += Math.cos(state.t * ORBIT_RATE) * ORBIT_R;
      z += Math.sin(state.t * ORBIT_RATE) * ORBIT_R;
    }
    return { x, z };
  }

  function fly(dt, want, wantYaw) {
    const vx0 = state.vx;
    const vz0 = state.vz;
    state.vx += clamp(want.vx - state.vx, -ACCEL * dt, ACCEL * dt);
    state.vz += clamp(want.vz - state.vz, -ACCEL * dt, ACCEL * dt);
    state.x += state.vx * dt;
    state.z += state.vz * dt;

    const speed = Math.hypot(state.vx, state.vz);
    const turn = clamp(wrapAngle(wantYaw - state.yaw), -TURN_RATE * dt, TURN_RATE * dt);
    state.yaw = wrapAngle(state.yaw + turn);

    // Lean into the acceleration — in the machine's own frame. Right is local +Z (see
    // geometry/helicopter.js), which `BODY_EULER_ORDER`'s roll tips the mast toward.
    const ax = dt > 0 ? (state.vx - vx0) / dt : 0;
    const az = dt > 0 ? (state.vz - vz0) / dt : 0;
    const f = heading(state.yaw);
    const fwd = ax * f.x + az * f.z;
    const right = ax * Math.sin(state.yaw) + az * Math.cos(state.yaw);
    const k = 1 - Math.exp(-dt * ATTITUDE_EASE);
    const wantRoll = clamp(right * ROLL_GAIN, -ATTITUDE_MAX, ATTITUDE_MAX);
    const wantPitch = clamp(-fwd * PITCH_GAIN - speed * PITCH_SPEED, -ATTITUDE_MAX, ATTITUDE_MAX);
    state.roll += (wantRoll - state.roll) * k;
    state.pitch += (wantPitch - state.pitch) * k;
  }

  function updateTrack(dt, target) {
    const at = station(target);
    const dx = at.x - state.x;
    const dz = at.z - state.z;
    const dist = Math.hypot(dx, dz);
    const v = Math.min(MAX_SPEED, dist * GAIN);
    const want = dist > 1e-6 ? { vx: (dx / dist) * v, vz: (dz / dist) * v } : { vx: 0, vz: 0 };
    // Nose down the way it is going while it is going somewhere; turned toward what it is
    // watching once it is holding station over it — the pedal turn that says *helicopter*.
    const speed = Math.hypot(state.vx, state.vz);
    const travel = Math.atan2(-state.vz, state.vx);
    const look = Math.atan2(-(target.z - state.z), target.x - state.x);
    fly(dt, want, speed > 6 ? travel : look);

    // The light: on once it is near enough to have found what it is looking for.
    const near = Math.hypot(target.x - state.x, target.z - state.z) < LIGHT_RANGE;
    state.light = clamp(state.light + (near ? 1 : -1) * LIGHT_EASE * dt, 0, 1);
    const kAim = 1 - Math.exp(-dt * AIM_RATE);
    state.aim.x += (target.x - state.aim.x) * kAim;
    state.aim.z += (target.z - state.aim.z) * kAim;
  }

  function updateOut(dt) {
    // Away from the middle of the island, accelerating, turning onto it as it goes.
    const r = Math.hypot(state.x, state.z) || 1;
    const ox = state.x / r;
    const oz = state.z / r;
    fly(dt, { vx: ox * LEAVE_SPEED, vz: oz * LEAVE_SPEED }, Math.atan2(-state.vz, state.vx));
    state.light = clamp(state.light - LIGHT_EASE * dt, 0, 1);
    if (state.fade <= 0 && r > FADE[1]) {
      state.mode = 'away';
      heli.group.visible = false;
      light.visible = false;
    }
  }

  function pose() {
    heli.group.position.set(state.x, state.y, state.z);
    heli.group.rotation.set(
      state.roll + waves(WOBBLE_ROLL, state.t),
      state.yaw + waves(WOBBLE_YAW, state.t),
      state.pitch + waves(WOBBLE_PITCH, state.t),
      BODY_EULER_ORDER,
    );
    heli.mainHub.rotation.y = state.rotor;
    heli.tailHub.rotation.z = state.rotor * TAIL_RATIO;
    heli.setRotorBlur(1);
    const cycle = state.t % TAIL_CYCLE;
    heli.setTailLights(flashing(TAIL_FLASHES.red, cycle), flashing(TAIL_FLASHES.blue, cycle));
    heli.setFade(state.fade);
    heli.setSearchlight(state.light);
  }

  function poseLight() {
    const level = state.light * state.fade;
    light.visible = level > 0.001;
    if (!light.visible) return;
    heli.group.updateMatrixWorld();
    lamp.set(SEARCHLIGHT.x, SEARCHLIGHT.y - 0.06, SEARCHLIGHT.z);
    heli.group.localToWorld(lamp);

    const ax = state.aim.x + waves(AIM_WOBBLE, state.t);
    const az = state.aim.z + waves(AIM_WOBBLE, state.t + 7.3);
    const gy = groundY(ax, az) + POOL_LIFT;
    dir.set(ax - lamp.x, gy - lamp.y, az - lamp.z);
    const len = dir.length();
    dir.divideScalar(len);
    beam.position.copy(lamp);
    beam.quaternion.setFromUnitVectors(up, dir);
    beam.scale.set(len, SPOT_R, SPOT_R);

    // The pool, stretched along the beam's horizontal run by how far off vertical it comes in.
    const h = Math.hypot(dir.x, dir.z);
    const stretch = 1 / Math.max(0.35, -dir.y);
    const yaw = h > 1e-4 ? Math.atan2(-dir.z, dir.x) : 0;
    // 'YXZ' is Ry·Rx: laid flat first, then turned about the vertical, so the circle's local X —
    // the axis the stretch below scales — ends up along the beam's heading.
    for (const disc of [pool, shade]) {
      disc.position.set(ax, gy, az);
      disc.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    }
    pool.scale.set(SPOT_R * stretch, SPOT_R, 1);
    shade.scale.set(SPOT_R * stretch * SHADE_SCALE, SPOT_R * SHADE_SCALE, 1);

    beam.material.uniforms.uStrength.value = lerp(BEAM.day, BEAM.night, dark) * level;
    pool.material.uniforms.uStrength.value = lerp(POOL.day, POOL.night, dark) * level;
    shade.material.uniforms.uStrength.value = lerp(SHADE.day, SHADE.night, dark) * level;
  }

  /**
   * @param dt
   * @param target  what to watch this frame, or null to go home: `{ x, z, yaw?, moving? }`.
   * @param opts.dark  0 (noon) .. 1 (night), for the light's strength.
   */
  function update(dt, target, { dark: d = 0 } = {}) {
    dark = clamp(d, 0, 1);
    state.seen = target ? { x: target.x, z: target.z } : null;
    if (state.mode === 'away') {
      if (!target) return;
      begin(target);
    } else if (state.mode === 'out' && target) {
      state.mode = 'track';
    }
    state.t += dt;
    state.rotor += ROTOR_FLIGHT * dt;

    if (state.mode === 'track') {
      if (target) updateTrack(dt, target);
      else state.mode = 'out';
    }
    if (state.mode === 'out') updateOut(dt);
    if (state.mode === 'away') return;

    state.fade = ramp(Math.hypot(state.x, state.z), FADE[0], FADE[1]);
    pose();
    poseLight();
  }

  return {
    state,
    group: heli.group,
    light,
    update,
    /** Up, or on its way in or out. */
    busy: () => state.mode !== 'away',
    /** 0..1 how loud the rotor is from `(x, z)` — the listener is the taxi. */
    loudness(x, z) {
      if (state.mode === 'away') return 0;
      const d = Math.hypot(state.x - x, state.z - z);
      return state.fade * (0.3 + 0.7 * ramp(d, 20, 80));
    },
  };
}
