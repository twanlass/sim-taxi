/**
 * What the player has seen and earned, and Demo mode, which pretends they have seen nothing.
 *
 * Every "once ever" moment in the game is a flag in `localStorage`: the New Move cards, the depot's
 * repair tip, anything a race win unlocks. They all go through the two constructors here and
 * nowhere else, so that one switch can override every one of them — a new one-time moment that
 * makes its flag with `createSeenFlag` is covered by Demo mode without anyone remembering to wire
 * it up, and one that rolls its own `getItem` is not.
 *
 * **Demo mode** (Tyler, 2026-10-21: "when on always show things that are temporal like unlocked
 * combos, intro story"). For showing the game to someone: every run plays as if it were the
 * player's first — every seen flag reads unseen, every unlock reads unlocked — and *none of it is
 * written*. A seen flag in Demo mode keeps a shadow in memory, so a card shown once is not shown
 * twice in the same run (a run is a page load: Play again reloads), and the real flag underneath
 * is never touched. Switch Demo mode off and the player's own progress is exactly where it was.
 * The high-score table is not progress in this sense and is left alone; a demo run that sets a
 * score keeps it.
 *
 * Where it lives: a switch at the bottom of the title screen's Settings page, which is only there
 * once it has been revealed — by opening the game with `?demo`, or by tapping the Settings heading
 * five times (the App Store build has no URL bar). A player who never goes looking never sees it.
 * `?demo` also turns it on for that load without saving anything; `?demo=off` forces it off.
 *
 * Soft-failing like settings.js: a store that throws costs the memory, never the screen.
 */

export const DEMO_KEY = 'simTaxi.demo';
/**
 * '1' once the Settings rows have been revealed, so they stay there on later visits; '0' once they
 * have been hidden again (the same five taps, Tyler 2026-10-25: set things up for a demo, then put
 * them away before the audience sees the screen). Hidden outranks Demo mode being on or `?demo`,
 * which otherwise reveal the rows by themselves.
 */
export const DEMO_ROW_KEY = 'simTaxi.demo.row';
/** sessionStorage: the last card Demo mode rotated to (`demoRotate`). */
export const DEMO_TURN_KEY = 'simTaxi.demo.turn';

const pageStore = () => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};
const sessionStore = () => {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null; } catch { return null; }
};
const read = (store, key) => { try { return store?.getItem(key) ?? null; } catch { return null; } };
const write = (store, key, value) => { try { store?.setItem(key, value); } catch { /* soft */ } };

/**
 * @param {object} [opts]
 * @param {Storage | null} [opts.storage]  Injected for the headless checks; the page's own otherwise.
 * @param {Storage | null} [opts.session]  Likewise for sessionStorage.
 * @param {string} [opts.search]           The query string; the page's own otherwise.
 */
export function createDemo({ storage, session, search } = {}) {
  const store = () => (storage !== undefined ? storage : pageStore());
  const sess = () => (session !== undefined ? session : sessionStore());
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const param = new URLSearchParams(query).get('demo');
  // `?demo` (any value but off) forces it on, `?demo=off` off; neither is saved.
  const forced = param === null ? null : param !== 'off';
  let saved = read(store(), DEMO_KEY) === '1';
  const row = read(store(), DEMO_ROW_KEY);
  let revealed = row === '1' || (row !== '0' && (forced !== null || saved));
  const listeners = new Set();
  return {
    on: () => forced ?? saved,
    /** True when the URL decides, and the Settings switch would be overruled. */
    forced: () => forced !== null,
    set(on) {
      saved = Boolean(on);
      write(store(), DEMO_KEY, saved ? '1' : '0');
      for (const fn of listeners) fn(forced ?? saved);
    },
    revealed: () => revealed,
    reveal() {
      revealed = true;
      write(store(), DEMO_ROW_KEY, '1');
    },
    /** Hide the rows again. Demo mode itself stays as it is. */
    conceal() {
      revealed = false;
      write(store(), DEMO_ROW_KEY, '0');
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * The next of `items` for this run to show, rotating across runs in this tab: the one after the
     * one the last run took. Demo mode needs it for anything shown one-at-a-time in order (the New
     * Move cards): with every flag unseen, "the first unseen" is the same card every run.
     */
    rotate(items, slot = 'card') {
      if (!items.length) return null;
      const key = `${DEMO_TURN_KEY}.${slot}`;
      const raw = read(sess(), key);
      const last = raw === null ? -1 : Number(raw);
      const next = Number.isInteger(last) && last >= 0 ? (last + 1) % items.length : 0;
      write(sess(), key, String(next));
      return items[next];
    },
  };
}

let shared = null;
/** The page's own Demo mode, made on first use. */
export function demoMode() {
  shared ??= createDemo();
  return shared;
}

/**
 * A "once ever" flag: unseen until `set()`, remembered across loads. Under Demo mode it reads
 * unseen at the start of every run and `set()` only marks this run.
 *
 * @param {object} opts
 * @param {string} opts.key
 * @param {Storage | null} [opts.storage]  Injected for the headless checks; the page's own otherwise.
 * @param {ReturnType<typeof createDemo>} [opts.demo]
 */
export function createSeenFlag({ storage, key, demo } = {}) {
  const store = () => (storage !== undefined ? storage : pageStore());
  const mode = () => demo ?? (storage === undefined ? demoMode() : null);
  let seen = read(store(), key) === '1';
  let shadow = false;
  return {
    get: () => (mode()?.on() ? shadow : seen),
    set() {
      if (mode()?.on()) { shadow = true; return; }
      seen = true;
      write(store(), key, '1');
    },
  };
}

/**
 * A reward the player earns once and keeps. Under Demo mode it reads earned, and earning it writes
 * nothing — a demo run does not hand out real unlocks.
 */
export function createUnlockFlag({ storage, key, demo } = {}) {
  const store = () => (storage !== undefined ? storage : pageStore());
  const mode = () => demo ?? (storage === undefined ? demoMode() : null);
  let earned = read(store(), key) === '1';
  return {
    get: () => Boolean(mode()?.on()) || earned,
    set() {
      if (mode()?.on()) return;
      earned = true;
      write(store(), key, '1');
    },
  };
}
