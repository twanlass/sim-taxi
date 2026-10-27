// The talk's deck, and its live-demo slide: the game running on its main menu inside a phone, and a
// tap that brings the phone to the middle of the screen, full height, to play. See docs/talk.md.
//
// **The game runs in a same-origin iframe, not on this page.** `src/main.js` boots the whole game
// on import and `createLayout()` installs its road network as *the* city (CLAUDE.md), so the game
// cannot be mounted as a component of another page. The iframe gives it a document of its own, and
// being same-origin lets this page reach in: `window.__taxi.presenter` to stop the world while the
// slide is off screen.
//
// **The phone is always the size it is when it's played, and is shrunk into the slide with a
// transform.** The iframe is the phone's screen at that size, portrait, so the game lays out as it
// does on an iPhone — menu, HUD, pedals — and it never resizes: going live is the transform easing
// to none. Resizing the iframe instead would resize the game's canvas on every step of the
// animation, and a resize both empties the drawing buffer and re-frames the camera. (The first
// version kept the iframe the size of the window and clipped it to the phone, which made the game
// lay out for a landscape window and opened out to it.)

// Inter, for the titles only (the Figma style asks for weight 450, which only the variable cut has).
import '@fontsource-variable/inter';
import { mountSelect } from './select.js';
import { createSnake } from './snake.js';
import { wispAway } from './wisp.js';
import { escapeCreatures, perchCreatures } from './escape.js';
import { flattenScene } from './flatten.js';

const REVEAL_MS = 900;
const lerp = (a, b, k) => a + (b - a) * k;

const game = document.getElementById('game');
const device = document.getElementById('device');
const slot = document.getElementById('phone-slot');
const surround = document.getElementById('surround');
let surroundFrame = 0;
document.documentElement.style.setProperty('--reveal-ms', `${REVEAL_MS}ms`);

// The real game, from its main menu: the phone shows the title screen with the city running, and
// everything after it (Play, the opening vignette, the tutorial) is the game as a player gets it.
// Only the startup splash is skipped, and the menu's intro blur.
// Both copies of the game load the same city (see the surround, below), so its seed is pinned here.
const CITY = `seed=${Math.floor(Math.random() * 1e9)}`;
game.src = `/?splash=classic&titleintro=classic&${CITY}`;

let live = false;

/** Shrink the phone from its playing size and place into the slot the slide keeps for it. */
function dock() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const s = slot.getBoundingClientRect();
  const scale = s.height / device.offsetHeight;
  const dx = s.left + s.width / 2 - W / 2;
  const dy = s.top + s.height / 2 - H / 2;
  device.style.setProperty('--dock', `translate(${dx}px, ${dy}px) scale(${scale})`);
}

function go(toLive) {
  if (toLive === live || !document.body.classList.contains('on-phone')) return;
  live = toLive;
  document.body.classList.toggle('live', toLive);
  if (toLive) game.focus();
  else game.blur();
}

device.addEventListener('click', () => go(true));

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
// The sketchbook: each click (or →) is the next beat — three doodles come out of the photo as
// pixel sprites and stand about at the bottom of the screen watching the cursor, then walk off
// (src/talk/escape.js), and WISP_AFTER_MS into the walk — about halfway across for the middle one,
// with no press of its own — the photo blows away into wisps (src/talk/wisp.js), and once it has
// gone the deck moves on to the snake by itself. Presses while the photo is still smoking are
// swallowed; leaving the slide puts the photo back.
const sketchSlide = document.getElementById('sketch');
const sketchPhoto = sketchSlide.querySelector('.photo');
const snakeSlide = document.getElementById('snake');
let wisp = null;
let escapees = null;
let escaped = false;
let wispTimer = 0;
const WISP_AFTER_MS = 1200;
sketchSlide.advance = () => {
  if (!escapees) {
    escapees = escapeCreatures(sketchPhoto);
    return true;
  }
  if (!escaped) {
    escaped = true;
    escapees.leave();
    wispTimer = setTimeout(() => {
      wisp = wispAway(sketchPhoto);
      wisp.done.then((ok) => { if (ok) show(slides.indexOf(snakeSlide)); });
    }, WISP_AFTER_MS);
    return true;
  }
  return true;
};
sketchSlide.addEventListener('click', () => sketchSlide.advance());
sketchSlide.addEventListener('leave', () => {
  escapees?.cancel();
  escapees = null;
  escaped = false;
  clearTimeout(wispTimer);
  wisp?.cancel();
  wisp = null;
  sketchPhoto.style.visibility = '';
});
// The thanks slide: PERCH_AFTER_MS after it comes up, slide 4's creatures come back and climb up
// onto the word (src/talk/escape.js). Leaving takes them away again.
const thanksSlide = document.getElementById('thanks');
const PERCH_AFTER_MS = 900;
let perched = null;
let perchTimer = 0;
thanksSlide.addEventListener('enter', () => {
  perchTimer = setTimeout(() => {
    document.fonts.ready.then(() => {
      if (thanksSlide.classList.contains('on')) perched = perchCreatures(thanksSlide.querySelector('h1'));
    });
  }, PERCH_AFTER_MS);
});
thanksSlide.addEventListener('leave', () => {
  clearTimeout(perchTimer);
  perched?.cancel();
  perched = null;
});
// The snake, a slide of its own so the talk can jump straight to it: it starts as the slide comes
// up, and each click (or →) puts the next thing on the board — the pineapple in the hat, the dragon
// fruit, the bomb — then moves on. Leaving the slide clears it.
let snake = null;
snakeSlide.addEventListener('enter', () => (snake ??= createSnake(snakeSlide)).advance());
snakeSlide.advance = () => snake?.advance() ?? false;
snakeSlide.addEventListener('click', () => snakeSlide.advance());
snakeSlide.addEventListener('leave', () => snake?.stop());
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
  const arriving = slides[current] !== slides[next];
  demos(slides[next], true);
  if (next > 0) startClock();
  if (cans && slides[next] !== kid) cans.then((c) => c.clear());
  current = next;
  slides.forEach((s, k) => s.classList.toggle('on', k === current));
  ticks.forEach((b, k) => b.classList.toggle('on', k === current));
  document.body.classList.toggle('on-phone', slides[current].id === 'slide');
  if (slides[current].id !== 'slide') go(false);
  loadSurround(slides[current].id === 'slide');
  game.contentWindow?.__taxi?.presenter?.hold(slides[current].id !== 'slide');
  document.body.classList.toggle('on-bleed', slides[current].classList.contains('bleed'));
  history.replaceState(null, '', `#${current + 1}`);
  if (arriving) slides[current].dispatchEvent(new Event('enter'));
}
mountSelect(document.getElementById('select'), { start: () => show(current + 1) });
// The hopping taxi, on the "Rocket Rides" title slide and the "Try it out" slide: the workshop's
// taxi, the same one the marketing site's hero carries (rocket-rides-web bundles this module).
// The module draws one taxi at a time (a second `mount` disposes the first), so the taxi moves to
// whichever of the two slides comes up, each time it does. Loaded the first time either does, so
// the deck doesn't stand up a WebGL context before then; the looks are decided first, as the
// workshop's own viewer does before it.
// Framed the way the marketing site frames it (its data-back / data-aim / data-ceil), pulled in
// from the workshop's distant default so the car is a mark you can see from the back of a room.
const HERO_TAXI = { back: 1.25, aimY: 1.6, ceil: 3.2 };
// On the title slide the taxi makes an entrance: the road waits empty until →, and then it comes
// up through a hole in it (`entry` in emptytaxi.js). Every visit to that slide starts empty again.
let heroTaxi = null;
for (const host of document.querySelectorAll('.slide .hero-taxi')) {
  const slide = host.closest('.slide');
  const entry = slide.id === 'name';
  let taxi = null;
  let entered = false;
  new MutationObserver(() => {
    if (!slide.classList.contains('on')) { taxi = null; entered = false; return; }
    heroTaxi ??= Promise.all([import('../game/renderpath.js'), import('../workshop/emptytaxi.js')])
      .then(([rp, m]) => { rp.decideLooks(rp.renderBudget()); return m; });
    taxi ??= heroTaxi.then((m) => m.mount(host, { ...HERO_TAXI, entry }));
  }).observe(slide, { attributes: true, attributeFilter: ['class'] });
  if (entry) {
    slide.advance = () => {
      if (entered || !taxi) return false;
      entered = true;
      taxi.then((t) => t.enter());
      return true;
    };
  }
}
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

window.addEventListener('resize', dock);
dock();

// The city round the live phone: a second copy of the game on the same seed, filling the window
// behind the scrim, held still, with nothing but its canvas showing, and its camera locked to the
// phone's every frame — the same position and the same world units per pixel, its frustum grown
// out from the phone's screen to the window's edges — so the streets carry on past the bezel. Only
// the traffic differs, frozen out there. Loaded while the slide is up and blanked when it goes, so
// it isn't rendering a whole window's worth of city through the rest of the talk.

/** The phone camera's drawn frustum, with any view offset and zoom folded in (as three builds it). */
function drawnFrustum(c) {
  const dx = (c.right - c.left) / (2 * c.zoom);
  const dy = (c.top - c.bottom) / (2 * c.zoom);
  const cx = (c.right + c.left) / 2;
  const cy = (c.top + c.bottom) / 2;
  let l = cx - dx;
  let t = cy + dy;
  let w = 2 * dx;
  let h = 2 * dy;
  if (c.view?.enabled) {
    const sw = w / c.view.fullWidth;
    const sh = h / c.view.fullHeight;
    l += sw * c.view.offsetX;
    t -= sh * c.view.offsetY;
    w = sw * c.view.width;
    h = sh * c.view.height;
  }
  return { l, t, w, h };
}

function followPhone() {
  surroundFrame = requestAnimationFrame(followPhone);
  if (!live) return;
  const from = game.contentWindow?.__taxi?.camera?.camera;
  const to = surround.contentWindow?.__taxi?.camera?.camera;
  if (!from || !to) return;
  const r = game.getBoundingClientRect();
  const { l, t, w, h } = drawnFrustum(from);
  const sx = w / r.width;
  const sy = h / r.height;
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.near = from.near;
  to.far = from.far;
  to.zoom = 1;
  to.clearViewOffset();
  to.left = l - sx * r.left;
  to.right = l + sx * (window.innerWidth - r.left);
  to.top = t + sy * r.top;
  to.bottom = t - sy * (window.innerHeight - r.top);
  to.updateProjectionMatrix();
  to.updateMatrixWorld();
}

function loadSurround(on) {
  cancelAnimationFrame(surroundFrame);
  if (!on) { surround.removeAttribute('src'); return; }
  if (!surround.getAttribute('src')) {
    surround.src = `/?splash=classic&titleintro=classic&${CITY}`;
    surround.onload = function quiet() {
      const w = surround.contentWindow;
      if (!w.__taxi?.presenter) { setTimeout(quiet, 100); return; }
      w.__taxi.presenter.hold(true);
      w.__taxi.presenter.settle();
      const style = w.document.createElement('style');
      style.textContent = 'body > :not(canvas) { visibility: hidden !important; }';
      w.document.head.appendChild(style);
    };
  }
  surroundFrame = requestAnimationFrame(followPhone);
}

// The game only runs while its slide is up: the presenter's hold freezes the world the way the
// pause does, with nothing drawn over it. Its handle comes up a moment after the frame loads.
function holdGame() {
  const presenter = game.contentWindow?.__taxi?.presenter;
  if (!presenter) { setTimeout(holdGame, 100); return; }
  presenter.hold(!document.body.classList.contains('on-phone'));
  game.classList.add('ready');
}
holdGame();
