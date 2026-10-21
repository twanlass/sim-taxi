/**
 * The title screen: Play, Settings, Credits, over the live city with the camera drifting across it.
 *
 * **It parks the run, the way the Home Screen tip does** (game/homescreen.js), and main.js reads
 * the same kind of flag: while `holding()` is true the fare board is not seeded, the tutorial and
 * the opening vignette are held, the city's entrance wave is *settled* rather than played (the
 * menu sits over a finished city, not a street grid filling itself in), and the HUD stays off.
 * Traffic keeps driving — the whole point of the backdrop is the sim running in it. Play lets go of
 * all of that at once, so what follows is exactly the run that used to start on load: the camera
 * goes down to the garage door, the door rolls up, the taxi drives out, the tips start talking.
 *
 * The camera is not driven from here. `panAt(t)` says where the drift is at `t` seconds and main.js
 * puts it at the top of its priority list, so the list stays the one place the framing is decided.
 *
 * Three views share one overlay: the menu, Settings and Credits. The two sub-pages dim the city
 * behind a mask (`.title-scrim`) because they are lists to be read; the menu does not, because it
 * is three words and the city is the show.
 *
 * Sound on/off is the existing mute (sfx.js, shared with the pause screen's Settings and the M key) —
 * see game/settings.js for why it is not stored twice.
 */

import { HALF_SPAN_X, HALF_SPAN_Z } from '../city/grid.js';
import { createClaudeMark } from './creditegg.js';
import { el, menuPage, settingsRows } from './menupage.js';

/** Seconds per lap of the drift. Slow on purpose: ~1 world unit a second is a stroll, not a tour. */
export const PAN_PERIOD = 120;
/**
 * How tight the backdrop is framed — the frustum's half-height, against PLAY_ZOOM's 52. Close
 * enough that the traffic reads as cars doing things rather than as a map, far enough that a
 * block or two is always in frame round the menu.
 */
export const PAN_ZOOM = 34;
/** The lap's radii, as fractions of each half-span — the drift stays over buildings, not the sea. */
const PAN_RX = 0.3;
const PAN_RZ = 0.3;

/**
 * Where the drift is at `t` seconds: a slow ellipse round the middle of the city. An ellipse rather
 * than a back-and-forth so the motion never stops and turns, which reads as a camera *move*, and
 * the ratio of the radii follows the map's own (it is a block row taller than it is wide).
 */
export function panAt(t) {
  const a = (t / PAN_PERIOD) * Math.PI * 2;
  return { x: Math.cos(a) * HALF_SPAN_X * PAN_RX, z: Math.sin(a) * HALF_SPAN_Z * PAN_RZ, zoom: PAN_ZOOM };
}

export const CREDITS = [
  ['Game design', 'Tyler, Nia, and Isla Wanlass'],
  ['Art direction', 'Tyler Wanlass'],
  ['Music + sound design', 'Nicolás J. Infantas Jamett'],
  ['Programming', 'Claude', 'claude'],
];

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The way in, in three beats (Tyler, 2026-10-21): the city fades up out of black a little out of
 * focus, the menu fades in over it, then the city sharpens. `?titleintro=classic` is the screen as
 * it was, menu and city both there the moment the black lifts.
 *
 * **The blur is a CSS filter on the city's canvas, and only for the intro.** It is the cheapest
 * blur there is to get: no extra render pass and no second copy of the frame, just the compositor
 * running a Gaussian over the canvas layer — but it runs on *every* frame the city draws while the
 * filter is set, at full device resolution, so it is set for the ~3 s of the intro and then taken
 * off the element entirely. Not left at `blur(0px)`: WebKit can keep a filtered layer for a zero
 * blur. The canvas is scaled up a little under the blur so the blur's edge, which samples in from
 * outside the canvas, falls off-screen rather than drawing a pale rim, and settles to 1 as it
 * sharpens.
 *
 * The timeline starts when the page's black lifts (`html.booting` coming off — game/splash.js does
 * that when the startup screen is gone, src/boot.js when there is none). The startup screen's own
 * fade is the first beat: the city is held behind it, already blurred, so its fade *is* the city
 * fading up. Without one there is nothing to fade from but the cut off black, so the title brings
 * its own veil (`title-cold`).
 */
export const INTRO = {
  /** Without the startup screen, the city's fade up out of black. */
  veil: 0.6,
  /** A beat on the blurred city before the menu, then the menu's fade. */
  menuAt: 0.25,
  menu: 0.6,
  /** The blur starts clearing once the menu is most of the way in, and takes this long — slow on
   *  purpose: at 1.2 s (the first cut) Tyler found it snapped into focus. */
  focusAt: 0.75,
  focus: 2.4,
};

function playIntro(cold) {
  const html = document.documentElement;
  const lead = cold ? INTRO.veil : 0;
  html.style.setProperty('--intro-menu-at', `${lead + INTRO.menuAt}s`);
  html.style.setProperty('--intro-focus-at', `${lead + INTRO.focusAt}s`);
  html.style.setProperty('--intro-veil', `${INTRO.veil}s`);
  html.style.setProperty('--intro-menu', `${INTRO.menu}s`);
  html.style.setProperty('--intro-focus', `${INTRO.focus}s`);
  html.classList.add('title-intro');
  if (cold) html.classList.add('title-cold');
  let timer = 0;
  let observer = null;
  const end = () => {
    clearTimeout(timer);
    observer?.disconnect();
    html.classList.remove('title-intro', 'title-intro-go', 'title-cold');
  };
  const go = () => {
    observer?.disconnect();
    // A frame on the blurred, menu-less state first, so the transitions have a start to run from.
    requestAnimationFrame(() => {
      html.classList.add('title-intro-go');
      const length = lead + Math.max(INTRO.menuAt + INTRO.menu, INTRO.focusAt + INTRO.focus);
      timer = setTimeout(end, length * 1000 + 50);
    });
  };
  if (html.classList.contains('booting')) {
    observer = new MutationObserver(() => { if (!html.classList.contains('booting')) go(); });
    observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  } else go();
  return end;
}

/**
 * @param {HTMLElement | null} root  `#title-screen`, empty until this fills it. Null → returns null.
 * @param {object} opts
 * @param {{ isOn: () => boolean, set: (on: boolean) => void }} opts.sound  The game's one mute.
 * @param {ReturnType<import('./settings.js').createSettings>} opts.settings
 * @param {() => void} opts.onPlay  Fired once, on the press that starts the run.
 */
export function createTitleScreen(root, { sound, settings, onPlay }) {
  if (!root) return null;

  let holding = true;
  let view = 'menu';
  let clock = 0;

  const scrim = el('div', 'title-scrim');
  // The reel's crossfade cover (game/titlereel.js): the outgoing shot, copied here at each cut and
  // faded off the incoming one. Under the menu, so the words stay up through every cut, and never
  // takes a tap — a Play pressed mid-fade has to land.
  const cover = el('canvas', 'title-cover');

  // --- the menu ---------------------------------------------------------------------------------
  const menu = el('nav', 'title-view title-menu');
  menu.setAttribute('aria-label', 'Main menu');
  const playButton = el('button', 'title-item', 'Play');
  const settingsButton = el('button', 'title-item', 'Settings');
  const creditsButton = el('button', 'title-item', 'Credits');
  for (const b of [playButton, settingsButton, creditsButton]) b.type = 'button';
  menu.append(playButton, settingsButton, creditsButton);

  // --- Settings ---------------------------------------------------------------------------------
  const settingsPage = menuPage('settings', 'Settings', () => show('menu'));
  const settingsBody = settingsRows(settingsPage.body, { sound, settings });

  // --- Credits ----------------------------------------------------------------------------------
  const creditsPage = menuPage('credits', 'Credits', () => show('menu'));
  const list = el('dl', 'title-credits');
  // The third field names a mark to set after the name: only Claude's, which is also a button
  // (game/creditegg.js).
  let claudeMark = null;
  for (const [role, name, mark] of CREDITS) {
    const item = el('div', 'title-credit');
    const dd = el('dd', null, name);
    if (mark === 'claude') {
      claudeMark = createClaudeMark(root);
      dd.append(claudeMark.node);
    }
    item.append(el('dt', null, role), dd);
    list.append(item);
  }
  creditsPage.body.append(list);

  // The intro's black, for a load with no startup screen to fade from (see `playIntro`).
  const veil = el('div', 'title-veil');

  root.append(cover, scrim, veil, menu, settingsPage.section, creditsPage.section);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Rocket Rides');

  const views = { menu, settings: settingsPage.section, credits: creditsPage.section };

  function show(next) {
    const from = view;
    view = next;
    root.dataset.view = next;
    if (next !== 'credits') claudeMark?.cancel();
    for (const [name, node] of Object.entries(views)) {
      node.hidden = name !== next;
      node.setAttribute('aria-hidden', String(name !== next));
    }
    // The sound row can change from outside this screen (M), so it is re-read on the way in.
    if (next === 'settings') settingsBody.refresh();
    // Focus follows the view for a keyboard: onto the way back out of a page, or onto the item that
    // led into it on the way home.
    const focus = next === 'settings' ? settingsPage.back
      : next === 'credits' ? creditsPage.back
        : from === 'settings' ? settingsButton
          : from === 'credits' ? creditsButton : null;
    focus?.focus({ preventScroll: true });
  }

  settingsButton.addEventListener('click', () => { show('settings'); });
  creditsButton.addEventListener('click', () => { show('credits'); });

  function play() {
    if (!holding) return;
    holding = false;
    endIntro?.();
    document.body.classList.remove('title-up');
    root.style.pointerEvents = 'none';
    onPlay?.();
    if (stillPlease()) { root.hidden = true; return; }
    const fade = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-in' });
    fade.onfinish = () => { root.hidden = true; };
  }
  playButton.addEventListener('click', play);

  // Escape walks back out of a page. Registered on window, ahead of nothing: the pause key also
  // answers Escape, and it is told to stand down while this screen holds (`canPause` in main.js).
  window.addEventListener('keydown', (event) => {
    if (!holding || event.key !== 'Escape' || view === 'menu') return;
    event.preventDefault();
    show('menu');
  });

  document.body.classList.add('title-up');
  root.hidden = false;
  show('menu');
  const endIntro = !stillPlease() && new URLSearchParams(window.location.search).get('titleintro') !== 'classic'
    ? playIntro(!document.getElementById('splash')) : null;

  return {
    holding: () => holding,
    view: () => view,
    cover,
    show,
    play,
    /** Advance the drift's clock and say where the camera wants to be. */
    pan(dt) {
      clock += dt;
      return panAt(clock);
    },
  };
}
