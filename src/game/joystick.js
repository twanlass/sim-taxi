/**
 * The steering stick: a virtual joystick bottom left that drives Pac-Man steering (game/steer.js).
 * Tyler, 2026-11-24: "No swipe. Let's add a virtual joystick bottom left" — `?steer=swipe` keeps
 * the swipe version.
 *
 * **It points at streets, not at screen directions.** The camera looks down the city's diagonal, so
 * the four ways a car can drive lie on screen at roughly 30° above and below the horizontal, right
 * and left — and a stick's "up" sits exactly between two of them. So the stick snaps to the nearest
 * of the four *as they are drawn*, measured off the live camera (`toScreen`), and its rim carries a
 * notch at each one so the thumb can see where the four answers are. Snapping absolutely rather
 * than relative to the heading is what makes *holding* the stick mean something: held toward
 * up-right, the taxi takes up-right at the next corner that has it and keeps going that way, where
 * a heading-relative reading would read the same hold as a fresh turn after every corner and
 * staircase across the city.
 *
 * Holding pushes the direction every frame; letting go leaves the last one queued (the Pac-Man
 * buffer), so a flick is enough and the thumb can come off. Pushing toward the way the car is
 * already going clears the queue; pushing backwards is ignored — the U-turn is the brake's move.
 */

// Grid direction vectors (DIR: PX, PZ, NX, NZ).
const DIR_VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// How far the knob travels, and how far it has to go before it says anything, in CSS pixels.
const KNOB_TRAVEL = 34;
const DEAD_ZONE = 12;
// The notches sit just inside the well's rim.
const NOTCH_R = 47;

/**
 * Which street direction a stick vector `(sx, sy)` (screen pixels, y down) points at: the one whose
 * on-screen direction is nearest by angle.
 */
export function snapStick(sx, sy, toScreen) {
  let best = 0;
  let bestDot = -Infinity;
  const sl = Math.hypot(sx, sy) || 1;
  for (let d = 0; d < 4; d++) {
    const v = toScreen(DIR_VEC[d][0], DIR_VEC[d][1]);
    const dot = (v.x * sx + v.y * sy) / ((Math.hypot(v.x, v.y) || 1) * sl);
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

/**
 * @param el        the #stick element (well + knob inside it)
 * @param toScreen  `(dx, dz) => { x, y }`, a world ground vector in screen pixels
 * @param onPush    called with a grid direction while the stick is pushed, and with null on release
 */
export function createJoystick({ el, toScreen, onPush }) {
  const knob = el.querySelector('.stick-knob');
  const notches = DIR_VEC.map(() => {
    const n = document.createElement('div');
    n.className = 'stick-notch';
    el.insertBefore(n, knob);
    return n;
  });
  let press = null;

  function placeNotches() {
    for (let d = 0; d < 4; d++) {
      const v = toScreen(DIR_VEC[d][0], DIR_VEC[d][1]);
      const a = Math.atan2(v.y, v.x);
      notches[d].style.transform = `translate(${Math.cos(a) * NOTCH_R}px, ${Math.sin(a) * NOTCH_R}px) rotate(${a + Math.PI / 2}rad)`;
    }
  }

  function read(event) {
    const dx = event.clientX - press.cx;
    const dy = event.clientY - press.cy;
    const len = Math.hypot(dx, dy);
    const k = len > KNOB_TRAVEL ? KNOB_TRAVEL / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    onPush(len >= DEAD_ZONE ? snapStick(dx, dy, toScreen) : null, len >= DEAD_ZONE);
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
    /** Light the notch for the queued direction (or none). Call each frame; places the notches too. */
    update(queued) {
      placeNotches();
      for (let d = 0; d < 4; d++) notches[d].classList.toggle('is-queued', d === queued);
    },
    held: () => Boolean(press),
    /** The stick's centre and top, in viewport pixels — where the tip points. */
    top: () => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top };
    },
  };
}
