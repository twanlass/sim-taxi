/**
 * The one file in this project that knows actual audio bytes exist.
 *
 * **Vite-only syntax, and deliberately the only module with any.** `import.meta.glob` is a build
 * time transform, so this file cannot be imported by node — which is why it is absent from the
 * `BOOT` list in `tools/check.mjs` where every other browser-only module is listed. That is a real
 * hole in the guarantee, so `tools/audio.mjs` closes it from the other side: it reads this file as
 * text, checks the glob still points at `clips/` and still lists the extensions below, and compares
 * the manifest's basenames against what is actually on disk.
 *
 * **Through Vite rather than `public/`, and that is the important decision.** `public/sw.js` is
 * cache-first on unhashed filenames and bumps its `CACHE_NAME` by hand, so a sample dropped into
 * `public/` would reach an installed player exactly once and never again when it was replaced —
 * silently, forever. Imported here, every clip is content-hashed like the rest of `assets/`, so
 * cache-first is always correct and the problem does not exist. `tools/ios-sync.mjs` mirrors
 * `dist/`, so the `.ipa` picks them up with no extra work.
 *
 * **Adding a sound needs no code.** Drop a file in `src/audio/clips/` and name its basename in the
 * event's `clips` array in `events.js`. The glob finds it; nothing here is edited.
 *
 * AAC in `.m4a` is the format to deliver (`.ogg` is not safe on older iOS and this is an iPhone
 * game) but the others are accepted so an artist can audition a `.wav` without converting first —
 * the lab's drag-and-drop does not even need the file to be in the repo. See docs/audio.md.
 */

/**
 * Every clip in `clips/`, as `basename` → hashed URL.
 *
 * `eager` because the set is small, the manifest is walked at construction to decide what to
 * preload, and a lazy map would hand back promises for a lookup that wants to be a lookup.
 */
const FILES = import.meta.glob('./clips/*.{m4a,mp3,wav,ogg,aac,flac}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/**
 * `basename` (no extension) → URL.
 *
 * Keyed without the extension so `events.js` names a sound rather than a file, and an artist
 * swapping a `.wav` audition for the delivered `.m4a` does not touch the manifest. A basename
 * present twice under two extensions is a mistake worth catching rather than resolving by luck —
 * `tools/audio.mjs` fails on it.
 */
export const CLIP_URLS = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), url]),
);

/** How many clips are actually present. The lab says this out loud, because right now it is zero. */
export const CLIP_COUNT = Object.keys(CLIP_URLS).length;
