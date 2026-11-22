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
