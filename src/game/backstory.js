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
  "City council signed that {robo-taxi} deal. They'll be on the streets by Monday.",
  "Those rolling toasters brake for pigeons. I have no idea why people like 'em.",
  "Let's get out there and show people what a rocket-powered cab ride is all about.",
];

// Tyler's recordings of the four lines (2026-10-23), one sound each in game/sfx.js, played as each
// card comes up. `?introvo=classic` tells it in text alone.
export const BACKSTORY_VOICES = ['dispatch1', 'dispatch2', 'dispatch3', 'dispatch4'];
// The voice lands a little after the card opens; this is how long a line keeps asking for it — on
// the web the first tap anywhere (often Play itself) is what starts the decoding.
const VOICE_WAIT = 0.6;
// The typing finishes this far ahead of the voice, so the last word is on the card as it is said.
const VOICE_TAIL = 0.3;

// A finished line nobody has tapped for this long gives the card a nudge, and again every this long
// after (Tyler, 2026-10-22): nothing else on screen says the story is waiting on a tap.
const NUDGE_AFTER = 3;
// The nudge: a hop and a smaller second one, like a dock icon asking for attention.
const NUDGE_HOPS = [0, -12, 0, -5, 0];
const NUDGE_MS = 650;

// A word that punches once its line has finished typing: scales up and shakes, in the line's own
// black type (Tyler, 2026-10-23). Not the `{word}` callout, which turns yellow and wiggles as it
// types; this lands after the whole line is in. Keyed by line index. It was "real", then "lives", as
// the line was rewritten; "rocket-powered" is the game's own name in the line.
const PUNCH = { 3: 'rocket-powered' };
const PUNCH_MS = 700;
// Width, height and tilt (degrees) through the punch: up tall, three shakes settling, back to rest.
// It grows up far more than across, from the middle of its baseline (index.html), because a
// transform does not push the words beside it aside: a 1.35x scale from the left edge ran
// "rocket-powered" straight over "cab", and from the centre at 1.45 "a real" read "areal". At
// 1.05 across, a 14-letter word all but closed the spaces either side (measured at 390 px wide);
// 1.03 leaves them open.
const PUNCH_KEYS = [[1, 1, 0], [1.03, 1.4, -3], [1.025, 1.32, 2.5], [1.03, 1.35, -2], [1.02, 1.25, 1.5],
  [1.01, 1.1, -1], [1, 1, 0]];

// Where the card's bottom edge sits, as a fraction of the screen's height.
const STORY_CARD_BOTTOM = 0.76;

// Through progress.js, so Demo mode tells it on every Play and writes nothing.
let seenFlag = null;
const seen = () => (seenFlag ??= createSeenFlag({ key: 'simTaxi.backstorySeen' }));

/** Whether the story is read out (`BACKSTORY_VOICES`); `?introvo=classic` keeps it to text. */
export function backstoryVoiced() {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('introvo') !== 'classic';
}

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
 * then call `done`. A tap anywhere finishes the line typing or moves to the next; Escape ends it.
 * There is no Skip button (Tyler, 2026-10-23): four taps is the whole story. Marked seen as it starts, so quitting halfway does not bring it back.
 *
 * `speak(i)` starts line i's recording and answers `{ seconds, stop(), ended() }`, or null when
 * there is nothing to play (muted, not decoded yet, no audio): the line then types at its usual
 * pace. A line read out types at the voice's pace and is not nudged until the voice has finished.
 */
export function tellBackstory(root, { done, lines = BACKSTORY_LINES, speak = () => null }) {
  seen().set();
  const layer = document.createElement('div');
  layer.className = 'title-story';
  const talk = document.createElement('div');
  talk.className = 'title-story-talk';
  talk.setAttribute('role', 'status');
  talk.setAttribute('aria-live', 'polite');
  layer.append(talk);
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
  // The current line's recording, and how long the line has been asking for one (`VOICE_WAIT`).
  let voice = null;
  let asked = 0;
  const hush = () => { voice?.stop(); voice = null; };
  const listen = () => {
    voice = speak(at);
    if (voice) bubble.pace(Math.max(voice.seconds - VOICE_TAIL, 0));
  };
  const say = () => {
    hush();
    idle = 0;
    punched = false;
    asked = 0;
    bubble.show('Dispatch', lines[at], below);
    listen();
  };
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
        PUNCH_KEYS.map(([sx, sy, deg]) => ({ transform: `scale(${sx}, ${sy}) rotate(${deg}deg)` })),
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
    hush();
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
    if (!voice && bubble.isTyping() && asked < VOICE_WAIT) { asked += dt; listen(); }
    if (bubble.isOpen() && !bubble.isTyping() && !punched) {
      punched = true;
      if (PUNCH[at] && !still) punch(PUNCH[at]);
    }
    if (bubble.isOpen() && !bubble.isTyping() && !still && !(voice && !voice.ended())) {
      idle += dt;
      if (idle >= NUDGE_AFTER) { idle = 0; nudge(); }
    }
    if (!over) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  layer.addEventListener('click', () => bubble.tap());
  window.addEventListener('keydown', onKey, true);
  say();
  return { finish };
}
