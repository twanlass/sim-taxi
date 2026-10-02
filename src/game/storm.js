/**
 * The storm's clock — `?storm`. A sunny city that clouds over, goes dark and wet, rains hard, and
 * clears again, on a loop of `CYCLE` seconds. Pure: three numbers out of one clock, no scene
 * knowledge. `main.js` hands them to everything that has an opinion about weather (game/rain.js
 * and game/citylights.js for the look, sim/traffic.js for the grip and the headlights).
 *
 * - `dark`  the sky: 0 is the ordinary afternoon, 1 the storm at its blackest. Drives the grade,
 *           the haze, and the lights coming on.
 * - `rain`  what is falling: the streaks, the splashes and the drops on the lens. Lags `dark` on
 *           the way in — clouds first, then rain — and leads it out.
 * - `wet`   the ground: follows the rain up quickly and dries slowly, so the streets are still
 *           shining for a while after the sky has cleared. Drives the reflections and the grip.
 *
 * `?rain` is this pinned at the peak, and `?storm=0.6` pins it anywhere in between (a still frame
 * of a storm needs a fixed one).
 */

/** Seconds, in order: clear, clouding over, the storm, clearing. Loops. */
export const STORM_PHASES = { clear: 30, build: 35, peak: 45, ease: 35 };
export const CYCLE = Object.values(STORM_PHASES).reduce((a, b) => a + b, 0);

/** How far the rain trails the sky, in seconds, each way. */
const RAIN_LAG = 7;

/** Time constants for the ground, in seconds: soaking up, drying off. */
const WET_UP = 5;
// 28 first, which left the streets 18% wet 25 seconds into the next clear spell and never dry at
// all before the storm after. 14 has them shining through the clearing (20% wet as it ends), at 7%
// halfway through the sunny stretch and 2% by the time the next one comes over.
const DRY = 14;

const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** The sky's envelope at time `t` into the cycle, 0..1. */
export function envelope(t) {
  const { clear, build, peak, ease } = STORM_PHASES;
  const u = ((t % CYCLE) + CYCLE) % CYCLE;
  if (u < clear) return 0;
  if (u < clear + build) return smooth((u - clear) / build);
  if (u < clear + build + peak) return 1;
  return 1 - smooth((u - clear - build - peak) / ease);
}

export function createStorm({ pin = null, start = 0 } = {}) {
  const state = { t: start, dark: 0, rain: 0, wet: 0, pinned: pin };

  function settle() {
    if (state.pinned === null) return;
    const v = Math.min(1, Math.max(0, state.pinned));
    state.dark = v;
    state.rain = v;
    state.wet = v;
  }

  function update(dt) {
    if (state.pinned !== null) { settle(); return state; }
    state.t += dt;
    state.dark = envelope(state.t);
    // The rain is the sky's envelope read `RAIN_LAG` late on the way in and early on the way out:
    // the smaller of the two reads, so it can only ever trail the cloud.
    state.rain = Math.min(envelope(state.t - RAIN_LAG), envelope(state.t + RAIN_LAG));
    const tau = state.rain > state.wet ? WET_UP : DRY;
    state.wet += (state.rain - state.wet) * Math.min(1, dt / tau);
    return state;
  }

  settle();
  return {
    state,
    update,
    /** Pin the storm at `v` (0..1), or null to let the clock run again. */
    pin: (v) => { state.pinned = v; settle(); },
    /** Jump the clock, for looking at a moment of the cycle without waiting for it. */
    seek: (t) => { state.t = t; state.wet = envelope(t); },
  };
}
