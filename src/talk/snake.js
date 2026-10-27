// Slide 4's snake: the old phone game, played by itself over the slide, built up a click at a time.
// The first click lets a green snake loose after red apples; each one after adds something new to
// the board — a pineapple in a cowboy hat (eat it and the snake wears the hat), a pink dragon fruit
// (the snake turns pink), a black bomb with a sparking fuse (half the snake goes). It steers for the
// nearest thing on the board, grows on fruit, and starts over when it boxes itself in. A transparent
// canvas over the slide, like slide 2's cans. Everything is pixel art drawn from character grids.
//
// The bomb is the punchline, so it gets a beat of its own (`detonate`): the game freezes on the
// frame it bit, the screen flashes, the doomed half of the tail blinks red, and then it blows apart
// in a spray of pixels with the slide shaking under it before the snake carries on without it.

// One cell of the grid, in CSS pixels, drawn as 7 × 7 art pixels of 6px; how often the snake steps.
// 28px cells with 4px art read as specks from the back of a room; at 42 the step is slowed to match.
const CELL = 42;
const PX = 6;
const STEP_MS = 120;
const START_LENGTH = 5;
const SHORTEST = 2;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// The board: a centred box this fraction of the window wide and tall, the presentation's safe
// frame, so the snake and its fruit never stray where a projector or a cropped screen would lose them.
const SAFE_W = 0.72;
const SAFE_H = 0.66;

// The snake's colours: green to start, the pineapple's yellow once it has the hat, pink after a
// dragon fruit. Whichever it ate last wins.
const GREEN = { body: '#3cb043', head: '#2a8a33' };
const YELLOW = { body: '#ffd23f', head: '#d69a1a' };
const PINK = { body: '#ff6fb5', head: '#e0479a' };
const EYE = '#111111';
const DOOMED = '#e3342f';

/** The art, 7 × 7 unless noted; each letter is a colour in INK, '.' is clear. */
const ART = {
  apple: [
    '...k...',
    '.RRkRR.',
    'RRRRRRR',
    'RRWRRRR',
    'RRRRRRR',
    '.RRRRR.',
    '..R.R..',
  ],
  // A pineapple in a cowboy hat: the hat on top, a cross-hatched yellow square under it. 11 × 9,
  // overhanging its cell (ORIGIN) so the hat can be the same one the snake wears.
  pineapple: [
    '....BbB....',
    '...BBBBB...',
    '...bbbbb...',
    'B.BBBBBBB.B',
    '.BBBBBBBBB.',
    '...YYYYY...',
    '...YOYOY...',
    '...YYYYY...',
    '...YOYOY...',
  ],
  dragonfruit: [
    '...G...',
    '.G.P.G.',
    '..PPP..',
    '.PPPPP.',
    'GPPWPPG',
    '.PPPPP.',
    '..PPP..',
  ],
  // The fuse's spark is drawn separately, so it can flicker (`sparkAt`).
  bomb: [
    '.......',
    '....f..',
    '...f...',
    '..KKK..',
    '.KKKKK.',
    '.KWKKK.',
    '..KKK..',
  ],
  // The hat the snake wears once it has eaten the pineapple, 11 × 5, sat on top of its head. What
  // makes it a cowboy hat is the silhouette, so the tells are all in it: a brim nearly twice the
  // crown's width that curls up at both ends, a band, and a rounded crown with a crease (the dark pixel) down its top.
  // (The first cut was a dome on a flat brim and read as a bowler; the second had a 9-wide brim
  // and a notch in the crown, and read as a castle turret, then as antlers.)
  hat: [
    '....BbB....',
    '...BBBBB...',
    '...bbbbb...',
    'B.BBBBBBB.B',
    '.BBBBBBBBB.',
  ],
};
// Art wider than a cell, and where it sits relative to the cell's corner, in art pixels.
const ORIGIN = { pineapple: [-2, -2], hat: [-2, -3] };
const INK = {
  R: '#e3342f', W: '#ffffff', k: '#6b3f1d', G: '#3cb043', B: '#8b5a2b', b: '#5e3a17',
  Y: '#ffd23f', O: '#d69a1a', P: '#ff4fa3', K: '#1a1a1a', f: '#c8b28a',
};
const SPARK = ['#ffd23f', '#ff8a1f', '#ffffff'];
const BURST = ['#ffd23f', '#ff8a1f', '#e3342f'];

// The bomb's beat, in milliseconds from the bite. A white flash fades over the first few hundred,
// the tail blinks red for the rest of the freeze, and it blows at FREEZE_MS — the snake moves again
// from then on, while the pieces fly. (An inverted impact frame before the flash was tried and cut:
// a negative of the photo just looked bad.)
const FLASH_MS = 320;
const BLINK_MS = 90;
const FREEZE_MS = 900;
// The blast: each tail segment breaks into SHARDS × SHARDS pieces thrown out from the cut, falling
// under gravity (px/s²) and fading over their last third; the slide shakes by up to SHAKE_PX,
// easing out over SHAKE_MS. The bite itself gets a smaller shake.
const SHARDS = 3;
const SHARD_MS = 1300;
const GRAVITY = 2200;
const SHAKE_PX = 18;
const SHAKE_MS = 550;
const BITE_SHAKE_PX = 7;
const BITE_SHAKE_MS = 200;
const RING_MS = 450;

// What each later stage puts on the board, in click order. Each one takes the board over: one more
// of it is added and everything already there turns into it, in a ripple TURN_GAP_MS apart, each
// with a white pop TURN_MS long.
const STAGES = ['pineapple', 'dragonfruit', 'bomb'];
const TURN_GAP_MS = 110;
const TURN_MS = 260;

/** `shaken` is what the screen shake moves along with the game's canvas — the slide under it. */
export function createSnake(shaken = null) {
  const canvas = document.createElement('canvas');
  canvas.id = 'snake-game';
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  let cols = 0;
  let rows = 0;
  let ox = 0;
  let oy = 0;
  let body = [];
  let dir = DIRS[0];
  let items = [];          // { kind, at: [x, y] }
  let kinds = [];          // what keeps respawning: 'apple', then each stage's addition
  let hat = false;
  let colours = GREEN;
  let bomb = null;         // the bomb's beat while it plays: { t0, tail, cut, at }
  let shards = [];         // the tail's pieces in flight: { x, y, vx, vy, s, colour, t0 }
  let rings = [];          // the bangs, growing: { x, y, t0 }
  let shakes = [];         // { t0, px, ms }
  let stage = 0;
  let ticks = 0;
  let timer = 0;
  let frame = 0;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.floor(window.innerWidth * SAFE_W / CELL);
    rows = Math.floor(window.innerHeight * SAFE_H / CELL);
    // Centre the grid in the window, inside the safe frame.
    ox = (window.innerWidth - cols * CELL) / 2;
    oy = (window.innerHeight - rows * CELL) / 2;
  }

  const key = ([x, y]) => y * cols + x;
  const inside = ([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];

  // `turn` is when it pops into being (or into this kind from `was`), for the white pop in `draw`.
  function place(kind, turn = 0) {
    const taken = new Set([...body, ...items.map((i) => i.at)].map(key));
    let at;
    do at = [Math.floor(Math.random() * cols), Math.floor(Math.random() * rows)];
    while (taken.has(key(at)));
    items.push({ kind, at, turn });
  }

  function reset() {
    const y = Math.floor(rows / 2);
    body = Array.from({ length: START_LENGTH }, (_, i) => [START_LENGTH - i, y]);
    dir = DIRS[0];
    items = [];
    // As many as there are kinds, all of the latest — it has taken the board over (`advance`).
    for (const _ of kinds) place(kinds[kinds.length - 1]);
  }

  // Greedy: of the moves that don't hit a wall or the snake's own body, the one that ends nearest
  // anything on the board. The tail is about to move out of the way, so it doesn't count as body.
  function choose() {
    const [hx, hy] = body[0];
    const blocked = new Set(body.slice(0, -1).map(key));
    const options = DIRS
      .filter((d) => d[0] !== -dir[0] || d[1] !== -dir[1])
      .map((d) => ({ d, at: [hx + d[0], hy + d[1]] }))
      .filter(({ at }) => inside(at) && !blocked.has(key(at)));
    if (!options.length) return null;
    const far = ({ at }) => Math.min(...items.map((i) => Math.abs(at[0] - i.at[0]) + Math.abs(at[1] - i.at[1])));
    options.sort((a, b) => far(a) - far(b));
    return options[0];
  }

  function eat(item) {
    items.splice(items.indexOf(item), 1);
    place(item.kind);
    if (item.kind === 'pineapple') { hat = true; colours = YELLOW; }
    if (item.kind === 'dragonfruit') colours = PINK;
    if (item.kind === 'bomb') {
      // Half the snake goes. It stays on the board, frozen, until the beat blows it off. Once the
      // board is all bombs it bottoms out at SHORTEST, and a bite with nothing left to lose is just
      // a bang, with no freeze.
      const keep = Math.max(SHORTEST, Math.ceil(body.length / 2));
      const now = performance.now();
      if (keep >= body.length) {
        rings.push({ x: cellX(item.at) + CELL / 2, y: cellY(item.at) + CELL / 2, t0: now });
        shakes.push({ t0: now, px: BITE_SHAKE_PX, ms: BITE_SHAKE_MS });
        return false;
      }
      bomb = { t0: now, tail: body.slice(keep), cut: body[keep - 1], at: item.at };
      body = body.slice(0, keep);
      shakes.push({ t0: now, px: BITE_SHAKE_PX, ms: BITE_SHAKE_MS });
      return false;
    }
    return true;
  }

  function detonate(now) {
    const { tail, cut, at } = bomb;
    const cx = cellX(cut) + CELL / 2;
    const cy = cellY(cut) + CELL / 2;
    const piece = (CELL - 4) / SHARDS;
    tail.forEach((seg, n) => {
      for (let i = 0; i < SHARDS; i++) for (let j = 0; j < SHARDS; j++) {
        const x = cellX(seg) + 2 + i * piece;
        const y = cellY(seg) + 2 + j * piece;
        // Out from the cut and up, harder for the pieces nearest it, with a scatter so it reads as
        // a blast rather than a fan.
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const kick = 500 + 700 / (1 + n * 0.4) + Math.random() * 400;
        shards.push({
          x, y, s: piece,
          vx: (dx / d) * kick + (Math.random() - 0.5) * 600,
          vy: (dy / d) * kick - 500 - Math.random() * 500,
          colour: [DOOMED, colours.body, BURST[Math.floor(Math.random() * BURST.length)]][(i + j + n) % 3],
          t0: now,
        });
      }
    });
    rings.push({ x: cellX(at) + CELL / 2, y: cellY(at) + CELL / 2, t0: now });
    rings.push({ x: cx, y: cy, t0: now + 60 });
    shakes.push({ t0: now, px: SHAKE_PX, ms: SHAKE_MS });
    bomb = null;
  }

  function step() {
    // Freeze frame: nothing moves, the fuse doesn't flicker, until the tail has gone.
    if (bomb) return;
    ticks++;
    const move = choose();
    if (!move) { reset(); return; }
    dir = move.d;
    body.unshift(move.at);
    const item = items.find((i) => same(i.at, move.at));
    // Fruit grows the snake by keeping its tail this step; a bomb doesn't.
    if (!(item && eat(item))) body.pop();
  }

  // Drawn every animation frame rather than every step, so the blast and the shake run smooth
  // between the snake's 120ms moves.
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (bomb && now - bomb.t0 >= FREEZE_MS) detonate(now);
    draw(now);
  }

  /** A piece of art (by name) at a cell's corner, shifted by its ORIGIN if it overhangs the cell. */
  function sprite(kind, x, y) {
    const [dx, dy] = ORIGIN[kind] ?? [0, 0];
    art(ART[kind], x + dx * PX, y + dy * PX);
  }

  function art(rowsOfArt, x, y) {
    rowsOfArt.forEach((row, j) => [...row].forEach((c, i) => {
      if (c === '.') return;
      g.fillStyle = INK[c];
      g.fillRect(x + i * PX, y + j * PX, PX, PX);
    }));
  }

  const cellX = (at) => ox + at[0] * CELL;
  const cellY = (at) => oy + at[1] * CELL;

  function shake(now) {
    shakes = shakes.filter((s) => now - s.t0 < s.ms);
    let x = 0;
    let y = 0;
    for (const s of shakes) {
      const k = 1 - (now - s.t0) / s.ms;
      x += (Math.random() * 2 - 1) * s.px * k * k;
      y += (Math.random() * 2 - 1) * s.px * k * k;
    }
    const t = shakes.length ? `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` : '';
    canvas.style.transform = t;
    if (shaken) shaken.style.transform = t;
  }

  function draw(now = performance.now()) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    g.clearRect(0, 0, W, H);
    shake(now);
    for (const item of items) {
      const since = now - item.turn;
      // Not turned yet: still what it was, or (the one added) not there at all.
      if (since < 0) { if (item.was) sprite(item.was, cellX(item.at), cellY(item.at)); continue; }
      if (since < TURN_MS) {
        // The pop: a white flash over the cell that shrinks away as the new thing swells past full
        // size and settles.
        const u = since / TURN_MS;
        const cx = cellX(item.at) + CELL / 2;
        const cy = cellY(item.at) + CELL / 2;
        g.save();
        g.translate(cx, cy);
        g.scale(1 + 0.6 * Math.sin(Math.PI * u), 1 + 0.6 * Math.sin(Math.PI * u));
        g.translate(-cx, -cy);
        sprite(item.kind, cellX(item.at), cellY(item.at));
        g.restore();
        const f = CELL * 1.4 * (1 - u);
        g.fillStyle = `rgba(255, 255, 255, ${(1 - u).toFixed(2)})`;
        g.fillRect(cx - f / 2, cy - f / 2, f, f);
        continue;
      }
      sprite(item.kind, cellX(item.at), cellY(item.at));
      // The fuse sparks: a few bright pixels round its tip, different every step.
      if (item.kind === 'bomb') {
        for (let k = 0; k < 3; k++) {
          g.fillStyle = SPARK[(ticks + k) % SPARK.length];
          const sx = 5 + ((ticks * 3 + k * 5) % 3) - 1;
          const sy = (ticks + k * 2) % 2;
          g.fillRect(cellX(item.at) + sx * PX, cellY(item.at) + sy * PX, PX, PX);
        }
      }
    }
    // The doomed tail, held where it was bitten off, blinking between red and the snake's colour.
    if (bomb) {
      const red = Math.floor((now - bomb.t0) / BLINK_MS) % 2 === 0;
      g.fillStyle = red ? DOOMED : colours.body;
      for (const part of bomb.tail) g.fillRect(cellX(part) + 2, cellY(part) + 2, CELL - 4, CELL - 4);
    }
    body.forEach((part, i) => {
      g.fillStyle = i === 0 ? colours.head : colours.body;
      g.fillRect(cellX(part) + 2, cellY(part) + 2, CELL - 4, CELL - 4);
    });
    // Eyes on the head, toward the way it's going.
    const [hx, hy] = [cellX(body[0]), cellY(body[0])];
    const side = [dir[1], -dir[0]];
    g.fillStyle = EYE;
    for (const s of [1, -1]) {
      const ex = hx + CELL / 2 + dir[0] * CELL / 5 + side[0] * s * CELL / 5 - PX / 2;
      const ey = hy + CELL / 2 + dir[1] * CELL / 5 + side[1] * s * CELL / 5 - PX / 2;
      g.fillRect(ex, ey, PX, PX);
    }
    // The hat sits on top of the head whichever way the snake is going, brim across its middle.
    if (hat) sprite('hat', hx, hy);

    // The bangs: rings of hot pixels thrown outward, thinning as they go.
    rings = rings.filter((r) => now - r.t0 < RING_MS);
    for (const r of rings) {
      const u = (now - r.t0) / RING_MS;
      if (u < 0) continue;
      const radius = CELL * (0.4 + 2.6 * (1 - (1 - u) * (1 - u)));
      const size = PX * 2 * (1 - u) + 2;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        g.fillStyle = BURST[(k + Math.floor(u * 6)) % BURST.length];
        g.fillRect(r.x + Math.cos(a) * radius - size / 2, r.y + Math.sin(a) * radius - size / 2, size, size);
      }
    }
    // The tail's pieces, on their arcs. Positions are worked out from the launch rather than
    // integrated, so a dropped frame doesn't change where anything lands.
    shards = shards.filter((s) => now - s.t0 < SHARD_MS);
    for (const s of shards) {
      const t = (now - s.t0) / 1000;
      const u = t * 1000 / SHARD_MS;
      g.globalAlpha = u < 2 / 3 ? 1 : 3 * (1 - u);
      g.fillStyle = s.colour;
      const size = s.s * (1 - 0.5 * u);
      g.fillRect(s.x + s.vx * t, s.y + s.vy * t + 0.5 * GRAVITY * t * t, size, size);
    }
    g.globalAlpha = 1;

    // The flash: white washing out over the slide.
    if (bomb && now - bomb.t0 < FLASH_MS) {
      g.globalAlpha = 0.85 * (1 - (now - bomb.t0) / FLASH_MS);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
  }

  const onResize = () => { layout(); reset(); };

  function start() {
    layout();
    kinds = ['apple'];
    hat = false;
    colours = GREEN;
    bomb = null;
    shards = [];
    rings = [];
    shakes = [];
    reset();
    canvas.classList.add('on');
    window.addEventListener('resize', onResize);
    timer = setInterval(step, STEP_MS);
    frame = requestAnimationFrame(tick);
  }

  return {
    /** The next beat: start the snake, then put the next thing on the board. False once there's nothing left. */
    advance() {
      if (stage === 0) { start(); stage = 1; return true; }
      if (stage > STAGES.length) return false;
      const kind = STAGES[stage - 1];
      kinds.push(kind);
      // Everything on the board turns, nearest the snake's head first, then one more lands.
      const now = performance.now();
      const [hx, hy] = body[0];
      items.sort((a, b) => Math.hypot(a.at[0] - hx, a.at[1] - hy) - Math.hypot(b.at[0] - hx, b.at[1] - hy));
      items.forEach((item, i) => Object.assign(item, { was: item.kind, kind, turn: now + i * TURN_GAP_MS }));
      place(kind, now + items.length * TURN_GAP_MS);
      stage++;
      return true;
    },
    stop() {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      timer = 0;
      frame = 0;
      stage = 0;
      bomb = null;
      for (const el of [canvas, shaken]) if (el) el.style.transform = '';
      window.removeEventListener('resize', onResize);
      canvas.classList.remove('on');
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    },
  };
}
