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

import '@fontsource-variable/inter';

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

// Straight into a run: no title, no opening vignette, no tutorial bubbles.
game.src = '/?title=off&vignette=off&tutorial=off';

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
  if (toLive) { game.contentWindow.__taxi.pause?.setPaused(false); presenter.hold(false); }
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
    if (toLive) { hud(true); game.focus(); }
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
function show(i) {
  current = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((s, k) => s.classList.toggle('on', k === current));
  ticks.forEach((b, k) => b.classList.toggle('on', k === current));
  document.body.classList.toggle('on-phone', slides[current].id === 'slide');
  history.replaceState(null, '', `#${current + 1}`);
}
const fromHash = () => show((Number.parseInt(location.hash.slice(1), 10) || 1) - 1);
fromHash();
window.addEventListener('hashchange', fromHash);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { go(false); return; }
  if (live) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') show(current + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(current - 1);
  else if (e.key === 'r' || e.key === 'R') show(0);
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
