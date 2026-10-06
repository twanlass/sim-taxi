/**
 * The pause button — the ⏸ at the top of the HUD, and the screen it puts up.
 *
 * This game is played on a phone, in the gaps: one fare's clock is sixty-odd seconds and a run is
 * fifteen of them, so the interruption that ends a run is almost never a mistake the player made.
 * The button is the answer to that, and it sits in the top *centre* on purpose — between the money
 * counter and the streak, the one piece of the HUD's top edge nothing else was using, and the one
 * spot a thumb of either hand can reach without crossing the city.
 *
 * **The whole loop stops, not just the clocks.** `main.js` returns out of `frame()` before a single
 * `update()` while `state.paused` is set, so the traffic, the signals, the fare deadlines, the
 * daylight and the boost tank are all exactly where they were left. The tutorial's `setPaused` only
 * holds the fare clocks, which is right for a bubble that talks over a city still driving itself;
 * a pause that let the traffic run would put the taxi's own junction under a car that arrived while
 * nobody was looking.
 *
 * **The frame is still drawn.** Skipping the render too would be free while nothing moves, but a
 * resize or a rotation with the overlay up repaints the canvas at the new size from an empty
 * drawing buffer — the city would blink out and stay out until the player resumed. One static
 * render per frame is the cheap way to stay correct through both.
 *
 * **The screen is the title screen's menu**: "Paused" as a small header, then Resume, Settings and
 * Quit as plain white words. Settings is the title screen's own page (game/menupage.js); its Back, or Escape, returns to this menu rather than
 * resuming. Quit is the caller's (`onQuit`) — main.js reloads, which lands back on the title.
 *
 * **Only Resume resumes**, not the rest of the veil — a stray tap while reading the
 * paused screen must not drop the player straight back into traffic. It resumes on `pointerdown`
 * rather than on `click` so the press is what lands: the matching release then falls on the canvas
 * with no `click` synthesised after it — the two ends of the gesture are on different elements —
 * which is what stops the tap that resumes from also dispatching the taxi at whatever it happened
 * to be over. `click` is handled as well, because a keyboard activating the word fires that and
 * nothing else. `setPaused` is idempotent, so a pointer gesture that somehow produced both costs
 * nothing.
 *
 * Escape and P toggle it from a keyboard, which is also what makes the button reachable without a
 * pointer at all.
 */

import { menuPage, settingsRows } from './menupage.js';

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Wire the button and its screen together.
 *
 * `button` is `#pause` and `veil` is `#pause-veil`, both already in the markup — unlike the run-end
 * and Home Screen screens this one is small enough, and shown often enough, that building it from
 * script would only put its layout somewhere the rest of the HUD's isn't.
 *
 * `canPause` is asked before every pause and never before a resume: a state the game refuses to
 * enter must still be one it can leave. `onChange(paused)` fires after each real transition — that
 * is where `main.js` drops a held boost, so a run cannot be paused with the gas still down.
 *
 * Returns `null` when either element is missing (shot mode strips neither, but the lab page has
 * no HUD at all), so the caller can treat "no pause button on this page" as ordinary.
 */
export function createPause({
  button, veil, canPause = () => true, onChange, sound, settings, onQuit,
} = {}) {
  if (!button || !veil) return null;
  const menu = veil.querySelector('.pause-menu');
  const resumeButton = veil.querySelector('.pause-resume');
  const settingsButton = veil.querySelector('.pause-settings');
  const quitButton = veil.querySelector('.pause-quit');
  if (!menu || !resumeButton) return null;

  const state = { paused: false, view: 'menu' };
  let fade = null;

  // Settings is built only when there is a mute and a store to drive; without them (a page that
  // passes neither) the word is simply not offered.
  const settingsPage = sound && settings
    ? menuPage('settings', 'Settings', () => show('menu')) : null;
  const settingsBody = settingsPage
    ? settingsRows(settingsPage.body, { sound, settings }) : null;
  if (settingsPage) veil.append(settingsPage.section);
  else settingsButton?.remove();
  if (!onQuit) quitButton?.remove();

  const views = { menu, settings: settingsPage?.section };

  function show(next) {
    const from = state.view;
    state.view = next;
    for (const [name, node] of Object.entries(views)) {
      if (!node) continue;
      node.hidden = name !== next;
      node.setAttribute('aria-hidden', String(name !== next));
    }
    if (next === 'settings') settingsBody.refresh();
    // Focus follows the view for a keyboard, as on the title screen.
    if (next === 'settings') settingsPage.back.focus({ preventScroll: true });
    else if (from === 'settings') settingsButton?.focus({ preventScroll: true });
  }

  const paint = () => {
    document.body.classList.toggle('is-paused', state.paused);
    button.setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
    button.setAttribute('aria-pressed', String(state.paused));
    veil.setAttribute('aria-hidden', String(!state.paused));
  };

  const showVeil = () => {
    fade?.cancel();
    veil.hidden = false;
    if (stillPlease()) return;
    fade = veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  };

  const hideVeil = () => {
    fade?.cancel();
    if (stillPlease()) { veil.hidden = true; return; }
    fade = veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-in' });
    // Re-checked rather than trusted: a pause landing inside the fade-out has already put the veil
    // back up, and this callback would otherwise take it down a beat later with the game frozen
    // behind nothing at all.
    fade.onfinish = () => { if (!state.paused) veil.hidden = true; };
  };

  const setPaused = (next) => {
    if (next === state.paused) return;
    if (next && !canPause()) return;
    state.paused = next;
    paint();
    // Stops taking taps on the press that resumes, not on the frame after it — see the header for
    // what a veil still holding the pointer would swallow.
    veil.style.pointerEvents = next ? '' : 'none';
    // Every pause opens on the menu, not on whichever page the last one was left on.
    if (next) { show('menu'); showVeil(); } else hideVeil();
    onChange?.(next);
  };

  const toggle = () => setPaused(!state.paused);

  button.addEventListener('click', toggle);
  resumeButton.addEventListener('pointerdown', () => setPaused(false));
  resumeButton.addEventListener('click', () => setPaused(false));
  settingsButton?.addEventListener('click', () => show('settings'));
  quitButton?.addEventListener('click', () => onQuit?.());
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' && event.key !== 'p' && event.key !== 'P') return;
    // Not while typing initials into the run-end screen, where P is a letter.
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    // Escape walks back out of Settings first; P is a toggle wherever it is pressed.
    if (state.paused && event.key === 'Escape' && state.view !== 'menu') { show('menu'); return; }
    toggle();
  });

  paint();
  show('menu');

  return { state, toggle, setPaused, show };
}
