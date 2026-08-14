/**
 * The screen's real size, measured through CSS rather than asked of the window.
 *
 * `window.innerHeight` lies on an installed iOS app. In standalone mode with `black-translucent`
 * and `viewport-fit=cover`, the layout viewport still stops ~34pt short of the physical bottom —
 * the home-indicator zone — so a canvas sized off `innerHeight` leaves a strip of bare body
 * background under the game (measured on-device: the strip under the skyline in the first
 * edge-to-edge build was exactly this). CSS `100vh`, by contrast, resolves to the full screen
 * height there, and is the ONE length that is right from a cold start: `100dvh` reports the short
 * value until the device has been rotated once, and `innerHeight` never grows at all.
 *
 * So: a hidden, fixed, `100vw × 100vh` probe element, measured whenever the window thinks its
 * geometry changed. iOS also settles these values lazily on cold start — the same timing quirk
 * that breaks `100dvh` — so every trigger re-measures again shortly after, and startup itself
 * runs a short settle poll. Callers subscribe rather than listening to `resize` themselves:
 * a settle that arrives with no resize event still has to re-size the renderer.
 *
 * On any ordinary browser the probe simply measures the viewport and this module is
 * `window.innerWidth/innerHeight` with extra steps — the numbers agree exactly.
 *
 * Headless-safe: nothing here touches the DOM at import time (tools/check.mjs boots the module
 * graph in node); the probe exists only once `createViewport()` is called.
 */
export function createViewport() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;';
  document.documentElement.appendChild(probe);

  const size = { w: 0, h: 0 };
  const listeners = new Set();

  function measure() {
    // `|| window.inner*` covers a probe that somehow measures 0 (display:none ancestors don't
    // exist here, but a zero canvas is a black screen and not worth the risk).
    const w = probe.offsetWidth || window.innerWidth;
    const h = probe.offsetHeight || window.innerHeight;
    if (w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    for (const fn of listeners) fn(w, h);
  }

  // Every geometry event re-measures now and again shortly after: rotation reports its final
  // numbers late, in the same way cold start does.
  function measureSoon() {
    measure();
    setTimeout(measure, 250);
    setTimeout(measure, 750);
  }

  measure();
  window.addEventListener('resize', measureSoon);
  window.addEventListener('orientationchange', measureSoon);
  // The cold-start settle poll. On an installed iOS app the first frames can carry interim
  // values; by one second in, the viewport has told the truth.
  for (const ms of [50, 150, 300, 600, 1000]) setTimeout(measure, ms);

  return {
    width: () => size.w,
    height: () => size.h,
    /** Fires with (w, h) after any real change — including a late cold-start settle. */
    onChange: (fn) => listeners.add(fn),
  };
}
