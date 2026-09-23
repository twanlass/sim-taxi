// The taxi's hit points, as a bar under the cash total. See TAXI_HP in sim/collisions.js for what
// a hit costs and why.
//
// Two bars in one track, the arcade life-bar trick: the bright fill drops to the new level on the
// frame of the hit, and a pale "damage" bar behind it holds the old level for a beat before
// draining down to meet it. The gap between the two is the hit, readable for half a second after
// the thumb has moved on — a single bar that just got shorter says *that* you lost something, the
// trailing one says *how much*.
//
// The colour steps rather than blends — green, amber, red — for the same reason the plumbob's
// does: three states a glance can tell apart beat a gradient the eye has to judge.

const LOW = 0.34;        // at or under this the bar goes red (and game/taxidamage.js's last tier starts)
const MID = 0.67;
const TRAIL_HOLD = 0.35; // s the damage bar waits before draining
const TRAIL_RATE = 1.2;  // fraction of the bar per second it drains at

export function createHpMeter(el, max) {
  const fill = el?.querySelector('.hp-fill');
  const trail = el?.querySelector('.hp-trail');
  let shown = 1;
  let trailed = 1;
  let hold = 0;

  function paint() {
    if (!el) return;
    fill.style.transform = `scaleX(${shown})`;
    trail.style.transform = `scaleX(${trailed})`;
    el.dataset.level = shown <= LOW ? 'low' : shown <= MID ? 'mid' : 'high';
  }

  function hit(hp) {
    shown = Math.max(0, hp / max);
    hold = TRAIL_HOLD;
    paint();
    if (!el) return;
    // Re-fire the shake: CSS animations only restart when the class transitions, hence the reflow.
    el.classList.remove('hp-hit');
    void el.offsetWidth;
    el.classList.add('hp-hit');
  }

  function update(dt) {
    if (trailed <= shown) return;
    if (hold > 0) { hold -= dt; return; }
    trailed = Math.max(shown, trailed - TRAIL_RATE * dt);
    paint();
  }

  paint();
  return { hit, update };
}
