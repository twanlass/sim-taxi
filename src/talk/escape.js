// Slide 4's first beat: three of the cut-out doodles in the sketchbook photo come alive as SNES-style
// pixel sprites. One after another, each is scanned in over its doodle — a bright band sweeping
// up its silhouette from the feet, leaving the sprite behind it — and comes to life: eyes open, a
// stretch, then a hop down to the bottom of the screen, where they stand idling, breathing and
// blinking, their eyes following the cursor, until the presenter's next press (`leave`) walks them
// off to the left. (Two earlier entrances were cut: lifting a cut-out of the photo off
// the page and pixelating it, and tracing an ink outline round it and filling it in.)
//
// The sprites are drawn in code like everything else in the project: each is a handful of shapes
// (circles, ellipses, polygons, thick lines) rasterised onto a character grid, after the silhouette
// of the drawing it stands for, then shaded — a dark band down the edges away from the light, a
// highlight along the ones toward it — and ringed in a ballpoint-navy outline. The grids say what
// colour each part is; the outline and shading are worked out from them.

// The outline, the blue of the biro the doodles were drawn in, and the colours the grids use.
const INK = '#1b2266';
const COLOURS = {
  K: INK, W: '#ffffff', B: '#2a4bd7', Y: '#ffc93c', O: '#f08a24', L: '#ffe58a',
  T: '#2fb8a6', t: '#1f7f86', l: '#7fe0cf', G: '#ffd23f', P: '#9b6bd6', p: '#6e45a8', q: '#c3a0f0',
  N: '#ff7eb6',
};

// --- Rasterising -------------------------------------------------------------------------------
// Each shape paints `c` into every cell whose centre it covers.

const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill('.'));
const each = (g, fn) => g.forEach((row, y) => row.forEach((_, x) => fn(x + 0.5, y + 0.5, x, y)));
const ellipse = (g, cx, cy, rx, ry, c) => each(g, (px, py, x, y) => {
  if (((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1) g[y][x] = c;
});
const circle = (g, cx, cy, r, c) => ellipse(g, cx, cy, r, r, c);
function poly(g, pts, c) {
  each(g, (px, py, x, y) => {
    let inside = false;
    pts.forEach(([x1, y1], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 > py) !== (y2 > py) && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    });
    if (inside) g[y][x] = c;
  });
}
function line(g, x1, y1, x2, y2, w, c) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy || 1;
  each(g, (px, py, x, y) => {
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    if ((px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2 <= (w / 2) ** 2) g[y][x] = c;
  });
}
/** A polyline whose width tapers from `w0` to `w1` along it: a tentacle. */
function taper(g, pts, w0, w1, c) {
  for (let i = 0; i < pts.length - 1; i++) line(g, ...pts[i], ...pts[i + 1], w0 + ((w1 - w0) * i) / (pts.length - 1), c);
}
/**
 * Light from the top left: cells of `base` within `depth` of the region's bottom-right edge go
 * `dark`, those on its top-left edge `light`. Run before anything is drawn over the region, so a
 * pupil or a nose doesn't count as an edge.
 */
function shade(g, base, dark, light, depth = 2) {
  const src = g.map((row) => [...row]);
  const is = (x, y) => src[y]?.[x] === base;
  each(g, (_, __, x, y) => {
    if (!is(x, y)) return;
    let edge = !is(x + depth, y);
    for (let k = 1; k <= depth; k++) edge ||= !is(x + k, y + k);
    if (edge) g[y][x] = dark;
    else if (light && !is(x - 1, y - 1)) g[y][x] = light;
  });
}
/** Fill a shape in `c` with a one-cell rim of ink inside its own edge: the cat's nose. */
function inked(g, shape, c) {
  const m = grid(g[0].length, g.length);
  shape(m);
  const on = (x, y) => m[y]?.[x] === '#';
  each(g, (_, __, x, y) => {
    if (on(x, y)) g[y][x] = on(x + 1, y) && on(x - 1, y) && on(x, y + 1) && on(x, y - 1) ? c : 'K';
  });
}

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

/** The cells of each eye, found once on the open grid: a flood from the seed, or the box's cells. */
function eyeCells(g, e) {
  if (e.box) {
    const [x0, y0, w, h] = e.box;
    const cells = [];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells.push([x, y]);
    return cells;
  }
  const seen = new Set();
  const cells = [];
  const todo = [e.seed];
  while (todo.length) {
    const [x, y] = todo.pop();
    const k = `${x},${y}`;
    if (seen.has(k) || g[y]?.[x] !== e.white) continue;
    seen.add(k);
    cells.push([x, y]);
    todo.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return cells;
}

/**
 * Draw the eyes into grid `g`: pupils looking `look` — [x, y], each −1 to 1, left/up to right/down,
 * or just x — or shut.
 */
function drawEyes(g, eyes, look, shut) {
  const [lx, ly] = Array.isArray(look) ? look : [look, 0];
  for (const { e, cells } of eyes) {
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const mid = Math.round((y0 + y1) / 2);
    if (shut) {
      for (const [x, y] of cells) g[y][x] = y === mid ? 'K' : e.lid;
      continue;
    }
    // Kept a cell in from the eye's edge where there's room: a pupil on the rim of an eyeball
    // touches the outline, which is the same ink, and the eye reads as a hole.
    const slide = (lo, hi, size, k) => {
      const margin = hi - lo + 1 - size >= 4 ? 1 : 0;
      return Math.round(lo + margin + ((hi - lo + 1 - size - 2 * margin) * (k + 1)) / 2);
    };
    const px = slide(x0, x1, e.pw, lx);
    const py = slide(y0, y1, e.ph, ly);
    for (let y = py; y < py + e.ph; y++) for (let x = px; x < px + e.pw; x++) g[y][x] = e.pupil;
  }
}

/** A grid drawn to its own canvas, one canvas pixel per cell, outlined; scaled up when drawn. */
function gridCanvas(g) {
  const h = g.length;
  const w = g[0].length;
  const c = document.createElement('canvas');
  c.width = w + 2;
  c.height = h + 2;
  const ctx = c.getContext('2d');
  const filled = (x, y) => g[y]?.[x] !== undefined && g[y][x] !== '.';
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (filled(x, y)) ctx.fillStyle = COLOURS[g[y][x]];
      else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ctx.fillStyle = INK;
      else continue;
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  return c;
}

// --- The beat ----------------------------------------------------------------------------------

// In ms, px and px/s. Each creature comes ENTRY_GAP_MS after the last. It is scanned in from the
// feet up over SCAN_MS, under a white band SCAN_BAND of its height deep that fades out below its
// leading edge, and comes alive over ALIVE_MS — eyes open WAKE_MS in, a stretch.
// Then it holds HOLD_MS, hops (up at HOP_UP, falling under GRAVITY, drifting left at HOP_DRIFT),
// squashes on landing for LAND_MS, stands about until `leave`, and walks off at WALK_SPEED, a step
// every STRIDE_MS. FLOOR is how far above the bottom of the window they stand.
const ENTRY_GAP_MS = 750;
const SCAN_MS = 650;
const SCAN_BAND = 0.3;
const ALIVE_MS = 380;
const WAKE_MS = 140;
const HOLD_MS = 350;
const HOP_UP = 950;
const GRAVITY = 3200;
const HOP_DRIFT = 160;
const LAND_MS = 140;
const WALK_SPEED = 230;
const STRIDE_MS = 150;
const FLOOR = 28;
// Standing about: a breath every BREATH_MS, BREATH deep, and eyes on the cursor, turned all the way
// once it is LOOK_REACH px off to a side (or above or below). Each creature blinks every
// BLINK_EVERY_MS or so for BLINK_MS, on its own clock.
const BREATH_MS = 1700;
const BREATH = 0.035;
const LOOK_REACH = 320;
const BLINK_MS = 120;
const BLINK_EVERY_MS = 2400;

/**
 * Let the creatures out of `img` (the sketchbook photo, possibly tilted by CSS). Returns
 * `{ done, cancel, leave }`; they stand about until `leave()`, and `done` resolves when the last
 * one has walked off the screen.
 */
export function escapeCreatures(img) {
  const canvas = document.createElement('canvas');
  canvas.className = 'escapees';
  Object.assign(canvas.style, {
    position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 4, pointerEvents: 'none',
  });
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

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
    const open = [0, 1].map((f) => c.draw(f));
    const eyes = c.eyes.map((e) => ({ e, cells: eyeCells(open[0], e) }));
    // Every frame this creature can show, made on first use: walk step × where it looks × blink.
    const cache = new Map();
    const frame = (f, look, shut) => {
      const key = `${f}|${shut ? 'shut' : String(look)}`;
      if (!cache.has(key)) {
        const gr = open[f].map((row) => [...row]);
        drawEyes(gr, eyes, look, shut);
        cache.set(key, gridCanvas(gr));
      }
      return cache.get(key);
    };
    const first = frame(0, 0, false);
    // Scaled to the cut-out it stands for, in whole screen pixels per art pixel so every pixel is
    // the same size, and centred on it.
    const [bx0, by0, bx1, by1] = c.box;
    const px = Math.max(2, Math.round(Math.min(((bx1 - bx0) * k) / first.width, ((by1 - by0) * k) / first.height)));
    const w = first.width * px;
    const h = first.height * px;
    const [x, y] = toScreen([(bx0 + bx1) / 2, (by0 + by1) / 2]);
    // The scan-in: the sprite with its eyes shut, and its silhouette in white for the band.
    const asleep = frame(0, 0, true);
    const glow = document.createElement('canvas');
    glow.width = asleep.width;
    glow.height = asleep.height;
    const gg = glow.getContext('2d');
    gg.drawImage(asleep, 0, 0);
    gg.globalCompositeOperation = 'source-in';
    gg.fillStyle = '#ffffff';
    gg.fillRect(0, 0, glow.width, glow.height);
    // Where it lands: feet on the floor, and how long the hop takes to get there.
    const floorY = H - FLOOR - h / 2;
    const drop = floorY - y;
    const hopMs = 1000 * (HOP_UP + Math.sqrt(HOP_UP * HOP_UP + 2 * GRAVITY * drop)) / GRAVITY;
    return {
      frame, asleep, glow, px, x, y, w, h, floorY, hopMs,
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
  /** Where a creature standing at `x` looks to see the cursor, quantised so frames can be cached. */
  function lookAt(s, x) {
    if (!cursor) return [0, 0];
    const q = (v, step) => Math.round(Math.max(-1, Math.min(1, v / LOOK_REACH)) / step) * step;
    return [q(cursor[0] - x, 0.5), q(cursor[1] - (s.floorY - s.h / 3), 1)];
  }

  function pose(s, now) {
    let e = now - s.born;
    if (e < 0) return null;
    const blinking = (now + s.blinkPhase) % BLINK_EVERY_MS < BLINK_MS;
    const at = (o) => ({ sx: 1, sy: 1, f: 0, look: 0, shut: blinking, ...o });
    // The band runs from below the feet to past the head, so it enters and leaves whole.
    if (e < SCAN_MS) return at({ x: s.x, y: s.y, scan: -SCAN_BAND + (1 + 2 * SCAN_BAND) * (e / SCAN_MS) });
    e -= SCAN_MS;
    if (e < ALIVE_MS) {
      // Waking up: eyes open, and a stretch up out of the page and back.
      const q = Math.sin(Math.PI * e / ALIVE_MS);
      return at({ x: s.x, y: s.y, sx: 1 - 0.08 * q, sy: 1 + 0.14 * q, shut: e < WAKE_MS });
    }
    e -= ALIVE_MS;
    if (e < HOLD_MS) return at({ x: s.x, y: s.y, look: e < HOLD_MS / 2 ? 0 : -1 });
    e -= HOLD_MS;
    if (e < s.hopMs) {
      const t = e / 1000;
      // Stretched in the air, eyes wide.
      return at({ x: s.x - HOP_DRIFT * t, y: s.y - HOP_UP * t + 0.5 * GRAVITY * t * t, sx: 0.92, sy: 1.1, f: 1, shut: false });
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

  /**
   * A creature part-scanned: `scan` is the height of the band's leading edge as a fraction of the
   * sprite, from the feet. Below it the sprite, and over the band the white silhouette, strongest
   * at the edge and fading out down its depth, a row of art pixels at a time.
   */
  function drawScan(s, left, top, scan) {
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
      if (p.scan !== undefined) drawScan(s, left, top, p.scan);
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
