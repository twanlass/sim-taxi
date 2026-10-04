import { createSpeech } from './speech.js';

// "New Move Unlocked": the card that teaches the bootleg (game/bootleg.js) — hold Loco Mode, then
// tap the brake twice, and the taxi spins round onto the far lane.
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
// **When.** Once, ever, on the drop-off that brings the run to `AFTER_DELIVERED` fares — the first
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
// **The tutorial's own card.** It was first a full-screen dimmed screen with its own type and a
// caption, and Tyler wanted it to be the speech bubble every other tip is: pointed at the pedals it
// is about, with the row of buttons inside it and no words beyond the title and the name.

export const SEEN_KEY = 'simTaxi.seen.uturn';

/** Deliveries into a run before the card can show — robbery.js's MIN_DELIVERED; see above. */
export const AFTER_DELIVERED = 2;

/**
 * A beat after the drop-off before the card lands, in seconds of game time, so the payout pop and
 * the door have happened first and the card reads as the next thing rather than as interrupting
 * the last one.
 */
export const SHOW_DELAY = 0.9;

/**
 * Taps for this long after the card lands are ignored, in ms. It arrives on a timer, mid-run, under
 * a thumb that may well be tapping the city; the first tap after it appears should be one the
 * player meant for it.
 */
const TAP_GUARD_MS = 700;

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
// Nothing else — the pedal row is the instruction (Tyler, 2026-10-04: no caption, no "tap to
// continue"; every tutorial bubble is answered by a tap and this one is no different).
const TITLE = 'New Move Unlocked';
const LINE = 'U-Turn';

/**
 * The card itself: the game's speech bubble (game/speech.js) — the same card every tutorial tip
 * uses — pinned to the gas pedal, with the pedal row under its line. Browser-only: it clones the
 * HUD's pedal art.
 *
 * @param viewport  util/viewport.js
 * @param target    () => {x, y} | null — where the pointer touches: the top of the gas pedal
 * @param onClose   () => void — the card has been dismissed
 */
export function createNewMove({ viewport = null, target = () => null, onClose = () => {} } = {}) {
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
  const combo = document.createElement('div');
  combo.className = 'nm-combo';
  combo.setAttribute('aria-hidden', 'true');
  for (const [cls, id] of [['nm-boost', 'boost'], ['nm-brake nm-b1', 'brake'], ['nm-brake nm-b2', 'brake']]) {
    const key = document.createElement('div');
    key.className = `nm-key ${cls}`;
    const svg = art(id);
    if (svg) key.append(svg);
    combo.append(key);
  }

  const bubble = createSpeech(root, { viewport, typing: false });
  let open = false;
  let openedAt = 0;

  function close() {
    if (!open) return;
    open = false;
    bubble.hide();
    document.body.classList.remove('new-move-open');
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

  return {
    isOpen: () => open,
    /** Answers whether it opened. */
    open() {
      if (open) return false;
      open = true;
      openedAt = performance.now();
      // Restart the loop from the top, so every showing opens on the boost press rather than
      // wherever the animation happened to be left.
      combo.classList.remove('is-playing');
      bubble.show(TITLE, LINE, target, combo);
      void combo.offsetWidth;
      combo.classList.add('is-playing');
      document.body.classList.add('new-move-open');
      return true;
    },
    close,
    /** Keeps the bubble pinned to the pedal. Called from the frozen frame, on wall time. */
    update: (dt) => bubble.update(dt),
  };
}
