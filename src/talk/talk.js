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
// The talk's game clock: nine minutes, bottom right, started by the first step off the title. The
// start time lives in sessionStorage so a reload mid-talk doesn't hand back the full nine; R resets.
const TALK_MS = 9 * 60 * 1000;
// The title slide's backdrop camera: half-height of the view in world units.
// Set by eye with sliders (size 98, right 35vw): about 60% of the city, off the right edge.
const BG_ZOOM = 49;
// How far right the island sits, as a fraction of the window (it was the frame's 35vw offset).
const BG_SHIFT = 0.35;
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
  const cutTo = cam.cutTo.bind(cam);
  cam.cutTo = (x, z, zoom, yaw, aspect) => {
    cutTo(0, 0, BG_ZOOM, yaw, aspect);
    // `setViewOffset` slides the frame by pixels; a negative x moves what's drawn to the right.
    const W = w.innerWidth;
    const H = w.innerHeight;
    cam.camera.setViewOffset(W, H, -BG_SHIFT * W, 0, W, H);
    cam.camera.updateProjectionMatrix();
  };
  // Weather. The game only starts the squall once the taxi is the player's to drive, which the
  // title screen never reaches — so start it here, part way into its first crossing.
  const squall = w.__taxi.squall;
  if (squall) { squall.begin(); squall.state.clock = BG_SQUALL_AT; }
  // The handle is published seconds before the first frame shows anything — the first draws are
  // spent compiling shaders — so a timer off it faded in bare sky. Twenty of the frame's own
  // animation frames later, the city is on screen.
  let frames = 0;
  const count = () => {
    if (++frames < 20) { w.requestAnimationFrame(count); return; }
    f.classList.add('loaded');
    // The words move into the game's own frame, so the lens drops bend them; the HTML copy (kept
    // for layout) goes transparent once the frame has finished fading in over it.
    const slide = f.closest('.slide');
    import('./scenetext.js').then(({ paintIntoGame }) => {
      const painted = paintIntoGame(w, [...slide.querySelectorAll('h1, .byline')]);
      if (!painted) return;
      setTimeout(() => slide.classList.add('in-scene'), 1300);
      const onResize = () => { if (f.getAttribute('src')) painted.redraw(); else window.removeEventListener('resize', onResize); };
      window.addEventListener('resize', onResize);
    });
  };
  w.requestAnimationFrame(count);
}

function demos(slide, on) {
  for (const f of slide.querySelectorAll('.demo iframe, iframe.bg-game')) {
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
    f.onload = () => {
      const w = f.contentWindow;
      const style = w.document.createElement('style');
      // `data-fit`: scale a game's fixed-size canvas (Snake's 600x400) to the frame without touching
      // its own files. Opt-in — the workshop lays its canvas out itself.
      style.textContent = ('fit' in f.dataset ? 'canvas { width: min(96vw, 96vh * 1.5) !important; height: auto !important; }' : '')
        // `data-hide`: a demo's own dev tooling (Mystery's tuner panel and hotkey strip) stays off stage.
        + (f.dataset.hide ? `${f.dataset.hide} { display: none !important; }` : '');
      w.document.head.appendChild(style);
      w.addEventListener('focus', () => f.classList.add('focused'));
      w.addEventListener('blur', () => f.classList.remove('focused'));
      w.addEventListener('keydown', (e) => {
        // A game that spends Esc itself (Mystery closes its popup with it) keeps it while that's up.
        if (e.key === 'Escape' && !w.document.querySelector('#modal.on')) { f.blur(); window.focus(); f.classList.remove('focused'); }
      });
    };
  }
}

// Slide videos (`.vid video[data-src]`): fetched the first time their slide comes up, played from
// the top on every visit, paused on the way out.
function videos(slide, on) {
  for (const v of slide.querySelectorAll('.vid video')) {
    if (!on) { v.pause(); continue; }
    if (!v.getAttribute('src')) {
      v.addEventListener('loadeddata', () => v.classList.add('loaded'), { once: true });
      v.src = v.dataset.src;
    }
    v.currentTime = 0;
    v.play().catch(() => {});
  }
}

function show(i) {
  const next = Math.max(0, Math.min(slides.length - 1, i));
  if (slides[current] !== slides[next]) { demos(slides[current], false); videos(slides[current], false); }
  demos(slides[next], true);
  videos(slides[next], true);
  if (next > 0) startClock();
  if (cans && slides[next] !== kid) cans.then((c) => c.clear());
  current = next;
  slides.forEach((s, k) => s.classList.toggle('on', k === current));
  ticks.forEach((b, k) => b.classList.toggle('on', k === current));
  document.body.classList.toggle('on-phone', slides[current].id === 'slide');
  document.body.classList.toggle('on-bleed', slides[current].classList.contains('bleed'));
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
