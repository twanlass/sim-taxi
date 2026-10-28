// Pixel sprites drawn in code: shapes rasterised onto a character grid, shaded with light from the
// top left, and ringed in an outline. The sketchbook's creatures (escape.js) were drawn with this
// first, and the family on the character select (select.js) is drawn with it so the two read as one
// cast. A grid is rows of single-letter colour keys, '.' for clear; the palette is the caller's.

// --- Rasterising -------------------------------------------------------------------------------
// Each shape paints `c` into every cell whose centre it covers.

export const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill('.'));
export const each = (g, fn) => g.forEach((row, y) => row.forEach((_, x) => fn(x + 0.5, y + 0.5, x, y)));
export const ellipse = (g, cx, cy, rx, ry, c) => each(g, (px, py, x, y) => {
  if (((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1) g[y][x] = c;
});
export const circle = (g, cx, cy, r, c) => ellipse(g, cx, cy, r, r, c);
export function poly(g, pts, c) {
  each(g, (px, py, x, y) => {
    let inside = false;
    pts.forEach(([x1, y1], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 > py) !== (y2 > py) && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    });
    if (inside) g[y][x] = c;
  });
}
export function line(g, x1, y1, x2, y2, w, c) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy || 1;
  each(g, (px, py, x, y) => {
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    if ((px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2 <= (w / 2) ** 2) g[y][x] = c;
  });
}
/** A polyline whose width tapers from `w0` to `w1` along it: a tentacle. */
export function taper(g, pts, w0, w1, c) {
  for (let i = 0; i < pts.length - 1; i++) line(g, ...pts[i], ...pts[i + 1], w0 + ((w1 - w0) * i) / (pts.length - 1), c);
}
/**
 * Light from the top left: cells of `base` within `depth` of the region's bottom-right edge go
 * `dark`, those on its top-left edge `light`. Run before anything is drawn over the region, so a
 * pupil or a nose doesn't count as an edge.
 */
export function shade(g, base, dark, light, depth = 2) {
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
export function inked(g, shape, c) {
  const m = grid(g[0].length, g.length);
  shape(m);
  const on = (x, y) => m[y]?.[x] === '#';
  each(g, (_, __, x, y) => {
    if (on(x, y)) g[y][x] = on(x + 1, y) && on(x - 1, y) && on(x, y + 1) && on(x, y - 1) ? c : 'K';
  });
}

// --- Eyes and output ---------------------------------------------------------------------------

/** The cells of each eye, found once on the open grid: a flood from the seed, or the box's cells. */
export function eyeCells(g, e) {
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
export function drawEyes(g, eyes, look, shut) {
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
export function gridCanvas(g, colours, ink) {
  const h = g.length;
  const w = g[0].length;
  const c = document.createElement('canvas');
  c.width = w + 2;
  c.height = h + 2;
  const ctx = c.getContext('2d');
  const filled = (x, y) => g[y]?.[x] !== undefined && g[y][x] !== '.';
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (filled(x, y)) ctx.fillStyle = colours[g[y][x]];
      else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ctx.fillStyle = ink;
      else continue;
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  return c;
}
