/**
 * The player's settings from the title screen, remembered across visits in `localStorage`.
 *
 * All but one live here: the two volume sliders, the tutorial tips, the haptics switch, the
 * quality and the difficulty.
 * **Sound on/off is not
 * one of them** — it already had a home before this screen existed (`simTaxi.muted`, owned by
 * game/sfx.js, shared with the pause screen's pill and the M key), and a second copy of it here
 * would be two switches that can disagree. The title screen reads and writes that one through sfx.
 *
 * Soft-failing the way game/highscores.js is: a store that throws (Safari's private mode, a
 * `file://` origin) hands back the defaults and keeps the change for this visit only, rather than
 * taking the screen down over a preference. Anything unknown or out of range in a stored payload is
 * dropped back to its default, so a corrupt key costs that one value and not the lot.
 */

import { MODES } from './difficulty.js';

export const SETTINGS_KEY = 'simTaxi.settings';

/**
 * A first visit. Music full, effects at 75%: with the radio playing at full, the effects at full
 * buried it (Tyler, by ear, 2026-10-04). The slider is squared on the way to the gain, so 0.75 is
 * 0.56, about -5 dB under the mix in mix.json. A player with a saved setting keeps theirs.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  music: 1, effects: 0.75, tips: true,
  // The phone's Taptic Engine (util/haptics.js) — a row that only appears inside the iOS app.
  // There used to be a second switch, `comboHaptics`, for A/B-ing the combo patterns against the
  // plain knocks they replaced; Tyler folded it into this one (2026-10-06). A stored
  // `comboHaptics: false` is dropped rather than read as "haptics off": it chose the old knocks,
  // not silence.
  haptics: true,
  // One of `QUALITIES`. Regular by default: it is the one that keeps a phone cool.
  quality: 'regular',
  // One of `MODES` in game/difficulty.js. Easy by default: it is the curve the game shipped with
  // before the row existed, so nobody's game changes until they pick another.
  difficulty: 'easy',
});

/**
 * The Quality toggle: a pixel-ratio cap and a frame-rate cap, chosen together (Tyler, 2026-10-14).
 * It replaced separate Resolution (3/2/1.5/1) and Frame rate (60/30) rows, so a player is not
 * managing two numbers. What the two halves cost, from `?bench` on an iPhone (2026-10-11):
 *   - Frame rate is the big lever. 30 fps took 33% off busy time at any resolution; an iPhone at
 *     1x and 60 still ran warm and lost about 1% of battery a minute. 30 is the only step below 60
 *     that paces evenly, because rAF in iOS Safari and WKWebView runs at 60 even on a 120 Hz screen
 *     (the bench's everything-off row sat at exactly 60.0 at 46% busy); 40 was tried and alternates
 *     one and two refreshes a frame.
 *   - Resolution is the small one. 2x to 1x took only 11% off. 3 is an iPhone's native density
 *     (2.25x the pixels of 2); a screen below 3 is capped at its own ratio, and the governor
 *     (game/governor.js) steps down from either cap when frames slip.
 *   - `floor` is as far as the governor may take it. Ultra's sits above Regular's resolution, so a
 *     hot phone on Ultra never draws softer than Regular would (it was reaching 1.5).
 * `?dpr=` and `?fps=` on the URL still beat whichever is chosen.
 */
export const QUALITIES = Object.freeze({
  ultra: Object.freeze({ label: 'Ultra', resolution: 3, frameRate: 60, floor: 2.25 }),
  regular: Object.freeze({ label: 'Regular', resolution: 2, frameRate: 30, floor: 1 }),
});

/** The resolution and frame rate a settings object asks for. */
export const qualityOf = (values) => QUALITIES[values.quality] ?? QUALITIES[DEFAULT_SETTINGS.quality];

const unit = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.min(1, Math.max(0, v)) : fallback);

/** Coerce anything into a valid settings object. Exported for tools/scores.mjs-style checks. */
export function cleanSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    music: unit(src.music, DEFAULT_SETTINGS.music),
    effects: unit(src.effects, DEFAULT_SETTINGS.effects),
    tips: typeof src.tips === 'boolean' ? src.tips : DEFAULT_SETTINGS.tips,
    haptics: typeof src.haptics === 'boolean' ? src.haptics : DEFAULT_SETTINGS.haptics,
    // A stored `resolution`/`frameRate` from before the toggle is dropped: the toggle starts fresh.
    quality: Object.hasOwn(QUALITIES, src.quality) ? src.quality : DEFAULT_SETTINGS.quality,
    difficulty: Object.hasOwn(MODES, src.difficulty) ? src.difficulty : DEFAULT_SETTINGS.difficulty,
  };
}

/**
 * @param {object} [opts]
 * @param {Storage | null} [opts.storage]  Injected for the headless checks; the page's own otherwise.
 */
export function createSettings({ storage } = {}) {
  const store = () => {
    if (storage !== undefined) return storage;
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
  };

  let values;
  try {
    const raw = store()?.getItem(SETTINGS_KEY);
    values = cleanSettings(raw ? JSON.parse(raw) : null);
  } catch {
    values = cleanSettings(null);
  }

  const listeners = new Set();

  return {
    get: () => ({ ...values }),
    /** Merge `partial`, clean it, persist it, and tell whoever is listening. */
    set(partial) {
      values = cleanSettings({ ...values, ...partial });
      try { store()?.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch { /* soft, as ever */ }
      for (const fn of listeners) fn({ ...values });
      return { ...values };
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
