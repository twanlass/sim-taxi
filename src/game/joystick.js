/**
 * The steering stick: a virtual joystick bottom left that drives Pac-Man steering (game/steer.js).
 * Tyler, 2026-11-24: "No swipe. Let's add a virtual joystick bottom left" — `?steer=swipe` keeps
 * the swipe version.
 *
 * **It points at streets, not at screen directions.** The camera looks down the city's diagonal, so
 * the four ways a car can drive lie on screen at roughly 30° above and below the horizontal, right
 * and left — and a stick's "up" sits exactly between two of them. So the stick snaps to the nearest
 * of the four *as they are drawn*, measured off the live camera (`toScreen`). (Its rim carried a
 * notch at each of the four; Tyler found them confusing — they read as pointing in odd directions
 * rather than along the diagonal streets — and they went.) Snapping absolutely rather
 * than relative to the heading is what makes *holding* the stick mean something: held toward
 * up-right, the taxi takes up-right at the next corner that has it and keeps going that way, where
 * a heading-relative reading would read the same hold as a fresh turn after every corner and
 * staircase across the city.
 *
 * **The screen's own axes are where the snap is least sure.** With the streets at ±29°, the borders
 * between the four directions fall exactly on screen up, down, left and right — the pushes a thumb
 * makes most. Tyler, 2026-11-24: "when I'm kind of pointing it in the direction I want to go, it's
 * not quite right." Two things were costing those pushes:
 *
 * - **Backwards was a candidate.** Heading down-right, a push straight up is a coin toss between
 *   up-right (a left turn) and up-left (backwards) — and backwards is ignored, so half of them did
 *   nothing at all. The snap now leaves out the way back, so every push past the dead zone names a
 *   turn or straight on: up is the left turn, left is the right turn.
 * - **No hysteresis.** A thumb resting near a border wobbles across it, and the queue flipped with
 *   it. Once a hold has picked a direction it keeps it until the push is `HOLD_MARGIN` past the
 *   border.
 *
 * Holding pushes the direction every frame; letting go leaves the last one queued (the Pac-Man
 * buffer), so a flick is enough and the thumb can come off. Pushing toward the way the car is
 * already going clears the queue — the U-turn stays the brake's move.
 */

// Grid direction vectors (DIR: PX, PZ, NX, NZ).
const DIR_VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// How far the knob travels, and how far it has to go before it says anything, in CSS pixels.
const KNOB_TRAVEL = 34;
const DEAD_ZONE = 12;
// How far past a border a held push has to go before the stick changes its mind, in radians.
const HOLD_MARGIN = (15 * Math.PI) / 180;

/**
 * Which street direction a stick vector `(sx, sy)` (screen pixels, y down) points at: the one whose
 * on-screen direction is nearest by angle, never `exclude` (the way back), and `prev` for as long as
 * it is within `HOLD_MARGIN` of the nearest.
 */
export function snapStick(sx, sy, toScreen, { exclude = null, prev = null } = {}) {
  const sl = Math.hypot(sx, sy) || 1;
  const angle = new Array(4).fill(Infinity);
  let best = null;
  for (let d = 0; d < 4; d++) {
    if (d === exclude) continue;
    const v = toScreen(DIR_VEC[d][0], DIR_VEC[d][1]);
    const cos = (v.x * sx + v.y * sy) / ((Math.hypot(v.x, v.y) || 1) * sl);
    angle[d] = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (best == null || angle[d] < angle[best]) best = d;
  }
  if (prev != null && prev !== exclude && angle[prev] - angle[best] < HOLD_MARGIN) return prev;
  return best;
}

/**
 * @param el        the #stick element (well + knob inside it)
 * @param toScreen  `(dx, dz) => { x, y }`, a world ground vector in screen pixels
 * @param onPush    called with a grid direction while the stick is pushed, and with null on release
 * @param back      () => the grid direction straight back from the taxi's next decision, or null
 */
export function createJoystick({ el, toScreen, onPush, back = () => null }) {
  const knob = el.querySelector('.stick-knob');
  let press = null;
  let picked = null;

  function read(event) {
    const dx = event.clientX - press.cx;
    const dy = event.clientY - press.cy;
    const len = Math.hypot(dx, dy);
    const k = len > KNOB_TRAVEL ? KNOB_TRAVEL / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    picked = len >= DEAD_ZONE ? snapStick(dx, dy, toScreen, { exclude: back(), prev: picked }) : null;
    onPush(picked, len >= DEAD_ZONE);
  }

  el.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary && press) return;
    event.preventDefault();
    const r = el.getBoundingClientRect();
    press = { id: event.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    try { el.setPointerCapture(event.pointerId); } catch { /* a synthetic press has no pointer to capture */ }
    el.classList.add('is-held');
    read(event);
  });
  el.addEventListener('pointermove', (event) => {
    if (press && event.pointerId === press.id) read(event);
  });
  const release = (event) => {
    if (!press || event.pointerId !== press.id) return;
    press = null;
    picked = null;
    el.classList.remove('is-held');
    knob.style.transform = '';
    onPush(null, false);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  // iOS selection and magnifier gestures run off the raw touch stream (see CLAUDE.md).
  el.addEventListener('touchstart', (event) => { if (event.cancelable) event.preventDefault(); },
    { passive: false });

  return {
    held: () => Boolean(press),
    /** The stick's centre and top, in viewport pixels — where the tip points. */
    top: () => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top };
    },
  };
}
