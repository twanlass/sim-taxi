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
let caption = null;

const scale = (f) => `scaleX(${Math.max(0.0001, f)})`;

/**
 * The caption under the bar: what the load is "doing", in the game's voice (Tyler, 2026-11-09). Set
 * in the run-end screen's hint style — white, semi-opaque, breathing — and the breathe is an opacity
 * animation, so like the creep it keeps going while the page is frozen. Each line is real in the
 * sense that matters: it changes when the stage does, and during the warm-up it names something in
 * the slice actually being drawn (`SLICE_LINES`, keyed by the scene child's name, first match wins),
 * falling back to `SPARE_LINES` in order for a slice with nothing nameable in it.
 */
const CITY_LINE = 'Paving the streets…';
const LINK_LINE = 'Mixing the paint…';
const SLICE_LINES = [
  ['buildings', 'Putting up the buildings…'],
  ['river', 'Filling the river…'],
  ['ground', 'Pouring the sidewalks…'],
  ['hoopers', 'Pumping up the basketballs…'],
  ['skaters', 'Waxing the skatepark…'],
  ['taxi', 'Fuelling the taxi…'],
  ['tube-man', 'Inflating the tube man…'],
  ['ltrain', 'Running the L train…'],
  ['cars', 'Starting the traffic…'],
  ['garbage-truck', 'Waking the garbage truck…'],
  ['robotaxi', 'Charging the rolling toasters…'],
  ['drawbridge', 'Oiling the drawbridge…'],
  ['boats', 'Launching the boats…'],
  ['birds', 'Feeding the pigeons…'],
  ['fire-engine', 'Polishing the fire engine…'],
  ['race-rival', 'Tuning the street racers…'],
  ['garbage', 'Taking out the trash…'],
];
const SPARE_LINES = ['Hiding the cops…', 'Grilling the Dub Burgers…', 'Checking the mirrors…', 'Warming up the engine…'];
const used = new Set();
let spare = 0;

function sliceLine(children) {
  const names = new Set(children.map((c) => c.name));
  for (const [name, line] of SLICE_LINES) {
    if (names.has(name) && !used.has(line)) { used.add(line); return line; }
  }
  return SPARE_LINES[spare++ % SPARE_LINES.length];
}

function say(line) {
  if (caption && caption.textContent !== line) caption.textContent = line;
}

/** Builds the bar and starts the creep. Call before anything blocks, and let a frame present. */
export function showLoadBar() {
  if (!WANTED || root) return;
  // Under the word (dead centre, splash.js) with room for the logo's extrusion. Above the startup
  // screen, which is z-index 100.
  root = document.createElement('div');
  root.id = 'load-bar';
  Object.assign(root.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    top: '64vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '14px',
    zIndex: '101',
    pointerEvents: 'none',
    opacity: '0',
  });
  const track = document.createElement('div');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Loading');
  Object.assign(track.style, {
    width: 'min(42vw, 200px)',
    height: '6px',
    borderRadius: '3px',
    background: PALETTE.loadTrack,
    overflow: 'hidden',
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
  track.appendChild(fill);
  // The run-end screen's "Tap to continue" (`.run-end-continue`): same face, size and weight, white
  // at 0.62 breathing down to 0.32.
  caption = document.createElement('div');
  Object.assign(caption.style, {
    color: '#fff',
    fontFamily: 'var(--game-font)',
    fontSize: 'clamp(14px, 2.6vh, 17px)',
    fontWeight: '500',
    whiteSpace: 'nowrap',
    opacity: '0.62',
  });
  caption.setAttribute('aria-live', 'polite');
  root.append(track, caption);
  document.body.appendChild(root);
  say(CITY_LINE);
  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: SHOW_DELAY, fill: 'forwards' });
  caption.animate([{ opacity: 0.62 }, { opacity: 0.32 }, { opacity: 0.62 }], {
    duration: 2400, iterations: Infinity, easing: 'ease-in-out',
  });
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
 * blocks — and a frame before it, so the step and the caption are presented — and the step plays out
 * on the compositor while the slice draws. `children` are the slice's scene children, for its line.
 */
export function warmStep(from, to, children = []) {
  if (!fill) return;
  say(sliceLine(children));
  const at = (x) => LINK_SHARE + (1 - LINK_SHARE) * x;
  // The city is built by the first step: if the creep was behind, it starts from the true point.
  moveTo(at(to), STEP_MS, at(from));
}

/** The shader links' progress in [0, 1], polled a frame at a time while the page is free. */
export function compileProgress(f) {
  if (!fill) return;
  say(LINK_LINE);
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
  caption = null;
}
