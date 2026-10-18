/**
 * The ⚙️ panel's 🖥 / 📱 switch: frame a desktop window to what a phone in portrait shows, so a
 * mix tuned at a desk can be heard against the screen it ships on (Tyler, October 2026).
 *
 * **A mask, not a smaller canvas — and that is exact rather than approximate.** The camera's zoom
 * is a frustum *half-height* in world units (game/camera.js), the same on every device, so a phone
 * sees the same height of city a desktop does and only less of it across. A full-height window of a
 * phone's aspect, centred, is therefore precisely the phone's view: centred on the same camera
 * target, which is the 👂 every placed sound is heard from. The canvas, the camera and the sim are
 * untouched, which is the point — nothing about the game behaves differently in the frame.
 *
 * Two things a mask alone would get wrong, and each is a line:
 *
 * - **Pan.** A placed sound is panned by where it lands across the screen (`placeAt` in main.js,
 *   NDC x). Across a desktop's width a sound at the edge of a phone's view is at ±0.25; on the
 *   phone it is at ±1. `panScale()` is what turns one into the other.
 * - **The HUD.** Every pinned HUD element is already inset by `--safe-left` / `--safe-right` (the
 *   notch), so overriding those two on the root pulls the cash, the stars, the pause button and the
 *   rest inside the frame the way a phone would lay them out. The ⚙️ panel itself opts back out
 *   (index.html) — it is the tool, not the game.
 *
 * Debug only: main.js builds this only with the ⚙️ panel. The choice is remembered per browser,
 * soft, the way the panel's open sections are.
 */

// An iPhone 15 / 16 in portrait, in CSS pixels: the common size of the last few years, and the
// aspect (0.46) is shared by every Face ID iPhone to within a couple of percent.
export const PHONE_W = 393;
export const PHONE_H = 852;

const KEY = 'simtaxi.phoneFrame';
const load = () => { try { return globalThis.localStorage?.getItem(KEY) === '1'; } catch { return false; } };
const save = (on) => { try { globalThis.localStorage?.setItem(KEY, on ? '1' : '0'); } catch { /* soft */ } };

export function createPhoneFrame() {
  const mask = document.createElement('div');
  mask.id = 'phone-frame';
  mask.append(document.createElement('div'));
  document.body.append(mask);

  let on = false;
  const switches = [];
  function set(value) {
    on = Boolean(value);
    document.documentElement.classList.toggle('phone-frame', on);
    for (const paint of switches) paint();
    save(on);
  }
  set(load());

  return {
    on: () => on,
    set,
    /**
     * What a placed sound's screen pan has to be multiplied by to read as it would on the phone:
     * the window's width over the frame's. 1 with the frame off, or on a window already narrower
     * than a phone's aspect.
     */
    panScale() {
      if (!on) return 1;
      const w = window.innerWidth;
      const frame = Math.min(w, window.innerHeight * PHONE_W / PHONE_H);
      return frame > 0 ? w / frame : 1;
    },
    /** The 🖥 | 📱 split button, for the ⚙️ panel's header. */
    buildSwitch() {
      const wrap = document.createElement('div');
      wrap.className = 'dbg-device';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Screen');
      const make = (text, value, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', () => set(value));
        wrap.append(b);
        return b;
      };
      const desk = make('🖥', false, 'Desktop: the whole window.');
      const phone = make('📱', true, `Phone: frame the game to a ${PHONE_W}×${PHONE_H} portrait screen, `
        + 'with sounds panned as they would be on it.');
      const paint = () => {
        desk.classList.toggle('is-active', !on);
        phone.classList.toggle('is-active', on);
      };
      switches.push(paint);
      paint();
      return wrap;
    },
  };
}
