/**
 * Which renderer this page draws with, decided once at import and before any material exists.
 *
 * WebGPU where the browser has it; three's WebGLRenderer under `?renderer=classic`, in a browser
 * with no `navigator.gpu`, and in every headless tool (node has no `location`). It has to be a
 * module constant rather than something main.js hands around: `propMaterial()` builds a different
 * *class* of material for each renderer, and the first one is built at import time by modules
 * main.js has not reached yet.
 *
 * See docs/rendering.md, "The WebGPU port".
 */
export const GPU = typeof location !== 'undefined'
  && typeof navigator !== 'undefined'
  && Boolean(navigator.gpu)
  && new URLSearchParams(location.search).get('renderer') !== 'classic';

/**
 * Build something for one of the page's small WebGLRenderers while the game itself is on WebGPU.
 *
 * The startup splash, the taxi and rider finders and the cargo chip each draw a model of their own
 * into a little canvas with a plain WebGLRenderer, and a WebGLRenderer cannot draw a node
 * material: handed the game's taxi it threw inside the splash's first compile, before the game was
 * imported, and the page stayed black. Everything built inside `forWebGL` gets the GLSL materials.
 */
let classic = 0;
export function forWebGL(build) {
  classic += 1;
  try {
    return build();
  } finally {
    classic -= 1;
  }
}

/** Whether a material being built now should be a node material. Ask as it is built, not at import. */
export const gpuMaterials = () => GPU && classic === 0;

/**
 * A WebGPU page that fails to start reloads once on WebGL, and says why.
 *
 * Nothing headless can present a WebGPU canvas, so the first run of any change on real hardware is
 * the player's; a black screen with nothing on it is the worst report to work from. Any error
 * before the game is up (`window.__taxi`) sends the page to `?renderer=classic&gpuerror=<what>`,
 * and that page shows the message in a strip along the top until it is tapped. After the game is
 * up an error is an ordinary error and nothing here acts on it.
 */
/**
 * Before the game is up, reload the page on WebGL with `what` as the reason; after, do nothing and
 * answer false. Also the device's own error handler's first move (main.js): a shader WebKit refuses
 * to compile fails as a device error rather than a throw, and the material it belonged to then
 * draws nothing on WebGPU however the frame is arranged — the city went missing that way on an
 * iPhone, under a lone fire truck.
 */
export function fallBackToWebGL(what) {
  if (!GPU || window.__taxi) return false;
  const params = new URLSearchParams(location.search);
  params.set('renderer', 'classic');
  params.set('gpuerror', String(what).slice(0, 300));
  location.replace(`${location.pathname}?${params}`);
  return true;
}
if (GPU) {
  window.addEventListener('error', (event) => fallBackToWebGL(event.error?.stack ?? event.message));
  window.addEventListener('unhandledrejection', (event) => fallBackToWebGL(event.reason?.stack ?? event.reason));
} else if (typeof location !== 'undefined' && typeof document !== 'undefined') {
  const what = new URLSearchParams(location.search).get('gpuerror');
  if (what) gpuNote(`WebGPU failed, drawing with WebGL. ${what}`);
}

/**
 * A strip of diagnostic text along the top of the page, until it is tapped. For the port's own
 * failures, and only for us: it shows under `?dev` and on the dev server, and everywhere else the
 * text goes to the console alone. A player has nothing to do with a WGSL compiler's message, and
 * the first one shipped as a red bar across the loading screen.
 */
export function gpuNote(text) {
  if (typeof document === 'undefined') return;
  console.warn(text);
  const show = import.meta.env?.DEV || new URLSearchParams(location.search).has('dev');
  if (show) {
    const note = document.createElement('div');
    note.textContent = text;
    note.style.cssText = 'position:fixed;z-index:9999;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top) + 6px) 10px 6px;'
      + 'font:11px/1.3 ui-monospace,monospace;color:#fff;background:rgba(160,30,30,.92);white-space:pre-wrap;word-break:break-word';
    note.addEventListener('click', () => note.remove());
    (document.body ?? document.documentElement).append(note);
  }
}
