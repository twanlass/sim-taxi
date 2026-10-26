import { KERB_H } from '../city/ground.js';
import { createSpeech } from './speech.js';

// The drive-through's conversation as subtitles: each line of the speaker clip (`driveThru` in
// game/sfx.js) pops up in the shared speech card (game/speech.js) as it is said, types out over the
// length of its own audio, and goes again on its own. Nothing to answer — the whole visit is hands
// off (the lot drives the taxi, game/drivethru.js), so a card that wanted a tap would be the only
// thing in it asking for one (Tyler, 2026-10-26: "automatically pops up and goes away").
//
// Driven off the same edge main.js starts the clip on (`driveThruSpeaker`), and stopped on the
// edge it fades it, so a visit cut short takes its words down with its voice. Game time rather than
// the audio clock: a pause holds the card and the clip together, and a muted phone still gets the
// conversation — which is the case subtitles are for.
//
// The tag sits on the menu board while the speaker takes the order and on the pickup window once
// it is asking for money, which is where the taxi is (or is rolling to) on each line.

/**
 * The clip's lines, in order, in seconds from its start, measured off the master with ffmpeg's
 * `silencedetect` at −40 dB: `at` is where the voice starts and `said` where it stops, which is what
 * the typing is paced to. `end` is when the card goes, and nobody is talking between that and the
 * next `at`. The three grunts are one card rather than three: each is under half a second long with
 * 0.4s between them, and a card per grunt is a strobe.
 */
export const ORDER_LINES = [
  { at: 0.3, said: 1.66, end: 1.95, where: 'board', line: 'Welcome to {Dub Burger}.' },
  { at: 2.05, said: 4.11, end: 4.6, where: 'board', line: 'Mmhmm. Uh-huh. Yeah.' },
  { at: 4.72, said: 5.69, end: 7.0, where: 'window', line: 'Cash or {Bitcoin}?' },
  { at: 7.7, said: 9.1, end: 10.4, where: 'window', line: 'Here ya go. Later.' },
];

export const ORDER_TITLE = 'Dub Burger';

// Where the tags touch: the middle of the menu board and of the pickup window's surround, both on
// the lane-side façade (city/burgerjoint.js puts them 0.7 to 2.5 and 0.85 to 2.35 up the wall).
const TAG_Y = KERB_H + 1.6;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the card is kept inside
 * @param site      the joint's site (`burgerSite` in city/burgerjoint.js)
 */
export function createOrderTalk({ project, viewport = null, site }) {
  const root = document.getElementById('order-talk');
  const idle = { state: { open: false }, start: () => {}, stop: () => {}, update: () => {} };
  if (!root || !site) return idle;

  const bubble = createSpeech(root, { viewport });
  const state = { open: false };
  const tags = {
    board: () => project(site.wall.x1 + 0.28, TAG_Y, site.orderZ),
    window: () => project(site.wall.x1 + 0.1, TAG_Y, site.pickupZ),
  };
  // Seconds into the clip, or null when no visit is on; and the index of the line now up (-1 none).
  let t = null;
  let showing = -1;

  function stop() {
    t = null;
    showing = -1;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    /** The clip has just started. */
    start() { t = 0; showing = -1; },
    /** The clip was faded out, or the run ended. */
    stop,
    update(dt, { over = false } = {}) {
      bubble.update(dt);
      if (t === null) return;
      if (over) { stop(); return; }
      t += dt;
      const next = ORDER_LINES[showing + 1];
      if (next && t >= next.at) {
        showing += 1;
        state.open = true;
        bubble.show(ORDER_TITLE, next.line, tags[next.where]);
        bubble.pace(next.said - next.at);
      }
      const cue = ORDER_LINES[showing];
      if (state.open && t >= cue.end) {
        state.open = false;
        bubble.hide();
        if (showing === ORDER_LINES.length - 1) t = null;
      }
    },
  };
}
