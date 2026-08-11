/**
 * The high-score table, driven against a fake `localStorage`.
 *
 * Everything interesting about `game/highscores.js` is a failure mode a browser will not show you
 * on the machine it is developed on: a store that throws on read, one that throws on write, a
 * corrupt payload, a hand-edited entry with a NaN in it. Those are exactly the cases that surface
 * as "my scores vanished" months later, and a fake store is the only way to reach them on purpose.
 *
 * The ranking is asserted here too, tie-breaks included, because the order of a five-row table is
 * the one thing the player will notice being wrong immediately.
 *
 *   node tools/scores.mjs
 */
import {
  loadScores, recordRun, clearScores, lastName, normaliseName, MAX_ENTRIES, DEFAULT_NAME,
} from '../src/game/highscores.js';

const results = [];
const failures = [];

function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A `localStorage` that can be told to misbehave.
 *
 * `throwOnRead` / `throwOnWrite` are the two shapes the real thing takes when it is unhappy —
 * Safari's private mode throws on `setItem` while reading back fine, and blocked storage throws on
 * everything.
 */
function fakeStore({ throwOnRead = false, throwOnWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(key) {
      if (throwOnRead) throw new Error('SecurityError: storage is blocked');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnWrite) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
  };
}

/** A run, with only the fields that rank. */
const run = (cash, fares = 5, seconds = 60) => ({ cash, fares, seconds, shift: 'Early Shift' });

const names = (store) => loadScores(store).map((e) => e.name).join(',');
const cashes = (store) => loadScores(store).map((e) => e.cash).join(',');

// --- Recording and order ----------------------------------------------------
{
  const store = fakeStore();
  const first = recordRun(run(100), store);
  check('a first run takes rank 1', first.rank === 1, `rank ${first.rank}`);
  check('and is written to the store', loadScores(store).length === 1);
  check('unnamed runs open on the default name',
    loadScores(store)[0].name === DEFAULT_NAME, loadScores(store)[0].name);

  check('a better run takes the top', recordRun(run(300), store).rank === 1);
  check('a worse run lands under it', recordRun(run(50), store).rank === 3);
  check('the table is ordered by cash', cashes(store) === '300,100,50', cashes(store));
}

// --- The cap ----------------------------------------------------------------
{
  const store = fakeStore();
  for (const cash of [10, 20, 30, 40, 50, 60]) recordRun(run(cash), store);
  check(`the table caps at ${MAX_ENTRIES}`, loadScores(store).length === MAX_ENTRIES,
    `${loadScores(store).length} rows`);
  check('and keeps the best of them', cashes(store) === '60,50,40,30,20', cashes(store));

  const missed = recordRun(run(5), store);
  check('a run off the bottom gets no rank', missed.rank === null, `rank ${missed.rank}`);
  check('and does not touch the table', cashes(store) === '60,50,40,30,20', cashes(store));
  check('but is still handed the board to show', missed.entries.length === MAX_ENTRIES);
}

// --- Tie-breaks -------------------------------------------------------------
{
  const store = fakeStore();
  recordRun({ ...run(100, 4, 90), shift: '' }, store);
  recordRun({ ...run(100, 7, 90), shift: '' }, store);
  check('equal cash breaks on fares', loadScores(store)[0].fares === 7, `${loadScores(store)[0].fares}`);

  const quick = fakeStore();
  recordRun({ ...run(100, 5, 120), shift: '' }, quick);
  recordRun({ ...run(100, 5, 40), shift: '' }, quick);
  check('equal cash and fares breaks on the shorter run',
    loadScores(quick)[0].seconds === 40, `${loadScores(quick)[0].seconds}`);

  // Stable sort, new entry pushed last: an exact tie leaves the incumbent ahead.
  const tied = fakeStore();
  recordRun(run(100), tied).setName('OLD');
  const second = recordRun(run(100), tied);
  check('an exact tie ranks behind the incumbent', second.rank === 2, `rank ${second.rank}`);
  check('and the incumbent keeps the top row', loadScores(tied)[0].name === 'OLD');
}

// --- Names ------------------------------------------------------------------
{
  check('names are uppercased', normaliseName('twa') === 'TWA');
  check('punctuation and spaces are dropped', normaliseName('a-b c!d') === 'ABC');
  check('and they are capped at three', normaliseName('LONGER') === 'LON');
  check('a nameless name is empty, not a default', normaliseName('...') === '');
  check('a non-string is empty', normaliseName(null) === '' && normaliseName(7) === '');

  const store = fakeStore();
  const scored = recordRun(run(100), store);
  scored.setName('twa');
  check('setName writes through to the table', names(store) === 'TWA', names(store));
  check('and is remembered for next time', lastName(store) === 'TWA', lastName(store));
  check('so the next run opens pre-filled', recordRun(run(90), store).entries
    .find((e) => e.cash === 90).name === 'TWA');

  scored.setName('');
  check('an empty commit keeps the name already on the row', names(store).startsWith('TWA'),
    names(store));
}

// --- Corrupt and hostile payloads -------------------------------------------
{
  const store = fakeStore();
  store.setItem('simtaxi.scores.v1', '{not json');
  check('corrupt JSON reads as an empty table', loadScores(store).length === 0);
  check('and a fresh run still records over it', recordRun(run(100), store).rank === 1);

  const shaped = fakeStore();
  shaped.setItem('simtaxi.scores.v1', JSON.stringify({ v: 1, entries: 'nope' }));
  check('a non-array entries field reads empty', loadScores(shaped).length === 0);

  const junk = fakeStore();
  junk.setItem('simtaxi.scores.v1', JSON.stringify({
    v: 1,
    entries: [
      { name: 'OK', cash: 100, fares: 3, seconds: 60, at: 1 },
      { name: 'BAD', cash: Number.NaN, fares: 3, seconds: 60, at: 2 },
      { name: 'INF', cash: Infinity, fares: 3, seconds: 60, at: 3 },
      null,
      'not an object',
      { name: 'ELEVENCHARS', cash: 50, fares: 2, seconds: 30, at: 4 },
    ],
  }));
  const cleaned = loadScores(junk);
  check('unparseable rows are dropped', cleaned.length === 2, `${cleaned.length} survived`);
  check('an over-long name is cut to three', cleaned.some((e) => e.name === 'ELE'),
    cleaned.map((e) => e.name).join(','));

  const negative = fakeStore();
  negative.setItem('simtaxi.scores.v1', JSON.stringify({
    v: 1, entries: [{ name: 'NEG', cash: -500, fares: -1, seconds: -9, at: 1 }],
  }));
  check('negative figures clamp to zero rather than out-ranking everything',
    loadScores(negative)[0].cash === 0);
}

// --- A store that will not co-operate ---------------------------------------
{
  const blind = fakeStore({ throwOnRead: true });
  check('a store that throws on read is an empty table', loadScores(blind).length === 0);
  check('and recording against it does not throw', recordRun(run(100), blind).rank === 1);
  check('lastName survives it too', lastName(blind) === '');

  const readonly = fakeStore({ throwOnWrite: true });
  const scored = recordRun(run(100), readonly);
  check('a store that throws on write still reports the rank earned',
    scored.rank === 1, `rank ${scored.rank}`);
  check('and hands back a board to render', scored.entries.length === 1);
  check('naming it does not throw either', (() => {
    try { scored.setName('ABC'); return true; } catch { return false; }
  })());
  check('nothing was persisted', loadScores(readonly).length === 0);

  check('no store at all is an empty table', loadScores(null).length === 0);
  check('and recording into nothing does not throw', recordRun(run(100), null).rank === 1);
}

// --- Clearing ---------------------------------------------------------------
{
  const store = fakeStore();
  recordRun(run(100), store).setName('TWA');
  clearScores(store);
  check('clearing empties the table', loadScores(store).length === 0);
  check('but keeps the initials — a preference, not a score', lastName(store) === 'TWA');
}

const passed = results.filter(Boolean).length;
for (const line of failures.slice(0, 12)) console.log(`  FAIL ${line}`);
console.log(`${passed}/${results.length} checks passed`);
process.exit(failures.length ? 1 : 0);
