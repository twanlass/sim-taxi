/**
 * Where a Loco Mode tuning goes so it survives a crash.
 *
 * A wreck ends the run and Retry is `location.reload()`, which is exactly the moment a tuning
 * session is most likely to be interrupted — you crank the ceiling to something silly, drive into
 * a bus at 90mph *because* you cranked it, and the sliders are back to shipped. The tank of
 * patience for re-dragging six sliders is about two crashes deep.
 *
 * **It only ever loads under `?debug`.** That gate is in main.js rather than here, and it is the
 * one rule this module exists around: a stashed 170 u/s taxi leaking into an ordinary session
 * would be invisible — the panel isn't built, so nothing on screen says the game is not the game —
 * and it would quietly put a nonsense run on the high-score table. The stash is a convenience for
 * somebody who has already opted into the panel, never a mode the game can wake up in.
 *
 * Storage discipline is `highscores.js`'s, for its reasons: `localStorage` is a getter that can
 * throw on access, Safari's private mode throws on *write* while reporting a healthy object, and a
 * full quota throws on `setItem`. Every path degrades to "no stash", because a debug panel that
 * breaks the game when storage is blocked is worse than one that forgets.
 *
 * The store is injectable so `tools/probe.mjs` can drive the whole thing in node against a fake,
 * including the throwing and corrupt cases — the half of this module a browser never reaches.
 */

/** Bumped if the shape changes. An unreadable version reads as "no stash", not a crash. */
const KEY = 'simtaxi.loco.v1';

/** The knobs a stash may carry. Anything else in the payload is dropped on the way in. */
const KEYS = ['kick', 'speed', 'accel', 'overdriveSpeed', 'overdriveAccel', 'brake',
  'sway', 'swayWave', 'chop', 'chopWave', 'fade'];

/**
 * Read lazily and behind a try: `globalThis.localStorage` *itself* throws when storage is blocked,
 * so this cannot be a module-level constant. In node it is simply absent, which is what lets this
 * module import cleanly in `npm run check`.
 */
function defaultStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Clean a stored payload into something `setLocoTuning` can be handed, or `null` for nothing
 * usable. Everything here has been outside the program — a hand-edited `localStorage`, a
 * half-written value from a tab that was killed mid-write, an older version of this game.
 *
 * A non-finite or non-positive number is dropped rather than clamped. `setLocoTuning` ignores
 * those too, so clamping here would only be a second opinion about the same value; dropping keeps
 * the two agreeing that a bad number means "no opinion", and the knob keeps its shipped default.
 * There is deliberately no upper bound: the sliders have one and this is what the console's
 * `__taxi.loco.set` writes through, so a stash is allowed to hold a number no slider can reach.
 */
function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of KEYS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** The stashed tuning, or `null` if there isn't one, storage is dead, or the payload is junk. */
export function loadLocoTuning(store = defaultStore()) {
  let text = null;
  try { text = store?.getItem(KEY) ?? null; } catch { return null; }
  if (!text) return null;
  try { return sanitise(JSON.parse(text)); } catch { return null; }
}

/**
 * Stash a tuning. Returns whether the write landed, so the panel can say "saved" rather than
 * claim it — a slider that reports a save storage refused is worse than one that says nothing.
 */
export function saveLocoTuning(tuning, store = defaultStore()) {
  const clean = sanitise(tuning);
  if (!clean) return false;
  try { store?.setItem(KEY, JSON.stringify(clean)); return true; } catch { return false; }
}

/** Forget it. The panel's Reset calls this, so reset means reset across a reload as well. */
export function clearLocoTuning(store = defaultStore()) {
  try { store?.removeItem(KEY); return true; } catch { return false; }
}
