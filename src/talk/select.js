// Slide 3: a retro character select, the family as the cast of the next two slides would draw them —
// the sketchbook creatures' look (pixels.js): round shapes on a grid, light from the top left, a
// ballpoint-navy outline, big eyes that follow the cursor and blink. Each holds the thing they're
// best at. (Each had stat bars for it too, and they went: the props already say it.)
//
// It builds up a press at a time. Tyler is there when the slide comes up, already 1P. The first
// press pops Heather in beside him; the second sends her grey and off the screen, because she didn't
// want to make games with him; the third pops Isla in and then Nia, and START shows with them. The
// press after that moves on. A player bounces in their
// stance from the moment they arrive.
//
// (It was four little 16-wide people in fighting-game stances under a "Choose your player" title,
// all four tagged on one press. Stylised to match the creatures so the deck has one cast, and the
// title went: the screen says what it is.)
import '@fontsource/press-start-2p';
import { grid, ellipse, circle, poly, line, shade, eyeCells, drawEyes, gridCanvas } from './pixels.js';

// The creatures' ink, so the two slides share an outline.
const INK = '#1b2266';

/** `hex` towards black (k < 0) or white (k > 0) by |k|. */
function tint(hex, k) {
  const n = Number.parseInt(hex.slice(1), 16);
  const to = k < 0 ? 0 : 255;
  const mix = (v) => Math.round(v + (to - v) * Math.abs(k));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map(mix).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// What every sprite shares: skin and its shade and light, the eye white, blush, mouth, shoes, and
// the props' colours. Each player adds their own hair (H, shaded h/j), eyes (E), shirt (T, t/u)
// and trousers (P, p).
const BASE = {
  K: INK, S: '#f1c29a', s: '#d39a72', l: '#ffe2c6', W: '#ffffff', B: '#f08a84', M: '#a33a3a',
  F: '#2a2a33', f: '#4a4a58',
  // Pencil: yellow barrel, its shade, bare wood, graphite, pink eraser, the eraser's band.
  Y: '#ffc93c', y: '#d99a1c', C: '#f3d2a2', G: '#55525e', N: '#ff7eb6', A: '#c9c9d4',
  // Cupcake: frosting (N), the case and its pleats, a cherry.
  Q: '#d9a066', q: '#a8743c', R: '#d8323c',
  // Yarn: the ball and the darker wound strands; a knitting needle.
  V: '#7b5cd6', v: '#4e3aa0',
};

/**
 * In the order they arrive. `age` is the line under the name. `k` scales the whole figure (a little under Tyler, down to the youngest), `hair` and `prop`
 * pick its shapes, `sitsOut` is the joke: she's on the select screen and then she isn't playing.
 */
const PLAYERS = [
  {
    name: 'Tyler', age: 'old', k: 1, hair: 'wave', prop: 'controller',
    H: '#6b4226', E: '#3f9a4a', T: '#c8432f', P: '#3b4f7a',
  },
  {
    name: 'Heather', age: '???', k: 0.95, hair: 'long', prop: 'cupcake', sitsOut: true,
    H: '#6e4a2e', E: '#3f9a4a', T: '#8a4fd0', P: '#2f3a52',
  },
  {
    name: 'Isla', age: '11', k: 0.86, hair: 'pigtails', prop: 'yarn',
    H: '#e8c35a', E: '#3a7bd5', T: '#f06aa0', P: '#4a7bc8',
  },
  {
    name: 'Nia', age: '8', k: 0.78, hair: 'bob', prop: 'pencil',
    H: '#4f3220', E: '#3f9a4a', T: '#59c27a', P: '#5a4a7a',
  },
];
// The arcade's player colours: red, blue, green, yellow.
const TAG_COLOURS = ['#ff4d4d', '#3fa9ff', '#52d16b', '#ffd23f'];
// The presses, in order, after Tyler (who is there from the start): `in` brings players on by index
// into PLAYERS, staggered; `out` sends the one who sits out off. The press after the last moves on.
const BEATS = [{ in: [1] }, { out: true }, { in: [2, 3] }];
// Between two arrivals on the same press.
const ARRIVE_GAP_MS = 380;
// The bounce: each half this long. A blink: this long, every BLINK_EVERY_MS give or take half.
const BOUNCE_MS = 260;
const BLINK_MS = 130;
const BLINK_EVERY_MS = 3200;
// How far the cursor has to be from a sprite, in px, for its eyes to go all the way over.
const LOOK_REACH = 320;

// --- The figure --------------------------------------------------------------------------------
// Drawn in a design space 34 wide and 40 tall with the feet on y = 39.5, scaled by the player's `k`
// about the bottom middle, so the kids are smaller versions of the same shapes.

const DESIGN_W = 34;
const DESIGN_H = 40;
const HEAD = { x: 16, y: 13, r: 8.5 };
const TORSO_TOP = 20.5;
const LEG_TOP = 31;
const EYES = [[12.6, 13.8], [19.4, 13.8]];

/**
 * One frame of player `p`: `low` is the bounce's low half, which sits everything above the hips a
 * cell down. Returns the grid and the eye seeds (in grid cells) for `eyeCells`.
 */
function figure(p, low) {
  const k = p.k;
  const W = DESIGN_W;
  const H = Math.ceil(DESIGN_H * k) + 1;
  const g = grid(W, H);
  const dy = low ? 1 / k : 0;
  // Design space to grid: about the bottom middle, and the upper body down by `dy` on the low half.
  const X = (x) => W / 2 + (x - DESIGN_W / 2) * k;
  const Y = (y, upper = true) => H - 0.5 - (DESIGN_H - 0.5 - (y + (upper ? dy : 0))) * k;
  const at = ([x, y], upper) => [X(x), Y(y, upper)];
  const E = (x, y, rx, ry, c, upper = true) => ellipse(g, X(x), Y(y, upper), rx * k, ry * k, c);
  const O = (x, y, r, c, upper = true) => circle(g, X(x), Y(y, upper), r * k, c);
  const L = (a, b, w, c, ua = true, ub = true) => line(g, ...at(a, ua), ...at(b, ub), w * k, c);
  const Pg = (pts, c, upper = true) => poly(g, pts.map((q) => at(q, upper)), c);
  /** Paint `c` from shape `draw` only where the design-space y is above `yMax`. */
  const above = (yMax, draw) => {
    const keep = g.map((row) => [...row]);
    draw();
    const cut = Y(yMax);
    g.forEach((row, gy) => { if (gy + 0.5 > cut) row.forEach((_, gx) => { g[gy][gx] = keep[gy][gx]; }); });
  };
  const { x: hx, y: hy, r } = HEAD;

  // Behind everything: long hair down the back, pigtails.
  if (p.hair === 'long') {
    E(hx, hy - 1, r + 2, r + 1.5, 'H');
    Pg([[hx - r - 2, hy], [hx + r + 2, hy], [hx + r + 1.5, hy + 13], [hx - r - 1.5, hy + 13]], 'H');
  }
  if (p.hair === 'bob') {
    E(hx, hy, r + 2, r + 1.5, 'H');
    Pg([[hx - r - 2, hy], [hx + r + 2, hy], [hx + r + 2, hy + 7], [hx - r - 2, hy + 7]], 'H');
  }
  if (p.hair === 'pigtails') {
    E(hx - r - 2.5, hy + 2, 3, 5, 'H');
    E(hx + r + 2.5, hy + 2, 3, 5, 'H');
  }
  if (p.hair !== 'wave') shade(g, 'H', 'h', 'j');

  // Legs and shoes, which stay planted through the bounce; then the torso over the hips.
  L([13.2, LEG_TOP], [12.6, 37.6], 3.4, 'P', true, false);
  L([18.8, LEG_TOP], [19.4, 37.6], 3.4, 'P', true, false);
  shade(g, 'P', 'p', null, 1);
  E(12, 38.4, 2.6, 1.5, 'F', false);
  E(20, 38.4, 2.6, 1.5, 'F', false);
  shade(g, 'F', 'F', 'f', 1);
  Pg([[11.2, TORSO_TOP], [20.8, TORSO_TOP], [23, LEG_TOP + 1], [9, LEG_TOP + 1]], 'T');
  E(16, TORSO_TOP + 0.5, 4.8, 1.5, 'T');
  shade(g, 'T', 't', 'u');

  // The head, shaded before anything goes on it so features don't count as edges.
  O(hx, hy, r, 'S');
  E(hx - r + 0.2, hy + 1.5, 1.4, 2, 'S');
  E(hx + r - 0.2, hy + 1.5, 1.4, 2, 'S');
  shade(g, 'S', 's', 'l');

  // Hair over the top of the head.
  const hairTop = () => {
    if (p.hair === 'wave') {
      // Swept over to one side, the fringe curling up at its tip.
      above(hy - 2.4, () => O(hx, hy - 0.5, r + 1.2, 'H'));
      Pg([[hx - r - 0.5, hy - 2.5], [hx + 2, hy - 6.5], [hx + r + 1.5, hy - 3.5], [hx + r + 0.5, hy + 0.5],
        [hx + 4.5, hy - 3], [hx - 1, hy - 1.6], [hx - r + 0.5, hy + 1]], 'H');
    } else if (p.hair === 'pigtails') {
      above(hy - 2.8, () => O(hx, hy - 0.5, r + 1, 'H'));
      Pg([[hx - r + 0.5, hy - 3], [hx + r - 0.5, hy - 3], [hx + r - 2, hy - 1.2], [hx - r + 2, hy - 1.2]], 'H');
    } else {
      // Parted down the middle: a V of forehead under a cap that falls down both sides of the face.
      above(hy - 2.2, () => O(hx, hy - 0.5, r + 1.2, 'H'));
      Pg([[hx, hy - 8], [hx - 2.6, hy - 2.2], [hx + 2.6, hy - 2.2]], 'S');
      L([hx - r + 0.6, hy - 3], [hx - r + 0.2, hy + 5], 2.6, 'H');
      L([hx + r - 0.6, hy - 3], [hx + r - 0.2, hy + 5], 2.6, 'H');
    }
  };
  hairTop();
  shade(g, 'H', 'h', 'j');
  if (p.hair === 'pigtails') {
    O(hx - r + 0.4, hy - 2.6, 1.3, 'R');
    O(hx + r - 0.4, hy - 2.6, 1.3, 'R');
  }

  // The face: eyes (filled in per frame by drawEyes), blush, a smile.
  for (const [ex, ey] of EYES) O(ex, ey, 2.5, 'W');
  O(10.4, 17, 1.2, 'B');
  O(21.6, 17, 1.2, 'B');
  // A plain line: at this size a curve's turned-up corners filled in and read as an open mouth.
  L([14.8, 18.1], [17.2, 18.1], 1, 'M');

  // Arms and the prop. Shoulders at the torso's top corners; a hand is a skin circle.
  const shoulderL = [11.6, TORSO_TOP + 1.6];
  const shoulderR = [20.4, TORSO_TOP + 1.6];
  const arm = (from, ...to) => {
    let a = from;
    for (const b of to) { L(a, b, 2.8, 'T'); a = b; }
    O(a[0], a[1], 1.7, 'S');
  };
  const akimbo = () => { L(shoulderL, [8.2, 26], 2.8, 'T'); L([8.2, 26], [10.6, 29.6], 2.8, 'T'); O(10.6, 29.6, 1.6, 'S'); };
  if (p.prop === 'pencil') {
    // A pencil held up like a sword, point to the sky.
    akimbo();
    // Out past the cheek before it rises, so the arm doesn't run up the side of the face.
    arm(shoulderR, [25.5, 21.5], [27, 15]);
    L([27, 20], [28.2, 5.5], 2.4, 'Y');
    L([27.7, 19.5], [28.8, 7], 0.9, 'y');
    L([26.9, 21.4], [27, 20.2], 2.4, 'A');
    L([26.8, 23.2], [26.9, 21.8], 2.4, 'N');
    Pg([[27, 5.6], [29.4, 5.8], [28.4, 2]], 'C');
    O(28.4, 2.5, 0.75, 'G');
    O(27.2, 15, 1.8, 'S');
  } else if (p.prop === 'cupcake') {
    // A cupcake held out in both hands at the chest.
    // Low enough that the cherry clears her chin.
    L(shoulderL, [12.4, 29.4], 2.8, 'T');
    L(shoulderR, [19.6, 29.4], 2.8, 'T');
    Pg([[12.8, 27], [19.2, 27], [18.2, 31.6], [13.8, 31.6]], 'Q');
    for (const x of [14.6, 16, 17.4]) L([x, 27.5], [x - 0.1, 31.2], 0.6, 'q');
    E(16, 26, 4, 2.4, 'N');
    E(16, 24.4, 2.6, 1.7, 'N');
    O(16, 22.7, 1.1, 'R');
    O(12.4, 29.4, 1.6, 'S');
    O(19.6, 29.4, 1.6, 'S');
  } else if (p.prop === 'yarn') {
    // A ball of yarn held up overhead, a cheer.
    L(shoulderL, [8.6, 27.5], 2.8, 'T');
    O(8.6, 27.5, 1.6, 'S');
    // Out past the pigtail before it rises, so the arm doesn't cross her face.
    arm(shoulderR, [26.5, 19], [27.5, 9.5]);
    O(27.8, 5.6, 3.8, 'V');
    for (const [a, b] of [[[25, 4.2], [30.4, 7.4]], [[25.2, 7.4], [30, 3.2]], [[26.6, 2.2], [29.6, 8.8]]]) L(a, b, 0.8, 'v');
    O(27.5, 9.5, 1.8, 'S');
  } else if (p.prop === 'controller') {
    // An NES pad held in both hands at the chest, flat on: a grey slab, a black D-pad on the
    // left and two red buttons on a dark panel on the right. (A laptop came first, and then an oversized arcade
    // stick; neither read at this size. The pad is a silhouette everyone already knows.)
    L(shoulderL, [9.4, 28.6], 2.8, 'T');
    L(shoulderR, [22.6, 28.6], 2.8, 'T');
    Pg([[9, 24.4], [23, 24.4], [23, 30.6], [9, 30.6]], 'A');
    Pg([[16.6, 25.6], [21.8, 25.6], [21.8, 29.4], [16.6, 29.4]], 'f');
    L([11.2, 27.5], [14.2, 27.5], 1, 'K');
    L([12.7, 26], [12.7, 29], 1, 'K');
    O(18.2, 28, 1.1, 'R');
    O(20.6, 27, 1.1, 'R');
    O(9.4, 28.6, 1.7, 'S');
    O(22.6, 28.6, 1.7, 'S');
  }

  const seeds = EYES.map(([ex, ey]) => [Math.floor(X(ex)), Math.floor(Y(ey))]);
  return { g, seeds, W, H };
}

/** Player `p`'s two bounce frames, open-eyed and empty, with the eyes worked out on each. */
function frames(p) {
  const colours = {
    ...BASE,
    H: p.H, h: tint(p.H, -0.3), j: tint(p.H, 0.25),
    E: p.E, T: p.T, t: tint(p.T, -0.25), u: tint(p.T, 0.25), P: p.P, p: tint(p.P, -0.3),
  };
  return {
    colours,
    frames: [false, true].map((low) => {
      const f = figure(p, low);
      const eyes = f.seeds.map((seed) => {
        const e = { seed, white: 'W', pupil: 'E', pw: 2, ph: 2, lid: 'S' };
        return { e, cells: eyeCells(f.g, e) };
      });
      return { ...f, eyes };
    }),
  };
}

// --- The screen --------------------------------------------------------------------------------

/**
 * Build the screen inside `slide`. `start` is called by the START button. Sets `slide.advance`,
 * which the deck calls on → before moving on; it answers true while there's something left to do.
 * Everything resets when the slide is left (`leave`), and the sprites only animate while it's up.
 */
export function mountSelect(slide, { start }) {
  const roster = document.createElement('div');
  roster.className = 'roster';
  // Player numbers skip the one who sits out: she is 2P while she's up, and once she's gone Isla is
  // 2P after her and Nia 3P.
  let seat = 0;
  const cast = PLAYERS.map((p) => {
    const slot = p.sitsOut ? seat : seat++;
    const f = document.createElement('div');
    f.className = 'fighter';
    f.style.setProperty('--p', TAG_COLOURS[slot]);
    const art = frames(p);
    const { W, H } = art.frames[0];
    const stage = document.createElement('div');
    stage.className = 'stage';
    const canvas = document.createElement('canvas');
    canvas.className = 'sprite';
    canvas.width = W + 2;
    canvas.height = H + 2;
    // The sprite's size in grid cells, for the stylesheet: it scales by --u, and the tag hangs off
    // the top of the figure rather than the top of the stage, the kids being shorter.
    f.style.setProperty('--cw', String(W + 2));
    f.style.setProperty('--ch', String(H + 2));
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${slot + 1}P`;
    stage.append(tag, canvas);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = `Age: ${p.age}`;
    f.append(stage, name, age);
    roster.appendChild(f);
    return { p, f, canvas, ctx: canvas.getContext('2d'), art, blinkAt: 0, drawn: '' };
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'start';
  button.textContent = 'Start';
  slide.append(roster, button);

  // Eyes on the cursor, as the creatures' are.
  let cursor = null;
  const onMove = (e) => { cursor = [e.clientX, e.clientY]; };
  let raf = 0;
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    for (const c of cast) {
      if (!c.f.classList.contains('in')) continue;
      const low = !c.f.classList.contains('dropped') && Math.floor(now / BOUNCE_MS) % 2 === 1;
      if (now > c.blinkAt + BLINK_MS) c.blinkAt = now + BLINK_EVERY_MS * (0.5 + Math.random());
      const shut = now > c.blinkAt;
      let look = [0, 0];
      if (cursor) {
        const r = c.canvas.getBoundingClientRect();
        const q = (v, step) => Math.round(Math.max(-1, Math.min(1, v / LOOK_REACH)) / step) * step;
        look = [q(cursor[0] - (r.left + r.width / 2), 1), q(cursor[1] - (r.top + r.height * 0.3), 1)];
      }
      // Only redrawn when something it shows has changed.
      const key = `${low}|${shut}|${look}`;
      if (key === c.drawn) continue;
      c.drawn = key;
      const fr = c.art.frames[low ? 1 : 0];
      const g = fr.g.map((row) => [...row]);
      drawEyes(g, fr.eyes, look, shut);
      c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
      c.ctx.drawImage(gridCanvas(g, c.art.colours, INK), 0, 0);
    }
  };

  let step = 0;
  let timers = [];
  const arrive = (c) => c.f.classList.add('in');
  const leaver = cast.find((c) => c.p.sitsOut);
  const place = () => {
    // A press before the last arrival has popped in lands it first.
    timers.forEach(clearTimeout);
    timers = [];
    for (const i of BEATS[step - 1]?.in ?? []) arrive(cast[i]);
    const beat = BEATS[step];
    if (!beat) return false;
    step++;
    (beat.in ?? []).forEach((i, n) => timers.push(setTimeout(() => arrive(cast[i]), n * ARRIVE_GAP_MS)));
    if (beat.out) leaver?.f.classList.add('dropped');
    // START once the team is all there.
    if (step === BEATS.length) slide.classList.add('ready');
    return true;
  };
  slide.addEventListener('click', place);
  button.addEventListener('click', (e) => { e.stopPropagation(); start(); });
  slide.advance = place;
  slide.addEventListener('enter', () => {
    arrive(cast[0]);
    window.addEventListener('pointermove', onMove);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
  slide.addEventListener('leave', () => {
    timers.forEach(clearTimeout);
    timers = [];
    step = 0;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    for (const c of cast) { c.f.classList.remove('in', 'dropped'); c.drawn = ''; }
    slide.classList.remove('ready');
  });
}
