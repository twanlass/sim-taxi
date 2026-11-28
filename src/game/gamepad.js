/**
 * A game controller — a PS4 DualShock 4 first, anything the browser reports with the `standard`
 * mapping after it — for playing on a TV. Tyler, 2026-11-25: "I want to make an Apple TV version of
 * this I can play on my tv with my ps4 controller." tvOS has no web view, so this game cannot run
 * there as it is; what it can do is be played *from a couch*, on a Mac plugged into the TV or a
 * phone AirPlaying to it, and both of those read the pad through the Gamepad API (the iOS shell's
 * WKWebView included).
 *
 * **In a run it presses the keys the keyboard already has.** Loco is Space and the brake is B
 * (main.js), and each of those handlers carries a stack of guards — not while paused, not behind
 * the Home Screen tip, stand down for the robber's line, which itself answers Space. The pad
 * dispatches those same key events on `document.body` rather than calling `holdLocoMode()` beside
 * them, so it inherits every guard and the next one anybody adds. The target is the body, not the
 * window, because `keyIsSpokenFor` only exempts a target that is an Element.
 *
 * | Pad | In a run | On a menu |
 * |---|---|---|
 * | Left stick | Steer (free driving: the stick is a heading) | Move the focus ring |
 * | D-pad | — | Move the focus ring |
 * | ✕, R2, R1 | Loco (Space) | ✕ presses the ringed button |
 * | □, L2, L1 | Brake (B) | — |
 * | ○ | — | Back (Escape) |
 * | Options | Pause (Escape) | Escape (resume, or back out of Settings) |
 *
 * **The stick reads as the touch stick does.** Free driving asks for `{ dx, dy, len }` in CSS pixels
 * past a dead zone (game/freedrive.js), and only the direction is used — so the pad answers in the
 * same units, scaled to the touch knob's travel, and screen-up on the pad is screen-up on the map.
 *
 * **Menus are whatever buttons a finger could hit.** No menu in this game was built for a focus
 * model, and wiring each one up is a list that goes stale. Instead the candidates are every button
 * on screen whose own centre `elementFromPoint` lands on — which leaves out whatever a veil covers,
 * whatever is hidden, and whatever has `pointer-events: none`, with nothing to maintain. The ring
 * starts on the first in document order — Story on the title, Resume on pause, Play again at the end
 * of a run (the largest was tried first and picked Settings, the title's longest word) — and the
 * D-pad walks it to the nearest neighbour in that direction. A press is pointerdown, pointerup and
 * click, because the game's buttons are split between the three. With nothing to ring, ✕ is Enter,
 * which the run-end tally takes for the tap that skips it.
 *
 * Browsers expose a pad only after one of its buttons has been pressed with the page in front, so
 * nothing here runs until then.
 */

// Standard-mapping button indices (w3c.github.io/gamepad/#remapping).
const B = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, OPTIONS: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const LOCO = [B.CROSS, B.R1, B.R2];
const BRAKE = [B.SQUARE, B.L1, B.L2];

// A DualShock's stick rests anywhere within ~0.08 of centre and a worn one further; 0.22 is
// comfortably clear of both without eating a deliberate nudge.
export const STICK_DEAD = 0.22;
// A trigger is an axis read as a button; the browser's own `pressed` threshold differs between
// Chrome (~0.12) and Safari, so read `value`.
const TRIGGER_ON = 0.35;
// Holding a direction on a menu repeats like a held key: a pause, then a steady tick.
const REPEAT_FIRST = 0.4;
const REPEAT_NEXT = 0.16;
// A stick pushed this far is a menu direction.
const MENU_PUSH = 0.55;

// The buttons the run's own HUD draws: never menu candidates, since the pad has its own way to each.
const HUD = '#boost, #brake, #stick, #pause, #taxi-finder';
// The body classes under which the screen is a menu rather than a run. Not `coach-open`: the
// tutorial's bubbles stand over a live run, and Loco is what clears them (`holdLocoMode`).
const MENU_CLASSES = ['title-up', 'is-paused', 'game-over', 'new-move-open'];

/**
 * Radial dead zone, rescaled so the push grows from 0 at its edge: `{ x, y, mag }` or null.
 */
export function deadZone(ax, ay, dead = STICK_DEAD) {
  const m = Math.hypot(ax, ay);
  if (m < dead) return null;
  const mag = Math.min(1, (m - dead) / (1 - dead));
  return { x: (ax / m) * mag, y: (ay / m) * mag, mag };
}

/**
 * The candidate nearest `from` in direction `dir` (`[dx, dy]`, screen axes), or null. Scored as the
 * distance along the direction plus twice the distance across it, so a button straight below beats
 * one nearer but off to the side — the usual spatial-navigation weighting.
 */
export function nearestInDirection(from, cands, dir) {
  let best = null;
  let bestScore = Infinity;
  for (const c of cands) {
    if (c === from.el) continue;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * dir[1] - dy * dir[0]);
    const score = along + 2 * across;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/**
 * @param travel   the touch knob's travel in CSS px (the stick vector's full length)
 * @param minLen   the touch stick's dead zone in CSS px (any push past ours reads at least this)
 * @param onActive called with true the first time the pad is used, and false when a finger is
 */
export function createGamepad({ travel = 34, minLen = 12, onActive = () => {} } = {}) {
  const supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  let active = false;
  let pad = null;
  let prev = [];
  let vec = null;
  let focus = null;
  let held = null;
  let heldFor = 0;
  let nextRepeat = 0;
  let keysDown = { loco: false, brake: false };
  let last = 0;

  function setActive(on) {
    if (on === active) return;
    active = on;
    document.body.classList.toggle('pad-active', on);
    if (!on) setFocus(null);
    onActive(on);
  }

  function key(type, code, keyName) {
    document.body.dispatchEvent(new KeyboardEvent(type, {
      key: keyName, code, bubbles: true, cancelable: true,
    }));
  }

  function pressed(index) {
    const b = pad?.buttons[index];
    if (!b) return false;
    return index === B.L2 || index === B.R2 ? b.value > TRIGGER_ON : b.pressed;
  }

  const menuMode = () => MENU_CLASSES.some((c) => document.body.classList.contains(c));

  function candidates() {
    const out = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (el.disabled || el.matches(HUD)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > w || y > h) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) continue;
      out.push({ el, x, y });
    }
    return out;
  }

  function setFocus(el) {
    if (focus === el) return;
    focus?.classList.remove('pad-focus');
    focus = el;
    if (el) {
      el.classList.add('pad-focus');
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }

  function press(el) {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true,
      cancelable: true, pointerId: 91, isPrimary: true, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new PointerEvent('pointerup', at));
    el.click();
  }

  function menuDirection(dt) {
    let dir = null;
    if (pressed(B.UP)) dir = [0, -1];
    else if (pressed(B.DOWN)) dir = [0, 1];
    else if (pressed(B.LEFT)) dir = [-1, 0];
    else if (pressed(B.RIGHT)) dir = [1, 0];
    else if (pad) {
      const [ax, ay] = pad.axes;
      if (Math.max(Math.abs(ax), Math.abs(ay)) > MENU_PUSH) {
        dir = Math.abs(ax) > Math.abs(ay) ? [Math.sign(ax), 0] : [0, Math.sign(ay)];
      }
    }
    const k = dir ? dir.join() : null;
    if (k !== held) { held = k; heldFor = 0; nextRepeat = REPEAT_FIRST; return dir; }
    if (!dir) return null;
    heldFor += dt;
    if (heldFor < nextRepeat) return null;
    nextRepeat += REPEAT_NEXT;
    return dir;
  }

  function releaseKeys() {
    if (keysDown.loco) { keysDown.loco = false; key('keyup', 'Space', ' '); }
    if (keysDown.brake) { keysDown.brake = false; key('keyup', 'KeyB', 'b'); }
  }

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    pad = null;
    for (const p of navigator.getGamepads()) if (p && p.connected) { pad = p; break; }
    if (!pad) { vec = null; releaseKeys(); prev = []; return; }

    const now_ = pad.buttons.map((_, i) => pressed(i));
    const edge = (i) => now_[i] && !prev[i];
    const stick = deadZone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    if (!active && (now_.some(Boolean) || stick)) setActive(true);
    if (!active) { prev = now_; return; }

    if (edge(B.OPTIONS)) key('keydown', 'Escape', 'Escape');

    if (menuMode()) {
      releaseKeys();
      vec = null;
      const cands = candidates();
      if (!focus || !cands.some((c) => c.el === focus)) {
        setFocus(cands[0]?.el ?? null);
      }
      const dir = menuDirection(dt);
      if (dir && focus) {
        const r = focus.getBoundingClientRect();
        const next = nearestInDirection({ el: focus, x: r.left + r.width / 2, y: r.top + r.height / 2 },
          cands, dir);
        if (next) setFocus(next.el);
      }
      if (edge(B.CROSS)) {
        if (focus) press(focus);
        // Nothing to ring — the run-end tally before its button arrives, which takes Enter for the
        // tap that skips it.
        else { key('keydown', 'Enter', 'Enter'); key('keyup', 'Enter', 'Enter'); }
      }
      if (edge(B.CIRCLE)) key('keydown', 'Escape', 'Escape');
    } else {
      setFocus(null);
      held = null;
      vec = stick ? (() => {
        const len = Math.max(minLen, stick.mag * travel);
        return { dx: (stick.x / stick.mag) * len, dy: (stick.y / stick.mag) * len, len };
      })() : null;
      const loco = LOCO.some((i) => now_[i]);
      const brake = BRAKE.some((i) => now_[i]);
      if (loco !== keysDown.loco) { keysDown.loco = loco; key(loco ? 'keydown' : 'keyup', 'Space', ' '); }
      if (brake !== keysDown.brake) { keysDown.brake = brake; key(brake ? 'keydown' : 'keyup', 'KeyB', 'b'); }
    }
    prev = now_;
  }

  if (supported) {
    requestAnimationFrame(tick);
    // A finger on the glass hands the screen back to touch: the stick and pedals come back and the
    // ring goes. The next pad press takes it again.
    window.addEventListener('pointerdown', (event) => {
      if (event.isTrusted && event.pointerType !== 'mouse') setActive(false);
    }, { capture: true });
    window.addEventListener('gamepaddisconnected', () => { releaseKeys(); setActive(false); });
  }

  return {
    /** Has the pad been used since the last touch? */
    active: () => active,
    /** The left stick as a touch-stick vector (`{ dx, dy, len }` CSS px), or null. */
    vector: () => (active ? vec : null),
    /** A short rumble, 0..1, where the pad has a motor and the browser lets us at it. */
    rumble(strength = 0.6, ms = 180) {
      const act = pad?.vibrationActuator;
      if (!active || !act?.playEffect) return;
      act.playEffect('dual-rumble', {
        duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6),
      }).catch(() => {});
    },
  };
}
