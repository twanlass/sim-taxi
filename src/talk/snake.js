// Slide 5's snake: the old phone game, played by itself over the slide, built up a click at a time.
// The first click lets a green snake loose after red apples; each one after adds something new to
// the board — a pink dragon fruit (the snake turns pink), a pineapple in a cowboy hat (eat it and
// the snake wears the hat). Each addition freezes the snake where it is (`paused`) so the room can
// be asked what's about to happen, and the next press — or ↑/↓ — lets it go and shows them.
// Everything on the board bobs while it waits. It steers for the nearest thing on the board, grows
// on fruit, and starts over when it boxes itself in. A transparent canvas over the slide, like slide
// 2's cans. Everything is pixel art drawn from character grids.
//
// The bombs are the punchline (`buildMaze`): they fill the whole board in a wave out from the
// snake's head, all but a one-cell corridor carved from where it is, drawn ahead of it as a dashed
// line — and the corridor goes nowhere. The snake freezes there for the last quiz, then runs it to
// the dead end and into a bomb: a flash, a bang, the slide shakes, and gravity switches on — every
// art pixel of every bomb and of the snake drops to the bottom of the window and heaps up there
// (`collapse`), while GAME OVER fades in over the middle in the deck's own heading type. The press
// after that moves on. (Bombs used to be one more thing on the board that took
// half the snake off in a spray of pixels; the maze tells the joke instead.)

// One cell of the grid, in CSS pixels, drawn as 7 × 7 art pixels of 6px; how often the snake steps.
// 28px cells with 4px art read as specks from the back of a room; at 42 the step is slowed to match,
// and slowed again to 170 so the room can follow it during the pop quiz (120 was a blur).
const CELL = 42;
const PX = 6;
const STEP_MS = 170;
const START_LENGTH = 5;
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

// The end, in milliseconds from the bang: a white flash fades over FLASH_MS while the slide shakes
// by up to SHAKE_PX easing out over SHAKE_MS, and GAME OVER fades in over TEXT_MS from TEXT_AT_MS.
// (An inverted impact frame before the flash was tried and cut: a negative of the photo just looked
// bad. A white card in the pixel font came before the heading type, and read as a second slide.)
const FLASH_MS = 320;
const SHAKE_PX = 18;
const SHAKE_MS = 550;
const RING_MS = 450;
const TEXT_AT_MS = 650;
const TEXT_MS = 500;
// The collapse: each pixel lets go up to LET_GO_MS after the bang, falls at FALL_G px/s² with a
// little sideways drift, and those within BLAST_CELLS of the bang are thrown out from it first. A
// pixel that lands slides off any column more than a pixel taller than its neighbour, so the heap
// slumps like sand rather than standing in stacks.
const LET_GO_MS = 260;
const FALL_G = 2600;
const DRIFT = 50;
const BLAST_CELLS = 4;
const BLAST_KICK = 900;
// The maze: the bombs land MAZE_SWEEP_MS apart per cell of distance from the head, so the wave
// crosses a 1456-wide board in about a second. The corridor is MAZE_SHARE of the board's cells, up to
// MAZE_MOST — at STEP_MS that is about eight seconds of the snake running it, longer is a wait. It
// goes straight on MAZE_STRAIGHT of the time it can, so it reads as corridors and not a scribble.
const MAZE_SWEEP_MS = 30;
const MAZE_SHARE = 0.15;
const MAZE_MOST = 45;
const MAZE_STRAIGHT = 0.7;
const MAZE_SEARCH = 20000;
// The corridor ahead of the snake, and the end card.
const TRAIL = 'rgba(27, 34, 102, 0.4)';
const OVER_INK = '#1a1a1a';

// What each later stage puts on the board, in click order. Each one takes the board over: one more
// of it is added and everything already there turns into it, in a ripple TURN_GAP_MS apart, each
// with a white pop TURN_MS long. The bombs are the last, and the maze (`buildMaze`).
const STAGES = ['dragonfruit', 'pineapple', 'bomb'];
// The idle bob: everything on the board hops one art pixel and back every BOB_MS, each on its own
// phase so the board doesn't pulse in step.
const BOB_MS = 700;
const TURN_GAP_MS = 110;
// How many of the current thing are on the board: two or three, drawn again at each stage. (It
// used to grow by one a stage, which by the bomb was four of them and read as clutter.)
const onBoard = () => 2 + Math.floor(Math.random() * 2);
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
  let count = 0;           // how many are on the board (`onBoard`)
  let hat = false;
  let colours = GREEN;
  let maze = null;         // the bombs' corridor: { path: [[x, y], ...], at: the next cell's index }
  let over = 0;            // when it hit the bomb at the end of it: GAME OVER
  let debris = null;       // every pixel on the board once gravity is on: { x, y, vx, vy, c, t0, rest }
  let heap = [];           // how many pixels high the pile is in each PX-wide column of the window
  let lastFrame = 0;
  let rings = [];          // the bangs, growing: { x, y, t0 }
  let shakes = [];         // { t0, px, ms }
  let stage = 0;
  let paused = false;      // frozen on a new arrival, until the next press (`advance`) or ↑/↓
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
    if (maze) { buildMaze(performance.now()); return; }
    // All of the latest — it has taken the board over (`advance`).
    for (let i = 0; i < count; i++) place(kinds[kinds.length - 1]);
  }

  /**
   * The corridor: a walk from the head that never comes back alongside itself or the snake — each
   * cell's only open neighbour is the one before it — so with bombs everywhere else it is one cell
   * wide all the way and ends in a dead end. A depth-first search, kept to MAZE_SEARCH steps, that
   * takes the longest walk it found if it never reaches the length it wanted.
   */
  function carve() {
    const goal = Math.min(MAZE_MOST, Math.floor(cols * rows * MAZE_SHARE));
    const snake = new Set(body.map(key));
    const onPath = new Set();
    const path = [];
    let best = [];
    let budget = MAZE_SEARCH;
    const taken = (c) => snake.has(key(c)) || onPath.has(key(c));
    const fits = (c, from) => inside(c) && !taken(c)
      && DIRS.every((d) => { const n = [c[0] + d[0], c[1] + d[1]]; return same(n, from) || !taken(n); });
    const walk = (from, d) => {
      if (path.length > best.length) best = [...path];
      if (best.length >= goal || --budget <= 0) return;
      const turns = DIRS.filter((t) => t !== d && (t[0] !== -d[0] || t[1] !== -d[1])).sort(() => Math.random() - 0.5);
      for (const t of Math.random() < MAZE_STRAIGHT ? [d, ...turns] : [...turns, d]) {
        const c = [from[0] + t[0], from[1] + t[1]];
        if (!fits(c, from)) continue;
        path.push(c);
        onPath.add(key(c));
        walk(c, t);
        if (best.length >= goal || budget <= 0) return;
        path.pop();
        onPath.delete(key(c));
      }
    };
    walk(body[0], DIRS.find((d) => same(d, dir)) ?? DIRS[0]);
    return best;
  }

  /** Bombs on every cell but the snake and its corridor, popping in out from the head. */
  function buildMaze(now) {
    const path = carve();
    const open = new Set([...body, ...path].map(key));
    const was = new Map(items.map((i) => [key(i.at), i.kind]));
    const [hx, hy] = body[0];
    items = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (open.has(key([x, y]))) continue;
      items.push({ kind: 'bomb', was: was.get(key([x, y])), at: [x, y], turn: now + Math.hypot(x - hx, y - hy) * MAZE_SWEEP_MS });
    }
    maze = { path, at: 0 };
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
  }

  // Down the corridor a cell a step; past its end, into whichever bomb is in the way — straight on
  // if it can, the way anyone running a maze would hit the wall at the end of it.
  function runMaze() {
    const next = maze.path[maze.at];
    if (next) {
      dir = [next[0] - body[0][0], next[1] - body[0][1]];
      body.unshift(next);
      body.pop();
      maze.at++;
      return;
    }
    const [hx, hy] = body[0];
    const hit = [dir, ...DIRS]
      .filter((d) => d[0] !== -dir[0] || d[1] !== -dir[1])
      .map((d) => ({ d, item: items.find((i) => same(i.at, [hx + d[0], hy + d[1]])) }))
      .find(({ item }) => item);
    const now = performance.now();
    if (hit) {
      dir = hit.d;
      items.splice(items.indexOf(hit.item), 1);
      rings.push({ x: cellX(hit.item.at) + CELL / 2, y: cellY(hit.item.at) + CELL / 2, t0: now });
    }
    rings.push({ x: cellX(body[0]) + CELL / 2, y: cellY(body[0]) + CELL / 2, t0: now + 60 });
    shakes.push({ t0: now, px: SHAKE_PX, ms: SHAKE_MS });
    over = now;
    collapse(now, hit ? hit.item.at : body[0]);
  }

  /** Every art pixel on the board, bombs and snake, as a particle where it is drawn right now. */
  function collapse(now, at) {
    const pixels = [];
    const add = (x, y, c) => pixels.push({ x, y, c });
    const paint = (kind, x, y) => {
      const [dx, dy] = ORIGIN[kind] ?? [0, 0];
      ART[kind].forEach((row, j) => [...row].forEach((ch, i) => {
        if (ch !== '.') add(x + (dx + i) * PX, y + (dy + j) * PX, INK[ch]);
      }));
    };
    for (const item of items) paint(item.kind, cellX(item.at), cellY(item.at) - bobOf(item, now));
    // A segment is CELL - 4 square, so six art pixels a side with the odd pixels split round it.
    const n = Math.floor((CELL - 4) / PX);
    const inset = (CELL - n * PX) / 2;
    body.forEach((part, k) => {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        add(cellX(part) + inset + i * PX, cellY(part) + inset + j * PX, k === 0 ? colours.head : colours.body);
      }
    });
    for (const [ex, ey] of eyes()) add(ex, ey, EYE);
    if (hat) paint('hat', cellX(body[0]), cellY(body[0]));
    const bx = cellX(at) + CELL / 2;
    const by = cellY(at) + CELL / 2;
    debris = pixels.map(({ x, y, c }) => {
      const dx = x - bx;
      const dy = y - by;
      const d = Math.hypot(dx, dy) || 1;
      const near = Math.max(0, 1 - d / (BLAST_CELLS * CELL));
      return {
        x, y, c, rest: false,
        vx: (Math.random() - 0.5) * 2 * DRIFT + (dx / d) * BLAST_KICK * near,
        vy: (dy / d) * BLAST_KICK * near - 200 * near,
        // Near the bang lets go at once; further out, any time in the first LET_GO_MS.
        t0: now + (1 - near) * Math.random() * LET_GO_MS,
      };
    });
    heap = Array(Math.ceil(window.innerWidth / PX) + 1).fill(0);
    items = [];
    lastFrame = now;
  }

  // The pixels falling and heaping. Integrated a frame at a time (capped, so a stalled tab doesn't
  // drop them through the floor); a landed pixel snaps to its column and stays.
  function fall(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const H = window.innerHeight;
    const last = heap.length - 1;
    for (const p of debris) {
      if (p.rest || now < p.t0) continue;
      p.vy += FALL_G * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0 || p.x > last * PX) { p.vx = -p.vx * 0.4; p.x = Math.max(0, Math.min(last * PX, p.x)); }
      let col = Math.round(p.x / PX);
      if (p.y < H - (heap[col] + 1) * PX) continue;
      // Down whichever side is lower, as far as it goes.
      for (;;) {
        const l = col > 0 && heap[col - 1] < heap[col] - 1;
        const r = col < last && heap[col + 1] < heap[col] - 1;
        if (!l && !r) break;
        col += l && r ? (Math.random() < 0.5 ? -1 : 1) : l ? -1 : 1;
      }
      heap[col]++;
      p.x = col * PX;
      p.y = H - heap[col] * PX;
      p.rest = true;
    }
  }

  function step() {
    // The end: nothing moves and the fuses stop flickering.
    if (over) return;
    ticks++;
    if (paused) return;
    if (maze) { runMaze(); return; }
    const move = choose();
    if (!move) { reset(); return; }
    dir = move.d;
    body.unshift(move.at);
    const item = items.find((i) => same(i.at, move.at));
    // Fruit grows the snake by keeping its tail this step.
    if (item) eat(item);
    else body.pop();
  }

  // Drawn every animation frame rather than every step, so the bang and the fades run smooth
  // between the snake's STEP_MS moves.
  function tick(now) {
    frame = requestAnimationFrame(tick);
    draw(now);
  }

  /** A piece of art (by name) at a cell's corner, shifted by its ORIGIN if it overhangs the cell. */
  function sprite(kind, x, y) {
    const [dx, dy] = ORIGIN[kind] ?? [0, 0];
    const art = baked(kind);
    g.drawImage(art, x + dx * PX, y + dy * PX, art.width / art.dpr, art.height / art.dpr);
  }

  // Each piece of art painted once into a canvas of its own at the screen's density: the maze puts
  // a few hundred bombs on the board, and 49 rectangles apiece every frame is a lot of rectangles.
  const bakes = new Map();
  function baked(kind) {
    const dpr = window.devicePixelRatio || 1;
    let c = bakes.get(kind);
    if (c?.dpr === dpr) return c;
    const rowsOfArt = ART[kind];
    c = document.createElement('canvas');
    c.dpr = dpr;
    c.width = Math.round(rowsOfArt[0].length * PX * dpr);
    c.height = Math.round(rowsOfArt.length * PX * dpr);
    const b = c.getContext('2d');
    b.scale(dpr, dpr);
    rowsOfArt.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.') return;
      b.fillStyle = INK[ch];
      b.fillRect(i * PX, j * PX, PX, PX);
    }));
    bakes.set(kind, c);
    return c;
  }

  // Idling: up an art pixel for the first part of each bob, whole pixels only so it stays crisp.
  const bobOf = (item, now) => (((now / BOB_MS + ((item.at[0] * 7 + item.at[1] * 13) % 10) / 10) % 1) < 0.3 ? PX : 0);
  // The head's two eye pixels, toward the way it's going.
  function eyes() {
    const [hx, hy] = [cellX(body[0]), cellY(body[0])];
    const side = [dir[1], -dir[0]];
    return [1, -1].map((s) => [
      hx + CELL / 2 + dir[0] * CELL / 5 + side[0] * s * CELL / 5 - PX / 2,
      hy + CELL / 2 + dir[1] * CELL / 5 + side[1] * s * CELL / 5 - PX / 2,
    ]);
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
      const bob = bobOf(item, now);
      sprite(item.kind, cellX(item.at), cellY(item.at) - bob);
      // The fuse sparks: a few bright pixels round its tip, different every step.
      if (item.kind === 'bomb') {
        for (let k = 0; k < 3; k++) {
          g.fillStyle = SPARK[(ticks + k) % SPARK.length];
          const sx = 5 + ((ticks * 3 + k * 5) % 3) - 1;
          const sy = (ticks + k * 2) % 2;
          g.fillRect(cellX(item.at) + sx * PX, cellY(item.at) - bob + sy * PX, PX, PX);
        }
      }
    }
    // The corridor still ahead of the snake, a dashed line down the middle of it to the dead end.
    if (maze && !over && maze.at < maze.path.length) {
      g.save();
      g.strokeStyle = TRAIL;
      g.lineWidth = PX;
      g.setLineDash([PX, PX * 2]);
      g.beginPath();
      for (const [n, at] of [body[0], ...maze.path.slice(maze.at)].entries()) {
        g[n ? 'lineTo' : 'moveTo'](cellX(at) + CELL / 2, cellY(at) + CELL / 2);
      }
      g.stroke();
      g.restore();
    }
    if (debris) {
      // Gravity's on: the snake and the bombs are only pixels now.
      fall(now);
      for (const p of debris) {
        g.fillStyle = p.c;
        g.fillRect(p.x, p.y, PX, PX);
      }
    } else {
      body.forEach((part, i) => {
        g.fillStyle = i === 0 ? colours.head : colours.body;
        g.fillRect(cellX(part) + 2, cellY(part) + 2, CELL - 4, CELL - 4);
      });
      g.fillStyle = EYE;
      for (const [ex, ey] of eyes()) g.fillRect(ex, ey, PX, PX);
      // The hat sits on top of the head whichever way the snake is going, brim across its middle.
      if (hat) sprite('hat', cellX(body[0]), cellY(body[0]));
    }

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
    // The flash: white washing out over the slide.
    if (over && now - over < FLASH_MS) {
      g.globalAlpha = 0.85 * (1 - (now - over) / FLASH_MS);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
    if (over && now - over > TEXT_AT_MS) gameOver(Math.min(1, (now - over - TEXT_AT_MS) / TEXT_MS), W, H);
  }

  // GAME OVER in the middle of the window in the slide's own heading type, the question's font and
  // size, read off it so the two can't drift apart.
  function gameOver(u, W, H) {
    const h1 = shaken?.querySelector('h1');
    const cs = h1 ? getComputedStyle(h1) : null;
    g.save();
    g.globalAlpha = u;
    g.font = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : `800 96px system-ui, sans-serif`;
    if (cs) g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = OVER_INK;
    g.fillText('GAME OVER', W / 2, H / 2);
    g.restore();
  }

  const onResize = () => { layout(); reset(); };
  // ↑/↓ let a frozen snake go too; → is the deck's, and comes in through `advance`.
  const onKey = (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') paused = false; };

  function start() {
    layout();
    kinds = ['apple'];
    count = onBoard();
    hat = false;
    colours = GREEN;
    maze = null;
    over = 0;
    debris = null;
    rings = [];
    shakes = [];
    reset();
    paused = false;
    canvas.classList.add('on');
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    timer = setInterval(step, STEP_MS);
    frame = requestAnimationFrame(tick);
  }

  return {
    /**
     * The next beat: start the snake, then put the next thing on the board and freeze, then let it
     * go, and so on — the last thing being the maze. A press while the snake runs the maze waits for
     * the bang, so a double tap can't skip the joke; false once it's GAME OVER.
     */
    advance() {
      if (stage === 0) { start(); stage = 1; return true; }
      if (over) return false;
      if (paused) { paused = false; return true; }
      if (maze || stage > STAGES.length) return true;
      const kind = STAGES[stage - 1];
      if (kind === 'bomb') { buildMaze(performance.now()); stage++; paused = true; return true; }
      kinds.push(kind);
      // Everything on the board turns, nearest the snake's head first — the furthest dropped if
      // there are more than this stage's count — then any still owed land after them.
      count = onBoard();
      const now = performance.now();
      const [hx, hy] = body[0];
      items.sort((a, b) => Math.hypot(a.at[0] - hx, a.at[1] - hy) - Math.hypot(b.at[0] - hx, b.at[1] - hy));
      items.length = Math.min(items.length, count);
      items.forEach((item, i) => Object.assign(item, { was: item.kind, kind, turn: now + i * TURN_GAP_MS }));
      while (items.length < count) place(kind, now + items.length * TURN_GAP_MS);
      stage++;
      paused = true;
      return true;
    },
    stop() {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      timer = 0;
      frame = 0;
      stage = 0;
      paused = false;
      maze = null;
      over = 0;
      debris = null;
      for (const el of [canvas, shaken]) if (el) el.style.transform = '';
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      canvas.classList.remove('on');
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    },
  };
}
