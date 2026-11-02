// Slide 4's first beat: three of the cut-out doodles in the sketchbook photo come alive as SNES-style
// pixel sprites. One after another, each is scanned in over its doodle — a bright band sweeping
// up its silhouette from the feet, leaving the sprite behind it — and comes to life: eyes open, a
// stretch, then a hop onto a line a little over halfway down the screen, where they stand idling, breathing and
// blinking, their eyes following the cursor, until the presenter's next press (`leave`) walks them
// off to the left. (Two earlier entrances were cut: lifting a cut-out of the photo off
// the page and pixelating it, and tracing an ink outline round it and filling it in.)
//
// The sprites are drawn in code like everything else in the project: each is a handful of shapes
// (circles, ellipses, polygons, thick lines) rasterised onto a character grid, after the silhouette
// of the drawing it stands for, then shaded — a dark band down the edges away from the light, a
// highlight along the ones toward it — and ringed in a ballpoint-navy outline. The grids say what
// colour each part is; the outline and shading are worked out from them.

import {
  grid, ellipse, circle, poly, line, taper, shade, inked, eyeCells, drawEyes, gridCanvas,
} from './pixels.js';

// The outline, the blue of the biro the doodles were drawn in, and the colours the grids use.
const INK = '#1b2266';
const COLOURS = {
  K: INK, W: '#ffffff', B: '#2a4bd7', Y: '#ffc93c', O: '#f08a24', L: '#ffe58a',
  T: '#2fb8a6', t: '#1f7f86', l: '#7fe0cf', G: '#ffd23f', P: '#9b6bd6', p: '#6e45a8', q: '#c3a0f0',
  N: '#ff7eb6',
};

// --- The creatures -----------------------------------------------------------------------------

/**
 * Each creature: `box`, the cut-out it stands for in the photo (its bounds in the image's own
 * pixels, 1536 × 1024), which the sprite is scaled and centred to fit; `draw(f)`, its grid for walk
 * step `f` (0 or 1), eyes open and empty; and `eyes`. An eye is either a `seed` cell inside a region
 * of `white` (an eyeball, found by flood fill) or a `box` [x, y, w, h] of fur, with a `pw` × `ph`
 * `pupil` that slides across it to look left, ahead or right; a blink fills it with `lid` and draws
 * a line of ink across its middle.
 */
const CREATURES = [
  {
    // The one with its eyes on stalks: a pear of a body, two thin stalks in a V — the left one
    // taller — with big round eyeballs on top, little pointed arms out to the sides, bent legs.
    box: [652, 40, 800, 272],
    draw(f) {
      const g = grid(30, 40);
      ellipse(g, 14.5, 28, 8.5, 8, 'Y');
      ellipse(g, 14.5, 21.5, 4.5, 6, 'Y');
      poly(g, [[8, 23], [0.5, 20], [8, 27.5]], 'Y');
      poly(g, [[21, 23], [28.5, 19.5], [21, 26.5]], 'Y');
      line(g, 12.8, 20, 8, 8, 2.2, 'Y');
      line(g, 16.2, 20, 21.5, 12, 2.2, 'Y');
      shade(g, 'Y', 'O', 'L');
      // Legs and feet: splayed on one step, passing under the body on the other.
      const [a, b] = f ? [12.5, 16.5] : [9, 20];
      line(g, 11.5, 34, a, 38.5, 2, 'O');
      line(g, a - 2, 38.5, a + 1, 38.5, 1.6, 'O');
      line(g, 17.5, 34, b, 38.5, 2, 'O');
      line(g, b - 1, 38.5, b + 2, 38.5, 1.6, 'O');
      circle(g, 7.5, 5, 4.4, 'W');
      circle(g, 22, 10, 4, 'W');
      return g;
    },
    eyes: [[7, 5], [22, 10]].map((seed) => ({ seed, white: 'W', pupil: 'B', pw: 3, ph: 3, lid: 'Y' })),
  },
  {
    // The squid: a tall diamond of a head with one eye near its point, a V of a brow and two eyes
    // under it, and six long wavy tentacles splaying out wide below, churning as it walks.
    box: [935, 65, 1175, 410],
    draw(f) {
      const g = grid(38, 52);
      [-17, -11, -4, 4, 11, 17].forEach((spread, i) => {
        const base = 14 + i * 2;
        const pts = [];
        for (let k = 0; k <= 12; k++) {
          const t = k / 12;
          const wave = Math.sin(t * Math.PI * 2.2 + f * Math.PI + i * 1.3) * 2.4 * t;
          pts.push([base + spread * t ** 1.5 + wave, 24 + t * 26]);
        }
        taper(g, pts, 3.6, 1.3, 'T');
      });
      poly(g, [[19, 0], [8.5, 13.5], [19, 28], [29.5, 13.5]], 'T');
      shade(g, 'T', 't', 'l');
      circle(g, 19, 7, 2.1, 'G');
      circle(g, 14.5, 16, 2.6, 'G');
      circle(g, 23.5, 16, 2.6, 'G');
      line(g, 15, 10.3, 19, 12.8, 1.1, 'K');
      line(g, 19, 12.8, 23, 10.3, 1.1, 'K');
      return g;
    },
    eyes: [[19, 7], [14, 16], [23, 16]].map((seed) => ({ seed, white: 'G', pupil: 'K', pw: 2, ph: 2, lid: 'T' })),
  },
  {
    // The box cat: a squarish, slightly skewed box with two pointed ears up on its right, dot eyes,
    // a big onion of a nose and a starburst of a mouth, on two stick legs.
    box: [1270, 725, 1450, 890],
    draw(f) {
      const g = grid(32, 36);
      poly(g, [[13.5, 7], [17.5, 0], [20, 6.5]], 'P');
      poly(g, [[20.5, 6.5], [25, 0], [27.5, 6.5]], 'P');
      poly(g, [[1, 7.5], [28, 5.5], [29, 29.5], [2, 31]], 'P');
      shade(g, 'P', 'p', 'q');
      inked(g, (m) => { circle(m, 13.5, 21, 4.6, '#'); poly(m, [[13.5, 13], [10, 19], [17, 19]], '#'); }, 'N');
      for (let a = 0; a < 8; a++) {
        const an = (a * Math.PI) / 4;
        line(g, 14.5, 28, 14.5 + Math.cos(an) * 2.6, 28 + Math.sin(an) * 2.6, 1, 'K');
      }
      const [a, b] = f ? [11.5, 18.5] : [8.5, 21.5];
      line(g, 10.5, 31, a, 35.5, 1.2, 'p');
      line(g, 19.5, 30.5, b, 35.5, 1.2, 'p');
      return g;
    },
    eyes: [[8, 12], [16, 12]].map(([x, y]) => ({ box: [x, y, 4, 2], white: 'P', pupil: 'K', pw: 2, ph: 2, lid: 'P' })),
  },
];

// --- The beat ----------------------------------------------------------------------------------

// In ms, px and px/s. Each creature comes ENTRY_GAP_MS after the last. It is scanned in from the
// feet up over SCAN_MS, under a white band SCAN_BAND of its height deep that fades out below its
// leading edge, and HOP_AT of the way through the scan it is already jumping off the page (up at
// HOP_UP, falling under GRAVITY, drifting left at HOP_DRIFT), the scan finishing in the air. (It used
// to finish the scan standing on the drawing, stretch awake and pause before the jump, which left
// time to see that the pixel silhouette doesn't trace the ink exactly.) Then it
// squashes on landing for LAND_MS, stands about until `leave`, and walks off at WALK_SPEED, a step
// every STRIDE_MS. FLOOR_AT is where their feet land, as a fraction of the window's height: up in
// the frame rather than at its foot (28px off the bottom at first), which a room can't see past the
// heads in front. A doodle below that line hops up to it, launching harder than HOP_UP if it has to.
const ENTRY_GAP_MS = 750;
const SCAN_MS = 650;
const SCAN_BAND = 0.3;
const HOP_AT = 0.5;
const HOP_UP = 950;
const GRAVITY = 3200;
const HOP_DRIFT = 160;
const LAND_MS = 140;
const WALK_SPEED = 230;
const STRIDE_MS = 150;
const FLOOR_AT = 0.6;
// Standing about: a breath every BREATH_MS, BREATH deep, and eyes on the cursor, turned all the way
// once it is LOOK_REACH px off to a side (or above or below). Each creature blinks every
// BLINK_EVERY_MS or so for BLINK_MS, on its own clock.
const BREATH_MS = 1700;
const BREATH = 0.035;
const LOOK_REACH = 320;
const BLINK_MS = 120;
const BLINK_EVERY_MS = 2400;

/**
 * A creature's frames: `frame(step, look, shut)`, made on first use and cached (walk step × where
 * it looks × blink); `asleep`, eyes shut, for the scan-in; and `glow`, its silhouette in white, for
 * the scan's band.
 */
function makeSprite(c) {
  const open = [0, 1].map((f) => c.draw(f));
  const eyes = c.eyes.map((e) => ({ e, cells: eyeCells(open[0], e) }));
  const cache = new Map();
  const frame = (f, look, shut) => {
    const key = `${f}|${shut ? 'shut' : String(look)}`;
    if (!cache.has(key)) {
      const gr = open[f].map((row) => [...row]);
      drawEyes(gr, eyes, look, shut);
      cache.set(key, gridCanvas(gr, COLOURS, INK));
    }
    return cache.get(key);
  };
  const asleep = frame(0, 0, true);
  const glow = document.createElement('canvas');
  glow.width = asleep.width;
  glow.height = asleep.height;
  const gg = glow.getContext('2d');
  gg.drawImage(asleep, 0, 0);
  gg.globalCompositeOperation = 'source-in';
  gg.fillStyle = '#ffffff';
  gg.fillRect(0, 0, glow.width, glow.height);
  return { frame, asleep, glow };
}

/**
 * A creature part-scanned: `scan` is the height of the band's leading edge as a fraction of the
 * sprite, from the feet. Below it the sprite, and over the band the white silhouette, strongest
 * at the edge and fading out down its depth, a row of art pixels at a time.
 */
function drawScan(g, s, left, top, scan) {
  const rows = s.asleep.height;
  const edge = Math.round(rows * (1 - scan));
  const from = Math.max(0, edge);
  if (from < rows) g.drawImage(s.asleep, 0, from, s.asleep.width, rows - from, left, top + from * s.px, s.w, (rows - from) * s.px);
  const depth = Math.max(1, Math.round(rows * SCAN_BAND));
  for (let i = 0; i < depth; i++) {
    const row = edge + i;
    if (row < 0 || row >= rows) continue;
    g.globalAlpha = (1 - i / depth) ** 1.5;
    g.drawImage(s.glow, 0, row, s.glow.width, 1, left, top + row * s.px, s.w, s.px);
  }
  g.globalAlpha = 1;
}

/** The scan band's leading edge `ms` in (from below the feet to past the head), or undefined once done. */
const scanAt = (ms) => (ms < SCAN_MS ? -SCAN_BAND + (1 + 2 * SCAN_BAND) * (ms / SCAN_MS) : undefined);

/** A full-window canvas over the deck for the sprites, at device resolution. */
function overlay() {
  const canvas = document.createElement('canvas');
  canvas.className = 'escapees';
  Object.assign(canvas.style, {
    position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none',
  });
  document.body.appendChild(canvas);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  return canvas;
}

/** Eyes toward `cursor` from a creature's eye line at (x, y), quantised so frames can be cached. */
function lookToward(cursor, x, y) {
  if (!cursor) return [0, 0];
  const q = (v, step) => Math.round(Math.max(-1, Math.min(1, v / LOOK_REACH)) / step) * step;
  return [q(cursor[0] - x, 0.5), q(cursor[1] - y, 1)];
}

/**
 * Let the creatures out of `img` (the sketchbook photo, possibly tilted by CSS). Returns
 * `{ done, cancel, leave }`; they stand about until `leave()`, and `done` resolves when the last
 * one has walked off the screen.
 */
export function escapeCreatures(img) {
  const canvas = overlay();
  const g = canvas.getContext('2d');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  // Image pixel → screen: the layout box (the bounding rect of a tilted element is bigger than the
  // picture), turned by the element's own rotation about its centre.
  const r = img.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const tilt = (parseFloat(getComputedStyle(img).rotate) || 0) * Math.PI / 180;
  const k = img.offsetWidth / img.naturalWidth;
  const toScreen = ([nx, ny]) => {
    const x = (nx - img.naturalWidth / 2) * k;
    const y = (ny - img.naturalHeight / 2) * k;
    return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)];
  };

  const t0 = performance.now();
  const sprites = CREATURES.map((c, i) => {
    const { frame, asleep, glow } = makeSprite(c);
    const first = frame(0, 0, false);
    // Scaled to the cut-out it stands for, in whole screen pixels per art pixel so every pixel is
    // the same size, and centred on it.
    const [bx0, by0, bx1, by1] = c.box;
    const px = Math.max(2, Math.round(Math.min(((bx1 - bx0) * k) / first.width, ((by1 - by0) * k) / first.height)));
    const w = first.width * px;
    const h = first.height * px;
    const [x, y] = toScreen([(bx0 + bx1) / 2, (by0 + by1) / 2]);
    // Where it lands: feet on the floor, and how long the hop takes to get there.
    const floorY = H * FLOOR_AT - h / 2;
    const drop = floorY - y;
    // Fast enough to peak a fifth over a landing above it, so it comes down onto the line.
    const up = Math.max(HOP_UP, 1.1 * Math.sqrt(2 * GRAVITY * Math.max(0, -drop)));
    const hopMs = 1000 * (up + Math.sqrt(up * up + 2 * GRAVITY * drop)) / GRAVITY;
    return {
      frame, asleep, glow, px, x, y, w, h, floorY, hopMs, up,
      born: t0 + i * ENTRY_GAP_MS, blinkPhase: Math.random() * BLINK_EVERY_MS,
    };
  });

  let raf = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const end = (ok) => {
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    canvas.remove();
    finish(ok);
  };

  // Where a sprite is and how it's drawn at time `now` — position, squash, walk step, where it's
  // looking, whether it's blinking, and during the entry how much of it has been drawn — or
  // null before it's born and once it's off the screen.
  // Where the cursor is, for the eyes; until it moves they look straight out.
  let cursor = null;
  const onMove = (ev) => { cursor = [ev.clientX, ev.clientY]; };
  window.addEventListener('pointermove', onMove);
  let exitAt = null;
  /** Where a creature standing at `x` looks to see the cursor. */
  const lookAt = (s, x) => lookToward(cursor, x, s.floorY - s.h / 3);

  function pose(s, now) {
    let e = now - s.born;
    if (e < 0) return null;
    const blinking = (now + s.blinkPhase) % BLINK_EVERY_MS < BLINK_MS;
    const at = (o) => ({ sx: 1, sy: 1, f: 0, look: 0, shut: blinking, ...o });
    const takeoff = SCAN_MS * HOP_AT;
    if (e < takeoff) return at({ x: s.x, y: s.y, scan: scanAt(e) });
    const scan = scanAt(e);
    e -= takeoff;
    if (e < s.hopMs) {
      const t = e / 1000;
      // Stretched in the air, eyes wide — once the scan has finished drawing it.
      return at({ x: s.x - HOP_DRIFT * t, y: s.y - s.up * t + 0.5 * GRAVITY * t * t, sx: 0.92, sy: 1.1, f: 1, shut: false, scan });
    }
    e -= s.hopMs;
    const landX = s.x - HOP_DRIFT * s.hopMs / 1000;
    if (e < LAND_MS) {
      const q = Math.sin(Math.PI * e / LAND_MS);
      return at({ x: landX, y: s.floorY, sx: 1 + 0.25 * q, sy: 1 - 0.25 * q, shut: true });
    }
    e -= LAND_MS;
    // Standing about until told to go, and then for as long as it took to land if it was told early.
    if (exitAt === null || now < exitAt) {
      const q = Math.sin(((now + s.blinkPhase) / BREATH_MS) * Math.PI * 2);
      return at({ x: landX, y: s.floorY, sx: 1 - BREATH * 0.5 * q, sy: 1 + BREATH * q, look: lookAt(s, landX) });
    }
    e = Math.min(e, now - exitAt);
    const x = landX - WALK_SPEED * e / 1000;
    if (x < -s.w) return null;
    const f = Math.floor(e / STRIDE_MS) % 2;
    // A one-pixel bob on the passing step, eyes on where it's going.
    return at({ x, y: s.floorY - (f ? s.px : 0), f, look: -1 });
  }

  const draw = (now) => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    let alive = false;
    for (const s of sprites) {
      const p = pose(s, now);
      if (!p) { alive ||= now < s.born; continue; }
      alive = true;
      // Scaled about the feet, so a squash sits it down rather than shrinking it toward its middle.
      const w = s.w * p.sx;
      const h = s.h * p.sy;
      const left = Math.round(p.x - w / 2);
      const top = Math.round(p.y + s.h / 2 - h);
      if (p.scan !== undefined) drawScan(g, s, left, top, p.scan);
      else g.drawImage(s.frame(p.f, p.look, p.shut), left, top, w, h);
    }
    if (alive) raf = requestAnimationFrame(draw);
    else end(true);
  };
  raf = requestAnimationFrame(draw);
  return {
    done,
    cancel: () => end(false),
    /** Walk them all off, now — or as soon as each has landed, for any still on its way down. */
    leave: () => { exitAt ??= performance.now(); },
  };
}

// --- The encore --------------------------------------------------------------------------------
// The thanks slide brings them back: each hops in from off the side of the screen, lands on the
// heading's baseline, looks toward the word, walks up to it and hops up onto the letters, where it
// idles as it did at the bottom of slide 4 — breathing, blinking, eyes on the cursor — for as long
// as the slide is up. PERCH says, per creature, which side it comes from and where it lands (px past
// the word's edge, negative to the left) and where along the word it settles (a fraction of its
// width). They come PERCH_GAP_MS apart, at PERCH_PX screen pixels per art pixel; the hop in peaks
// HOP_IN_APEX px up, they stand LOOK_MS before setting off, and the hop onto the word peaks
// PERCH_APEX px above where it lands.
//
// Where it lands is worked out to the pixel (`restTop`): the word is rasterised to find the top of
// its ink in every screen column, each sprite's lowest pixel in every one of its columns is read off
// its art, and the creature comes to rest where the first of its pixels meets a letter — on the T's
// bar, the shoulder of an n, the top of the k — rather than on the word's tallest letter everywhere.
// (The first cut stood them all on the cap height, which left the ones over the lower-case letters
// hanging in the air.)
const PERCH = [
  { creature: 0, from: -170, at: 0.18 },
  { creature: 1, from: 150, at: 0.5 },
  { creature: 2, from: 330, at: 0.84 },
];
const PERCH_PX = 3;
const PERCH_GAP_MS = 450;
const HOP_IN_APEX = 160;
const LOOK_MS = 450;
const PERCH_APEX = 70;
// The easter egg: a click on a creature squashes it flat over SQUISH_MS and it bursts into BROOD
// copies of itself at BROOD_PX, thrown up and out (BROOD_VX to either side, BROOD_VY up, give or
// take half), which fall back onto the word — or the baseline beside it — and idle like the rest.
// The copies can be clicked too, up to BROOD_CAP creatures on the slide.
const SQUISH_MS = 260;
const BROOD = 10;
const BROOD_PX = 2;
const BROOD_VX = 520;
const BROOD_VY = 1200;
const BROOD_CAP = 160;

/**
 * The top of `el`'s ink in every screen column, as `surface(x)` (the baseline where there is none),
 * plus the left and right of its line and its baseline. The text is drawn again onto a canvas in the
 * same font, size, weight and letter spacing, and read back.
 */
function inkProfile(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const w = Math.ceil(r.width);
  const h = Math.ceil(r.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  // The range's box is the font's content area, so the baseline is its ascent down from the top.
  const ascent = g.measureText(el.textContent).fontBoundingBoxAscent;
  g.fillText(el.textContent, 0, ascent);
  const data = g.getImageData(0, 0, w, h).data;
  const tops = new Float32Array(w).fill(Infinity);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (data[(y * w + x) * 4 + 3] > 127) { tops[x] = r.top + y; break; }
    }
  }
  const baseline = r.top + ascent;
  const surface = (x) => {
    const i = Math.floor(x - r.left);
    return i >= 0 && i < w && tops[i] < Infinity ? tops[i] : baseline;
  };
  return { left: r.left, right: r.right, baseline, surface };
}

/** For each column of a sprite's art, how many rows down its lowest pixel ends (0 for an empty one). */
function feetOf(art) {
  const { width, height } = art;
  const data = art.getContext('2d').getImageData(0, 0, width, height).data;
  return Array.from({ length: width }, (_, x) => {
    for (let y = height - 1; y >= 0; y--) if (data[(y * width + x) * 4 + 3] > 127) return y + 1;
    return 0;
  });
}

/** Which art pixels of `art` are drawn, for hit-testing a click against the sprite's own shape. */
function maskOf(art) {
  const { width, height } = art;
  const data = art.getContext('2d').getImageData(0, 0, width, height).data;
  return (x, y) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] > 127;
}

/**
 * Bring the creatures back onto `heading`. Returns `{ cancel }`; they stay perched until cancelled.
 * A click on one pops it into a brood of copies (BROOD above).
 */
export function perchCreatures(heading) {
  const canvas = overlay();
  const g = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const word = inkProfile(heading);
  const t0 = performance.now();
  // Each creature's frames, feet and hit mask, made once and shared by all its copies.
  const looks = new Map();
  const lookOf = (ci) => {
    if (!looks.has(ci)) {
      const art = makeSprite(CREATURES[ci]);
      const first = art.frame(0, 0, false);
      looks.set(ci, { art, first, feet: feetOf(first), hit: maskOf(first) });
    }
    return looks.get(ci);
  };
  // The centre y of a sprite `w` × `h` at `px` standing centred on x: as low as it can go before any
  // of its pixels meets the surface under that pixel's column.
  const restY = (feet, w, h, px, x) => {
    const left = Math.round(x - w / 2);
    let top = Infinity;
    feet.forEach((f, c) => {
      if (!f) return;
      for (let k = 0; k < px; k++) top = Math.min(top, word.surface(left + c * px + k) - f * px);
    });
    return top + h / 2;
  };
  const sprites = PERCH.map((p, i) => {
    const { art, first, feet, hit } = lookOf(p.creature);
    const px = PERCH_PX;
    const w = first.width * px;
    const h = first.height * px;
    const rest = (x) => restY(feet, w, h, px, x);
    const dir = p.from < 0 ? 1 : -1; // which way it walks: toward the word
    const xs = p.from < 0 ? -w : W + w; // off the edge it hops in from
    const x0 = p.from < 0 ? word.left + p.from : word.right + p.from;
    // It walks until it is just short of the word's edge, then hops onto its perch.
    const xt = p.from < 0 ? word.left - w / 2 - 12 : word.right + w / 2 + 12;
    const xp = word.left + (word.right - word.left) * p.at;
    const ground = rest(x0);
    const perch = rest(xp);
    const rise = ground - perch;
    const vyIn = Math.sqrt(2 * GRAVITY * HOP_IN_APEX);
    const vy = Math.sqrt(2 * GRAVITY * (rise + PERCH_APEX));
    return {
      ...art, ci: p.creature, hit, rest, px, w, h, dir, xs, x0, xt, xp, ground, perch, rise, vy, vyIn,
      inMs: (2000 * vyIn) / GRAVITY,
      walkMs: (1000 * Math.abs(xt - x0)) / WALK_SPEED,
      hopMs: 1000 * (vy + Math.sqrt(vy * vy - 2 * GRAVITY * rise)) / GRAVITY,
      born: t0 + i * PERCH_GAP_MS, blinkPhase: Math.random() * BLINK_EVERY_MS,
    };
  });

  let cursor = null;
  // The creature under a point, by its drawn pixels rather than its box: the topmost one drawn.
  const under = (x, y) => {
    for (let i = sprites.length - 1; i >= 0; i--) {
      const s = sprites[i];
      const d = s.drawn;
      if (!d || s.popAt) continue;
      const ax = Math.floor(((x - d.left) / d.w) * s.asleep.width);
      const ay = Math.floor(((y - d.top) / d.h) * s.asleep.height);
      if (s.hit(ax, ay)) return s;
    }
    return null;
  };
  const onMove = (ev) => {
    cursor = [ev.clientX, ev.clientY];
    document.body.style.cursor = under(ev.clientX, ev.clientY) ? 'pointer' : '';
  };
  const onDown = (ev) => {
    const s = under(ev.clientX, ev.clientY);
    if (s) s.popAt = performance.now();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerdown', onDown);

  /** A popped creature's brood: BROOD copies thrown out of where it stood, falling under gravity. */
  function brood(s, now) {
    const { art, first, feet, hit } = lookOf(s.ci);
    const px = BROOD_PX;
    const w = first.width * px;
    const h = first.height * px;
    const n = Math.min(BROOD, BROOD_CAP - sprites.length + 1);
    for (let k = 0; k < n; k++) {
      sprites.push({
        ...art, ci: s.ci, hit, px, w, h, free: true,
        rest: (x) => restY(feet, w, h, px, x),
        x: s.at.x, y: s.at.y,
        vx: (Math.random() * 2 - 1) * BROOD_VX,
        vy: -BROOD_VY * (0.5 + Math.random()),
        landedAt: null, born: now, blinkPhase: Math.random() * BLINK_EVERY_MS,
      });
    }
  }

  /** One frame of a thrown copy's flight: gravity, the screen's sides, and landing where it falls. */
  function fly(s, now, dt) {
    if (s.landedAt) return;
    s.vy += GRAVITY * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    const W = window.innerWidth;
    if (s.x < s.w / 2 || s.x > W - s.w / 2) { s.vx = -s.vx; s.x = Math.max(s.w / 2, Math.min(W - s.w / 2, s.x)); }
    const ground = s.rest(s.x);
    if (s.vy > 0 && s.y >= ground) {
      s.y = ground;
      s.landedAt = now;
    }
  }

  const squash = (e) => { const q = Math.sin(Math.PI * e / LAND_MS); return { sx: 1 + 0.25 * q, sy: 1 - 0.25 * q }; };

  // Position (the sprite's centre), squash, step and gaze at `now`.
  function pose(s, now) {
    const blinking = (now + s.blinkPhase) % BLINK_EVERY_MS < BLINK_MS;
    // Squashed flat, eyes screwed shut, about to go.
    if (s.popAt) {
      const k = Math.min(1, (now - s.popAt) / SQUISH_MS);
      const q = k * k;
      return { ...s.at, sx: 1 + 0.45 * q, sy: 1 - 0.6 * q, f: 0, look: 0, shut: true };
    }
    if (s.free) {
      const at = (o) => ({ sx: 1, sy: 1, f: 0, look: Math.sign(s.vx), shut: blinking, x: s.x, y: s.y, ...o });
      if (!s.landedAt) return at({ sx: 0.92, sy: 1.1, f: 1, shut: false });
      const e = now - s.landedAt;
      if (e < LAND_MS) return at(squash(e));
      const q = Math.sin(((now + s.blinkPhase) / BREATH_MS) * Math.PI * 2);
      return at({ sx: 1 - BREATH * 0.5 * q, sy: 1 + BREATH * q, look: lookToward(cursor, s.x, s.y - s.h / 3) });
    }
    let e = now - s.born;
    if (e < 0) return null;
    const at = (o) => ({ sx: 1, sy: 1, f: 0, look: s.dir, shut: blinking, ...o });
    if (e < s.inMs) {
      const t = e / 1000;
      return at({ x: s.xs + (s.x0 - s.xs) * (e / s.inMs), y: s.ground - (s.vyIn * t - 0.5 * GRAVITY * t * t), sx: 0.92, sy: 1.1, f: 1, shut: false });
    }
    e -= s.inMs;
    if (e < LAND_MS) return at({ x: s.x0, y: s.ground, ...squash(e), shut: true });
    e -= LAND_MS;
    if (e < LOOK_MS) return at({ x: s.x0, y: s.ground, look: e < LOOK_MS / 2 ? 0 : s.dir });
    e -= LOOK_MS;
    if (e < s.walkMs) {
      const f = Math.floor(e / STRIDE_MS) % 2;
      return at({ x: s.x0 + s.dir * WALK_SPEED * e / 1000, y: s.ground - (f ? s.px : 0), f });
    }
    e -= s.walkMs;
    if (e < s.hopMs) {
      const t = e / 1000;
      const x = s.xt + (s.xp - s.xt) * (e / s.hopMs);
      return at({ x, y: s.ground - (s.vy * t - 0.5 * GRAVITY * t * t), sx: 0.92, sy: 1.1, f: 1, shut: false });
    }
    e -= s.hopMs;
    if (e < LAND_MS) return at({ x: s.xp, y: s.perch, ...squash(e), shut: true });
    const q = Math.sin(((now + s.blinkPhase) / BREATH_MS) * Math.PI * 2);
    return at({ x: s.xp, y: s.perch, sx: 1 - BREATH * 0.5 * q, sy: 1 + BREATH * q, look: lookToward(cursor, s.xp, s.perch - s.h / 3) });
  }

  let raf = 0;
  let last = performance.now();
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.imageSmoothingEnabled = false;
    // Popped ones that have finished squashing burst into their brood (appended, so drawn on top).
    for (const s of sprites.filter((t) => t.popAt && now - t.popAt >= SQUISH_MS)) {
      sprites.splice(sprites.indexOf(s), 1);
      brood(s, now);
    }
    for (const s of sprites) {
      if (s.free) fly(s, now, dt);
      const p = pose(s, now);
      if (!p) { s.drawn = null; continue; }
      if (!s.popAt) s.at = { x: p.x, y: p.y };
      // Scaled about the feet, as on slide 4.
      const w = s.w * p.sx;
      const h = s.h * p.sy;
      const left = Math.round(p.x - w / 2);
      const top = Math.round(p.y + s.h / 2 - h);
      s.drawn = { left, top, w, h };
      g.drawImage(s.frame(p.f, p.look, p.shut), left, top, w, h);
    }
  };
  raf = requestAnimationFrame(draw);
  return {
    cancel() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.body.style.cursor = '';
      canvas.remove();
    },
  };
}
