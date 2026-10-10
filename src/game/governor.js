/**
 * The resolution governor: steps the pixel ratio down when frames start slipping, and back up
 * once there is room again. On by default; `?governor=off` holds the ratio where the budget put it.
 *
 * Why it exists is a measurement, not a hunch. `?bench` on an iPhone (2026-10-10): the cool
 * baseline held 59.4 fps with 1.3% of frames late on 3.1 ms of CPU; the same baseline four minutes
 * later, on a warm phone, was 52 fps with **16.6%** late and 7.2 ms of CPU. Nothing in the scene
 * had changed. The phone had throttled, and the frame that fit with room to spare on a cool chip
 * stopped fitting on a hot one. A player meets that in every run longer than a few minutes.
 *
 * **Pixel ratio is the one lever that can move live.** MSAA is a context attribute and AO is
 * compiled into every material, so neither can be given up without a reload. A ratio change is a
 * `setPixelRatio`, and every render target in the pipeline already follows the drawing buffer
 * (`resizeIfNeeded` in game/ssao.js, the bloom chain, the rain mirror) — the same path
 * `game/recovery.js` uses on a context loss. Dropping 2 → 1.5 takes 44% of the pixels out of the
 * main pass, the AO prepass and the bloom. The shadow map is a fixed size and is not touched.
 *
 * **It is slow on purpose, in both directions.** A ratio change reallocates the drawing buffer and
 * every target behind it, which is itself a hitch, so a governor that hunts would cause the thing
 * it is there to remove. Down needs a whole window of late frames; up needs half a minute of clean
 * ones, and a step up that slips straight back doubles the wait before the next try.
 *
 * **What it cannot see.** The display caps the frame rate, so a phone holding 60 reports the same
 * interval at 30% GPU load as at 95%: the governor reacts to throttling, it does not anticipate
 * it. That is also why it never climbs *above* the budget's cap — "there is room" is only ever a
 * guess, and the cap is the look the game was designed at.
 */

/** Multipliers on the budget's cap, cheapest last. Never below a ratio of 1. */
const STEPS = [1, 0.875, 0.75, 0.625, 0.5];
const MIN_RATIO = 1;
/** Seconds per judgement window. */
const WINDOW = 2;
/** A frame this many vsyncs long is late. */
const LATE_VSYNCS = 1.5;
const VSYNC_MS = 1000 / 60;
/** Late fraction over one window that steps down. Above the cool baseline's 1.3%, under the hot one's 16.6%. */
const DOWN_AT = 0.08;
/** Late fraction a window has to stay under to count toward stepping up. */
const CLEAN_BELOW = 0.02;
/** Seconds of clean windows before trying a step up, and its ceiling after repeated failures. */
const UP_AFTER = 30;
const UP_AFTER_MAX = 240;
/** Seconds after any change in which a slip counts as that change failing. */
const PROBATION = 10;
/**
 * An interval this long is the page having been away (a backgrounded tab, the app switcher), not
 * load. Not counted. It was 250 ms at first, to keep shader links out too, and that made a device
 * that is *uniformly* slow invisible: a headless soak at ~1 fps never stepped down once, because
 * every one of its frames was a "stall". A single link is one late frame among ~120 in a window,
 * far under `DOWN_AT`, so it needs no exclusion of its own.
 */
const STALL_MS = 2000;

export function createGovernor({ renderer, budget, enabled = true, onChange = () => {} }) {
  let level = 0;
  let frames = 0;
  let late = 0;
  let windowStart = 0;
  let last = 0;
  let cleanFor = 0;
  let upAfter = UP_AFTER;
  let changedAt = -Infinity;
  let steppedUpAt = -Infinity;

  const cap = () => Math.min(globalThis.devicePixelRatio ?? 1, budget.pixelRatioCap);
  const ratioAt = (l) => Math.max(Math.min(MIN_RATIO, cap()), cap() * STEPS[l]);
  // The cheapest step that still lowers the ratio: on a cap of 1 there is nowhere to go at all.
  const floorLevel = () => {
    let l = 0;
    while (l + 1 < STEPS.length && ratioAt(l + 1) < ratioAt(l)) l += 1;
    return l;
  };

  function apply(next, now, why) {
    level = next;
    changedAt = now;
    cleanFor = 0;
    renderer.setPixelRatio(ratioAt(level));
    onChange(`governor: dpr ${ratioAt(level).toFixed(2)} (${why})`);
  }

  return {
    /** The ratio it is holding now, for `?bench` and the diagnostics panel. */
    ratio: () => ratioAt(level),
    /**
     * Once per drawn frame, with a wall-clock time in ms. `active` false (paused, a card up, a
     * run over) drops the frame from the count: those frames are cheap and would read as headroom.
     */
    frame(now, active = true) {
      const dt = last ? now - last : 0;
      last = now;
      if (!enabled || !active || !dt || dt > STALL_MS) return;
      if (!windowStart) windowStart = now;
      frames += 1;
      if (dt >= LATE_VSYNCS * VSYNC_MS) late += 1;
      if (now - windowStart < WINDOW * 1000) return;

      const share = late / frames;
      frames = 0;
      late = 0;
      windowStart = now;

      // Ratio raised by the recovery or the cap lowered under it: follow, and judge from there.
      if (Math.abs(renderer.getPixelRatio() - ratioAt(level)) > 1e-6) renderer.setPixelRatio(ratioAt(level));

      if (share >= DOWN_AT) {
        if (now - steppedUpAt < PROBATION * 1000) upAfter = Math.min(UP_AFTER_MAX, upAfter * 2);
        if (level < floorLevel() && now - changedAt > WINDOW * 1000) apply(level + 1, now, `${Math.round(share * 100)}% late`);
        cleanFor = 0;
        return;
      }
      cleanFor = share < CLEAN_BELOW ? cleanFor + WINDOW : 0;
      if (level > 0 && cleanFor >= upAfter) {
        steppedUpAt = now;
        apply(level - 1, now, `clean for ${upAfter}s`);
      }
    },
  };
}
