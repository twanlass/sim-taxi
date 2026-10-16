import * as THREE from 'three';
import { PALETTE, color } from '../palette.js';
import { BODY_EULER_ORDER, unlitMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { cullEmptyPools } from '../util/emptypools.js';
import { createViewport } from '../util/viewport.js';
import {
  createTaxiMesh, TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, TAXI_SCALE,
  TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK,
} from '../geometry/taxi.js';
import { setGhostOutlines } from '../geometry/ghostoutline.js';
import { FLAME_LEN } from './locoflame.js';
import { VIEW_DIR, DISTANCE } from './camera.js';
import { SUN } from './scene.js';
import { createDust } from './dust.js';
import { createSparks } from './sparks.js';
import { createFlames } from './flames.js';
import { createLocoFlame } from './locoflame.js';
import { createBlast } from './blast.js';
import { createSkidMarks } from './skidmarks.js';

/**
 * The startup screen: black, a patch of asphalt fading out into it, and the taxi dropping out of
 * the sky onto it — the Big Air landing's dust ring, shockwave and sparks — bouncing, then lighting
 * Loco Mode, lifting its nose and firing off the edge of the frame. Then the title menu.
 *
 * **It exists to cover the load, and it cannot animate *during* the load.** `main.js` builds the
 * whole city in one synchronous task (13.1 s of it under headless SwiftShader, one long task with
 * nothing in between), so nothing on the page can move while it runs. The order is therefore:
 * black while the game loads and evaluates (`src/boot.js` imports it behind this), then the drop
 * on a page that is no longer busy. The black is the point as much as the taxi — the page, the web
 * view and the iOS launch screen used to be the sky's pale blue, which is what a cold start showed
 * for as long as the load took (see `html.booting` in index.html).
 *
 * **Its own renderer and its own tiny scene.** The city's renderer has shadow maps, AO, bloom and a
 * governor between it and a frame; this is one disc, one car and four effect pools, so it gets a
 * context of its own and gives it back (`forceContextLoss`) when it is done.
 *
 * **Everything is built before the game is imported, on purpose.** `propMaterial()` bakes the AO,
 * Crayon and cloud-shadow decisions into the shader at creation (util/geo.js), and those switches are
 * thrown by `main.js` as it boots. A taxi made afterwards would compile against the city's SSAO
 * buffer and sample the occlusion of whatever building stood at that pixel in a frame it never drew.
 * Built and compiled first, it is the plain car.
 *
 * **The city does not draw underneath it.** `splashCovers()` is read at the top of main.js's frame:
 * while the drop is on screen the city skips its frames outright. It gets a few frames first,
 * behind the black (`WARM_FRAMES`), so its first-draw shader links happen where they cannot
 * stutter the drop — and the last of those frames, still on its canvas, is the menu the fade
 * reveals. The city picks up again once the screen is gone.
 */

// --- Timeline, in seconds from the moment the drop is allowed to start ------------------------
/** The asphalt fading up out of the black before anything falls. */
export const STAGE_IN = 0.3;
/** Falling, from above the top of the frame to the road. Fast: it is a slam, not a descent. */
export const FALL = 0.42;
/** When the tyres first touch. */
export const LAND = STAGE_IN + FALL;
/**
 * The bounces after the slam: apex heights in world units, under their own gravity. The fall's
 * gravity (whatever it takes to cover the frame in `FALL`) is ~340 u/s² — at that rate a 1.2-unit
 * bounce is over in a sixth of a second and reads as a twitch. 60 lets the car hang.
 */
export const BOUNCES = [1.15, 0.32];
const BOUNCE_G = 60;
const bounceTime = (h) => 2 * Math.sqrt((2 * h) / BOUNCE_G);
/** Every touchdown: the slam, then the end of each bounce. */
export const TOUCHDOWNS = BOUNCES.reduce((at, h) => [...at, at.at(-1) + bounceTime(h)], [LAND]);
/** Loco Mode lights. A beat after the last bounce, so the car is seen *sitting* before it goes. */
export const IGNITE = TOUCHDOWNS.at(-1) + 0.32;
/** Launch acceleration, u/s², and the wheelie it lifts into. */
const LAUNCH_ACCEL = 70;
export const WHEELIE = 0.3;        // rad, ~17°
const WHEELIE_RATE = 9;            // per second, the nose coming up
/**
 * How long the empty patch holds after the car has gone — skid marks, the dust settling, the
 * backfire fading — before the fade to the menu. Tyler's beat: "have the taxi fully exit, wait 1s,
 * then fade". The first cut faded 0.8s after ignition, with the car still on its way out.
 */
export const HOLD = 1;
export const FADE = 0.4;
/** A tap anywhere skips to the fade, and a skipped fade is quicker. */
const SKIP_FADE = 0.22;
/** City frames drawn behind the black before the drop starts — see the module note. */
const WARM_FRAMES = 3;

// --- Staging ----------------------------------------------------------------------------------
/** The patch: solid out to `SOLID` of its radius, faded to black by the edge. */
export const DISC_R = 6;
const DISC_SOLID = 0.28;
/** What the frame has to fit: the patch across, and some sky above it for the car to fall through. */
const FIT_HALF_W = 6.5;
const FIT_HALF_H = 6.5;
/** North — the game's own −z, up-screen and to the right under this camera. */
export const HEADING = Math.PI / 2;
/** The quarter-turn and a bit it unwinds on the way down, so it tumbles in rather than lowering. */
const FALL_SPIN = 1.1;
/** The drawn body's half-width; its half-length is `TAXI_TAILPIPE_BACK`. Not the sim's 1.7 / 2. */
const HALF_W = (1.7 / 2) * TAXI_SCALE;
/** Screen height per unit of world height, under the fixed 33° camera. */
const RISE_ON_SCREEN = Math.sqrt(1 - VIEW_DIR.y * VIEW_DIR.y);

/** The frustum half-height for a viewport: whichever of the two fits binds. */
export function splashZoom(aspect) {
  return Math.max(FIT_HALF_H, FIT_HALF_W / aspect);
}

/** Screen right and screen up, as world directions, under the fixed camera. */
const SCREEN_RIGHT = new THREE.Vector3(1, 0, -1).normalize();
const SCREEN_UP = new THREE.Vector3().crossVectors(SCREEN_RIGHT, VIEW_DIR).normalize();
/** Half the car's drawn extent across its line of travel on screen, roof and wheelie included. */
const EXIT_SIDE = 3;
/** From the car's origin back to the tip of its plume, with room for the flicker's stretch. */
export const FLAME_TAIL = TAXI_TAILPIPE_BACK + FLAME_LEN * 1.2;

/**
 * When the car — the tip of its Loco plume included — has fully left the frame, walked off its own
 * pose rather than worked out in closed form: it leaves on a diagonal through whichever edge it
 * reaches first, and on a wide frame that is the top, where the wheelie's lift counts too (the
 * closed form that left the lift out had the plume still in a desktop frame). Per aspect: a desktop
 * window is wider than a phone and takes longer to leave.
 */
const exitCache = new Map();
export function exitTime(aspect) {
  const key = aspect.toFixed(4);
  if (exitCache.has(key)) return exitCache.get(key);
  const zoom = splashZoom(aspect);
  const at = new THREE.Vector3();
  const inFrame = (x, y, z) => {
    at.set(x, y, z);
    return Math.abs(at.dot(SCREEN_RIGHT)) - EXIT_SIDE < zoom * aspect && Math.abs(at.dot(SCREEN_UP)) - EXIT_SIDE < zoom;
  };
  let t = IGNITE;
  for (; t < IGNITE + 3; t += 1 / 120) {
    const p = splashPose(t, aspect);
    const tx = p.x - Math.cos(p.yaw) * FLAME_TAIL;
    const tz = p.z + Math.sin(p.yaw) * FLAME_TAIL;
    if (!inFrame(p.x, p.y, p.z) && !inFrame(tx, p.y, tz)) break;
  }
  exitCache.set(key, t);
  return t;
}

/** The fade to the menu: a `HOLD` on the empty patch after the car is gone. */
export function fadeAt(aspect) {
  return exitTime(aspect) + HOLD;
}

/** Start to finish, at an aspect: about 3.8s on a phone. */
export function splashLength(aspect) {
  return fadeAt(aspect) + FADE;
}

/** Where to drop from: clear of the top of the frame, whatever its shape. */
export function dropHeight(aspect) {
  return splashZoom(aspect) / RISE_ON_SCREEN + 4;
}

/**
 * The car's pose at `t` seconds into the timeline. Pure, so the probe can walk it: the wheels never
 * go under the road, and the car is out of frame before the fade.
 *
 * `along` is how far it has driven, forward along `HEADING`. `lift` is the body's origin above the
 * road; a pitched or rolled body is raised by the sagitta of each, the way `sim/traffic.js` keeps
 * a tilted car's low edge on the tarmac — except in the wheelie, which pivots on the rear axle.
 */
export function splashPose(t, aspect) {
  let y = 0;
  let pitch = 0;
  let roll = 0;
  let yaw = HEADING;
  let squash = 0;
  let along = 0;
  let wheelie = 0;

  if (t < LAND) {
    const u = Math.max(0, (t - STAGE_IN) / FALL);
    y = dropHeight(aspect) * (1 - u * u);
    // Nose down and rolled as it comes in, unwinding the spin into the heading it will leave on.
    yaw = HEADING + FALL_SPIN * (1 - u) ** 2;
    pitch = -0.22;
    roll = 0.14;
  } else {
    // In the air between touchdowns: a parabola under the bounce gravity.
    let last = LAND;
    for (let n = 0; n < BOUNCES.length; n++) {
      const t0 = TOUCHDOWNS[n];
      const t1 = TOUCHDOWNS[n + 1];
      if (t >= t0 && t < t1) {
        const s = t - t0;
        const v0 = Math.sqrt(2 * BOUNCE_G * BOUNCES[n]);
        y = v0 * s - 0.5 * BOUNCE_G * s * s;
      }
      if (t >= t0) last = t0;
    }
    if (t >= TOUCHDOWNS.at(-1)) last = TOUCHDOWNS.at(-1);
    // Each touchdown rings the body: a damped wobble in pitch and roll and a squash on the springs,
    // biggest on the slam. The first lands nose-first (it came in nose down), so it rocks back.
    const hit = TOUCHDOWNS.indexOf(last);
    const k = [1, 0.45, 0.2][hit] ?? 0.2;
    const s = t - last;
    const ring = Math.exp(-s * 7) * Math.cos(s * 22);
    pitch = -0.2 * k * ring;
    roll = 0.12 * k * Math.exp(-s * 6) * Math.sin(s * 17 + 0.6);
    squash = 0.2 * k * Math.exp(-s * 11) * Math.max(0, Math.cos(s * 26));
  }

  if (t >= IGNITE) {
    const s = t - IGNITE;
    along = 0.5 * LAUNCH_ACCEL * s * s;
    // Up on the back wheels and holding there, with a little overshoot as the thrust bites.
    wheelie = WHEELIE * (1 - Math.exp(-s * WHEELIE_RATE)) * (1 + 0.15 * Math.exp(-s * 4) * Math.sin(s * 14));
    pitch += wheelie;
  }

  // Off the road by the sagitta of the tilt, so a rocked body sits on its tyres rather than in the
  // asphalt. The wheelie turns about the tail instead: about the rear axle, which is where a real one
  // pivots, the overhang behind it put the bumper 0.24 into the road at the top of the lift (probe).
  const tilt = pitch - wheelie;
  y += Math.abs(Math.sin(roll)) * HALF_W + Math.abs(Math.sin(tilt)) * TAXI_TAILPIPE_BACK
    + Math.sin(wheelie) * TAXI_TAILPIPE_BACK;

  return {
    x: Math.cos(HEADING) * along,
    z: -Math.sin(HEADING) * along,
    y, yaw, pitch, roll, squash, along, wheelie,
  };
}

// --- The gate main.js reads -------------------------------------------------------------------
let covering = false;
/** True while the drop is on screen and the city should skip its frames. */
export function splashCovers() {
  return covering;
}

/**
 * Whether this load gets the startup screen. Not where the title screen would not be either — shot
 * mode, `?dev`, `?title=off`, the reload "Play again" does (read, not consumed: main.js consumes
 * it) — and not on `?splash=classic`, which is the load as it was.
 */
export function wantsSplash() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('shot') || params.has('dev') || params.get('title') === 'off') return false;
  if (params.get('splash') === 'classic') return false;
  try {
    if (window.sessionStorage.getItem('simTaxi.skipTitle') === '1') return false;
  } catch { /* storage refused: a fresh start, so play it */ }
  return true;
}

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The patch of road. A disc with its own shader rather than a lit prop: it has to fade into pure
 * black at the edge whatever the light does, and it carries the one lane line the car leaves along.
 */
function asphaltPatch() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAsphalt: { value: color('asphalt') },
      uLine: { value: color('laneMark') },
      uRubber: { value: color('skidRubber') },
      uOpacity: { value: 0 },
      uR: { value: DISC_R },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vXZ = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uAsphalt;
      uniform vec3 uLine;
      uniform vec3 uRubber;
      uniform float uOpacity;
      uniform float uR;
      varying vec2 vXZ;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        // Grain: two scales of stone, so the patch reads as tarmac rather than as a grey disc.
        float g = hash(floor(vXZ * 7.0)) * 0.6 + hash(floor(vXZ * 2.3)) * 0.4;
        vec3 c = uAsphalt * (0.86 + 0.22 * g);
        // The centre line, a lane to the car's left: dashed along z, as every street's is.
        float dash = step(0.5, fract(vXZ.y / 4.0));
        float line = (1.0 - smoothstep(0.11, 0.15, abs(vXZ.x + 2.1))) * dash;
        c = mix(c, uLine, line * 0.9);
        // A tar seam across it, slightly darker, so the line is not the only thing on it.
        float seam = 1.0 - smoothstep(0.04, 0.09, abs(vXZ.y - vXZ.x * 0.18 - 2.6));
        c = mix(c, uRubber, seam * 0.35);
        float d = length(vXZ) / uR;
        float fade = 1.0 - smoothstep(0.28, 1.0, d);
        gl_FragColor = vec4(c * fade * fade * uOpacity, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const geometry = new THREE.CircleGeometry(DISC_R, 48);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 0;
  return mesh;
}

/** The soft dark spot under a falling car: the one thing that says where it is going to land. */
function blobShadow() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const material = unlitMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false });
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.02;
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * @param {HTMLElement} root  `#splash`. The canvas goes in it, and it fades out with it.
 * @returns the startup screen, or null when this load doesn't get one.
 */
export function createSplash(root) {
  if (!root) return null;

  const viewport = createViewport();
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(viewport.width(), viewport.height());
  renderer.setClearColor(PALETTE.splashVoid, 1);
  root.appendChild(renderer.domElement);
  const aspect = () => viewport.width() / Math.max(1, viewport.height());

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, SUN.fill));
  const sun = new THREE.DirectionalLight(PALETTE.sun, SUN.intensity);
  sun.position.set(
    Math.cos(SUN.azimuth) * Math.cos(SUN.elevation),
    Math.sin(SUN.elevation),
    Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
  );
  scene.add(sun);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DISTANCE * 2);
  const shakeAt = new THREE.Vector3();
  function frameCamera(shake = 0, rng = null) {
    const zoom = splashZoom(aspect());
    camera.left = -zoom * aspect();
    camera.right = zoom * aspect();
    camera.top = zoom;
    camera.bottom = -zoom;
    camera.updateProjectionMatrix();
    shakeAt.set(rng ? rng.jitter(shake) : 0, 0, rng ? rng.jitter(shake) : 0);
    camera.position.copy(VIEW_DIR).multiplyScalar(DISTANCE).add(shakeAt);
    camera.lookAt(shakeAt);
  }
  frameCamera();
  viewport.onChange((w, h) => {
    renderer.setSize(w, h);
    frameCamera();
  });

  const patch = asphaltPatch();
  scene.add(patch);
  const shadow = blobShadow();
  scene.add(shadow);

  const taxi = createTaxiMesh();
  // Nothing in this scene can hide the car, so the outline that shows it through buildings has
  // nothing to do — and with no stencil buffer asked for, it would fill the whole hull.
  setGhostOutlines(taxi.group, false);
  scene.add(taxi.group);

  // The game's own effect pools, the same ones the Big Air landing and the Loco press spend.
  const rng = makeRng(0x5ef1a5);
  const dust = createDust(scene, camera, makeRng(11));
  const sparks = createSparks(scene, makeRng(12));
  const flames = createFlames(scene, makeRng(13));
  const plume = createLocoFlame(scene);
  const blast = createBlast(scene, makeRng(14));
  const skids = createSkidMarks(scene);

  // Every program linked now, while the screen is black and before main.js throws the switches
  // that would change what these materials compile to (see the module note).
  taxi.group.position.set(0, 0, 0);
  renderer.compile(scene, camera);
  taxi.group.visible = false;
  renderer.render(scene, camera);

  const car = { x: 0, z: 0, yaw: HEADING, crashed: false, shownPitch: 0, shownLift: 0, shownBarrel: 0 };
  let clock = -1;          // < 0: not started
  let fadeFrom = Infinity; // timeline time the fade began
  let fadeLength = FADE;
  let touched = 0;         // touchdowns already spent
  let ignited = false;
  let lastSkid = -1;
  let shake = 0;
  let raf = 0;
  let last = 0;
  let done = false;
  let ready = false;
  let skipped = false;
  let finishResolve;
  const finished = new Promise((resolve) => { finishResolve = resolve; });

  function wheelPoints(pose) {
    const fx = Math.cos(pose.yaw);
    const fz = -Math.sin(pose.yaw);
    const rx = Math.sin(pose.yaw);
    const rz = Math.cos(pose.yaw);
    const out = [];
    for (const [along, track, rear] of [[TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK, false],
      [-TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK, true]]) {
      for (const side of [-1, 1]) {
        out.push({ x: pose.x + fx * along + rx * side * track, z: pose.z + fz * along + rz * side * track, rear });
      }
    }
    return out;
  }

  /**
   * What each touchdown throws: the slam is the Big Air landing — the ring of dust, the shockwave,
   * sparks off all four wheels — and the bounces less of it. The dust is the landing's shape at a
   * fraction of its size: a puff's size and throw both scale on `power`, and this camera is four
   * times closer than play's, so the landing's own 30 at 1.2 buried the car in a sandstorm.
   */
  function touchdown(n, pose) {
    if (n === 0) {
      dust.burst(pose.x, pose.z, pose.yaw, 18, 0.42, { ring: 1.7, linger: 0.8 });
      blast.shock(pose.x, pose.z, { tint: PALETTE.landRing, yaw: pose.yaw });
      for (const w of wheelPoints(pose)) sparks.burst(w.x, 0, w.z, pose.yaw + rng.jitter(Math.PI), 12, 14);
      shake = 0.55;
    } else {
      dust.burst(pose.x, pose.z, pose.yaw, n === 1 ? 8 : 4, n === 1 ? 0.3 : 0.2, { linger: 0.6 });
      if (n === 1) for (const w of wheelPoints(pose)) sparks.burst(w.x, 0, w.z, pose.yaw, 3, 6);
      shake = Math.max(shake, n === 1 ? 0.18 : 0.06);
    }
  }

  function pose(t) {
    const p = splashPose(t, aspect());
    taxi.group.visible = t >= STAGE_IN;
    taxi.group.position.set(p.x, p.y, p.z);
    taxi.group.rotation.set(p.roll, p.yaw, p.pitch, BODY_EULER_ORDER);
    taxi.group.scale.set(1 + p.squash * 0.5, 1 - p.squash, 1 + p.squash * 0.5);
    // The shadow: wide and faint with the car high, tight and dark as it arrives.
    const high = Math.min(1, p.y / 12);
    const s = 5.2 * (1 + high * 0.8);
    shadow.scale.set(s, 1, s * 0.62);
    shadow.position.x = p.x;
    shadow.position.z = p.z;
    shadow.rotation.y = p.yaw;
    shadow.material.opacity = t < STAGE_IN ? 0 : (1 - high * 0.7) * Math.min(1, (t - STAGE_IN) / 0.15);
    car.x = p.x;
    car.z = p.z;
    car.yaw = p.yaw;
    car.shownPitch = p.pitch;
    car.shownLift = p.y;
    return p;
  }

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    clock += dt;
    const t = clock;

    patch.material.uniforms.uOpacity.value = Math.min(1, t / STAGE_IN);
    const p = pose(t);

    while (touched < TOUCHDOWNS.length && t >= TOUCHDOWNS[touched]) {
      touchdown(touched, splashPose(TOUCHDOWNS[touched], aspect()));
      touched += 1;
    }
    if (!ignited && t >= IGNITE) {
      ignited = true;
      flames.burst(
        p.x - Math.cos(p.yaw) * TAXI_TAILPIPE_BACK,
        TAXI_TAILPIPE_HEIGHT,
        p.z + Math.sin(p.yaw) * TAXI_TAILPIPE_BACK,
        p.yaw,
      );
      shake = Math.max(shake, 0.2);
    }
    // The burnout: rubber laid and dust kicked off the back tyres for the first few metres, while
    // they are still on the patch and spinning up rather than gripping.
    if (ignited && p.along < 9) {
      for (const w of wheelPoints(p)) {
        if (!w.rear) continue;
        if (p.along - lastSkid > 0.35 || lastSkid < 0) skids.add(w.x, w.z, p.yaw, 1);
        if (rng.chance(0.5)) dust.burst(w.x, w.z, p.yaw, 1, 0.28, { linger: 0.6 });
      }
      if (p.along - lastSkid > 0.35 || lastSkid < 0) lastSkid = p.along;
    }
    plume.update(dt, car, ignited && t < exitTime(aspect()));

    dust.update(dt);
    sparks.update(dt);
    flames.update(dt);
    blast.update?.(dt);
    skids.update(dt);

    // The pools hide themselves while empty, and the switch is global (util/emptypools.js): main.js
    // throws it every frame for every pool, these included, and it is not drawing frames now.
    cullEmptyPools();
    shake *= Math.exp(-dt * 9);
    frameCamera(shake, rng);
    renderer.render(scene, camera);

    if (t >= fadeAt(aspect()) && fadeFrom === Infinity) beginFade(FADE);
    if (t >= fadeFrom + fadeLength) finish();
  }

  function beginFade(length) {
    if (fadeFrom !== Infinity) return;
    fadeFrom = Math.max(0, clock);
    fadeLength = length;
    // The city stays held through the fade: what it reveals is the frame the city drew while warming
    // up behind the black, still on its canvas. Letting it draw again here was tried, and its first
    // frame back is the expensive one — on a slow device the fade stood still while it ran.
    root.style.transition = `opacity ${length}s ease-in`;
    root.style.opacity = '0';
  }

  function finish() {
    if (done) return;
    done = true;
    covering = false;
    cancelAnimationFrame(raf);
    renderer.dispose();
    renderer.forceContextLoss();
    root.remove();
    document.documentElement.classList.remove('booting');
    finishResolve();
  }

  // Tap to skip — the press only, so it cannot carry through as a click onto the menu under it.
  root.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (!ready) { skipped = true; return; }
    beginFade(SKIP_FADE);
  });

  return {
    /** Resolves when the screen is gone. */
    finished,
    /**
     * Start once the game is up: `loading` is the game's import. A few of its frames go by behind
     * the black first, then the drop — or straight to the fade, if a tap or the player's
     * reduced-motion setting already said no.
     */
    run(loading) {
      loading.then(() => {
        let warm = 0;
        const wait = () => {
          if (++warm < WARM_FRAMES) { requestAnimationFrame(wait); return; }
          ready = true;
          if (skipped || stillPlease()) {
            clock = 0;
            raf = requestAnimationFrame(step);
            beginFade(SKIP_FADE);
            return;
          }
          covering = true;
          clock = 0;
          raf = requestAnimationFrame(step);
        };
        requestAnimationFrame(wait);
      }, () => finish());
      return finished;
    },
  };
}
