import { createSpeech } from './speech.js';

// "New Move Unlocked": the card that teaches a move the player cannot find by looking — the bootleg
// (game/bootleg.js: hold Loco Mode, then tap the brake twice, and the taxi spins round onto the far
// lane) and the drift (`driftTaxi` in sim/traffic.js: Loco Mode, a tap of the brake just before a
// turn, Loco Mode again, and the taxi slides round the corner and kicks out of it). One card, one
// move at a time; main.js says which (`MOVES` below).
//
// What follows was written for the U-turn, the first of them, and holds for both.
//
// The bootleg is the one control in the game a player cannot find by looking. Every other input is
// a button that does what it says the first time it is pressed; this one is a *sequence* on two
// buttons that each already do something else, inside a 350ms window, and only while Loco Mode is
// engaged. Nobody stumbles into that. A bubble saying it in words was the obvious first shape and
// it is the wrong one: "boost, then brake twice" read as a sentence is three instructions, and the
// thing that has to land is the *rhythm* — one long press, then two short ones. So the card shows
// the buttons themselves (the real pedal art, cloned off the HUD) and plays the sequence on them on
// a loop: each starts dimmed, and comes up to full colour as it is pressed, so the order is the
// order things light up in.
//
// **When.** The U-turn: once, ever, on the drop-off that brings the run to `AFTER_DELIVERED` fares — the first
// moment a robbery is allowed to happen (robbery.js `MIN_DELIVERED`), which is what the move exists
// for: the cut-off cops sit in the junctions *ahead* of the taxi and a 180 puts every one of them
// behind it. Taught any later and the first chase can arrive before it; taught earlier and it is
// a fourth new thing landing on top of the opening tutorial's Loco Mode beat, which this
// deliberately waits out (main.js gates it on the tutorial being done), because a move built on
// Loco Mode makes no sense to someone who has not been shown Loco Mode yet. A drop-off is a calm
// beat: nothing is chasing anyone, the seat has just emptied, and the next fare has not been
// picked. A drop-off that *starts* something — a delivered robber hands the taxi a patrol chase —
// is not, and main.js skips it and waits for the next one.
//
// The drift comes after it, from `MOVES.drift.after` deliveries and never on the same drop-off — two
// cards back to back is a lecture, and the drift reads as the second chapter of the same idea (the
// brake is a Loco Mode button too). It waits for the U-turn's card to have been seen, so a run whose
// early drop-offs were all busy still shows them in order, one drop-off apart at the least.
//
// **Remembered**, unlike the opening tutorial, which runs every game on purpose (see tutorial.js).
// That one is a tap long and is also the only thing that shows a returning player which car is
// theirs. This one stops the world and asks to be read, and a card announcing a move as "new" on
// every retry is a card that is lying by the second. Soft-failing like settings.js: a store that
// throws costs the memory, and the card shows once per visit rather than once ever.
//
// **The world stops**, exactly as it does for the robber's line and the pause (an early return
// from `frame()` that still draws). The card lands mid-run with the clocks running, and a player
// reading an animation is not driving.
//
// **The tutorial's own card, with the move acted out in it.** It was first a full-screen dimmed
// screen with its own type and a caption; Tyler wanted the speech bubble every other tip is, with
// no words beyond the title and the name; and then a clip of the taxi doing it between the name and
// the buttons, the buttons pressed in time with the clip so the two connect (game/uturnclip.js),
// the card wide enough to show it and the screen dimmed under it.

export const SEEN_KEY = 'simTaxi.seen.uturn';

/** Deliveries into a run before the card can show — robbery.js's MIN_DELIVERED; see above. */
export const AFTER_DELIVERED = 2;

/**
 * The moves, in the order they are taught. `after` is the deliveries into a run before each can
 * show; `keys` the pedal row, each [name, HUD button] — the name is what the clip's `clipKeys` answers
 * for (game/uturnclip.js, game/driftclip.js).
 */
export const MOVES = {
  uturn: {
    seenKey: SEEN_KEY, after: AFTER_DELIVERED, line: 'U-Turn',
    keys: [['boost', 'boost'], ['brake1', 'brake'], ['brake2', 'brake']],
  },
  drift: {
    seenKey: 'simTaxi.seen.drift', after: 4, line: 'Drift',
    keys: [['boost', 'boost'], ['brake', 'brake'], ['kick', 'boost']],
  },
};

/**
 * The same card for the depot (game/repairclip.js), which is not a move and is not taught on a
 * drop-off: it goes up once ever, a beat after the taxi first starts smoking (`SMOKE_FRACTION`),
 * which is when the "Head to the shop for repairs." bubble it replaced used to (Tyler, 2026-10-06).
 * No pedal row — the instruction is a tap, and the clip shows a finger making it on the door — so the
 * line carries it in words, and the eyebrow is the depot's own name rather than "New Move Unlocked",
 * which a repair is not. Kept out of MOVES because main.js walks those in order on drop-offs.
 */
export const REPAIR = {
  seenKey: 'simTaxi.seen.repair', title: 'Taxi Depot', line: 'Tap for Repairs', keys: [],
};

/**
 * A beat after the drop-off before the card lands, in seconds of game time, so the payout pop and
 * the door have happened first and the card reads as the next thing rather than as interrupting
 * the last one.
 */
export const SHOW_DELAY = 0.9;

/**
 * Taps for this long after the card lands are ignored, in ms. Any tap or key press dismisses it
 * (Tyler, 2026-10-04) — but it arrives on a timer, mid-run, under a thumb that may already be
 * coming down on the city, and that tap should not close a card nobody has seen yet. It was 700ms;
 * 300 is about the shortest a deliberate tap follows something appearing.
 */
const TAP_GUARD_MS = 300;

/**
 * @param {object} opts
 * @param {Storage | null} [opts.storage]  Injected for the headless checks; the page's own otherwise.
 */
export function createSeenFlag({ storage, key = SEEN_KEY } = {}) {
  const store = () => {
    if (storage !== undefined) return storage;
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
  };
  let seen;
  try { seen = store()?.getItem(key) === '1'; } catch { seen = false; }
  return {
    get: () => seen,
    set() {
      seen = true;
      try { store()?.setItem(key, '1'); } catch { /* soft: this visit only */ }
    },
  };
}

// The card's words: the tutorial bubble's title slot carries the eyebrow, its line the move's name.
// Nothing else — the clip and the pedal row are the instruction (Tyler, 2026-10-04: no caption, no "tap to
// continue"; every tutorial bubble is answered by a tap and this one is no different).
const TITLE = 'New Move Unlocked';

/**
 * The card itself: the game's speech bubble (game/speech.js) — the same card every tutorial tip
 * uses — centred on the screen over a dim, with no pointer. Under its line, the clip of the move
 * (game/moveclip.js) and under that the pedal row, which the clip's own clock presses.
 * Browser-only: it clones the HUD's pedal art.
 *
 * `open(move)` takes one of MOVES (or REPAIR; `title` overrides the eyebrow) with two more fields from main.js: `clipKeys` (the clip module's
 * own) and `makeClip`, (canvas) => clip | null, which films the clip in the city — null when there is
 * nowhere to film it, and the card shows without one.
 *
 * @param viewport  util/viewport.js
 * @param onClose   () => void — the card has been dismissed
 */
export function createNewMove({ viewport = null, onClose = () => {} } = {}) {
  const root = document.getElementById('new-move');
  const idle = { isOpen: () => false, open: () => false, close: () => {}, update: () => {} };
  if (!root) return idle;

  // The real buttons, so the card can never drift from what is on the screen under it. `<defs>` are
  // left behind — the gradients and filters they hold are already in the document under the same
  // ids, and a second copy would be duplicate ids — so the clones resolve their `url(#…)`s against
  // the HUD's originals.
  const art = (id) => {
    const svg = document.querySelector(`#${id} .pedal-art`)?.cloneNode(true);
    if (!svg) return null;
    svg.querySelector('defs')?.remove();
    svg.removeAttribute('class');
    return svg;
  };
  const media = document.createElement('div');
  media.className = 'nm-media';
  const canvas = document.createElement('canvas');
  canvas.className = 'nm-clip';
  const combo = document.createElement('div');
  combo.className = 'nm-combo';
  combo.setAttribute('aria-hidden', 'true');
  media.append(canvas, combo);
  // All three keys at one size, a "+" between each (Tyler, 2026-10-04): the row is a recipe, and
  // the HUD's big-gas/small-brake sizing read as a hierarchy that is not in the combo. Built per
  // move, on open.
  let keys = {};
  function buildKeys(row) {
    combo.replaceChildren();
    combo.hidden = !row.length;
    keys = {};
    for (const [name, id] of row) {
      if (combo.childElementCount) {
        const plus = document.createElement('span');
        plus.className = 'nm-plus';
        plus.textContent = '+';
        combo.append(plus);
      }
      const key = document.createElement('div');
      key.className = `nm-key nm-${id}`;
      const svg = art(id);
      if (svg) key.append(svg);
      combo.append(key);
      keys[name] = key;
    }
  }

  const bubble = createSpeech(root, { viewport, typing: false });
  // Centred on the screen. The speech card stands *above* its target, so the target is the middle
  // of the screen pushed down by half the card's own height (measured live: the clip sizes itself
  // to the viewport's width).
  const card = () => root.querySelector('.speech-card');
  const target = () => {
    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    return { x: w / 2, y: h / 2 + (card()?.offsetHeight ?? 0) / 2 };
  };
  let clip = null;
  let move = null;
  let open = false;
  let openedAt = 0;

  function pressKeys() {
    const state = move.clipKeys(clip ? clip.time : 0);
    for (const [name, key] of Object.entries(keys)) {
      key.classList.toggle('is-lit', state[name].lit);
      key.classList.toggle('is-down', state[name].down);
    }
  }

  function close() {
    if (!open) return;
    open = false;
    bubble.hide();
    document.body.classList.remove('new-move-open');
    // Shown once ever, so the context goes with it rather than sitting idle for the rest of the run.
    clip?.dispose();
    clip = null;
    onClose();
  }

  // The layer is a full-screen catcher while it is up (`body.new-move-open #new-move`), so a tap
  // anywhere lands here rather than on the canvas — the robber's line's arrangement. `click`, so the
  // click that follows the press does not fall through to the city either.
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!open || performance.now() - openedAt < TAP_GUARD_MS) return;
    close();
  });
  // Any key too. Captured on `window` and swallowed, so the Space or B that closes the card does not
  // also go on to boost or brake a taxi the player was not looking at.
  window.addEventListener('keydown', (e) => {
    if (!open) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || performance.now() - openedAt < TAP_GUARD_MS) return;
    close();
  }, { capture: true });

  return {
    isOpen: () => open,
    /** The move on the card, or null. */
    move: () => (open ? move : null),
    /** Answers whether it opened. */
    open(next) {
      if (open) return false;
      open = true;
      move = next;
      openedAt = performance.now();
      buildKeys(move.keys);
      canvas.hidden = false;
      // Shown first, so the card's canvas has its size before the clip measures it.
      bubble.show(move.title ?? TITLE, move.line, target, media);
      try { clip = move.makeClip(canvas); } catch (err) { console.warn(`${move.line} clip:`, err); clip = null; }
      // Nowhere to film: the card without a clip, re-measured.
      if (!clip) { canvas.hidden = true; bubble.show(move.title ?? TITLE, move.line, target, media); }
      pressKeys();
      document.body.classList.add('new-move-open');
      return true;
    },
    close,
    /** The clip, the keys it presses and the bubble's placement. Called from the frozen frame, on
     * wall time. Answers whether the clip drew the frame (main.js draws it otherwise). */
    update(dt) {
      if (!open) return false;
      clip?.update(dt);
      pressKeys();
      bubble.update(dt);
      return Boolean(clip);
    },
    /** Seek the clip — for the screenshot tooling. */
    seek(t) { if (clip) { clip.restart(); clip.update(t); pressKeys(); } },
  };
}
