import * as THREE from 'three';
import { carGeometry, CABIN_TOP } from '../sim/traffic.js';
import {
  sirenOn, sirenPodGeometry, sirenBarAnchors, sirenRedMaterial, sirenBlueMaterial,
} from '../geometry/lights.js';
import { propMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { mirrorSceneLights } from './avatarlights.js';
import { VIEW_DIR } from './camera.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// The police radio: a bubble that says the fare who just got in is not a fare.
//
// A robber boards on the ordinary urgency scale — same crystal, same ring, same band of paint (see
// docs/gameplay.md#the-robber) — so the figure coming down the bank's steps was the only thing
// saying this pickup is different, and it is a 20px figure the player was not looking at, because a
// robbery triggers on a drive-*past*. The police arriving says it too, but a beat later and off
// screen. This says it on the frame it happens.
//
// Deliberately **not** the tutorial's coach bubble, though it borrows its look:
//
//   - No spotlight. The run is live and the clock that matters most in the game has just started;
//     dimming the city over the getaway would spend it.
//   - Nothing to answer. It is `pointer-events: none` and times itself out, because the tap the
//     player is about to make is on the road, routing the getaway, and a bubble that ate it would
//     cost the one second this event is about.
//   - Its own element and its own context. The tutorial's third beat can still be cycling when a
//     robbery lands, and the two say different things from different places — the coach speaks for
//     the taxi from the bottom, the radio is somebody else's channel breaking in from the top.
//
// Named `radio` rather than anything with `alert`/`banner`/`popup` in it: ad-blocker filter lists
// match those, and one hit takes the module graph down (see CLAUDE.md).

/** What the dispatcher says. */
export const RADIO_LINE = 'All units respond! Robbery in progress.';

/**
 * How long it stays up, in seconds of game time. Long enough to read the line twice at a glance
 * (39 characters), short enough that it is gone before the first cop car is on screen to take over
 * saying it. Game time rather than wall time, so a pause holds it rather than eating it.
 */
export const RADIO_LINGER = 3.2;

// Matches the exit transition in index.html, as the coach's CLOSE_MS does.
const CLOSE_MS = 220;

// The avatar box, in CSS pixels — the coach's taxi square, so the two bubbles are one family.
const AVATAR_PX = 54;
// One turn every 5.5s, the coach's own rate.
const AVATAR_SPIN = (Math.PI * 2) / 5.5;
// Viewed as the coach views the taxi: the game camera's elevation on the +Z azimuth, which is the
// sunlit side at the hour the game parks at (see `createAvatar` in game/tutorial.js).
const AVATAR_VIEW = new THREE.Vector3(0, VIEW_DIR.y, Math.hypot(VIEW_DIR.x, VIEW_DIR.z)).normalize();

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The cop car turning in the bubble. The *robbery's* cop car — the ordinary ambient car in
 * `policeBody` with the siren bar on its roof (sim/traffic.js) — not the corridor cruiser, because
 * this is the car about to be in the player's mirror.
 *
 * Built from the traffic model's own `carGeometry` rather than a copy, so the car in the bubble is
 * the car on the road. That geometry leaves its body white for the instance tint; here the
 * material's own colour does the same multiply, glass and tyres included, which is exactly what
 * the instance colour does to them on the street.
 */
function createAvatar(sun, hemi) {
  const canvas = document.createElement('canvas');
  // Same budget flags as every other context this page opens — see util/shot.js.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(AVATAR_PX, AVATAR_PX, false);
  canvas.style.width = `${AVATAR_PX}px`;
  canvas.style.height = `${AVATAR_PX}px`;

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  const pivot = new THREE.Group();
  scene.add(pivot);
  const bodyMaterial = propMaterial({ ao: false });
  bodyMaterial.color.copy(color('policeBody'));
  pivot.add(new THREE.Mesh(carGeometry(), bodyMaterial));

  // The bar: two pods per colour, the whole bar flashing red then blue as it does on the street.
  // Switched by `visible` here rather than by scale — nothing in this scene is instanced.
  const bar = (material) => {
    const group = new THREE.Group();
    for (const at of sirenBarAnchors(-0.2, CABIN_TOP)) {
      const pod = new THREE.Mesh(sirenPodGeometry(), material);
      pod.position.copy(at);
      group.add(pod);
    }
    pivot.add(group);
    return group;
  };
  const red = bar(sirenRedMaterial());
  const blue = bar(sirenBlueMaterial());

  // Framed on what the car sweeps as it turns, as the coach frames the taxi. Measured off
  // `carGeometry()` projected through this camera over a full turn: ±1.92 across, and −1.66 to
  // +1.59 about CENTRE_Y — +1.89 with the bar's 0.3 on the roof. 2.2 is that plus a little air,
  // the same 87–96% fill the coach's taxi gets.
  const CENTRE_Y = 1.0;
  const FIT = 2.2;
  const camera = new THREE.OrthographicCamera(-FIT, FIT, FIT, -FIT, 0.1, 60);
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(AVATAR_VIEW, 20);
  camera.lookAt(0, CENTRE_Y, 0);
  // The coach's reduced-motion pose: a front three-quarter on the lit side.
  const stillAngle = -Math.PI / 4;

  return {
    canvas,
    render(elapsed) {
      const still = prefersReducedMotion();
      pivot.rotation.y = still ? stillAngle : elapsed * AVATAR_SPIN;
      // Reduced motion parks the bar on red rather than strobing it — a flashing light is the one
      // piece of motion here that is not just the car turning.
      const onRed = still || sirenOn(elapsed);
      red.visible = onRed;
      blue.visible = !onRed;
      syncLights();
      renderer.render(scene, camera);
    },
  };
}

/**
 * @param lights  {sun, hemi} — the city's own rig, mirrored into the avatar as the coach's is
 */
export function createRadio({ lights }) {
  const root = document.getElementById('radio');
  const idle = { state: { open: false }, show: () => {}, update: () => {} };
  if (!root) return idle;

  const avatarSlot = root.querySelector('.radio-avatar');
  root.querySelector('.radio-line').textContent = RADIO_LINE;

  // Built on the first robbery rather than at boot. Most runs never meet one, and a WebGL context
  // nobody looks at is still one of the browser's small budget of them.
  let avatar = null;
  const state = { open: false, left: 0, elapsed: 0 };
  let closing = null;

  function hide() {
    if (!state.open) return;
    state.open = false;
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    closing = setTimeout(() => {
      root.hidden = true;
      root.classList.remove('is-closing');
      closing = null;
    }, CLOSE_MS);
  }

  return {
    state,
    /** The robber is in the car. */
    show() {
      if (!avatar) {
        avatar = createAvatar(lights.sun, lights.hemi);
        avatarSlot.appendChild(avatar.canvas);
      }
      if (closing) { clearTimeout(closing); closing = null; }
      state.open = true;
      state.left = RADIO_LINGER;
      state.elapsed = 0;
      avatar.render(0);
      root.hidden = false;
      root.classList.remove('is-closing');
      // One frame of the closed state first, or the transition has nothing to run from — the same
      // reflow the coach bubble uses.
      void root.offsetWidth;
      root.classList.add('is-open');
    },
    /** Game time, so a pause holds the bubble; a run that ends takes it down at once. */
    update(dt, { over = false } = {}) {
      if (!state.open) return;
      if (over) { hide(); return; }
      state.elapsed += dt;
      avatar.render(state.elapsed);
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
