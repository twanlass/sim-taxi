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
 * `?backdrop=island`: the whole island in frame, floating in its fog bank, rather than tight on the
 * middle. For the light marketing site (Tyler, 2026-11-15: lose the mask round the city and let its
 * own cloud edges fade into the page): the frame's edges are all fog, so the site sets its page to
 * the fog's colour and the city needs no cut at all. Plain `?backdrop` keeps the tight framing, so the
 * site live today does not change under it before its own update lands.
 */
export const BACKDROP_ISLAND = BACKDROP && params.get('backdrop') === 'island';

/**
 * The slide's frustum half-height under `?backdrop`, against the menu's 34. Tight on the city's
 * middle, with no fog in frame (Tyler, 2026-10-25: the whole island read as too far out, and then
 * the island's ragged edge as still too much cloud): 32 across a landscape frame, 46 on a tall one,
 * where the width is the short side.
 */
export function backdropZoom(aspect) {
  if (BACKDROP_ISLAND) return aspect < 1 ? ISLAND_ZOOM_TALL : ISLAND_ZOOM_WIDE;
  return aspect < 1 ? 46 : 32;
}

/**
 * Under `?backdrop=island`. Landscape: 58 puts the whole island in a 1280 × 760 frame with a margin
 * of fog on every side. Portrait: the island is wider than it is tall on screen, so a phone gets it
 * cropped at the sides (the phone's own edges) and fog above and below; 64 keeps the blocks large
 * enough to read as a city on a 390-wide screen.
 */
const ISLAND_ZOOM_WIDE = 58;
const ISLAND_ZOOM_TALL = 64;

/** Posted to the parent frame once the city is on screen. */
export const READY_MESSAGE = 'rocketrides:backdrop-ready';

export function announceReady() {
  if (!BACKDROP || window.parent === window) return;
  window.parent.postMessage({ type: READY_MESSAGE }, '*');
}
