// The talk's opening slide: the game as a still inside a phone outline, and a tap that opens the
// phone out into the whole live game. See docs/talk.md.
//
// **The game runs in a same-origin iframe, not on this page.** `src/main.js` boots the whole game
// on import and `createLayout()` installs its road network as *the* city (CLAUDE.md), so the game
// cannot be mounted as a component of another page. The iframe gives it a document of its own, and
// being same-origin lets this page reach straight into it: `window.__taxi.presenter` to freeze the
// world, `window.__taxi.camera.camera` to frame the still, and the iframe's own `<body>` to hide
// the HUD. Nothing about the slide lives inside the game beyond that three-method handle.
//
// **The phone is a clip over a full-window game, not a small game that grows.** The iframe is the
// size of the window from the first frame to the last. While the slide is up, a `clip-path` cuts it
// down to the phone's screen and the camera's projection is pushed in and shifted so the taxi sits
// in the middle of that cut-out; the reveal eases the clip open and the projection back to the
// game's own in one curve. Resizing the iframe instead would resize the game's canvas on every
// step of the animation, and a resize both empties the drawing buffer and re-frames the camera.

// Inter, for the titles only (the Figma style asks for weight 450, which only the variable cut has).
import '@fontsource-variable/inter';
import { mountSelect } from './select.js';
import { createSnake } from './snake.js';
import { flattenScene } from './flatten.js';

const REVEAL_MS = 1100;
// How far the still is pushed in. At 1 a landscape window shows the whole city, which inside a
// phone-sized cut-out is a postage stamp; 2.4 is about what the game shows on an actual phone.
const STILL_ZOOM = 2.4;
// Let the settled city run this long, hidden, before freezing it: long enough for the first riders
// to appear (the board fills on the first `fares.update`) and for traffic to look under way.
const WARM_MS = 1200;

const game = document.getElementById('game');
const phone = document.getElementById('phone');
const back = document.getElementById('back');
document.documentElement.style.setProperty('--reveal-ms', `${REVEAL_MS}ms`);

// The real game, from its main menu: the phone opens onto the title screen and everything after it
// (Play, the opening vignette, the tutorial) is the game as a player gets it. Only the startup
// splash is skipped, and the menu's intro, whose 3 s blur would otherwise be frozen into the still.
game.src = '/?splash=classic&titleintro=classic';

// 0 = the slide, 1 = the live game; animated between.
let t = 0;
let live = false;
let animating = false;

/**
 * The phone's screen against the window, so the clip and the camera agree. Measured off the layout
 * box, not `getBoundingClientRect`: the phone is mid-scale for the whole reveal, and the way back
 * measures it on the frame it starts shrinking — a transformed rect there clipped the game to a
 * phone two and a half times the size of the one drawn.
 */
function phoneScreen() {
  const border = phone.clientLeft;
  const left = phone.offsetLeft + border;
  const top = phone.offsetTop + border;
  return {
    left, top,
    right: left + phone.clientWidth, bottom: top + phone.clientHeight,
    radius: phone.clientWidth * 0.12,
  };
}

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a, b, k) => a + (b - a) * k;
// The game's zoom from the first still, kept so a trip back and forth does not compound.
let framingZoom = 0;

function setClip(k) {
  const s = phoneScreen();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const c = (v) => `${lerp(v, 0, k).toFixed(2)}px`;
  document.documentElement.style.setProperty('--clip',
    `inset(${c(s.top)} ${c(W - s.right)} ${c(H - s.bottom)} ${c(s.left)} round ${c(s.radius)})`);
}

// The game's own framing, read when the still is taken, and the taxi it pushes in on. Zoom and
// target go through the game's camera state rather than `camera.zoom`: everything that sizes itself
// against the frame (the haze, the AO, the markers) reads the state, and a projection zoomed behind
// its back drew the still visibly darker than the same city at play zoom.
let framing = null;

function takeFraming() {
  const taxi = game.contentWindow.__taxi;
  const { state } = taxi.camera;
  framing = {
    zoom: state.zoom,
    from: { x: state.target.x, z: state.target.z },
    taxi: { x: taxi.traffic.taxi.x, z: taxi.traffic.taxi.z },
  };
}

/** Push the game's camera in on the taxi and over the phone, by `1 - k` of the way. */
function frameCamera(k) {
  const taxi = game.contentWindow?.__taxi;
  const cam = taxi?.camera?.camera;
  if (!cam || !framing) return;
  const s = phoneScreen();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const e = ease(k);
  const { state } = taxi.camera;
  state.zoom = lerp(framing.zoom / STILL_ZOOM, framing.zoom, e);
  state.target.x = lerp(framing.taxi.x, framing.from.x, e);
  state.target.z = lerp(framing.taxi.z, framing.from.z, e);
  // The game's own loop applies the state while it runs; under the hold, nothing does.
  if (taxi.presenter.held()) taxi.camera.update(W / H);
  // `setViewOffset` shifts the frame by the given pixels: shifting by (centre − phone centre)
  // lands the middle of the game's view — the taxi — in the middle of the phone.
  const dx = lerp(W / 2 - (s.left + s.right) / 2, 0, e);
  const dy = lerp(H / 2 - (s.top + s.bottom) / 2, 0, e);
  if (k >= 1) cam.clearViewOffset();
  else cam.setViewOffset(W, H, dx, dy, W, H);
  cam.updateProjectionMatrix();
}

/** The game's HUD, hidden while it is a still and faded back in once it is live. */
function hud(show) {
  const doc = game.contentDocument;
  if (!doc?.body) return;
  if (!doc.getElementById('talk-style')) {
    const style = doc.createElement('style');
    style.id = 'talk-style';
    style.textContent = `
      body.talk-still > :not(canvas) { visibility: hidden !important; }
      body.talk-fade > :not(canvas) { animation: talk-in 0.5s ease both; }
      @keyframes talk-in { from { opacity: 0; } }`;
    doc.head.appendChild(style);
  }
  doc.body.classList.toggle('talk-still', !show);
  if (show) {
    doc.body.classList.add('talk-fade');
    setTimeout(() => doc.body.classList.remove('talk-fade'), 600);
  }
}

function go(toLive) {
  if (animating || toLive === live) return;
  const presenter = game.contentWindow?.__taxi?.presenter;
  if (!presenter) return;
  animating = true;
  live = toLive;
  document.body.classList.add('revealing');
  document.body.classList.toggle('live', toLive);
  // Live from the first frame of the reveal: the city starts moving as the phone opens, which is
  // the whole trick. On the way back it freezes where it stands and the phone closes over it.
  // The title screen's camera reel cuts round the landmarks through `cutTo` every frame, which would
  // fight the reveal's zoom out; it's held off until the phone has opened, then handed back.
  const cam = game.contentWindow.__taxi.camera;
  if (toLive) {
    game.contentWindow.__taxi.pause?.setPaused(false);
    if (!cam.heldCut) { cam.heldCut = cam.cutTo; cam.cutTo = () => {}; }
    presenter.hold(false);
  }
  else { presenter.hold(true); hud(false); game.blur(); takeFraming(); framing.zoom = framingZoom; }
  setClip(toLive ? 1 : 0);

  const from = t;
  const to = toLive ? 1 : 0;
  const start = performance.now();
  const step = (now) => {
    const k = Math.min((now - start) / REVEAL_MS, 1);
    t = lerp(from, to, k);
    // Leaving the game (Esc, the blur) also trips the game's own pause, and a paused game draws one
    // frame and stops — so the push back in would never be drawn. Undo it for as long as we move.
    if (!toLive) game.contentWindow.__taxi.pause?.setPaused(false);
    frameCamera(t);
    if (k < 1) { requestAnimationFrame(step); return; }
    animating = false;
    document.body.classList.remove('revealing');
    if (toLive) {
      if (cam.heldCut) { cam.cutTo = cam.heldCut; delete cam.heldCut; }
      hud(true);
      game.focus();
    }
  };
  requestAnimationFrame(step);
}

phone.addEventListener('click', () => go(true));
back.addEventListener('click', () => go(false));
// The deck. One `.slide` shows at a time; the hash keeps your place across a reload. The phone
// slide is just one of them — the game iframe only shows while it is up.
const slides = [...document.querySelectorAll('.slide')];
let current = 0;
// The table of contents down the left edge: one tick per slide, named by its `data-name` or its
// heading, and a click jumps there.
const toc = document.getElementById('toc');
const ticks = slides.map((s, k) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<i></i><span>${k + 1}. ${s.dataset.name ?? s.querySelector('h1, h2')?.textContent ?? ''}</span>`;
  b.addEventListener('click', () => show(k));
  toc.appendChild(b);
  return b;
});
// Slide 2's cans, loaded on the first click there and swept away whenever the slide changes.
const kid = document.getElementById('kid');
let cans = null;
// Where the real Dr Pepper cans are in the photo (bottom left, by the keyboard), as fractions of it.
const REAL_CANS = { x: 0.11, y: 0.92 };
kid.querySelector('.photo').addEventListener('click', async (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  cans ??= import('./cans.js').then((m) => m.createCans());
  (await cans).drop({ x: r.left + REAL_CANS.x * r.width, y: r.top + REAL_CANS.y * r.height });
});
// Slide 4's snake: each click (or →) is the next beat — the snake, then the pineapple in the hat,
// the dragon fruit, the bomb — and leaving the slide clears it. Once the game is on, `playing`
// sends the photo back behind it (talk/index.html).
const snakeSlide = document.getElementById('snake');
let snake = null;
snakeSlide.advance = () => {
  snakeSlide.classList.add('playing');
  return (snake ??= createSnake(snakeSlide)).advance();
};
snakeSlide.addEventListener('click', () => snakeSlide.advance());
snakeSlide.addEventListener('leave', () => { snakeSlide.classList.remove('playing'); snake?.stop(); });
// The talk's game clock: nine minutes, bottom right, started by the first step off the title. The
// start time lives in sessionStorage so a reload mid-talk doesn't hand back the full nine; R resets.
const TALK_MS = 9 * 60 * 1000;
// The title slide's backdrop camera: half-height of the view in world units.
// Set by eye with sliders (Tyler, 2026-10-26): a held view of the city's middle, off the right edge.
const BG_ZOOM = 40;
// How far right the island sits, as a fraction of the window (it was the frame's 35vw offset).
const BG_SHIFT = 0.35;
// How far down it sits, as a fraction of the window's height: clear of the title's words above.
const BG_SHIFT_Y = 0.14;
// The squall's crossing clock on the backdrop: its first cell is due at 20 s and a crossing takes
// 75 s, so 30 has one already on its way in when the slide comes up.
const BG_SQUALL_AT = 30;
const clock = document.getElementById('clock');
const clockTime = clock.querySelector('b');
let startedAt = Number(sessionStorage.getItem('talk-start')) || 0;
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function tickClock() {
  if (!startedAt) return;
  const left = TALK_MS - (Date.now() - startedAt);
  // Ceil while counting down so 9:00 shows for its whole first second and 0:00 lands on time up.
  clockTime.textContent = left > 0 ? fmt(left + 999) : `+${fmt(-left)}`;
  clock.classList.toggle('hurry', left > 0 && left <= 60_000);
  clock.classList.toggle('over', left <= 0);
}
function startClock() {
  if (startedAt) return;
  startedAt = Date.now();
  sessionStorage.setItem('talk-start', String(startedAt));
  clock.classList.add('on');
  tickClock();
}
function resetClock() {
  startedAt = 0;
  sessionStorage.removeItem('talk-start');
  clock.classList.remove('on', 'hurry', 'over');
  clockTime.textContent = fmt(TALK_MS);
}
if (startedAt) { clock.classList.add('on'); tickClock(); }
setInterval(tickClock, 250);

// Playable demos (`.demo iframe[data-src]`): loaded when their slide comes up and blanked when it
// goes, so each visit starts a fresh game and nothing keeps running off screen. A click focuses the
// game and its keys go to it; Esc inside hands focus back to the deck.
/**
 * The title slide's backdrop: the game's title screen with everything over its canvas hidden and
 * the camera pinned. The reel cuts round the landmarks, and every cut goes through the camera's
 * `cutTo` — so answering each one with the same wide shot holds the frame dead still (no pan, no
 * drift) while the city keeps moving under it. Fades in once the game is up and has drawn a moment.
 */
function pinBackdrop(f) {
  const w = f.contentWindow;
  const cam = w?.__taxi?.camera;
  if (!cam || !f.getAttribute('src')) {
    if (f.getAttribute('src')) setTimeout(() => pinBackdrop(f), 100);
    return;
  }
  const style = w.document.createElement('style');
  style.textContent = 'body > :not(canvas) { visibility: hidden !important; }';
  w.document.head.appendChild(style);
  // The title's framing by default; a frame can ask for its own (`data-zoom`, `data-shift`) — the
  // old-versus-new wipe pins both games to the old version's fixed camera.
  const slide = f.closest('.slide');
  const zoomTo = Number(f.dataset.zoom) || BG_ZOOM;
  const shift = f.dataset.shift !== undefined ? Number(f.dataset.shift) : BG_SHIFT;
  const shiftY = f.dataset.shiftY !== undefined ? Number(f.dataset.shiftY) : BG_SHIFT_Y;
  const cutTo = cam.cutTo.bind(cam);
  const pin = (aspect) => {
    cutTo(0, 0, zoomTo, 0, aspect);
    // `setViewOffset` slides the frame by pixels; a negative x moves what's drawn to the right.
    const W = w.innerWidth;
    const H = w.innerHeight;
    cam.camera.setViewOffset(W, H, -shift * W, -shiftY * H, W, H);
    cam.camera.updateProjectionMatrix();
  };
  // The title's slide cuts to its first frame and then eases along with `focusOn` (main.js), so
  // both have to answer with the same fixed shot or the backdrop drifts across the city.
  cam.cutTo = (x, z, zoom, yaw, aspect) => pin(aspect);
  cam.focusOn = (x, z, zoom, dt, aspect) => pin(aspect);
  // Weather. The game only starts the squall once the taxi is the player's to drive, which the
  // title screen never reaches — so start it here, part way into its first crossing.
  const squall = w.__taxi.squall;
  // `data-squall` asks for it: the title's backdrop and the then-and-now wipe's today side.
  // A value is the crossing clock to start from: the first cell is due at 20 s and crosses in 75 s,
  // so 50 puts it about 40% across on load and over the middle of the city by the time the wipe
  // has revealed it, ~8 s later.
  if (squall && 'squall' in f.dataset) {
    squall.begin();
    squall.state.clock = Number(f.dataset.squall) || BG_SQUALL_AT;
  }
  // The handle is published seconds before the first frame shows anything — the first draws are
  // spent compiling shaders — so a timer off it faded in bare sky. Twenty of the frame's own
  // animation frames later, the city is on screen.
  let frames = 0;
  const count = () => {
    if (++frames < 20) { w.requestAnimationFrame(count); return; }
    f.classList.add('loaded');
    // The then-and-now wipe holds on the first commit until today's game is drawing, then reveals it.
    if (slide.classList.contains('compare')) slide.dispatchEvent(new Event('today-ready'));
    if (!slide.classList.contains('title')) return;
    // The words move into the game's own frame, so the lens drops bend them; the HTML copy (kept
    // for layout) goes transparent once the frame has finished fading in over it.
    import('./scenetext.js').then(({ paintIntoGame }) => {
      const painted = paintIntoGame(w, [...slide.querySelectorAll('h1, .kicker img, .kicker span, .handle')]);
      if (!painted) return;
      setTimeout(() => slide.classList.add('in-scene'), 1300);
      const onResize = () => { if (f.getAttribute('src')) painted.redraw(); else window.removeEventListener('resize', onResize); };
      window.addEventListener('resize', onResize);
    });
  };
  w.requestAnimationFrame(count);
}

function demos(slide, on) {
  for (const f of slide.querySelectorAll('.demo iframe, iframe.bg-game, iframe.cmp-old')) {
    if (!on) {
      f.removeAttribute('src');
      f.classList.remove('focused', 'loaded');
      slide.classList.remove('in-scene');
      continue;
    }
    if (f.getAttribute('src')) continue;
    f.src = f.dataset.src;
    // A backdrop is only ever looked at, and it doesn't wait for the frame's load event: that waits
    // on every file the game fetches (the audio among them) and fired ~9s after the city was up.
    if (f.classList.contains('bg-game')) { pinBackdrop(f); continue; }
    // The first build: its camera is already fixed on the whole city, so it only loses its HUD —
    // and its lighting, drawn flat (flatten.js) before it fades in.
    if (f.classList.contains('cmp-old')) {
      f.onload = () => {
        const style = f.contentDocument.createElement('style');
        style.textContent = 'body > :not(canvas) { visibility: hidden !important; }';
        f.contentDocument.head.appendChild(style);
        const flatten = () => { if (f.getAttribute('src') && !flattenScene(f.contentWindow)) setTimeout(flatten, 100); };
        flatten();
        setTimeout(() => f.classList.add('loaded'), 800);
      };
      continue;
    }
    f.onload = () => {
      const w = f.contentWindow;
      w.addEventListener('focus', () => f.classList.add('focused'));
      w.addEventListener('blur', () => f.classList.remove('focused'));
      w.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { f.blur(); window.focus(); f.classList.remove('focused'); }
      });
    };
  }
}

// The then-and-now wipe. It opens with the first commit filling the screen (the divider parked at
// the right edge); once today's game is drawing, the divider eases to the middle as the reveal.
// After that, drag anywhere on the slide and the divider follows the pointer.
// Long, so the quartic ease-out's tail is a slow settle into the middle rather than a stop.
const REVEAL_WIPE_MS = 5500;
// A beat on the first commit alone before the sweep, to talk over what it looked like then.
const REVEAL_HOLD_MS = 3000;
for (const cmp of document.querySelectorAll('.compare')) {
  let raf = 0;
  let hold = 0;
  const setX = (x) => cmp.style.setProperty('--x', `${(x * 100).toFixed(2)}%`);
  const move = (e) => {
    clearTimeout(hold);
    cancelAnimationFrame(raf);
    setX(Math.min(Math.max(e.clientX / window.innerWidth, 0), 1));
  };
  cmp.addEventListener('today-ready', () => { hold = setTimeout(sweep, REVEAL_HOLD_MS); });
  function sweep() {
    const start = performance.now();
    // The divider shows for the sweep, lingers a beat, then fades until it's hovered or dragged.
    cmp.classList.add('sweeping');
    const step = (now) => {
      const k = Math.min((now - start) / REVEAL_WIPE_MS, 1);
      // Ease-out (quartic): in fast from the edge, settling slowly into the middle.
      setX(lerp(1, 0.5, 1 - (1 - k) ** 4));
      if (k < 1) raf = requestAnimationFrame(step);
      else setTimeout(() => cmp.classList.remove('sweeping'), 700);
    };
    raf = requestAnimationFrame(step);
  }
  // Back to the first commit whenever the slide is left, so every visit gets the reveal.
  cmp.addEventListener('reset-wipe', () => {
    clearTimeout(hold);
    cancelAnimationFrame(raf);
    cmp.classList.remove('sweeping', 'dragging');
    setX(1);
  });
  cmp.addEventListener('pointerdown', (e) => {
    cmp.setPointerCapture(e.pointerId);
    cmp.classList.remove('sweeping');
    cmp.classList.add('dragging');
    move(e);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    cmp.addEventListener(type, () => cmp.classList.remove('dragging'));
  }
  cmp.addEventListener('pointermove', (e) => { if (cmp.hasPointerCapture(e.pointerId)) move(e); });
}

function show(i) {
  const next = Math.max(0, Math.min(slides.length - 1, i));
  if (slides[current] !== slides[next]) {
    demos(slides[current], false);
    slides[current].dispatchEvent(new Event('reset-wipe'));
    slides[current].dispatchEvent(new Event('leave'));
  }
  demos(slides[next], true);
  if (next > 0) startClock();
  if (cans && slides[next] !== kid) cans.then((c) => c.clear());
  current = next;
  slides.forEach((s, k) => s.classList.toggle('on', k === current));
  ticks.forEach((b, k) => b.classList.toggle('on', k === current));
  document.body.classList.toggle('on-phone', slides[current].id === 'slide');
  document.body.classList.toggle('on-bleed', slides[current].classList.contains('bleed'));
  history.replaceState(null, '', `#${current + 1}`);
}
mountSelect(document.getElementById('select'), { start: () => show(current + 1) });
const fromHash = () => show((Number.parseInt(location.hash.slice(1), 10) || 1) - 1);
fromHash();
window.addEventListener('hashchange', fromHash);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { go(false); return; }
  if (live) return;
  // A slide with steps of its own (the character select's tags) takes → until it has none left.
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (!slides[current].advance?.()) show(current + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(current - 1);
  else if (e.key === 'r' || e.key === 'R') { resetClock(); show(0); }
  else if (e.key === 'Enter' && document.body.classList.contains('on-phone')) go(true);
});
// The game has focus once it is live, so Escape has to be heard from inside it too.
game.addEventListener('load', () => {
  game.contentWindow.addEventListener('keydown', (e) => { if (e.key === 'Escape') go(false); });
});

window.addEventListener('resize', () => {
  setClip(live ? 1 : 0);
  frameCamera(t);
});

// Wait for the game to publish its handle, settle the city's entrance so the still is a whole
// city, let it run a beat, then freeze it and show it.
function whenReady() {
  const presenter = game.contentWindow?.__taxi?.presenter;
  if (!presenter) { setTimeout(whenReady, 100); return; }
  presenter.settle();
  hud(false);
  setClip(0);
  setTimeout(() => {
    presenter.hold(true);
    takeFraming();
    framingZoom = framing.zoom;
    frameCamera(0);
    game.classList.add('ready');
  }, WARM_MS);
}
setClip(0);
whenReady();
