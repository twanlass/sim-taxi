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

// A word that punches once its line has finished typing: scales up and shakes, in the line's own
// black type (Tyler, 2026-10-23). Not the `{word}` callout, which turns yellow and wiggles as it
// types; this lands after the whole line is in. Keyed by line index.
const PUNCH = { 3: 'real' };
const PUNCH_MS = 700;
// Scale and tilt (degrees) through the punch: up big, three shakes settling, back to rest.
const PUNCH_KEYS = [[1, 0], [1.45, -8], [1.38, 7], [1.4, -6], [1.3, 4], [1.15, -2], [1, 0]];

// Where the card's bottom edge sits, as a fraction of the screen's height.
const STORY_CARD_BOTTOM = 0.76;

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
  // Its bottom edge three quarters of the way down (Tyler, 2026-10-22: the foot of the screen sat
  // too low), clear of the garage the camera holds in the middle. The slot adds `DOCK_LIFT` (24 px)
  // above whatever floor it is handed, so the floor is set that far below the line.
  const bubble = createSpeech(talk, {
    typing: true, onDismiss: () => next(), dockFloor: (vh) => vh * STORY_CARD_BOTTOM + 24,
  });
  // Docked, the card ignores its target; under `?bubbles=classic` it points at the lower middle.
  const below = () => ({ x: window.innerWidth / 2, y: window.innerHeight * 0.72 });
  // Seconds the current line has sat finished and untapped.
  let idle = 0;
  // Whether the current line has had its punch (`PUNCH`), so it lands once per line.
  let punched = false;
  const say = () => { idle = 0; punched = false; bubble.show('Dispatch', lines[at], below); };
  // Wraps the word in a span of its own once the line is fully typed — typing rewrites the runs'
  // text every letter, so it cannot be wrapped any sooner — and animates that span alone. An
  // inline-block so the transform takes; transforms do not move the words around it.
  const punch = (word) => {
    const walker = document.createTreeWalker(talk.querySelector('.speech-text'), NodeFilter.SHOW_TEXT);
    const pattern = new RegExp(`\\b${word}\\b`);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const m = pattern.exec(node.data);
      if (!m) continue;
      const hit = node.splitText(m.index);
      hit.splitText(word.length);
      const span = document.createElement('span');
      span.className = 'title-story-punch';
      hit.replaceWith(span);
      span.append(hit);
      span.animate(
        PUNCH_KEYS.map(([k, deg]) => ({ transform: `scale(${k}) rotate(${deg}deg)` })),
        { duration: PUNCH_MS, easing: 'ease-out' },
      );
      return;
    }
  };
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
    if (bubble.isOpen() && !bubble.isTyping() && !punched) {
      punched = true;
      if (PUNCH[at] && !still) punch(PUNCH[at]);
    }
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
