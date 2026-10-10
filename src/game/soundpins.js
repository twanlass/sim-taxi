import { attachQuickTips } from './quicktips.js';

// A 🔊 pin over every placed sound on the map, in debug mode: tap one and the ⚙️ panel opens on that
// sound's controls (`showSound` in game/debugpanel.js), with its falloff rings on the ground
// (game/soundrings.js). It answers "what is that I can hear, and where are its knobs" without
// knowing the sound's name first.
//
// DOM rather than geometry, for the reason game/copshout.js gives: it has to be read and clicked,
// and the scene has no font. Each pin follows its point by projecting it through the live camera
// every frame. Sounds that share a spot (a flock's take-off and landing) share a pin, with a chip
// for each, so neither hides under the other.

/** Points closer than this in world units are one pin. */
const MERGE = 1.5;

/**
 * @param {object} opts
 * @param {(x: number, y: number, z: number) => {x: number, y: number}} opts.project  World to viewport pixels.
 * @param {() => {width: () => number, height: () => number}} [opts.viewport]
 * @param {(key: string) => void} opts.onPick
 * @param {(clientX: number, clientY: number) => {x: number, z: number}|null} [opts.groundAt]
 *   Viewport pixels to the ground under them — what the ring handles drag across.
 * @param {(key: string, part: 'near'|'far', radius: number, done: boolean) => void} [opts.onResize]
 */
export function createSoundPins({ project, viewport, onPick, groundAt = () => null, onResize = () => {} }) {
  const layer = document.createElement('div');
  layer.id = 'sound-pins';
  document.body.append(layer);
  attachQuickTips(layer);
  const pool = [];
  // The listener: the point every placed sound is measured from (`placeAt` in main.js), over the
  // white dot game/soundrings.js draws there.
  const ear = Object.assign(document.createElement('div'), { className: 'sound-ear', textContent: '👂' });
  ear.title = 'Listener: placed sounds are heard from here';
  layer.append(ear);

  // The selected sound's two ring handles: drag one and that radius follows the finger, measured
  // on the ground from the source, so the circle under it is the one the slider would draw. On the
  // ring's screen-right edge, which a fixed camera keeps clear of the ring's own pin.
  let target = null;     // { key, x, z } — the source the handles belong to this frame
  const handles = {};
  for (const part of ['near', 'far']) {
    const h = document.createElement('div');
    h.className = `sound-handle sound-handle-${part}`;
    h.title = part === 'near' ? 'Drag: full within' : 'Drag: silent past';
    let drag = null;
    h.addEventListener('pointerdown', (event) => {
      if (!target) return;
      event.stopPropagation();
      event.preventDefault();
      drag = { key: target.key, x: target.x, z: target.z };
      try { h.setPointerCapture(event.pointerId); } catch { /* a synthetic press has no pointer */ }
    });
    const radiusAt = (event) => {
      const g = groundAt(event.clientX, event.clientY);
      return g ? Math.round(Math.hypot(g.x - drag.x, g.z - drag.z)) : null;
    };
    h.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const r = radiusAt(event);
      if (r != null) onResize(drag.key, part, r, false);
    });
    const end = (event) => {
      if (!drag) return;
      const r = radiusAt(event);
      onResize(drag.key, part, r ?? 0, true);
      drag = null;
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', () => { drag = null; });
    layer.append(h);
    handles[part] = h;
  }

  function pin(n) {
    while (pool.length <= n) {
      const el = document.createElement('div');
      el.className = 'sound-pin';
      el.append(Object.assign(document.createElement('span'), { className: 'sound-pin-icon', textContent: '🔊' }));
      // The game reads presses on `window` (the route-band drag, the audio unlock) and on the
      // canvas; a press on a pin is the pin's.
      el.addEventListener('pointerdown', (event) => event.stopPropagation());
      layer.append(el);
      pool.push({ el, chips: [], keys: '' });
    }
    return pool[n];
  }

  /**
   * @param {boolean} on  Debug mode, and nothing covering the map.
   * @param {{key: string, x: number, z: number, y?: number}[]} sources
   * @param {string|null} focused  The sound selected in the panel, drawn lit.
   * @param {{x: number, z: number}|null} listener  Where the 👂 goes, or null to hide it.
   * @param {{key: string, x: number, z: number, near: number, far: number, right: {x: number, z: number}}|null} [rings]
   *   The selected sound's source, its falloff, and the ground direction that is screen-right.
   */
  function update(on, sources, focused, listener = null, rings = null) {
    layer.hidden = !on;
    if (!on) return;
    target = rings;
    for (const part of ['near', 'far']) {
      const h = handles[part];
      h.hidden = !rings;
      if (!rings) continue;
      const r = rings[part];
      const at = project(rings.x + rings.right.x * r, 0.3, rings.z + rings.right.z * r);
      h.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    ear.hidden = !listener;
    if (listener) {
      const at = project(listener.x, 0.3, listener.z);
      ear.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    const spots = [];
    for (const s of sources) {
      const near = spots.find((p) => Math.hypot(p.x - s.x, p.z - s.z) < MERGE);
      if (near) { if (!near.keys.includes(s.key)) near.keys.push(s.key); continue; }
      spots.push({ x: s.x, z: s.z, y: s.y ?? 0, keys: [s.key] });
    }
    const w = viewport?.width() ?? window.innerWidth;
    const h = viewport?.height() ?? window.innerHeight;
    let n = 0;
    for (const spot of spots) {
      const at = project(spot.x, spot.y + 1.5, spot.z);
      if (at.x < -40 || at.x > w + 40 || at.y < -40 || at.y > h + 40) continue;
      const p = pin(n++);
      p.el.hidden = false;
      p.el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%)`;
      const keys = spot.keys.join(' ');
      if (p.keys !== keys) {
        for (const c of p.chips) c.remove();
        p.chips = spot.keys.map((key) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'sound-pin-chip';
          chip.textContent = key;
          chip.dataset.key = key;
          chip.addEventListener('click', (event) => { event.stopPropagation(); onPick(key); });
          p.el.append(chip);
          return chip;
        });
        p.keys = keys;
      }
      for (const c of p.chips) c.classList.toggle('is-focused', c.dataset.key === focused);
    }
    for (let k = n; k < pool.length; k++) pool[k].el.hidden = true;
  }

  return { update };
}
