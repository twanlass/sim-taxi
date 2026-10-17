/**
 * The title screen's backdrop as a reel of short shots: the camera jump cuts round the city's
 * landmarks — the basketball court, the skatepark, the L, the burger joint — and sits on each for
 * a few seconds with a slow drift, with a quick dip to black between them. `?titlecam=classic` is
 * the slow ellipse it replaced (`panAt` in game/titlescreen.js).
 *
 * Like the drift, it does not move the camera itself. `frame(dt, aspect)` says where the camera is
 * this frame and main.js cuts it there, so the priority list stays the one place framing is decided.
 * It is a *cut* every frame rather than an ease because the motion inside a shot is already the
 * shape it wants (a linear drift and a small push-in), and an ease towards a moving point would lag
 * it and smear every jump cut into a swoop.
 *
 * The dip is driven off the same clock as the shots, by setting the element's opacity each frame,
 * rather than as a WAAPI animation beside it: two clocks can disagree about when the screen is
 * black, and the one thing the dip is for is that the camera moves on a frame nobody sees.
 *
 * A shot is `{ name, at, zoom }`, with `at()` the subject's `{ x, y, z }` (y is how high above the
 * ground the subject's middle stands — see `aimAtHeight`) or null when it has nothing to show. A
 * landmark always answers; the train answers only while it is running on the island, so it is
 * played when it happens to be there rather than waited for, and a shot that loses its subject
 * part way (the train running off the coast) cuts early.
 */

import { aimAtHeight, RIGHT, UP, VIEW_DIR } from './camera.js';

/** Seconds on each shot, counted from the cut — "a couple of seconds", per the brief, and enough
 *  for a jump shot or a run at the ramp to play out inside it. */
export const SHOT = 5;
// The dip: out fast, a beat of black, in slower — the same shape as game/wipe.js's skip, quicker,
// because this one recurs every few seconds and should read as a cut, not as a scene change.
export const DIP_OUT = 0.22;
export const DIP_HOLD = 0.08;
export const DIP_IN = 0.34;
/** World units the camera drifts across a shot, along screen-right. Slow: ~1 unit a second. */
const DRIFT = 5;
/** How much wider the shot opens than it ends: a small push-in under the drift. */
const PUSH = 0.08;
/**
 * Where the subject sits, clear of the menu. The menu is a left-aligned column, vertically centred:
 * on a wide screen the open space is to its right, so the subject goes a third of the half-width
 * right of centre; on a phone the column spans most of the width but only the middle quarter of
 * the height (37–62% down on a 390×844), so the subject goes below it, at about three-quarters of
 * the way down.
 */
const MENU_SHIFT = 0.32;
const BELOW_MENU = 0.5;
/**
 * How much of the screen's width a subject's `r` (its half-extent across the screen) may take:
 * the open half beside the menu on a wide screen, nearly all of it on a phone. The shot's own
 * `zoom` is the floor — a wide screen frames to it, a phone opens out until the subject fits.
 */
const WIDE_SHARE = 0.6;
const TALL_SHARE = 0.9;
/** The shortest time a train shot is worth starting with — less and it leaves the frame at once. */
const TRAIN_MIN = 3;
/** And the shortest it is allowed to run before an early cut, so a cut never follows a cut. */
const MIN_HOLD = 2;

const smooth = (k) => k * k * (3 - 2 * k);

/**
 * @param {object} opts
 * @param {Array<{ name: string, at: () => ({ x: number, y: number, z: number } | null), zoom: number,
 *   r: number, live?: boolean, minLeft?: () => number }>} opts.shots
 *        In playing order. A shot with `live` is an *event* (the train) and is slotted in whenever it
 *        is available and was not the last thing shown; the rest rotate.
 * @param {HTMLElement | null} [opts.dip]  A black full-screen element under the menu. Null → hard cuts.
 * @param {() => boolean} [opts.still]  Reduced motion: hard cuts, no drift.
 */
export function createTitleReel({ shots, dip = null, still = () => false }) {
  const rotation = shots.filter((s) => !s.live && s.at());
  const events = shots.filter((s) => s.live);
  if (!rotation.length) return null;

  let next = 0;            // index into `rotation`
  let current = null;
  let clock = 0;
  let first = true;
  let leaving = false;     // the dip out has started; the cut lands when it is black
  let leaveAt = SHOT;      // when the dip out starts, in shot seconds
  let side = 1;            // drift direction, alternated per shot
  const played = [];       // names, for the probe
  let last = null;

  function eventReady() {
    return events.find((s) => s !== last && s.at() && (s.minLeft?.() ?? Infinity) >= TRAIN_MIN);
  }

  function cut() {
    const ev = eventReady();
    if (ev) current = ev;
    else {
      current = rotation[next % rotation.length];
      next += 1;
    }
    last = current;
    played.push(current.name);
    clock = 0;
    leaving = false;
    leaveAt = SHOT;
    side = -side;
  }
  cut();
  // Where the subject was last seen, so a live shot's last frames before the cut hold still rather
  // than jumping to the middle of the map when `at()` goes null under them.
  let seen = current.at();

  function setDip(v) {
    if (!dip) return;
    dip.style.opacity = v <= 0 ? '0' : v.toFixed(3);
  }

  return {
    /** The shot names in the order they were cut to. */
    played,
    current: () => current.name,
    /**
     * Advance the reel and say where the camera is: `{ x, z, zoom }`, a ground target, and how
     * dark the dip is (`black`, 0..1) — also written to the dip element.
     */
    frame(dt, aspect) {
      clock += dt;
      const subject = current.at();
      if (subject) seen = subject;
      // A live shot that has lost its subject, or is about to, leaves now (but not inside MIN_HOLD).
      if (!leaving && current.live && clock >= MIN_HOLD
        && (!subject || (current.minLeft?.() ?? Infinity) < DIP_OUT + DIP_HOLD)) {
        leaveAt = clock;
      }
      if (!leaving && clock >= leaveAt) leaving = true;
      let black = 0;
      if (leaving) {
        const out = (clock - leaveAt) / DIP_OUT;
        black = smooth(Math.min(1, out));
        if (clock - leaveAt >= DIP_OUT + DIP_HOLD || still()) {
          cut();
          first = false;
          seen = current.at() ?? seen;
          black = still() ? 0 : 1;
        }
      } else if (!first && clock < DIP_IN && !still()) {
        black = 1 - smooth(clock / DIP_IN);
      }
      setDip(black);

      const k = Math.min(1, clock / SHOT);
      const tall = aspect < 1;
      const fit = (current.r ?? 0) / (aspect * (tall ? TALL_SHARE : WIDE_SHARE));
      const zoom = Math.max(current.zoom, fit) * (1 + PUSH * (1 - k));
      const aim = aimAtHeight(seen.x, seen.y ?? 0, seen.z);
      // A live subject carries its own motion; drifting under it as well reads as the camera
      // losing it. The landmarks drift.
      const drift = current.live || still() ? 0 : (k - 0.5) * DRIFT * side;
      const across = drift - (tall ? 0 : zoom * aspect * MENU_SHIFT);
      // Screen-up on the ground is foreshortened to VIEW_DIR.y, so a target `d` along UP moves the
      // picture `d * VIEW_DIR.y` — the subject is put `BELOW_MENU` half-heights down by moving the
      // target up-screen by that over VIEW_DIR.y.
      const up = tall ? (zoom * BELOW_MENU) / VIEW_DIR.y : 0;
      return {
        x: aim.x + RIGHT.x * across + UP.x * up,
        z: aim.z + RIGHT.z * across + UP.z * up,
        zoom,
        black,
      };
    },
    /**
     * Points on the ground the L's deck should fade around (`setFadePoints` in game/ltrain.js) so it
     * does not stand in front of the subject: the court and the skatepark sit beside its arterial,
     * and on some cities the truss crosses the frame right over the players. The subject's middle
     * and four points round it, since one point fades a circle about the size of a car. None for
     * the train, which is the deck's own subject.
     */
    fadePoints() {
      if (current.live) return [];
      const c = current.at();
      if (!c) return [];
      const pts = [{ x: c.x, z: c.z }];
      for (const s of [-1, 1]) {
        pts.push({ x: c.x + RIGHT.x * 4 * s, z: c.z + RIGHT.z * 4 * s });
        pts.push({ x: c.x + UP.x * 3 * s, z: c.z + UP.z * 3 * s });
      }
      return pts;
    },
    /** Lift the dip at once — Play hands the screen to the wipe. */
    clear() { setDip(0); },
  };
}
