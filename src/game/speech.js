// The game's one speech bubble — every line anyone says on screen goes through this: the tutorial's
// tips, the robber, dispatch, the cop's "Pull over!". The Figma file's "bubble-ui" (Taxi 🚕, node
// 180:1286): a white card with a small caps title naming who is talking, the line under it, and a
// pointer. See `.speech` in index.html for the look.
//
// **Pinned to what it is about.** Every bubble is handed a target — a function returning the point
// its pointer should touch, in viewport pixels, re-read every frame — and sits above it, the pointer
// on its bottom edge. The talker when there is one (the cop's roof, the taxi the robber is in) and
// the thing being pointed out when there is not (the rider to tap, the gas pedal). There used to be
// four fixed places a bubble could be — top centre, bottom centre, over the pill, over one car — and
// a spinning 3D avatar in each saying who was speaking. Pinning makes the avatar redundant: the
// pointer already says who, and it does it by touching them.
//
// **Off screen, it waits at the edge.** A target the camera cannot see does not take the bubble with
// it. The card clamps to the nearest edge along the line from the middle of the screen to the
// target, exactly the way the off-screen rider arrows do (game/farepointers.js), and its pointer
// moves to the middle of the side facing that edge and points straight out of it. Pan towards it and the card slides along the edge
// with the pan until the target comes into frame, when it drops onto it. The two placements agree
// at the boundary — a target sitting exactly on the band's bottom edge gets the same card from both
// — so nothing jumps as it crosses.
//
// **Typing is optional.** A bubble that is answered (the tutorial, the robber) types itself out and
// takes a tap to finish the line and a second to dismiss it; one that is not (dispatch, the cop)
// arrives whole and times itself out, because the tap the player is about to make belongs to the
// road.
//
// Named `speech` rather than anything with `bubble`-adjacent ad words (`popup`, `alert`, `banner`) in
// it — see CLAUDE.md on ad-blocker filter lists.

// Typing speed. ~38 chars/sec — fast enough that a reader is never waiting on the machine, slow
// enough that the line still arrives as speech rather than as a label appearing.
const TYPE_PER_CHAR = 0.026;
// A breath after punctuation, so a two-part line reads as two parts.
const TYPE_PAUSE = 0.14;
const PAUSE_AFTER = new Set([',', '.', '!', '?']);

// Matches the exit transition on `.speech` in index.html.
const CLOSE_MS = 200;

// The pointer's length, in CSS px: the file's 14 at the HUD's ×0.652.
const POINTER_H = 9.2;
// How far the pointer's base is sunk into the card. Its base corners are rounded, so a pointer
// butted against the edge shows two notches and a hairline of whatever is behind — the file tucks
// 6.2 of its 14 units inside the card (the pointer node hangs 10 below an 86-tall card, flipped,
// with 25% of its box empty), which is 4px here.
const POINTER_SINK = 4;
// How far the card stands off its target: the pointer's visible length plus a hair, so the tip
// lands just short of the point rather than on top of it.
const POINTER_GAP = POINTER_H - POINTER_SINK + 2;
// How far an on-screen pointer may lean off square to the card's edge.
const LEAN = (40 * Math.PI) / 180;

// The band a card may live in. Kept clear of the edges by `EDGE`, and of the top by the HUD's row
// (the cash total and the fuel meter: 13px + a 41px row, see `--hud-top` and `--hud-row`) so a
// bubble never sits over the money.
const EDGE = 10;
const HUD_TOP = 60;

// The pointer, the file's own path, drawn tip-up; `place` rotates it to face the target. Inline
// rather than an <img> so it can take `currentColor`: the card is a gradient, and a pointer filled
// the card's white stood out as a detached white triangle against the blue end of it — every
// pointer on the right-hand side, which is where dispatch waits for a cop coming in off screen.
const POINTER_SVG = `<svg class="speech-pointer" viewBox="0 0 17.501 14.0374" preserveAspectRatio="none" aria-hidden="true"><path fill="currentColor" d="M6.30991 1.25543C7.50644 -0.418478 9.99456 -0.418478 11.1911 1.25543L16.9363 9.29279C18.3556 11.2783 16.9363 14.0374 14.4957 14.0374H3.00529C0.564696 14.0374 -0.854561 11.2783 0.5647 9.29279L6.30991 1.25543Z"/></svg>`;

// The card's fill: the file's gradient, white for the first 60% and running to a pale blue in the
// bottom-right corner. Set on the card from here rather than in index.html because the pointer has
// to match whatever part of it it leaves from, and one copy of the numbers can't drift from itself.
const CARD_ANGLE = 114.9;
const CARD_FROM = [0xff, 0xff, 0xff];
const CARD_TO = [0xba, 0xd6, 0xff];
const CARD_STOP0 = 0.604;
const CARD_STOP1 = 0.999;
const CARD_FILL = `linear-gradient(${CARD_ANGLE}deg, rgb(${CARD_FROM}) ${CARD_STOP0 * 100}%, rgb(${CARD_TO}) ${CARD_STOP1 * 100}%)`;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The card's colour at (x, y) in a w × h card, as CSS resolves `CARD_FILL`: the gradient line runs
 * through the centre at `CARD_ANGLE` and is exactly long enough that its ends touch the far
 * corners. Pure, for the probe.
 */
export function cardColourAt(x, y, w, h) {
  const a = (CARD_ANGLE * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const t = len > 0 ? ((x - w / 2) * dx + (y - h / 2) * dy) / len + 0.5 : 0;
  const k = clamp((t - CARD_STOP0) / (CARD_STOP1 - CARD_STOP0), 0, 1);
  const c = CARD_FROM.map((v, i) => Math.round(v + (CARD_TO[i] - v) * k));
  return `rgb(${c.join(',')})`;
}

// The notch and the home indicator, off the `--safe-*` custom properties index.html sets — computed
// values, so `env()` has already been substituted. Re-read on resize because rotating moves them.
// Read on the first bubble rather than at import: the headless checks import this module (through
// radio.js) with no document to read.
const safe = { top: 0, right: 0, bottom: 0, left: 0 };
let safeWatched = false;
function readSafeInsets() {
  const style = getComputedStyle(document.documentElement);
  for (const side of Object.keys(safe)) {
    safe[side] = parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
  }
}
function watchSafeInsets() {
  if (safeWatched) return;
  safeWatched = true;
  readSafeInsets();
  window.addEventListener('resize', readSafeInsets);
}

/**
 * Where the card goes and where its pointer sits, for a target point and a card size, in a
 * viewport. Pure, so it can be asserted on headlessly (tools/probe.mjs).
 *
 * @returns {left, top, px, py, angle, onScreen} — the card's top-left corner, the pointer's base
 *          relative to the card's top-left, and the pointer's heading in radians (0 = right)
 */
export function placeSpeech(target, w, h, vw, vh, insets = safe) {
  const minX = insets.left + EDGE;
  const maxX = vw - insets.right - EDGE;
  const minY = insets.top + HUD_TOP;
  const maxY = vh - insets.bottom - EDGE;

  // The span a card's *centre* may range over. On a screen narrower than the card the span
  // collapses to its middle rather than turning inside out.
  const span = (lo, hi, half) => (hi - lo >= 2 * half ? [lo + half, hi - half] : [(lo + hi) / 2, (lo + hi) / 2]);
  const [cx0, cx1] = span(minX, maxX, w / 2);

  const onScreen = target.x >= insets.left && target.x <= vw - insets.right
    && target.y >= insets.top && target.y <= vh - insets.bottom;

  let cx;
  let cy;
  // Which edge of the card carries the pointer.
  let side;
  if (onScreen) {
    // Above the target, slid sideways to stay on the glass. If there is no room above — a target
    // up under the HUD — below it instead, pointer on the top edge.
    cx = clamp(target.x, cx0, cx1);
    let top = target.y - POINTER_GAP - h;
    side = 'bottom';
    if (top < minY) { top = target.y + POINTER_GAP; side = 'top'; }
    top = clamp(top, minY, Math.max(minY, maxY - h));
    cy = top + h / 2;
  } else {
    // Clamped along the ray from the band's middle to the target, the fare pointers' rule, in a
    // band shrunk by the card's own half-size (and the pointer's length, which hangs off it) so
    // the whole thing stays on the glass.
    const [cy0, cy1] = span(minY, maxY, h / 2 + POINTER_GAP);
    const mx = (cx0 + cx1) / 2;
    const my = (cy0 + cy1) / 2;
    const dx = target.x - mx;
    const dy = target.y - my;
    const sx = Math.abs(dx) > 0.001 ? (dx > 0 ? cx1 - mx : mx - cx0) / Math.abs(dx) : Infinity;
    const sy = Math.abs(dy) > 0.001 ? (dy > 0 ? cy1 - my : my - cy0) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    cx = mx + dx * s;
    cy = my + dy * s;
    // The pointer goes on the side facing the screen edge the card is waiting at.
    side = sx <= sy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  }

  // The pointer sits in the middle of its side and only turns. It used to sit where the line from
  // the card's centre to the target left the card, which slid it along the edge every frame the
  // target moved — a card waiting at the edge for an off-screen target had its pointer crawling
  // along it as the camera panned.
  const hw = w / 2;
  const hh = h / 2;
  const ox = side === 'right' ? hw : side === 'left' ? -hw : 0;
  const oy = side === 'bottom' ? hh : side === 'top' ? -hh : 0;
  const normal = { right: 0, bottom: Math.PI / 2, left: Math.PI, top: -Math.PI / 2 }[side];
  // On screen it leans towards the target (a card slid sideways to stay on the glass is no longer
  // square over it), but never lies along the card's edge — 40° either side of straight out. Off
  // screen it points straight out of its side: the side already says which way, and a pointer
  // leaning off a card's side edge stopped reading as a pointer and read as a broken corner.
  let angle = normal;
  if (onScreen) {
    let off = Math.atan2(target.y - (cy + oy), target.x - (cx + ox)) - normal;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    angle += clamp(off, -LEAN, LEAN);
  }

  return { left: cx - hw, top: cy - hh, px: hw + ox, py: hh + oy, angle, onScreen };
}

/**
 * @param root      the layer the bubble lives in — an empty, full-screen, `pointer-events: none`
 *                  element in index.html (`#coach`, `#robber-talk`, `#radio`, `#cop-shout`); this
 *                  builds the card inside it
 * @param viewport  util/viewport.js — the frame the renderer draws, which on an installed iOS app
 *                  is not `window.inner*`
 * @param typing    type each line out, and answer `tap()`
 * @param onDismiss () => void — a tap on a finished line; typing bubbles only
 */
export function createSpeech(root, { viewport = null, typing = false, onDismiss = () => {} } = {}) {
  watchSafeInsets();
  root.innerHTML = `
    <div class="speech">
      <div class="speech-body">
        <div class="speech-card">
          <div class="speech-title"></div>
          <div class="speech-text"><span class="speech-typed"></span><span class="speech-rest"></span></div>
          <div class="speech-media" hidden></div>
        </div>
        ${POINTER_SVG}
      </div>
    </div>`;
  const el = root.querySelector('.speech');
  const body = root.querySelector('.speech-body');
  const card = root.querySelector('.speech-card');
  const titleEl = root.querySelector('.speech-title');
  const typed = root.querySelector('.speech-typed');
  const rest = root.querySelector('.speech-rest');
  const pointer = root.querySelector('.speech-pointer');
  const mediaEl = root.querySelector('.speech-media');
  card.style.background = CARD_FILL;

  let text = '';
  let shown = 0;
  let charT = 0;
  let hold = 0;
  let closing = null;
  let open = false;
  let target = () => null;
  // Measured on `show` and on resize, not per frame: the untyped rest of the line is laid out
  // (hidden) from the start, so nothing about the card's box changes while it types, and a read per frame would force a layout
  // behind every character.
  let size = { w: 0, h: 0 };
  const measure = () => { size = { w: card.offsetWidth, h: card.offsetHeight }; };
  window.addEventListener('resize', () => { if (open) measure(); });

  const isTyping = () => shown < text.length;
  // The whole line is always in the card: what has been typed, then the rest of it hidden. So every
  // letter is laid out where it will finish from the first frame — the card does not grow, and a
  // word that is going to wrap is on its second line from the start rather than typing out on the
  // first and jumping down when it runs out of room.
  const typeTo = (n) => {
    shown = n;
    typed.textContent = text.slice(0, n);
    rest.textContent = text.slice(n);
  };
  const finishTyping = () => typeTo(text.length);

  function place() {
    const at = target();
    // Nothing to point at this frame (a hidden control, a car that just left the map): hold where
    // it was rather than jumping to a corner.
    if (!at) return;
    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    const p = placeSpeech(at, size.w, size.h, w, h);
    el.style.transform = `translate(${p.left.toFixed(1)}px, ${p.top.toFixed(1)}px)`;
    pointer.style.left = `${p.px.toFixed(1)}px`;
    pointer.style.top = `${p.py.toFixed(1)}px`;
    pointer.style.color = cardColourAt(p.px, p.py, size.w, size.h);
    // Drawn tip-up, so a heading of 0 (right) is a quarter turn clockwise. The last translate is in
    // the pointer's own turned frame, where +y is back towards its base — into the card.
    pointer.style.transform = `translate(-50%, -100%) rotate(${(p.angle + Math.PI / 2).toFixed(3)}rad) translateY(${POINTER_SINK}px)`;
    // The entrance grows out of the pointer, so the card arrives from what it is pinned to.
    body.style.transformOrigin = `${p.px.toFixed(0)}px ${p.py.toFixed(0)}px`;
  }

  function hide() {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    closing = setTimeout(() => {
      root.hidden = true;
      root.classList.remove('is-closing');
      closing = null;
    }, CLOSE_MS);
  }

  return {
    isOpen: () => open,
    isTyping,
    /**
     * @param title   who is talking — "TIP", "POLICE DISPATCH"; set in caps by the stylesheet
     * @param line    what they say
     * @param at      () => {x, y} | null — the point the pointer touches, viewport px, per frame
     * @param media   optional element shown under the line — the New Move card's pedal row
     *                (game/newmove.js). The card widens to fit it rather than wrapping it.
     */
    show(title, line, at, media = null) {
      if (closing) { clearTimeout(closing); closing = null; }
      titleEl.textContent = title;
      mediaEl.replaceChildren(...(media ? [media] : []));
      mediaEl.hidden = !media;
      card.classList.toggle('has-media', Boolean(media));
      text = line;
      target = at;
      if (typing && !prefersReducedMotion()) {
        typeTo(0);
      } else {
        finishTyping();
      }
      charT = 0;
      hold = 0;
      open = true;
      root.hidden = false;
      root.classList.remove('is-closing', 'is-open');
      measure();
      place();
      // One frame of the closed state before the open one, or the transition has nothing to run
      // from and the bubble simply appears.
      void root.offsetWidth;
      root.classList.add('is-open');
    },
    hide,
    /**
     * Finish the line, or dismiss a finished one. Returns false if there was nothing up to answer,
     * so the caller can tell a tap that did something from one that fell through to the game.
     */
    tap() {
      if (!typing || !open) return false;
      if (isTyping()) { finishTyping(); return true; }
      onDismiss();
      return true;
    },
    /** Advance the typewriter and re-pin to the target. Call every frame the bubble might be up. */
    update(dt) {
      if (root.hidden) return;
      place();
      if (!open || !isTyping()) return;
      if (hold > 0) { hold -= dt; return; }
      charT += dt;
      while (charT >= TYPE_PER_CHAR && isTyping()) {
        charT -= TYPE_PER_CHAR;
        shown += 1;
        if (PAUSE_AFTER.has(text[shown - 1])) { hold = TYPE_PAUSE; break; }
      }
      typeTo(shown);
    },
  };
}
