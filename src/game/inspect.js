import * as THREE from 'three';
import { RIGHT, UP } from './camera.js';

// Inspect mode — freeze the world and put the camera on a leash for looking at things close up.
// Behind `?debug`, for tuning the vehicle finishes (util/geo.js) and anything else that is a few
// pixels across at play zoom.
//
// **A freeze, not the pause.** The pause button stops the loop the same way, but it puts a veil
// over the whole city, which is the one thing a tuning session cannot have. Here `main.js` returns
// out of `frame()` before any `update()` exactly as it does for the pause — traffic, signals, fare
// clocks, daylight all hold — and draws the frame with nothing over it. The panel's sliders still
// land, because the finishes, the sun and the haze are uniforms and lights that the next render
// reads, not state the loop has to advance.
//
// **The camera is this module's while it is on.** The follow, the drag-pan and the boost chase
// all run inside the frame loop, which is not running, so nothing else is fighting for it. Input is
// taken on `window` in the capture phase, which is the only listener order that beats a listener
// on the canvas itself regardless of construction order (CLAUDE.md, on `attachDragPan`) — and it
// is swallowed there, so a drag to pan cannot also land as a tap that routes the taxi.
//
// **It puts the camera back on the way out**, zoom and target both: tuning should not cost the
// player their framing.

// The closest the camera goes: a frustum half-height of 2.5 units puts a 3.4-unit car across most
// of a phone's width. The game's own wheel zoom stops at 14, where a car is still ~30px long.
const MIN_ZOOM = 2.5;
const MAX_ZOOM = 150;
// Where it lands on the way in. 7 is close enough to read a hubcap, far enough to see the road
// and the façades the car is reflecting.
const ENTER_ZOOM = 7;

/**
 * @param controller  the city camera (game/camera.js)
 * @param canvas      the renderer's canvas — input on anything else (the panel) is left alone
 * @param aspect      () => viewport aspect ratio
 * @param focusables  () => [{ x, z }] the things "Next car" cycles through; the first is the taxi
 */
export function createInspect({ controller, canvas, aspect, focusables, onChange = () => {} }) {
  const state = { on: false };
  let saved = null;
  const pointers = new Map();
  let pinch = null;
  let focusIndex = 0;

  const zoomTo = (zoom) => {
    controller.state.zoom = THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    controller.update(aspect());
  };

  const panPixels = (dx, dy) => {
    const scale = (controller.state.zoom * 2) / canvas.clientHeight;
    controller.state.target.addScaledVector(RIGHT, -dx * scale);
    controller.state.target.addScaledVector(UP, dy * scale);
    controller.update(aspect());
  };

  function lookAt(index) {
    const list = focusables();
    if (!list.length) return;
    focusIndex = ((index % list.length) + list.length) % list.length;
    const { x, z } = list[focusIndex];
    controller.state.target.set(x, 0, z);
    controller.update(aspect());
  }

  function set(on) {
    if (on === state.on) return;
    state.on = on;
    if (on) {
      saved = {
        zoom: controller.state.zoom,
        punch: controller.state.punch,
        target: controller.state.target.clone(),
      };
      // Loco Mode's push-in is a multiplier on the zoom; held at 1 so the slider reads what it says.
      controller.state.punch = 1;
      controller.state.shake = 0;
      zoomTo(ENTER_ZOOM);
      lookAt(0);
    } else {
      pointers.clear();
      pinch = null;
      controller.state.zoom = saved.zoom;
      controller.state.punch = saved.punch;
      controller.state.target.copy(saved.target);
      controller.update(aspect());
    }
    onChange(on);
  }

  // Only events on the canvas: the panel, its sliders and the HUD keep working while frozen.
  const mine = (event) => state.on && event.target === canvas;
  const swallow = (event) => {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  };

  window.addEventListener('wheel', (event) => {
    if (!mine(event)) return;
    swallow(event);
    zoomTo(controller.state.zoom * Math.exp(event.deltaY * 0.0015));
  }, { capture: true, passive: false });

  window.addEventListener('pointerdown', (event) => {
    if (!mine(event)) return;
    swallow(event);
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: controller.state.zoom };
    }
  }, { capture: true });

  window.addEventListener('pointermove', (event) => {
    if (!state.on || !pointers.has(event.pointerId)) return;
    swallow(event);
    const last = pointers.get(event.pointerId);
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) zoomTo(pinch.zoom * (pinch.dist / dist));
    } else if (pointers.size === 1) {
      panPixels(now.x - last.x, now.y - last.y);
    }
  }, { capture: true });

  const lift = (event) => {
    if (!pointers.has(event.pointerId)) return;
    if (state.on) swallow(event);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  window.addEventListener('pointerup', lift, { capture: true });
  window.addEventListener('pointercancel', lift, { capture: true });

  // iOS runs its own pinch-zoom and selection off the raw touch stream (CLAUDE.md, on the Loco pill),
  // so the canvas's touches are stopped there too while inspecting.
  window.addEventListener('touchstart', (event) => {
    if (mine(event)) swallow(event);
  }, { capture: true, passive: false });
  window.addEventListener('click', (event) => {
    if (mine(event)) swallow(event);
  }, { capture: true });

  // I toggles; + and - zoom; N steps to the next car. Ignored while typing in a field.
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code === 'KeyI' && !event.repeat) { set(!state.on); return; }
    if (!state.on) return;
    if (event.key === '+' || event.key === '=') zoomTo(controller.state.zoom / 1.25);
    else if (event.key === '-' || event.key === '_') zoomTo(controller.state.zoom * 1.25);
    else if (event.code === 'KeyN') lookAt(focusIndex + 1);
  });

  return {
    state,
    set,
    toggle: () => set(!state.on),
    /** Centre on the taxi. */
    focusTaxi: () => lookAt(0),
    /** Centre on the next vehicle in `focusables()`. */
    nextCar: () => lookAt(focusIndex + 1),
    zoomIn: () => zoomTo(controller.state.zoom / 1.25),
    zoomOut: () => zoomTo(controller.state.zoom * 1.25),
    zoom: () => controller.state.zoom,
  };
}
