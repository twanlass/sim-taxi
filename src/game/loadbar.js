/**
 * The load bar: a thin flat bar under the ROCKET RIDES word while the game loads.
 *
 * A first launch after a new build is the long one (Tyler, 2026-11-08), and the word standing still
 * on black for all of it reads as a hang. The load is three stretches, and the bar is honest about
 * each in the only way it allows:
 *
 * - **Building the city** — main.js evaluating, one synchronous task (~1.3 s headless). No script
 *   runs until it ends, so the bar is handed one compositor animation before it starts: a creep
 *   that eases towards `CITY_SHARE` and never quite arrives. A transform animation runs off the main
 *   thread, so it keeps moving while the page is frozen; the creep is the one guess the bar makes.
 * - **Linking shaders** — the programs `renderer.compile()` queued, linking in the GPU process
 *   (2.7 s headless — the biggest stretch there). Where `KHR_parallel_shader_compile` exists the
 *   page is free while they link, and the bar counts them done (`compileProgress`).
 * - **Warming the GPU** — every mesh drawn once so its pipelines are built behind the load rather
 *   than mid-run (game/warmup.js). On a phone with a cold shader cache — the first launch after an
 *   update — this is most of the wait. It is sliced (`warmFirstDrawsInSteps`), and each slice moves
 *   the bar its true share, animated across the slice's own blocking draw.
 *
 * Shown on every load that boots behind black (the startup screen's and the "Play again" reload's
 * alike), never in shot mode or the marketing site's frame. It fades in after `SHOW_DELAY` so a
 * quick warm load never flashes it. `?loader=classic` is the load as it was: no bar, and the warm-up
 * in one frame.
 */
import { PALETTE } from '../palette.js';

// Guarded so tools/check.mjs can import it in node, where there is no page to put a bar on.
const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
export const LOADER = params.get('loader') !== 'classic';
const WANTED = typeof window !== 'undefined' && LOADER && !params.has('shot') && !params.has('backdrop');

/** Where each stretch ends on the bar: the city build, then the shader links, then the warm-up. */
const CITY_SHARE = 0.25;
const LINK_SHARE = 0.6;
/** How long the creep takes to get most of the way to `CITY_SHARE`, ms. */
const CREEP_MS = 4000;
const SHOW_DELAY = 400;
/** How long each step is animated over: long enough that the bar is still moving through most of a
 * slice that blocks, rather than arriving at once and sitting there looking hung. */
const STEP_MS = 700;
const FADE_MS = 250;

let root = null;
let fill = null;
let motion = null;

const scale = (f) => `scaleX(${Math.max(0.0001, f)})`;

/** Builds the bar and starts the creep. Call before anything blocks, and let a frame present. */
export function showLoadBar() {
  if (!WANTED || root) return;
  root = document.createElement('div');
  root.id = 'load-bar';
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-label', 'Loading');
  // Under the word (dead centre, splash.js) with room for the logo's extrusion, and inside the
  // safe area. Above the startup screen, which is z-index 100.
  Object.assign(root.style, {
    position: 'fixed',
    left: '50%',
    top: '64vh',
    width: 'min(42vw, 200px)',
    height: '6px',
    marginLeft: 'calc(min(42vw, 200px) / -2)',
    borderRadius: '3px',
    background: PALETTE.loadTrack,
    overflow: 'hidden',
    zIndex: '101',
    pointerEvents: 'none',
    opacity: '0',
  });
  fill = document.createElement('div');
  Object.assign(fill.style, {
    width: '100%',
    height: '100%',
    borderRadius: '3px',
    background: PALETTE.loadFill,
    transformOrigin: '0 50%',
    transform: scale(0),
    willChange: 'transform',
  });
  root.appendChild(fill);
  document.body.appendChild(root);
  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: SHOW_DELAY, fill: 'forwards' });
  motion = fill.animate([{ transform: scale(0.02) }, { transform: scale(CITY_SHARE * 0.95) }], {
    duration: CREEP_MS, easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)', fill: 'forwards',
  });
}

function current() {
  if (!fill) return 0;
  const m = new DOMMatrixReadOnly(getComputedStyle(fill).transform);
  return m.a;
}

function moveTo(f, ms, floor = 0) {
  if (!fill) return;
  // Never backwards: the creep can be ahead of a slow first slice's start.
  const from = Math.max(current(), floor);
  motion?.cancel();
  fill.style.transform = scale(from);
  motion = fill.animate([{ transform: scale(from) }, { transform: scale(Math.max(from, f)) }], {
    duration: ms, easing: 'ease-out', fill: 'forwards',
  });
}

/**
 * The warm-up's progress, `from` → `to` in [0, 1] of its own share, said *before* a slice that
 * blocks: the step plays out on the compositor while the slice draws.
 */
export function warmStep(from, to) {
  if (!fill) return;
  const at = (x) => LINK_SHARE + (1 - LINK_SHARE) * x;
  // The city is built by the first step: if the creep was behind, it starts from the true point.
  moveTo(at(to), STEP_MS, at(from));
}

/** The shader links' progress in [0, 1], polled a frame at a time while the page is free. */
export function compileProgress(f) {
  if (!fill) return;
  moveTo(CITY_SHARE + (LINK_SHARE - CITY_SHARE) * f, 200, CITY_SHARE);
}

/** Full, then gone. */
export function hideLoadBar() {
  if (!root) return;
  const el = root;
  moveTo(1, 120);
  // From wherever the fade-in had got to, so a load quicker than `SHOW_DELAY` never flashes it.
  const shown = Number(getComputedStyle(el).opacity);
  el.animate([{ opacity: shown }, { opacity: 0 }], { duration: FADE_MS, delay: 120, fill: 'forwards' })
    .finished.then(() => el.remove(), () => el.remove());
  root = null;
  fill = null;
  motion = null;
}
