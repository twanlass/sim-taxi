/**
 * Headless checks for the audio system — see docs/audio.md.
 *
 * **Audio is the one output in this game that silence cannot be told apart from success.** A feature
 * that renders nothing is indistinguishable from one that was never wired up — that is written down
 * in CLAUDE.md because the boats' wake was missing for weeks under a comment claiming it worked — and
 * a sound has it worse: no pixel changes, nothing is logged, and the only witness is an ear that is
 * not in CI. So everything here asserts a *correspondence* rather than a behaviour: that the manifest,
 * the folder, the call sites and the credits all still describe the same set of sounds.
 *
 * It is also the only cover for `src/audio/clips.js`, which cannot be in `tools/check.mjs`'s `BOOT`
 * list because `import.meta.glob` is Vite-only syntax that node cannot evaluate. That file is checked
 * from the outside here, as text.
 *
 *   node tools/audio.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENTS, EVENT_NAMES, BUSES, assertEvent } from '../src/audio/events.js';
import { shippedMix, MIX_KEYS } from '../src/audio/mix.js';
import { createAudio } from '../src/audio/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLIP_DIR = path.join(root, 'src/audio/clips');
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|aac|flac)$/i;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- The manifest itself ------------------------------------------------------

check('every event names a known bus',
  EVENT_NAMES.every((n) => BUSES.includes(EVENTS[n].bus)),
  EVENT_NAMES.map((n) => `${n}:${EVENTS[n].bus}`).join(' '));

const numbersSane = EVENT_NAMES.filter((n) => {
  const e = EVENTS[n];
  return !(e.gain >= 0 && e.gain <= 2 && e.pitch >= 0 && e.pitch < 0.5
    && e.cooldown >= 0 && e.cooldown <= 2 && Number.isInteger(e.voices) && e.voices >= 1);
});
check('every event\'s numbers are in range', numbersSane.length === 0,
  numbersSane.length ? `out of range: ${numbersSane.join(', ')}` : `${EVENT_NAMES.length} events`);

check('assertEvent rejects an unknown name',
  (() => { try { assertEvent('definitely-not-an-event'); return false; } catch { return true; } })());

// The shipped mix has to be the shape the stash and a pasted blob are validated against, or the lab's
// "Apply" button and `audiostash` are checking a different contract from the one the player reads.
const mix = shippedMix();
check('shippedMix() has every MIX_KEYS entry', MIX_KEYS.every((k) => k in mix), MIX_KEYS.join(', '));
check('every bus in the mix is a known bus',
  Object.keys(mix.buses).every((b) => BUSES.includes(b)), Object.keys(mix.buses).join(' '));
check('every bus declares a voice cap',
  Object.values(mix.buses).every((b) => Number.isInteger(b.voices) && b.voices >= 1),
  Object.entries(mix.buses).map(([k, v]) => `${k}:${v.voices}`).join(' '));
// A duck table naming a bus that does not exist would silently never fire.
const duckBad = Object.entries(mix.duck.table).flatMap(([from, to]) =>
  [from, ...Object.keys(to)].filter((b) => !BUSES.includes(b)));
check('the duck table only names known buses', duckBad.length === 0, duckBad.join(' ') || 'sfx→music');

// --- The player, constructed in node -----------------------------------------
//
// The whole point of the injectable clip map: the half a browser never reaches — no Web Audio at all —
// is the half that must not throw, because `tools/check.mjs` boots this module and `main.js` builds a
// player on every load before any gesture has happened.

const silent = createAudio();
check('createAudio() constructs with no Web Audio', silent.state.error === null && !silent.state.ready);
check('play() on a clipless event returns false, not a throw', silent.play('pick') === false);
check('play() rejects an unknown event', (() => {
  try { silent.play('nope'); return false; } catch { return true; }
})());
await silent.unlock();
check('unlock() degrades to an error string rather than throwing',
  silent.state.error === 'no Web Audio', String(silent.state.error));

// --- The manifest against the folder ----------------------------------------

const entries = (await readdir(CLIP_DIR)).filter((f) => AUDIO_EXT.test(f));
const basenames = entries.map((f) => f.replace(AUDIO_EXT, ''));
const duplicates = basenames.filter((b, i) => basenames.indexOf(b) !== i);
// Two extensions of one basename is ambiguous — `clips.js` keys on the basename, so which one wins
// would come down to glob order. Better a failure than a coin toss.
check('no basename appears twice under two extensions', duplicates.length === 0,
  duplicates.join(', ') || `${entries.length} clip files`);

const named = EVENT_NAMES.flatMap((n) => EVENTS[n].clips);
const missing = named.filter((b) => !basenames.includes(b));
check('every clip named in the manifest exists in clips/', missing.length === 0,
  missing.length ? `named but absent: ${missing.join(', ')}` : `${named.length} named`);

const orphans = basenames.filter((b) => !named.includes(b));
// An orphan is either a typo in the manifest or dead weight in the bundle, and both are worth a
// failure: the file is imported by the glob and shipped whether or not anything plays it.
check('no clip in clips/ is unnamed by any event', orphans.length === 0,
  orphans.length ? `present but unused: ${orphans.join(', ')}` : 'none');

// --- Licensing ---------------------------------------------------------------
//
// A game heading for the App Store cannot carry audio whose licence nobody wrote down, and the moment
// to catch that is the commit that adds the file, not the submission.

const credits = await readFile(path.join(CLIP_DIR, 'CREDITS.md'), 'utf8');
const undocumented = basenames.filter((b) => !credits.includes(b));
check('every clip has a row in CREDITS.md', undocumented.length === 0,
  undocumented.length ? `no provenance: ${undocumented.join(', ')}` : `${basenames.length} clips documented`);

// --- clips.js, checked as text ------------------------------------------------

const clipsSrc = await readFile(path.join(root, 'src/audio/clips.js'), 'utf8');
check('clips.js still globs ./clips/', clipsSrc.includes("import.meta.glob('./clips/"));
check('clips.js still accepts every extension the checks allow',
  ['m4a', 'mp3', 'wav', 'ogg', 'aac', 'flac'].every((e) => clipsSrc.includes(e)));
// The reason clips may not live in `public/`, asserted rather than trusted: `sw.js` is cache-first on
// unhashed filenames, so a sample moved there would stop reaching installed players the moment it was
// replaced, silently and for ever.
//
// Tested on the folder rather than on this file's text. The first cut of this check grepped `clips.js`
// for the string `public/` and failed on the *comment explaining why not to use it* — which is the
// trap CLAUDE.md records twice over: a check written wrong fails in exactly the same way as the bug it
// is looking for. What matters is where the bytes are, so that is what is measured.
const publicAudio = (await readdir(path.join(root, 'public'))).filter((f) => AUDIO_EXT.test(f));
check('no clip is served from public/', publicAudio.length === 0,
  publicAudio.length ? `unhashed audio in public/: ${publicAudio.join(', ')}` : 'none');
// The glob's target, separately — a comment may mention `public/`, the glob may not point at it.
check('the clip glob points at ./clips/, not public/',
  /import\.meta\.glob\('\.\/clips\//.test(clipsSrc) && !/glob\('[^']*public/.test(clipsSrc));

// --- Call sites --------------------------------------------------------------
//
// The check that actually catches the failure this file exists for: a `cue()`/`sound()` naming an
// event that is not in the manifest plays nothing, for ever, with no error anywhere.

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

const cueCalls = [];
for await (const file of walk(path.join(root, 'src'))) {
  const src = await readFile(file, 'utf8');
  for (const m of src.matchAll(/\b(?:cue|sound)\(\s*'([^']+)'/g)) {
    cueCalls.push({ file: path.relative(root, file), name: m[1] });
  }
}
const bogus = cueCalls.filter((c) => !EVENT_NAMES.includes(c.name));
check('every cue()/sound() call site names an event in the manifest', bogus.length === 0,
  bogus.length ? bogus.map((c) => `${c.file}:${c.name}`).join(' ') : `${cueCalls.length} call sites`);

// The eight that already had a haptic are the eight that should now have both. A site that buzzes
// without sounding is the drift `util/feedback.js` exists to prevent, so it is asserted rather than
// trusted to code review.
const wired = new Set(cueCalls.map((c) => c.name));
const unwired = EVENT_NAMES.filter((n) => !wired.has(n));
check('every event in the manifest is fired from somewhere', unwired.length === 0,
  unwired.length ? `declared but never played: ${unwired.join(', ')}` : `${wired.size} wired`);

// --- Summary -----------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
