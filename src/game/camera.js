import * as THREE from 'three';
import { HALF_SPAN } from '../city/grid.js';

// Classic 3/4 sim camera: a fixed orthographic view looking down a diagonal. Orthographic rather
// than perspective is what makes it read as a city *sim* — parallel lines stay parallel, so
// blocks at the far edge look the same size as blocks under the cursor.

// Exported because anything that has to *face* this camera needs the same number. The view never
// rotates — only the target and the zoom move — so a billboard is a constant orientation computed
// once from this, not a per-frame lookAt.
export const VIEW_DIR = new THREE.Vector3(1, 0.92, 1).normalize();
const DISTANCE = 400;

// Screen right is world (+X, -Z) for this view direction; screen up is (-X, -Z).
const RIGHT = new THREE.Vector3(1, 0, -1).normalize();
const UP = new THREE.Vector3(-1, 0, -1).normalize();

// A one-shot pan to a point that isn't moving — a tap on a rider-finder chip — as opposed to the
// two follow-cams, which chase a car. Different problem, different curve. Exponential smoothing has
// no ease *in*: it leaves at its highest speed on the very first frame, which is right when you are
// closing a gap that keeps reopening, and reads as most of a snap when you start from a dead stop.
//
// Duration is driven by distance so a hop to the next block and a cross-town pan both travel at a
// legible speed, clamped at both ends: under the floor a short pan is a snap again, and over the
// ceiling the player is watching the camera travel with a fare's clock draining.
const GLIDE_SPEED = 150;        // world units per second, averaged over the move
const GLIDE_MIN_TIME = 0.32;
const GLIDE_MAX_TIME = 0.75;
// Below this the camera is already there and a tween would only add a frame of nothing.
const GLIDE_EPSILON = 0.05;

// Smootherstep. Zero *velocity* and zero *acceleration* at both ends, where plain smoothstep only
// zeroes velocity — with a move this short the kink at the start of a smoothstep is still visible
// as a flick, and the whole point of the pan is that the eye can ride it all the way across.
const smootherstep = (k) => k * k * k * (k * (k * 6 - 15) + 10);

export function createCityCamera(aspect, { zoom = 46, target = [0, 0] } = {}) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1400);
  const state = {
    zoom,                       // half-height of the view frustum, in world units
    target: new THREE.Vector3(target[0], 0, target[1]),
    // Current shake magnitude, in world units. Non-zero means apply() jitters camera.position by
    // ±this on each axis before lookAt. Decayed each frame from main.js via updateShake().
    shake: 0,
  };

  // In-flight glide, or null when idle. Held here rather than on `state` because nothing outside
  // reads it — the getters below are the whole interface.
  let glide = null;

  function apply(aspectRatio) {
    const halfH = state.zoom;
    const halfW = halfH * aspectRatio;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();

    camera.position.copy(state.target).addScaledVector(VIEW_DIR, DISTANCE);
    if (state.shake > 0.001) {
      camera.position.x += (Math.random() * 2 - 1) * state.shake;
      camera.position.y += (Math.random() * 2 - 1) * state.shake;
      camera.position.z += (Math.random() * 2 - 1) * state.shake;
    }
    camera.lookAt(state.target);
  }

  apply(aspect);

  return {
    camera,
    state,
    resize: (aspectRatio) => apply(aspectRatio),
    update: (aspectRatio) => apply(aspectRatio),
    /**
     * Kick a new shake, in world units of amplitude. Takes the max of the existing shake and the
     * new value so a bigger impact can override a still-decaying smaller one, but a tiny
     * secondary hit can't cancel the big one.
     */
    kickShake(amplitude) {
      state.shake = Math.max(state.shake, amplitude);
    },
    /**
     * Decay the shake and repaint the camera. Called every frame from main.js so a running shake
     * refreshes independent of any pan/follow. Exponential decay reads as a natural fall-off
     * rather than a hard cut, and the low-threshold snap-to-zero avoids repainting forever.
     */
    updateShake(dt, aspectRatio) {
      if (state.shake <= 0.001) return;
      state.shake *= Math.exp(-dt * 5);
      if (state.shake < 0.01) state.shake = 0;
      apply(aspectRatio);
    },
    /**
     * Ease the camera target toward `(x, z)`. Framerate-independent: `smoothing` is a per-second
     * rate, so `1 - exp(-dt * smoothing)` is the fraction closed each frame. Higher = snappier.
     * Callers hold their own gate on when to follow (e.g. only while boost is active); this just
     * does the one step and leaves the state alone otherwise, so releasing the gate stops the
     * chase without any rubber-band back.
     */
    followXZ(x, z, dt, smoothing = 3.2, aspectRatio) {
      glide = null;             // a chase outranks a pan; see cancelGlide
      const t = 1 - Math.exp(-dt * smoothing);
      state.target.x += (x - state.target.x) * t;
      state.target.z += (z - state.target.z) * t;
      state.target.x = THREE.MathUtils.clamp(state.target.x, -HALF_SPAN, HALF_SPAN);
      state.target.z = THREE.MathUtils.clamp(state.target.z, -HALF_SPAN, HALF_SPAN);
      apply(aspectRatio);
    },
    /**
     * Ease target and zoom toward a fixed focus point — for cinematic beats like the wreck close-up
     * where both the framing *and* the zoom level need to change together. Same rate on both so a
     * caller can just keep calling it every frame and know they'll converge in step.
     */
    focusOn(x, z, targetZoom, dt, aspectRatio, smoothing = 2.4) {
      glide = null;             // as followXZ: whoever is easing the camera now owns it
      const t = 1 - Math.exp(-dt * smoothing);
      state.target.x += (x - state.target.x) * t;
      state.target.z += (z - state.target.z) * t;
      state.zoom += (targetZoom - state.zoom) * t;
      apply(aspectRatio);
    },
    /**
     * Start an eased pan to `(x, z)` — see GLIDE_SPEED above for why this is a fixed-duration
     * tween rather than the exponential ease the follows use. The start point is wherever the
     * camera is *now*, so a second call mid-flight redirects from there rather than snapping back
     * to the first call's origin — and its duration comes from that shorter remaining distance.
     */
    glideTo(x, z) {
      const toX = THREE.MathUtils.clamp(x, -HALF_SPAN, HALF_SPAN);
      const toZ = THREE.MathUtils.clamp(z, -HALF_SPAN, HALF_SPAN);
      const fromX = state.target.x;
      const fromZ = state.target.z;
      const dist = Math.hypot(toX - fromX, toZ - fromZ);
      if (dist < GLIDE_EPSILON) { glide = null; return; }
      glide = {
        fromX, fromZ, toX, toZ, t: 0,
        dur: THREE.MathUtils.clamp(dist / GLIDE_SPEED, GLIDE_MIN_TIME, GLIDE_MAX_TIME),
      };
    },
    /**
     * Abandon a glide where it stands. The player grabbing the map mid-pan has to win immediately —
     * a tween still writing the target every frame would drag the city back out from under their
     * finger. Deliberately leaves the camera where it got to, like every other handover here.
     */
    cancelGlide() { glide = null; },
    isGliding: () => glide !== null,
    /**
     * Step a running glide. Returns true on every frame it moved the camera, including the frame it
     * lands on, so a caller can tell "the pan owns this frame" from "nothing to do". A no-op when
     * idle, which is what lets main.js call it unconditionally.
     */
    updateGlide(dt, aspectRatio) {
      if (!glide) return false;
      glide.t = Math.min(glide.t + dt, glide.dur);
      const e = smootherstep(glide.t / glide.dur);
      state.target.x = glide.fromX + (glide.toX - glide.fromX) * e;
      state.target.z = glide.fromZ + (glide.toZ - glide.fromZ) * e;
      apply(aspectRatio);
      // Retired on the clock, not on the distance left: smootherstep's tail is flat, so a
      // "close enough" test would cut the last few frames — the gentlest part of the whole move.
      if (glide.t >= glide.dur) glide = null;
      return true;
    },
  };
}

// A press has to smear a few pixels before it counts as a drag. Below this it is still a tap, and
// the camera must not creep — on a phone every selection lands with 2-4px of finger travel, and a
// camera that answers all of it means the map slides a little every time you pick a fare.
const PAN_SLOP = 8;

// Panning stops with a corner of the city centred. Further than that and the whole map can be
// pushed off screen, which on a phone is unrecoverable without a landmark to steer back by.
const PAN_LIMIT = HALF_SPAN;

/**
 * Drag to pan, tap to pick.
 *
 * The camera was fixed on purpose — with the whole city in frame there is nothing to pan *to*, and
 * a pointerdown bound to dragging is exactly what fought tap-to-select in `city-lab`. A phone
 * breaks the premise: in portrait the frustum is sized by height, so the city runs off both sides
 * and half the fares spawn where you cannot see, let alone tap them.
 *
 * So panning is back, but gated on the slop above rather than on pointerdown, and it reports
 * whether the gesture became a drag so the picker can ignore the click that follows one. Callers
 * can pass `isEnabled` to disable panning on wide viewports where the whole city already fits —
 * kept as a live check so a resize re-enables it without a reload.
 *
 * `onPan` fires once per gesture, on the frame it crosses the slop. It is how the opening
 * follow-cam knows the player has taken the framing over — a swipe is the player saying they want
 * to look somewhere, and nothing should drag them back off it.
 */
export function attachDragPan(controller, domElement, getAspect, isEnabled = () => true,
  onPan = () => {}) {
  let drag = null;
  let panned = false;

  function panBy(right, up) {
    // A finger on the map beats a pan already in flight. Cancelled here rather than from the
    // `onPan` handover callback so it holds for every caller of panBy, not just the drag that
    // happens to cross the slop.
    controller.cancelGlide();
    const target = controller.state.target;
    target.addScaledVector(RIGHT, right).addScaledVector(UP, up);
    target.x = THREE.MathUtils.clamp(target.x, -PAN_LIMIT, PAN_LIMIT);
    target.z = THREE.MathUtils.clamp(target.z, -PAN_LIMIT, PAN_LIMIT);
    controller.update(getAspect());
  }

  domElement.addEventListener('pointerdown', (event) => {
    // Single finger only. A second touch belongs to a pinch, and feeding it into the same
    // drag makes the map jump to wherever that finger landed.
    if (!event.isPrimary) return;
    if (!isEnabled()) return;
    drag = { x: event.clientX, y: event.clientY, moved: 0 };
    panned = false;
    domElement.setPointerCapture(event.pointerId);
  });

  const release = () => { drag = null; };
  domElement.addEventListener('pointerup', release);
  domElement.addEventListener('pointercancel', release);

  domElement.addEventListener('pointermove', (event) => {
    if (!drag || !event.isPrimary) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.hypot(dx, dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.moved < PAN_SLOP) return;

    // First frame past the slop is the moment the gesture becomes a drag; `panned` is reset on
    // every pointerdown, so this is once per gesture rather than once per move event.
    if (!panned) onPan();
    panned = true;
    // World units per pixel falls straight out of the orthographic frustum: its height is
    // exactly 2 * zoom, whatever the aspect ratio. Vertical isn't drag-the-map: swipe up pans
    // the camera up (revealing what's above), swipe down pans it down — on a phone this reads
    // as "scroll to see more" rather than shoving the ground around.
    const scale = (controller.state.zoom * 2) / domElement.clientHeight;
    panBy(-dx * scale, dy * scale);
  });

  return {
    /**
     * True if the gesture that just ended was a drag. Stays true until the next pointerdown, which
     * is long enough to cover the `click` the browser synthesises after a mouse drag — a drag that
     * ends over a fare must not also route the taxi at it.
     */
    didPan: () => panned,
    panBy,
  };
}

/** Pan with WASD/arrows, zoom on the wheel. Pans along screen axes, not world axes. */
export function attachCameraControls(controller, domElement, getAspect) {
  const keys = new Set();
  const PAN_SPEED = 60;
  const MIN_ZOOM = 14;
  const MAX_ZOOM = 150;

  const onKey = (down) => (event) => {
    const code = event.code;
    if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(code)) return;
    down ? keys.add(code) : keys.delete(code);
    if (code.startsWith('Arrow')) event.preventDefault();
  };

  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => keys.clear());

  domElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0012);
    controller.state.zoom = THREE.MathUtils.clamp(controller.state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    controller.update(getAspect());
  }, { passive: false });

  // Drag to pan, in the same screen-relative frame as the keys.
  let dragging = null;
  domElement.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY };
    domElement.setPointerCapture(event.pointerId);
  });
  domElement.addEventListener('pointerup', () => { dragging = null; });
  domElement.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY };

    const scale = (controller.state.zoom * 2) / domElement.clientHeight;
    panBy(-dx * scale, -dy * scale);
  });

  function panBy(right, up) {
    controller.state.target.addScaledVector(RIGHT, right);
    controller.state.target.addScaledVector(UP, up);
  }

  return function updateControls(dt) {
    let right = 0;
    let up = 0;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) up += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) up -= 1;

    if (right || up) {
      const speed = PAN_SPEED * dt * (controller.state.zoom / 46);
      panBy(right * speed, up * speed);
    }
    controller.update(getAspect());
  };
}
