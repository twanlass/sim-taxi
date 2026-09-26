import * as THREE from 'three';
import { createPerson } from '../geometry/person.js';
import { mirrorSceneLights } from './avatarlights.js';
import { createBubble, POOL_CLEAR, POOL_EDGE } from './tutorial.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// The robber's line: the beat between the robber getting in and the police turning up.
//
// A robbery used to go straight from a drive-past to four cop cars and a radio call on the same
// frame, which is the whole event arriving at once while the player was looking at something else.
// It read as traffic changing colour rather than as the game changing mode. So the event now has a
// setup, in three beats:
//
//   1. The robber is in the car. **The world stops**, the city dims around the taxi, and the robber
//      shouts at the driver from a bubble at the bottom — the coach's card and the coach's place,
//      with the robber in the avatar where the taxi would be.
//   2. The next tap anywhere clears it. The lights come up and the police come on (`raiseAlarm` in
//      game/robbery.js).
//   3. A beat later, dispatch breaks in from the top (game/radio.js).
//
// **The world stops rather than runs on under it**, and that is the one decision in here that was
// weighed. The tutorial's gated beats let the traffic run, but they are at the top of a run with the
// clocks held and nothing chasing anyone. This one lands mid-run, with the taxi moving and a clock
// that matters about to start — a bubble that waited for a tap over a live city would either eat a
// routing tap the player meant for the road or let the getaway start behind it. Frozen, the tap has
// one meaning and nothing is lost while the line is read. main.js does the freezing, exactly as the
// pause does it: an early return from `frame()` that still draws.
//
// Its own element and its own pool rather than the tutorial's `#coach` and `#spotlight`: the
// tutorial's Loco Mode beat can be mid-showing when a robbery lands, and two owners of one element
// is a bubble that closes the other's line. `body.robber-talk` hides the coach while this is up.

/** What the robber shouts. One per robbery, drawn off the run's own seed. */
export const ROBBER_LINES = [
  'Get me outta here!!!',
  "LET'S GO! COPS ARE EVERYWHERE!",
  'Drive! DRIVE! Step on it!',
  "Don't just sit there — floor it!",
];

// The avatar box, in CSS pixels: the coach's taxi square, so the two bubbles are one family.
const AVATAR_PX = 54;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The robber in the bubble: the real `createPerson` in the real kit (`setRobber`), so the figure
 * that shouts is the one that just ran down the bank's steps. Waving, since that is the pose that
 * already means "you, taxi" — with a sack in the other hand it reads as a demand rather than a hail.
 *
 * Framed on the rider-finder chip's camera (game/riderfinder.js), trimmed to a square: ±2.0 across
 * and −1.45 to +2.55 up the view, which puts the ground on the bottom edge and the top edge at world
 * y ≈ 4.2 — over the cap (3.4) and the raised hand, with no crystal to make room for.
 */
function createRobberAvatar(sun, hemi) {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(AVATAR_PX, AVATAR_PX, false);
  canvas.style.width = `${AVATAR_PX}px`;
  canvas.style.height = `${AVATAR_PX}px`;

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);
  const person = createPerson({ pickable: null });
  person.setRobber(true);
  scene.add(person.group);

  const camera = new THREE.OrthographicCamera(-2.0, 2.0, 2.55, -1.45, 0.1, 40);
  camera.position.set(0, 3.2, 4.9);
  camera.lookAt(0, 1.55, 0);

  return {
    canvas,
    render(elapsed) {
      person.wave(prefersReducedMotion() ? 0 : elapsed * 1.6);
      syncLights();
      renderer.render(scene, camera);
    },
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  };
}

/**
 * @param lights        {sun, hemi} — the city's own rig, mirrored into the avatar
 * @param taxi          the player's car, which the pool is centred on
 * @param project       (x, y, z) => {x, y} — world to viewport pixels
 * @param pixelsPerUnit () => number — the camera's current scale, for sizing the pool
 * @param pickLine      () => string — which line this robbery gets
 * @param onDone        () => void — the bubble has been dismissed: raise the alarm
 */
export function createRobberLine({ lights, taxi, project, pixelsPerUnit, pickLine, onDone }) {
  const root = document.getElementById('robber-talk');
  const spot = document.getElementById('robber-spot');
  const idle = { isOpen: () => false, open: () => false, update: () => {}, cancel: () => {} };
  if (!root || !spot) return idle;

  // Built on the first robbery rather than at boot, as the radio's is: most runs never meet one,
  // and a WebGL context nobody looks at is still one of the browser's small budget of them.
  let bubble = null;
  let open = false;
  let elapsed = 0;

  function aim() {
    // 1.4 up, the middle of the car's flank — the tutorial's own aim.
    const p = project(taxi.x, 1.4, taxi.z);
    const px = pixelsPerUnit();
    spot.style.setProperty('--sx', `${p.x.toFixed(0)}px`);
    spot.style.setProperty('--sy', `${p.y.toFixed(0)}px`);
    spot.style.setProperty('--r0', `${(POOL_CLEAR * px).toFixed(0)}px`);
    spot.style.setProperty('--r1', `${(POOL_EDGE * px).toFixed(0)}px`);
  }

  function close() {
    if (!open) return;
    open = false;
    bubble.hide();
    document.body.classList.remove('robber-talk');
    onDone();
  }

  // The element is a full-screen catcher while it is up (`body.robber-talk #robber-talk` in
  // index.html), so a tap anywhere lands here and not on the canvas: the route drag and the picker
  // both only take presses whose target *is* the canvas. `click` rather than `pointerdown`, so the
  // catcher is still there for the click that follows the press and nothing falls through to the
  // city on the way out.
  root.addEventListener('click', () => { if (open) bubble.tap(); });
  // Space and Enter answer it too. Space is also the Loco Mode key, whose own handler is registered
  // first and stands down while this is open (main.js), so the press that clears the bubble does
  // not also floor it.
  window.addEventListener('keydown', (event) => {
    if (!open || event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return;
    event.preventDefault();
    bubble.tap();
  });

  return {
    isOpen: () => open,
    /** The robber is in the car: stop, dim, shout. */
    open() {
      if (open) return false;
      if (!bubble) {
        const avatar = createRobberAvatar(lights.sun, lights.hemi);
        bubble = createBubble(root, lights, close, avatar);
      }
      open = true;
      elapsed = 0;
      // Aimed before the fade, or the pool blooms from wherever it was last left.
      aim();
      document.body.classList.add('robber-talk');
      bubble.show(pickLine());
      return true;
    },
    /** Wall time: the world is stopped while this is up, so there is no game time to read. */
    update(dt) {
      if (!open) return;
      elapsed += dt;
      bubble.update(dt, elapsed);
      // Re-aimed every frame for a resize or a rotation — the city does not move under it.
      aim();
    },
    /** The run ended under it. Clear without raising anything. */
    cancel() {
      if (!open) return;
      open = false;
      bubble.hide();
      document.body.classList.remove('robber-talk');
    },
  };
}
