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
// **Docked, with a tag on the talker — the default since the bubbles were reworked.** Pinning the
// whole card to a car made it the biggest moving thing on the screen, standing on the road the
// player was steering through, and sliding round the glass after anything that drove out of frame
// (Tyler: "they get in the way and move a lot"). So the *words* now sit in one fixed slot at the
// bottom, just over the Loco Mode fuel arc, where they never move; and the *who* is a small tag pinned to
// the target the card used to stand on — the same placement, edge-waiting and pointer as before
// (`placeSpeech` with a tag-sized box), but 24px across instead of a card. The tag earns its keep
// on the racer: with its roof flag gone, nothing else says which car is asking. Two cards up at once
// stack up from the slot in the order they opened. It sat at the top, under the cash and the stars,
// for its first build; Tyler moved it down (2026-10-20), which also lands "Hold to floor it" right
// over the pedal it is about. `?bubbles=dock` drops the tag;
// `?bubbles=classic` is the pinned card. A caller that places its own card (the New Move card,
// centred) passes `pinned: true` and keeps the old placement.
//
// **A tag waiting at the edge answers a tap like a rider's arrow does** (`onEdgeTap`): it rides the
// camera to the talker, and the player then taps the thing itself — the garage, the racer. Only
// while it is at the edge: on screen the tag sits on its talker, and a press there belongs to the
// talker (the garage's pick under it, the racer's own listener in main.js). `?tipfocus=classic`
// leaves the edge tag inert, as it was.
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
// The tag's band, and it never flips (`placeSpeech`'s `tag`). The card's rule — no room above the
// target, so hang it below with the pointer on its top edge — turned the tag into an upside-down
// pin: a 24px "!" under the racer, pointing *up* at it (Tyler, 2026-10-22, the racer two blocks
// up-screen of the taxi in a browser tab, where the canvas starts under the URL bar). A card that
// flips is still a card; a tag that flips reads as a different symbol. So a tag stays above its
// target and may rise into the HUD row to do it — it is a disc the size of the cash's glyphs, there
// only while the talker is that near the top — and when even that runs out it comes down onto the
// target with its pointer still underneath. Only on screen: a tag waiting at the top edge for an
// off-screen talker stays clear of the HUD row, since it can wait there for as long as it likes.
const TAG_TOP = EDGE;

// How far the docked card's bottom edge stands over the top of the Loco Mode fuel arc, in CSS px
// (Tyler: "24 units above the boost bar").
const DOCK_LIFT = 24;
// Where the arc's top was last measured, in viewport px from the top, or null before the first
// read. Read off the arc itself (`#boost-meter .boost-track`) on each show and resize rather than
// worked out from the pedal's custom properties, because the arc is drawn by game/fuelarc.js and
// its extent past the pedal is that module's business. Kept across reads so a show while the pedals
// are slid away (`hud-away`, which translates them off the bottom) uses the last good value.
let arcTop = null;
function readArcTop(vh) {
  const track = typeof document !== 'undefined' && document.querySelector('#boost-meter .boost-track');
  const r = track?.getBoundingClientRect();
  if (r && r.height > 0 && r.top > 0 && r.top < vh) arcTop = r.top;
  // No pedals measured yet: about where the arc sits on a 390×844 phone.
  return arcTop ?? vh - 230;
}
// How fast a docked card's height closes on a new row, per second (an exponential ease): about
// 0.2 s to cover most of a 21 px line.
const GROW_RATE = 14;
// Between two docked cards stacked in the slot.
const DOCK_GAP = 8;
// The tag: a disc this wide, with the pointer hanging off it.
const TAG = 24;
// How far a finger may smear and still be a tap on an edge tag, in px — the fare arrows' TAP_SLOP,
// for the same reason: a touch pointer is captured to the tag it landed on, so sliding off it still
// delivers the release here, and that slide is the player saying "no".
const TAP_SLOP = 8;

/** `?tipfocus=classic`: a tag at the edge takes no tap. Browser-only. */
function edgeTapsOff() {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('tipfocus') === 'classic';
}

/** `?questmark=classic`: an offer's tag shows the speech dots like any other. Browser-only. */
function questMarkOff() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('questmark') === 'classic';
}

/** 'tag' (the default), 'dock' or 'classic' — `?bubbles=`. Browser-only. */
function speechMode() {
  if (typeof window === 'undefined') return 'tag';
  const v = new URLSearchParams(window.location.search).get('bubbles');
  return v === 'classic' || v === 'dock' ? v : 'tag';
}

/**
 * The docked card's look — white with black type (Tyler, 2026-10-20: the black card's white type was
 * hard to read). `?bubblestyle=classic` is the see-through black it replaced, `?bubblestyle=card`
 * the white Figma card with its blue gradient.
 */
function captionStyle() {
  if (typeof window === 'undefined') return 'white';
  const v = new URLSearchParams(window.location.search).get('bubblestyle');
  return v === 'card' ? 'card' : v === 'classic' ? 'black' : 'white';
}

/**
 * A line with the thing it is about called out: `'Tap the {garage} for repairs'` is the text
 * "Tap the garage for repairs" with "garage" highlighted. Answers the plain text and its runs,
 * each `{ s, e, hl }` over that text, covering it end to end.
 */
export function parseLine(line) {
  const runs = [];
  let text = '';
  for (const [i, part] of String(line).split(/\{([^{}]*)\}/).entries()) {
    if (!part) continue;
    runs.push({ s: text.length, e: text.length + part.length, hl: i % 2 === 1 });
    text += part;
  }
  if (!runs.length) runs.push({ s: 0, e: 0, hl: false });
  return { text, runs };
}

// The docked cards currently up, oldest first, so a second one stacks under the first rather than
// on top of it. Each entry is that card's measured height, read live.
const dockStack = [];

/**
 * Where a docked card goes: centred across the screen with its bottom edge `DOCK_LIFT` over
 * `floor` (the fuel arc's top), `offset` px further up for
 * the cards above it. Pure, for the probe.
 */
export function placeDocked(w, h, vw, floor, insets = safe, offset = 0) {
  const minX = insets.left + EDGE;
  const maxX = vw - insets.right - EDGE;
  const left = maxX - minX >= w ? clamp(vw / 2 - w / 2, minX, maxX - w) : minX;
  return { left, top: floor - DOCK_LIFT - h - offset };
}

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
 * @param tag     a tag rather than a card: it may rise into the HUD row and never flips below its
 *                target (see TAG_TOP)
 * @returns {left, top, px, py, angle, onScreen} — the card's top-left corner, the pointer's base
 *          relative to the card's top-left, and the pointer's heading in radians (0 = right)
 */
export function placeSpeech(target, w, h, vw, vh, insets = safe, { tag = false } = {}) {
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
    const roof = tag ? insets.top + TAG_TOP : minY;
    let top = target.y - POINTER_GAP - h;
    side = 'bottom';
    if (top < roof && !tag) { top = target.y + POINTER_GAP; side = 'top'; }
    top = clamp(top, roof, Math.max(roof, maxY - h));
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
 *                  element in index.html (`#coach`, `#robber-talk`, `#radio`, `#cop-shout`, `#depot-call`); this
 *                  builds the card inside it
 * @param viewport  util/viewport.js — the frame the renderer draws, which on an installed iOS app
 *                  is not `window.inner*`
 * @param typing    type each line out, and answer `tap()`
 * @param onDismiss () => void — a tap on a finished line; typing bubbles only
 * @param onEdgeTap () => boolean — a tap on the tag while it waits at the screen edge; answers
 *                  whether it took the tap. Omit it and an edge tag is a decoration.
 * @param edgeTappable () => boolean — whether an edge tag takes a press *right now*, read per frame
 *                  (main.js passes `isNarrow`: above it nothing is ever off the frame to pan to)
 * @param dockFloor (vh, insets) => number — where a docked card's slot sits, in place of the fuel
 *                  arc's top: for a card with no pedals under it (the backstory, game/backstory.js)
 */
export function createSpeech(root, { viewport = null, typing = false, onDismiss = () => {}, pinned = false,
  onEdgeTap = null, edgeTappable = () => true, dockFloor = null } = {}) {
  watchSafeInsets();
  const mode = speechMode();
  const docked = !pinned && mode !== 'classic';
  const tagged = docked && mode === 'tag';
  root.classList.toggle('speech-docked', docked);
  const look = docked ? captionStyle() : 'card';
  if (look !== 'card') root.classList.add(`speech-style-${look}`, 'speech-glass');
  root.innerHTML = `
    <div class="speech">
      <div class="speech-body">
        <div class="speech-card">
          <div class="speech-title"></div>
          <div class="speech-text"></div>
          <div class="speech-media" hidden></div>
        </div>
        ${POINTER_SVG}
      </div>
    </div>${tagged ? `
    <div class="speech-tag-pin"><div class="speech-tag-body"><div class="speech-tag"><i></i><i></i><i></i><b>!</b></div>${POINTER_SVG}</div></div>` : ''}`;
  const el = root.querySelector('.speech');
  const body = root.querySelector('.speech-body');
  const card = root.querySelector('.speech-card');
  const titleEl = root.querySelector('.speech-title');
  const textEl = root.querySelector('.speech-text');
  const pointer = root.querySelector('.speech-pointer');
  const mediaEl = root.querySelector('.speech-media');
  if (look === 'card') card.style.background = CARD_FILL;
  const tagPin = root.querySelector('.speech-tag-pin');
  const tagBody = root.querySelector('.speech-tag-body');
  const tagPointer = tagPin?.querySelector('.speech-pointer');
  // Whether the tag is waiting at the edge this frame, and whether that edge tag takes a press —
  // the one flag the stylesheet reads (`can-edge-tap`) and the handler checks.
  let atEdge = false;
  let edgeLive = false;
  const edgeTaps = Boolean(tagPin && onEdgeTap) && !edgeTapsOff();
  if (edgeTaps) {
    // A pointerdown/pointerup pair with a slop test, as on the fare arrows (game/farepointers.js
    // says why at length): the pair is what a press is on a bare div on an iPhone, and the slop
    // keeps a finger that slid off the tag from riding the camera anyway.
    let press = null;
    const hold = (on) => tagPin.classList.toggle('is-held', on);
    const travelled = (event) => press
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP;
    tagPin.addEventListener('pointerdown', (event) => {
      press = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
      hold(Boolean(press && edgeLive));
    });
    tagPin.addEventListener('pointermove', (event) => { if (travelled(event)) hold(false); });
    tagPin.addEventListener('pointerup', (event) => {
      const from = press;
      const slid = travelled(event);
      press = null;
      hold(false);
      if (!from || !event.isPrimary || slid || !edgeLive || !open) return;
      // Taken here, and kept from the layer's own listener (the racer's, in main.js), which would
      // otherwise answer the same press as a tap on the car.
      if (onEdgeTap()) event.stopPropagation();
    });
    tagPin.addEventListener('pointercancel', () => { press = null; hold(false); });
  }
  // This card's place in `dockStack`, while it is up.
  const slot = { h: 0 };
  let text = '';
  // The line's runs (`parseLine`), each with its own typed part and untyped rest.
  let runs = [];
  let shown = 0;
  let charT = 0;
  // Seconds a letter, `TYPE_PER_CHAR` unless the line is being spoken (`pace`).
  let perChar = TYPE_PER_CHAR;
  let hold = 0;
  let closing = null;
  let open = false;
  let target = () => null;
  // Measured on `show` and on resize, not per frame: the untyped rest of the line is laid out
  // (hidden) from the start, so nothing about the card's box changes while it types, and a read per frame would force a layout
  // behind every character.
  let size = { w: 0, h: 0 };
  // The fuel arc's top, for the docked slot. Measured with the card rather than per frame: the arc
  // throbs a percent when a pour lands, and a slot that tracked it would throb too.
  let floor = 0;
  // The docked card's box as it is this frame, while it types (`size` is the finished one).
  let live = { w: 0, h: 0 };
  // The docked card's height as drawn: eased towards `live.h`, so a line that wraps onto a new row
  // opens the card over a few frames instead of in one (Tyler, 2026-10-22). Written to the card as
  // an explicit height, so `readLive` clears it to measure the natural one underneath.
  let drawnH = 0;
  const readLive = () => {
    card.style.height = '';
    live = { w: card.offsetWidth, h: card.offsetHeight };
    if (drawnH > 0) card.style.height = `${drawnH}px`;
  };
  const measure = () => {
    size = { w: card.offsetWidth, h: card.offsetHeight };
    slot.h = size.h;
    const vh = viewport ? viewport.height() : window.innerHeight;
    if (docked) floor = dockFloor ? dockFloor(vh, safe) : readArcTop(vh);
  };
  window.addEventListener('resize', () => { if (open && !(docked && isTyping())) measure(); });

  const isTyping = () => shown < text.length;
  // The whole line is always in the card: what has been typed, then the rest of it hidden. So every
  // letter is laid out where it will finish from the first frame — the card does not grow, and a
  // word that is going to wrap is on its second line from the start rather than typing out on the
  // first and jumping down when it runs out of room.
  //
  // A highlighted run is its own span, so it can wear the callout and wiggle once it has been typed
  // in full (`is-said`). The caret rides the run the next letter goes into.
  const setLine = (line) => {
    ({ text, runs } = parseLine(line));
    textEl.replaceChildren(...runs.map((r) => {
      const el = document.createElement('span');
      el.className = r.hl ? 'speech-run speech-hl' : 'speech-run';
      r.typed = document.createElement('span');
      r.typed.className = 'speech-typed';
      r.rest = document.createElement('span');
      r.rest.className = 'speech-rest';
      el.append(r.typed, r.rest);
      r.el = el;
      return el;
    }));
  };
  const typeTo = (n) => {
    shown = n;
    let caret = runs[0];
    for (const r of runs) {
      const k = Math.min(Math.max(n - r.s, 0), r.e - r.s);
      r.typed.textContent = text.slice(r.s, r.s + k);
      r.rest.textContent = text.slice(r.s + k, r.e);
      if (r.s < n) caret = r;
      r.el.classList.toggle('is-said', k === r.e - r.s && r.e > r.s);
    }
    for (const r of runs) r.el.classList.toggle('is-caret', r === caret);
    root.classList.toggle('is-typing', n < text.length);
  };
  const finishTyping = () => typeTo(text.length);

  function placeTag(at, w, h) {
    if (!tagPin || !at) return;
    const p = placeSpeech(at, TAG, TAG, w, h, safe, { tag: true });
    atEdge = !p.onScreen;
    const taps = edgeTaps && atEdge && edgeTappable();
    if (taps !== edgeLive) {
      edgeLive = taps;
      tagPin.classList.toggle('can-edge-tap', taps);
    }
    tagPin.style.transform = `translate(${p.left.toFixed(1)}px, ${p.top.toFixed(1)}px)`;
    tagPointer.style.left = `${p.px.toFixed(1)}px`;
    tagPointer.style.top = `${p.py.toFixed(1)}px`;
    tagPointer.style.transform = `translate(-50%, -100%) rotate(${(p.angle + Math.PI / 2).toFixed(3)}rad) translateY(${POINTER_SINK}px)`;
    tagBody.style.transformOrigin = `${p.px.toFixed(0)}px ${p.py.toFixed(0)}px`;
  }

  function place() {
    if (docked) {
      const w = viewport ? viewport.width() : window.innerWidth;
      const h = viewport ? viewport.height() : window.innerHeight;
      let offset = 0;
      for (const other of dockStack) {
        if (other === slot) break;
        offset += other.h + DOCK_GAP;
      }
      // The finished card's left edge and the card's height as it stands, so the box grows to the
      // right from where the line starts and ends centred, its bottom edge never moving.
      const p = placeDocked(size.w, drawnH || live.h, w, floor, safe, offset);
      el.style.transform = `translate(${p.left.toFixed(1)}px, ${p.top.toFixed(1)}px)`;
      placeTag(target(), w, h);
      return;
    }
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

  function leaveDock() {
    const i = dockStack.indexOf(slot);
    if (i !== -1) dockStack.splice(i, 1);
  }

  function hide() {
    if (!open) return;
    open = false;
    leaveDock();
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
    /** Is the tag up and waiting at the screen edge, its talker off the frame? */
    atEdge: () => open && atEdge,
    /**
     * @param title   who is talking — "TIP", "POLICE DISPATCH"; set in caps by the stylesheet
     * @param line    what they say
     * @param at      () => {x, y} | null — the point the pointer touches, viewport px, per frame
     * @param media   optional element shown under the line — the New Move card's pedal row
     *                (game/newmove.js). The card widens to fit it rather than wrapping it.
     * @param tag     false for a tip about a HUD control (the boost hint over the Loco pedal): the
     *                tag's dots say someone *in the city* is talking, and a button is not a talker
     *                (Tyler, 2026-10-24). The card still docks in its slot; only the tag goes.
     */
    show(title, line, at, media = null, { tag = true } = {}) {
      if (closing) { clearTimeout(closing); closing = null; }
      root.classList.remove('tag-only', 'tag-quest');
      root.classList.toggle('no-tag', !tag);
      titleEl.textContent = title;
      mediaEl.replaceChildren(...(media ? [media] : []));
      mediaEl.hidden = !media;
      card.classList.toggle('has-media', Boolean(media));
      setLine(line);
      target = at;
      // A docked card always types itself out (Tyler, 2026-10-20), even one that is not answered:
      // dispatch and the racer type too, they just don't take a tap to finish. A pinned card types
      // only when it is answered, as before.
      charT = 0;
      hold = 0;
      perChar = TYPE_PER_CHAR;
      open = true;
      root.hidden = false;
      root.classList.remove('is-closing', 'is-open');
      // Measured with the whole line in: a docked card types without its untyped rest laid out, so
      // the box grows letter by letter, and where it *finishes* is what fixes its left edge.
      card.style.height = '';
      drawnH = 0;
      finishTyping();
      measure();
      if ((typing || docked) && !prefersReducedMotion()) typeTo(0);
      live = { w: card.offsetWidth, h: card.offsetHeight };
      if (docked) {
        drawnH = live.h;
        card.style.height = `${drawnH}px`;
        slot.h = size.h;
        if (!dockStack.includes(slot)) dockStack.push(slot);
      }
      place();
      // One frame of the closed state before the open one, or the transition has nothing to run
      // from and the bubble simply appears.
      void root.offsetWidth;
      root.classList.add('is-open');
    },
    hide,
    /**
     * Just the tag on the talker, with no card: someone has something to say and is waiting to be
     * asked (the street racer, until it is tapped). Answers false where there is no tag
     * (`?bubbles=classic`/`dock`), so the caller can say it some other way.
     *
     * `quest`: the talker is offering something the player can take or leave — a side quest — and
     * the tag says so with a yellow "!" instead of the dots, the mark an RPG hangs over an NPC with
     * a quest to give. The dots are kept for "someone is talking": the moment the offer turns into
     * a line (`show`), the tag goes back to them. `?questmark=classic` keeps the dots throughout.
     */
    showTag(at, { quest = false } = {}) {
      if (!tagged) return false;
      this.show('', '', at);
      root.classList.add('tag-only');
      if (quest && !questMarkOff()) root.classList.add('tag-quest');
      leaveDock();
      return true;
    },
    /**
     * Finish the line, or dismiss a finished one. Returns false if there was nothing up to answer,
     * so the caller can tell a tap that did something from one that fell through to the game.
     */
    tap() {
      if (!typing || !open) return false;
      if (isTyping()) {
        finishTyping();
        // The docked slot is placed off the live height, so a line finished early by a tap has to
        // re-read it — or a line that wraps onto a new row in its last letters hangs off the floor.
        if (docked) readLive();
        return true;
      }
      onDismiss();
      return true;
    },
    /**
     * Type the rest of the line over `seconds`, the length of a voice reading it out (the backstory's
     * dispatch, game/backstory.js), so the words arrive with the voice rather than racing it home at
     * ~38 a second. Never faster than the usual pace. The pause after punctuation is kept, since the
     * voice takes a breath there too.
     */
    pace(seconds) {
      const rest = text.slice(shown);
      if (!rest.length) return;
      const breaths = [...rest].filter((c) => PAUSE_AFTER.has(c)).length;
      perChar = Math.max(TYPE_PER_CHAR, (seconds - breaths * TYPE_PAUSE) / rest.length);
    },
    /** Advance the typewriter and re-pin to the target. Call every frame the bubble might be up. */
    update(dt) {
      if (root.hidden) return;
      if (docked && open && drawnH !== live.h) {
        const k = prefersReducedMotion() ? 1 : 1 - Math.exp(-dt * GROW_RATE);
        drawnH += (live.h - drawnH) * k;
        if (Math.abs(live.h - drawnH) < 0.5) drawnH = live.h;
        card.style.height = `${drawnH}px`;
      }
      place();
      if (!open || !isTyping()) return;
      if (hold > 0) { hold -= dt; return; }
      charT += dt;
      while (charT >= perChar && isTyping()) {
        charT -= perChar;
        shown += 1;
        if (PAUSE_AFTER.has(text[shown - 1])) { hold = TYPE_PAUSE; break; }
      }
      typeTo(shown);
      if (docked) readLive();
    },
  };
}
