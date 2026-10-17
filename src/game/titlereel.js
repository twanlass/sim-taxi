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
 * A shot is `{ name, at }`, with `at()` the subject's `{ x, y, z }` (y is how high above the
 * ground the subject's middle stands — see `aimAtHeight`) or null when it has nothing to show. A
 * landmark always answers; the train answers only while it is running on the island, so it is
 * played when it happens to be there rather than waited for, and a shot that loses its subject
 * part way (the train running off the coast) cuts early.
 */

import { aimAtHeight, RIGHT, UP, VIEW_DIR, PLAY_ZOOM, LOCO_PUNCH } from './camera.js';

/** Seconds on each shot, counted from the cut — "a couple of seconds", per the brief, and enough
 *  for a jump shot or a run at the ramp to play out inside it. */
export const SHOT = 5;
// The dip: out fast, a beat of black, in slower — the same shape as game/wipe.js's skip, quicker,
// because this one recurs every few seconds and should read as a cut, not as a scene change.
export const DIP_OUT = 0.22;
export const DIP_HOLD = 0.08;
export const DIP_IN = 0.34;
/**
 * Every shot's framing: halfway between the game's own camera and the Loco Mode push-in (Tyler,
 * 2026-10-17 — the first cut framed each landmark at 11 to 17 and read as far too tight). 45.8, so
 * a landmark is a block in its neighbourhood rather than the whole screen, and the cut from the
 * reel to the run does not change scale much either.
 */
export const REEL_ZOOM = (PLAY_ZOOM + PLAY_ZOOM * LOCO_PUNCH) / 2;
/** World units the camera drifts across a shot, along screen-right. Slow: ~2 units a second. */
const DRIFT = 10;
/** How much wider the shot opens than it ends: a small push-in under the drift. */
const PUSH = 0.08;
/**
 * Where the subject sits, clear of the menu. The menu is a left-aligned column, vertically centred:
 * on a wide screen the open space is to its right, so the subject goes a third of the half-width
 * right of centre; on a phone the column spans most of the width but only the middle quarter of
 * the height (37–62% down on a 390×844), so the subject goes just above or below it (a
 * third of the half-height off the middle, 34% or 66% down) — whichever side keeps the camera
 * nearer the middle of the map (`menuSide`). Not further: at REEL_ZOOM every tenth of the
 * half-height is 8.4 units of ground, so half the half-height (the first try) swung the camera 42
 * units off its subject and put a coast in frame whichever side it went.
 */
const MENU_SHIFT = 0.32;
const OFF_MENU = 0.32;
/** The shortest time a train shot is worth starting with — less and it leaves the frame at once. */
const TRAIN_MIN = 3;
/** And the shortest it is allowed to run before an early cut, so a cut never follows a cut. */
const MIN_HOLD = 2;

const smooth = (k) => k * k * (3 - 2 * k);

/**
 * @param {object} opts
 * @param {Array<{ name: string, at: () => ({ x: number, y: number, z: number } | null),
 *   live?: boolean, minLeft?: () => number }>} opts.shots
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
  // On a phone, whether the subject goes above the menu (-1) or below it (+1). At REEL_ZOOM a frame
  // is most of the island across, so a landmark near the far coast put under the menu lifts the
  // camera out over the fog bank, which then fills the top of the screen (the court, on the first
  // city this was watched on). Put above the menu instead, the same landmark pulls the camera
  // *inland*. Picked once per shot, at the cut, so it never flips mid-shot.
  let menuSide = 1;
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
    // The side whose target lands nearer the middle of the map: the target is the subject moved
    // `menuSide * reach` along UP, so compare the two squared distances.
    const at = current.at();
    if (at) {
      const reach = (REEL_ZOOM * OFF_MENU) / VIEW_DIR.y;
      const d = (sgn) => (at.x + UP.x * reach * sgn) ** 2 + (at.z + UP.z * reach * sgn) ** 2;
      menuSide = d(1) <= d(-1) ? 1 : -1;
    }
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
      const zoom = REEL_ZOOM * (1 + PUSH * (1 - k));
      const aim = aimAtHeight(seen.x, seen.y ?? 0, seen.z);
      // A live subject carries its own motion; drifting under it as well reads as the camera
      // losing it. The landmarks drift.
      const drift = current.live || still() ? 0 : (k - 0.5) * DRIFT * side;
      const across = drift - (tall ? 0 : zoom * aspect * MENU_SHIFT);
      // Screen-up on the ground is foreshortened to VIEW_DIR.y, so a target `d` along UP moves the
      // picture `d * VIEW_DIR.y` — the subject is put `OFF_MENU` half-heights off the middle by
      // moving the target the other way by that over VIEW_DIR.y.
      const up = tall ? (menuSide * zoom * OFF_MENU) / VIEW_DIR.y : 0;
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
