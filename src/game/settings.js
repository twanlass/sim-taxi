/**
 * The player's settings from the title screen, remembered across visits in `localStorage`.
 *
 * Three of the four live here: the two volume sliders and the tutorial tips. **Sound on/off is not
 * one of them** — it already had a home before this screen existed (`simTaxi.muted`, owned by
 * game/sfx.js, shared with the pause screen's pill and the M key), and a second copy of it here
 * would be two switches that can disagree. The title screen reads and writes that one through sfx.
 *
 * Soft-failing the way game/highscores.js is: a store that throws (Safari's private mode, a
 * `file://` origin) hands back the defaults and keeps the change for this visit only, rather than
 * taking the screen down over a preference. Anything unknown or out of range in a stored payload is
 * dropped back to its default, so a corrupt key costs that one value and not the lot.
 */

export const SETTINGS_KEY = 'simTaxi.settings';

/** A first visit. Both sliders full — the mix in mix.json is the designer's, so full *is* the mix. */
export const DEFAULT_SETTINGS = Object.freeze({ music: 1, effects: 1, tips: true });

const unit = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.min(1, Math.max(0, v)) : fallback);

/** Coerce anything into a valid settings object. Exported for tools/scores.mjs-style checks. */
export function cleanSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    music: unit(src.music, DEFAULT_SETTINGS.music),
    effects: unit(src.effects, DEFAULT_SETTINGS.effects),
    tips: typeof src.tips === 'boolean' ? src.tips : DEFAULT_SETTINGS.tips,
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
