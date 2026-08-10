/**
 * What to do when the GPU takes the context away — and it does.
 *
 * Reported from a Pixel on a PowerVR D-Series (Tensor G5): the city rendered correctly for about
 * a second, the driver reset, three restored the context, and it happened again, and again. Draw
 * calls and triangle counts were normal right up to each loss, so nothing was wrong with the
 * scene; the device simply would not keep giving us a context on the budget we were asking for.
 *
 * Three already handles the mechanics — it calls `preventDefault()` on the loss (which is what
 * lets the browser restore at all), flags itself so every `render()` in between is a no-op, and
 * re-initialises on restore. What it does not do, and cannot, is decide that **the budget was the
 * problem**. Left alone, the loop above is a black screen for as long as the player is willing to
 * look at it.
 *
 * So this de-escalates, in two steps, and the split between them is not arbitrary — it is what
 * can be changed on a live renderer versus what needs a new one:
 *
 *   1. **First loss — turn it down in place.** Pixel ratio and shadow map size are plain
 *      properties; dropping both costs three quarters of the drawing buffer and three quarters of
 *      the shadow map without touching a material. **The run survives**, which matters: the player
 *      is mid-fare with a clock draining, and a reload is a lost run.
 *   2. **Second loss — reload into `?safe`.** MSAA is a context attribute and AO is baked into
 *      every shader at build time (`util/geo.js`), so neither can be given up without starting
 *      over. By this point the run is going to be lost either way; a playable game is worth more
 *      than the fare that was in progress.
 *
 * **Step 1 is not free and is not pretended to be.** Dropping to DPR 1 on a phone is a visibly
 * softer picture — these are hard-edged flat facets and the aliasing shows. It is spent on the
 * *first* loss anyway, because a context loss is not a routine event on a healthy page: the GPU
 * has already declined to keep us once, and the cheapest thing that might stop it happening again
 * is worth more than the sharpness. Backgrounding the app or an OS-level GPU reset can produce an
 * isolated one, and the cost of over-reacting to those is a soft screen until the next reload —
 * against a black one for the rest of the run if this waits for a pattern that was already
 * obvious. Step 2 costs the run, so *that* one waits.
 *
 * Already in safe mode and still losing the context? Then this is not a budget problem and there
 * is nothing left here to give up — it stops, and leaves the mirrored `Context Lost.` on screen
 * saying so rather than reloading forever.
 */

/** What the first loss gives up. Both are live-settable; see the note above on why that matters. */
const DEGRADED_PIXEL_RATIO = 1;
const DEGRADED_SHADOW_MAP = 1024;

/**
 * @param renderer  the main WebGLRenderer, whose canvas carries the events
 * @param sun       the directional light whose shadow map step 1 shrinks
 * @param budget    the live budget object from `main.js`, mutated so the diagnostics panel and
 *                  anything else reading it see what was actually given up
 * @param onNotice  called with a one-line summary of each step, for `game/diag.js`
 */
export function attachContextRecovery({ renderer, sun, budget, onNotice = () => {} }) {
  let losses = 0;

  renderer.domElement.addEventListener('webglcontextlost', () => {
    losses += 1;

    // Headroom first, safe mode second. Asking "is there anything left I can turn down without a
    // reload" before "am I already in safe mode" is what keeps this correct as safe mode's own
    // contents change: since Android defaults to it, a device can now arrive here already at the
    // step-one floor, and the old order would have called that "nothing left" while the reload
    // branch was still the one being skipped.
    const canDegradeLive = budget.pixelRatioCap > DEGRADED_PIXEL_RATIO
      || budget.shadowMapSize > DEGRADED_SHADOW_MAP;

    if (canDegradeLive) {
      // Applied while the context is still down, on purpose: these are JS-side properties, and
      // setting them now means the context three restores comes back already inside the smaller
      // budget rather than being handed the old one and losing it again.
      budget.pixelRatioCap = DEGRADED_PIXEL_RATIO;
      budget.shadowMapSize = Math.min(budget.shadowMapSize, DEGRADED_SHADOW_MAP);
      // `setPixelRatio` re-runs `setSize` internally, so the drawing buffer follows.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatioCap));
      if (sun?.castShadow) {
        sun.shadow.mapSize.set(budget.shadowMapSize, budget.shadowMapSize);
        // The old map is a texture of the old size; three will not resize one in place, so it has
        // to go. Dropping the reference is what makes the next shadow pass allocate a new one.
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      onNotice(`context lost — dropped to dpr ${budget.pixelRatioCap},`
        + ` shadows ${budget.shadowMapSize}`);
      return;
    }

    // Nothing left to give up. Say so and stop — a reload loop is worse than a black screen,
    // because it also takes away the panel that would have explained it.
    if (budget.safe) {
      onNotice(`context lost x${losses} — already in safe mode`);
      return;
    }

    // The live half did not hold. Everything still on the table — MSAA, AO — needs a fresh
    // context and a fresh set of programs, which means a reload.
    onNotice('context lost again — reloading into safe mode');
    const url = new URL(window.location.href);
    url.searchParams.set('safe', '1');
    // `replace` rather than `assign`: the URL that just failed is not somewhere the back button
    // should be able to return to.
    window.location.replace(url.toString());
  });
}
