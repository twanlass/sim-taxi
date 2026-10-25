/**
 * `?backdrop`: the title screen's city with nothing else — for the marketing site, which frames this
 * page behind its hero (rocket-rides-web). The real city, so that every visual change to the game
 * reaches the site by itself, rather than through a video someone has to film again.
 *
 * What it takes away is everything that is not the city: the startup screen (game/splash.js), the
 * menu and the HUD (index.html, `html.backdrop`), and the whole of the sound, so none of the ~10 MB of
 * recordings is fetched (main.js leaves `sfx` null, as shot mode does). The page takes no input.
 * What it keeps is the title screen's own hold — the fare board unseeded, the traffic driving — and
 * its camera slide, framed wider (`backdropZoom`) because the site shows the city as a place rather
 * than as a menu's backdrop.
 *
 * It tells the frame it is in when the city has drawn (`announceReady`), so the site can hold its
 * still over the frame until then and crossfade, rather than showing the black of a page loading.
 */

const params = new URLSearchParams(globalThis.location?.search ?? '');

export const BACKDROP = params.has('backdrop');

/**
 * The slide's frustum half-height under `?backdrop`, against the menu's 34. Wide enough on a tall
 * phone for the island to fill the width with the fog bank above and below it (88); a landscape
 * frame is 2.2× wider for the same height, so it needs less (52, the play zoom) to show as much.
 */
export function backdropZoom(aspect) {
  return aspect < 1 ? 88 : 52;
}

/** Posted to the parent frame once the city is on screen. */
export const READY_MESSAGE = 'rocketrides:backdrop-ready';

export function announceReady() {
  if (!BACKDROP || window.parent === window) return;
  window.parent.postMessage({ type: READY_MESSAGE }, '*');
}
