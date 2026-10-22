import { createSpeech } from './speech.js';
import { createSeenFlag } from './progress.js';

/**
 * The story before the first run: four lines from dispatch, on the docked speech card, tapped
 * through between Play and the cut to the garage door. Shown once per device — the player who has
 * heard it once goes straight to the garage — and `?intro=classic` never shows it.
 * `?intro=always` shows it on every Play, for anyone working on it.
 *
 * Robo-taxis are flavour for now (Tyler, 2026-10-21): nothing in the run refers back to them yet.
 * The pitch is that they explain the controls — they stop at yellows and never speed, and the
 * player wins by doing everything they won't.
 *
 * Not `intro`: `#intro` is on ad-blocker filter lists (CLAUDE.md), hence `backstory`.
 */
export const BACKSTORY_LINES = [
  'Dispatch to Car 9. You there?',
  'City council signed that {robo-taxi} deal. Cars are going to be on the streets come Monday.',
  "Those rolling toasters brake for pigeons. No idea why people love 'em.",
  'Go remind this town what a real cab is all about.',
];

// A finished line nobody has tapped for this long gives the card a nudge, and again every this long
// after (Tyler, 2026-10-22): nothing else on screen says the story is waiting on a tap.
const NUDGE_AFTER = 3;
// The nudge: a hop and a smaller second one, like a dock icon asking for attention.
const NUDGE_HOPS = [0, -12, 0, -5, 0];
const NUDGE_MS = 650;

// Through progress.js, so Demo mode tells it on every Play and writes nothing.
let seenFlag = null;
const seen = () => (seenFlag ??= createSeenFlag({ key: 'simTaxi.backstorySeen' }));

export function backstoryMode() {
  if (typeof window === 'undefined') return 'once';
  const v = new URLSearchParams(window.location.search).get('intro');
  return v === 'classic' || v === 'always' ? v : 'once';
}

/** Will Play tell the story first? */
export function wantsBackstory(mode = backstoryMode()) {
  if (mode === 'classic') return false;
  if (mode === 'always') return true;
  return !seen().get();
}

/**
 * Tell the story inside `root` (the title screen, so it sits over the city and under nothing),
 * then call `done`. A tap anywhere finishes the line typing or moves to the next; Skip, or Escape,
 * ends it. Marked seen as it starts, so quitting halfway does not bring it back.
 */
export function tellBackstory(root, { done, lines = BACKSTORY_LINES }) {
  seen().set();
  const layer = document.createElement('div');
  layer.className = 'title-story';
  const talk = document.createElement('div');
  talk.className = 'title-story-talk';
  talk.setAttribute('role', 'status');
  talk.setAttribute('aria-live', 'polite');
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'title-story-skip';
  skip.textContent = 'Skip';
  layer.append(talk, skip);
  root.append(layer);

  let at = 0;
  let over = false;
  let raf = 0;
  // At the foot of the screen: there are no pedals up yet for the slot to sit over.
  const bubble = createSpeech(talk, {
    typing: true, onDismiss: () => next(), dockFloor: (vh, insets) => vh - insets.bottom - 8,
  });
  // Docked, the card ignores its target; under `?bubbles=classic` it points at the lower middle.
  const below = () => ({ x: window.innerWidth / 2, y: window.innerHeight * 0.72 });
  // Seconds the current line has sat finished and untapped.
  let idle = 0;
  const say = () => { idle = 0; bubble.show('Dispatch', lines[at], below); };
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  // On the card rather than the `.speech` it sits in, whose transform speech.js writes every frame.
  const nudge = () => talk.querySelector('.speech-card')?.animate(
    NUDGE_HOPS.map((y) => ({ transform: `translateY(${y}px)` })),
    { duration: NUDGE_MS, easing: 'ease-in-out' },
  );

  function finish() {
    if (over) return;
    over = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    bubble.hide();
    done();
  }
  function next() {
    at += 1;
    if (at >= lines.length) finish(); else say();
  }
  function onKey(event) {
    if (event.key === 'Escape') finish();
    else if (event.key === 'Enter' || event.key === ' ') bubble.tap();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  // The bubble types off a clock of its own (`update`), and the frame loop is parked behind the
  // title screen's gate, so the story drives it.
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    bubble.update(dt);
    last = now;
    if (bubble.isOpen() && !bubble.isTyping() && !still) {
      idle += dt;
      if (idle >= NUDGE_AFTER) { idle = 0; nudge(); }
    }
    if (!over) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  layer.addEventListener('click', (event) => {
    if (event.target === skip) finish(); else bubble.tap();
  });
  window.addEventListener('keydown', onKey, true);
  say();
  return { finish };
}
