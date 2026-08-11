/**
 * The high-score table — five runs, on this device and nowhere else.
 *
 * No server, no account, no sync. `localStorage` is the whole backend, which makes the failure
 * modes the interesting part of this module rather than the ranking.
 *
 * **Not `leaderboard.js`.** "Leaderboard" is the IAB's name for a 728×90 ad unit, and filter lists
 * carry generic rules against it — the same trap that keeps `beacon.js` and `#banner` out of this
 * codebase (see CLAUDE.md). A blocked module takes the whole graph down with
 * `ERR_BLOCKED_BY_CLIENT`, and nothing in the console says why. The DOM this feeds avoids the word
 * too: `#run-end .score-*`, never `.leaderboard`.
 *
 * **Every storage call is guarded, and a dead store is an empty table rather than an error.**
 * `localStorage` is not a property you can rely on: Safari's private mode throws `SecurityError` on
 * a *write* while reporting a perfectly good object, blocked third-party storage throws on the
 * property access itself, and a full quota throws on `setItem`. A game that dies on the game-over
 * screen because a score could not be saved is a far worse bug than one that quietly keeps no
 * scores, so every path here degrades to "no table" and the caller treats that as normal.
 *
 * **The store is injectable** — that is what lets `tools/scores.mjs` drive the whole thing in node
 * against a fake, including the throwing cases, which is the half of this module a browser test
 * would never reach.
 */

/** Bumped if the entry shape changes. An unreadable version reads as "no scores yet", not a crash. */
const KEY = 'simtaxi.scores.v1';

/** The last initials entered, so a repeat player confirms rather than retypes. See `lastName`. */
const NAME_KEY = 'simtaxi.initials';

/**
 * Five, not ten. The run-end card is capped at 358px and its own CSS is already fighting to keep
 * "Play again" above the fold on a landscape phone; ten rows loses that fight. Five is also about
 * as far back as anyone cares on a table only they will ever see.
 */
export const MAX_ENTRIES = 5;

/** Arcade initials. Three characters, A–Z and 0–9 — see `normaliseName`. */
export const NAME_LENGTH = 3;

/** What an entry is called when the player skips the prompt and has never entered a name. */
export const DEFAULT_NAME = 'AAA';

/**
 * Ids are only ever compared, never parsed. A run ends once per page load, so the counter cannot
 * collide with itself, and the timestamp keeps two tabs apart.
 */
let nextId = 0;
const makeId = (at) => `${at.toString(36)}-${(nextId++).toString(36)}`;

/**
 * The default store, read lazily and behind a try.
 *
 * `globalThis.localStorage` *itself* throws when storage is blocked — it is a getter, not a plain
 * property — so this cannot be a module-level constant. In node it is simply absent, which is what
 * lets this module import cleanly in `npm run check`.
 */
function defaultStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readRaw(store) {
  try { return store?.getItem(KEY) ?? null; } catch { return null; }
}

/** Returns whether the write landed, so a caller can tell "saved" from "storage refused". */
function writeRaw(store, text) {
  try { store?.setItem(KEY, text); return true; } catch { return false; }
}

/**
 * Clean one entry out of storage into something the board can render, or `null` to drop it.
 *
 * Everything here has been outside the program: a hand-edited `localStorage`, a half-written value
 * from a tab that was killed mid-write, or an older version of this game. The board renders with
 * `textContent` so there is nothing to inject, but an eleven-character name or a `NaN` cash figure
 * still breaks the layout, and a row that fails to render takes the screen with it.
 */
function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);
  const cash = count(raw.cash);
  const fares = count(raw.fares);
  const seconds = count(raw.seconds);
  if (cash === null || fares === null || seconds === null) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 32) : makeId(Date.now()),
    name: normaliseName(raw.name) || DEFAULT_NAME,
    cash,
    fares,
    seconds,
    // Stored but not shown. It is the one fact that tells two otherwise-similar runs apart, and
    // the row is too narrow to carry it — four columns is already what fits at the top of the
    // font-size clamp. Kept so a future row can show it without orphaning every existing score.
    shift: typeof raw.shift === 'string' ? raw.shift.slice(0, 24) : '',
    at: Number.isFinite(raw.at) ? raw.at : 0,
  };
}

/**
 * Ranking order: cash first, then fares, then the shorter run.
 *
 * Cash is the score — it is what the run-end card leads with and what the economy is built around.
 * The tie-breaks matter more than they look on a table this small: two runs that both cleared $200
 * are common, and "more fares for the same money" then "in less time" is the right way round,
 * because both describe a player who was working harder for it.
 *
 * Returns negative when `a` ranks ahead. Ties return 0, and `sort` is stable — so a new run that
 * ties an existing one lands *behind* it. The incumbent keeps the higher rank, which is the
 * convention every arcade table has used since arcade tables existed.
 */
function compare(a, b) {
  if (a.cash !== b.cash) return b.cash - a.cash;
  if (a.fares !== b.fares) return b.fares - a.fares;
  return a.seconds - b.seconds;
}

/**
 * Uppercase, A–Z and 0–9 only, three characters.
 *
 * Applied on the way in *and* on the way out. `text-transform: uppercase` in the CSS only changes
 * what is painted — the value stays exactly as typed — so a field that looks like it is shouting
 * saves "twa" without this.
 */
export function normaliseName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, NAME_LENGTH);
}

/** The table, best first. `[]` for absent, corrupt, or unreachable storage — all the same thing. */
export function loadScores(store = defaultStore()) {
  const text = readRaw(store);
  if (!text) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(parsed?.entries) ? parsed.entries : null;
  if (!list) return [];
  return list.map(sanitise).filter(Boolean).sort(compare).slice(0, MAX_ENTRIES);
}

function saveScores(entries, store) {
  return writeRaw(store, JSON.stringify({ v: 1, entries }));
}

/** The initials this device last entered, for pre-filling the prompt. `''` if there are none. */
export function lastName(store = defaultStore()) {
  try { return normaliseName(store?.getItem(NAME_KEY) ?? ''); } catch { return ''; }
}

function rememberName(name, store) {
  try { store?.setItem(NAME_KEY, name); } catch { /* a name we cannot remember is not a failure */ }
}

/**
 * Offer a finished run to the table.
 *
 * The score is written **immediately**, under the remembered name or `AAA`, and the returned
 * `setName` rewrites it afterwards. That ordering is deliberate: the player is asked for their
 * initials on a screen they can close at any moment, and a table that only saves once the prompt is
 * answered loses the run of anyone who shuts the tab on it. Naming is an edit to a saved score, not
 * a condition of saving one.
 *
 * Returns `{ rank, id, entries, setName }` — `rank` 1-based, or `null` when the run did not make
 * the table (in which case nothing was written and `setName` is a no-op, but `entries` still holds
 * the board so the caller can show it). `id` is how the board picks out the player's own row.
 */
export function recordRun({ cash, fares, seconds, shift = '' }, store = defaultStore()) {
  const at = Date.now();
  const entry = sanitise({
    id: makeId(at), name: lastName(store) || DEFAULT_NAME, cash, fares, seconds, shift, at,
  });
  const existing = loadScores(store);
  const missed = { rank: null, id: null, entries: existing, setName: () => existing };
  if (!entry) return missed;

  const ranked = [...existing, entry].sort(compare).slice(0, MAX_ENTRIES);
  const index = ranked.findIndex((row) => row.id === entry.id);
  // Sliced out by better runs: the table is unchanged, so there is nothing to write.
  if (index === -1) return missed;
  // A store that refuses the write still gets a board for this screen — the run happened, it just
  // will not be there next time. Reporting the rank the player earned beats pretending they missed.
  saveScores(ranked, store);

  return {
    rank: index + 1,
    id: entry.id,
    entries: ranked,
    /**
     * Name the run that was just recorded. Re-reads rather than trusting the array above, so a
     * second tab that scored in between is not clobbered by this one entry's edit, and returns the
     * table as it now stands for the board to redraw from.
     *
     * An empty commit — the player pressed OK on a field they had cleared — falls back to whatever
     * is *currently* on the row rather than to what the entry opened with. Those differ: the row
     * may already have been named by an earlier call in the same session, and falling back to the
     * opening value would quietly undo it.
     */
    setName: (raw) => {
      const current = loadScores(store);
      const row = current.find((item) => item.id === entry.id);
      const name = normaliseName(raw) || row?.name || entry.name;
      rememberName(name, store);
      if (!row) return current;      // pushed off the table by another tab while the prompt was up
      row.name = name;
      saveScores(current, store);
      return current;
    },
  };
}

/** Wipe the table. The initials are kept — they are a preference, not a score. */
export function clearScores(store = defaultStore()) {
  try { store?.removeItem(KEY); } catch { /* nothing to clear is the same as cleared */ }
}
