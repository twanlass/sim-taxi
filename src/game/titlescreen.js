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
import { RIGHT } from './camera.js';
import { createClaudeMark } from './creditegg.js';
import { el, menuPage, settingsRows } from './menupage.js';
import { nativeVersion } from '../util/platform.js';

const params = new URLSearchParams(globalThis.location?.search ?? '');

/**
 * The backdrop (Tyler, 2026-10-22): one slow slide along screen-right across the middle of the
 * city, there and back. `?titlecam=reel` is the landmark reel it replaced (game/titlereel.js, read
 * by main.js), `?titlecam=classic` the ellipse before that (`panClassicAt`).
 *
 * Along screen-right because that is the one direction the whole frame moves through at once — the
 * picture travels sideways under the menu rather than up into it — and because it is the direction
 * the intro story's shot past the garage slides in too, so the two read as the same camera.
 * Through the origin it crosses the river once on the way, bridges and boats included.
 */
export const TITLE_CAM = params.get('titlecam') === 'reel' ? 'reel'
  : params.get('titlecam') === 'classic' ? 'classic' : 'slide';
/** Seconds for the slide there and back. */
export const SLIDE_PERIOD = 160;
/**
 * How far either side of the middle the slide reaches, in world units along screen-right. 32 puts
 * the far ends at ±22.6 on each axis, under half of either half-span (52.5 × 64.5), so the frame
 * stays over buildings rather than running out into the fog. Peak speed is 2π · 32 / 160 = 1.26
 * units a second, under a centimetre of screen a second on a phone.
 */
export const SLIDE_REACH = 32;
/**
 * Where on the cosine the slide starts: 0.7 of the reach left of the middle, already moving at
 * 0.71 of its peak. Not at an end, where a cosine is at rest — the menu would fade in over a
 * still frame and the pan would read as starting late.
 */
const SLIDE_PHASE = Math.acos(0.7);

/**
 * Where the slide is at `t` seconds. A cosine, so the turn at each end is a long ease rather than a
 * stop: at 160 s a lap, the slowest stretch either side of a turn lasts the better part of a minute
 * and no one sitting on the menu sees it reverse.
 */
export function panAt(t) {
  const along = -SLIDE_REACH * Math.cos(SLIDE_PHASE + (t / SLIDE_PERIOD) * Math.PI * 2);
  return { x: RIGHT.x * along, z: RIGHT.z * along, zoom: PAN_ZOOM };
}

/** Seconds per lap of the classic ellipse. Slow on purpose: ~1 world unit a second is a stroll, not a tour. */
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
 * `?titlecam=classic`: a slow ellipse round the middle of the city. An ellipse rather than a
 * back-and-forth so the motion never stops and turns, and the ratio of the radii follows the map's
 * own (it is a block row taller than it is wide).
 */
export function panClassicAt(t) {
  const a = (t / PAN_PERIOD) * Math.PI * 2;
  return { x: Math.cos(a) * HALF_SPAN_X * PAN_RX, z: Math.sin(a) * HALF_SPAN_Z * PAN_RZ, zoom: PAN_ZOOM };
}

export const CREDITS = [
  ['Game design', 'Tyler, Nia, and Isla Wanlass'],
  ['Art direction', 'Tyler Wanlass'],
  ['Music + sound design', 'Nicolás J. Infantas Jamett'],
  ['Programming', 'Claude', 'claude'],
];

/** The web build's version for the title menu's foot — bump it here by hand. */
export const BUILD_VERSION = '1.0.0';
export const COPYRIGHT = `© 2026 48 Made, LLC. Build v${BUILD_VERSION}`;

/**
 * The title menu's foot line. Inside the app it names the version and build the shell reports
 * (`nativeVersion()`), so it always matches the TestFlight or App Store build it is in and nobody
 * has to bump anything; on the web, and in a shell too old to say, it is `COPYRIGHT`.
 */
export function copyrightLine() {
  const v = nativeVersion();
  return v ? `© 2026 48 Made, LLC. Build v${v.version} (${v.build})` : COPYRIGHT;
}

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The way in (Tyler, 2026-10-22): the city is there, sharp, the moment the black lifts, and the
 * menu fades in over it. `?titleintro=blur` is the three-beat version it replaced — the city fading
 * up out of black a little out of focus, the menu fading in, then the city sharpening — and
 * `?titleintro=classic` the screen before either, menu and city both there at once.
 *
 * Everything below about the blur and the veil is the `blur` version's; the default sets neither,
 * and is only the menu's fade on the same timeline.
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

export const TITLE_INTRO = ['blur', 'classic'].includes(params.get('titleintro'))
  ? params.get('titleintro') : 'fade';

function playIntro(cold, blur) {
  const html = document.documentElement;
  cold = cold && blur;
  const lead = cold ? INTRO.veil : 0;
  html.style.setProperty('--intro-menu-at', `${lead + INTRO.menuAt}s`);
  html.style.setProperty('--intro-focus-at', `${lead + INTRO.focusAt}s`);
  html.style.setProperty('--intro-veil', `${INTRO.veil}s`);
  html.style.setProperty('--intro-menu', `${INTRO.menu}s`);
  html.style.setProperty('--intro-focus', `${INTRO.focus}s`);
  html.classList.add('title-intro');
  if (blur) html.classList.add('title-blur');
  if (cold) html.classList.add('title-cold');
  let timer = 0;
  let observer = null;
  const end = () => {
    clearTimeout(timer);
    observer?.disconnect();
    html.classList.remove('title-intro', 'title-intro-go', 'title-blur', 'title-cold');
  };
  const go = () => {
    observer?.disconnect();
    // A frame on the blurred, menu-less state first, so the transitions have a start to run from.
    requestAnimationFrame(() => {
      html.classList.add('title-intro-go');
      const length = lead + Math.max(INTRO.menuAt + INTRO.menu, blur ? INTRO.focusAt + INTRO.focus : 0);
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
 * @param {ReturnType<import('./progress.js').createDemo>} [opts.demo]  Demo mode, for its Settings row.
 * @param {() => void} opts.onPlay  Fired once, on the press that starts the run.
 * @param {(done: () => void) => boolean} [opts.beforePlay]  Asked on the press: answer true to take
 *   the screen over first (the menu goes, the gate stays shut) and call `done` to let the run go —
 *   the backstory's hook (game/backstory.js).
 */
export function createTitleScreen(root, { sound, settings, demo = null, onPlay, beforePlay = null }) {
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
  // The small print sits inside the menu so it fades in with it and goes when a page opens.
  menu.append(playButton, settingsButton, creditsButton, el('p', 'title-legal', copyrightLine()));

  // --- Settings ---------------------------------------------------------------------------------
  const settingsPage = menuPage('settings', 'Settings', () => show('menu'));
  // Five quick taps on the heading reveal the Demo mode row — the way in on the App Store build,
  // which has no URL bar for `?demo` (game/progress.js, menupage.js).
  const settingsBody = settingsRows(settingsPage.body, { sound, settings, demo, header: settingsPage.header });

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

  // Between Play and the run while something `beforePlay` put up is being answered.
  let telling = false;
  function play() {
    if (!holding || telling) return;
    endIntro?.();
    if (beforePlay?.(go)) {
      telling = true;
      // The menu fades off rather than blinking out, now the camera flies under it instead of
      // cutting under a wipe (main.js `beforePlay`).
      if (stillPlease()) show('story');
      else {
        menu.style.pointerEvents = 'none';
        const out = menu.animate([{ opacity: 1 }, { opacity: 0 }],
          { duration: 260, easing: 'ease-in', fill: 'forwards' });
        out.onfinish = () => { show('story'); out.cancel(); menu.style.pointerEvents = ''; };
      }
      return;
    }
    go();
  }
  function go() {
    if (!holding) return;
    telling = false;
    holding = false;
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
    if (!holding || event.key !== 'Escape' || view === 'menu' || telling) return;
    event.preventDefault();
    show('menu');
  });

  document.body.classList.add('title-up');
  root.hidden = false;
  show('menu');
  const endIntro = !stillPlease() && TITLE_INTRO !== 'classic'
    ? playIntro(!document.getElementById('splash'), TITLE_INTRO === 'blur') : null;

  return {
    holding: () => holding,
    view: () => view,
    cover,
    show,
    play,
    /** Advance the drift's clock and say where the camera wants to be. */
    pan(dt) {
      clock += dt;
      return TITLE_CAM === 'classic' ? panClassicAt(clock) : panAt(clock);
    },
  };
}
