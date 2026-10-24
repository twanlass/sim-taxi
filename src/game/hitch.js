/**
 * The hitch logger — `?hitch`.
 *
 * Written for a report of "lots of frame-rate glitch hitching" on the iOS build (2026-10-24) that no
 * headless tool could reproduce: `tools/links.mjs` counted one mid-run shader link, `tools/perf.mjs`
 * measured the same 3.6 ms of JS a frame before and after the day's merges, and `tools/gpucost.mjs`
 * put the new walls, windows, roads and steam at 0–3% of a frame. Whatever it is lives on the
 * device, so this is a readout to hold in your hand rather than a tool to run.
 *
 * A **hitch** is a frame that arrives more than `SLOW` times late against the frame-rate cap. For
 * each one it records:
 *
 *   - `cpu` — how long the previous `tick()` took. A hitch with a small `cpu` was not the game's
 *     JavaScript: it was the GPU, the compositor, or the browser doing something between frames.
 *   - `link` — shader programs linked since the last frame (`gl.linkProgram` is wrapped).
 *   - `rs` — the canvas was resized (the heat governor stepping, `game/governor.js`).
 *   - the tags `probes` answer, such as whether a speech card is on screen.
 *
 * The bottom line is the useful one: hitches a minute *with* each tag against *without* it, so
 * "hitches while the glass card is up" can be told from "hitches, and the glass card happens to be
 * up a lot". Nothing runs without the flag, and the module imports in node.
 */

const SLOW = 1.7;
const KEEP = 8;

export function getHitchLogger() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('hitch');
}

/**
 * @param renderer  for the context whose links are counted, and the canvas size
 * @param enabled   `?hitch`
 * @param cap       `() => fps` — the frame-rate cap a frame is judged against
 * @param probes    `{ tag: () => boolean }` — state worth correlating with a hitch
 */
export function createHitchLogger(renderer, { enabled = false, cap = () => 60, probes = {} } = {}) {
  if (!enabled) return { begin: () => {}, end: () => {} };

  const gl = renderer.getContext();
  let links = 0;
  const link = gl.linkProgram.bind(gl);
  gl.linkProgram = (program) => { links += 1; return link(program); };

  const element = document.createElement('div');
  element.id = 'hitch-log';
  element.style.cssText = 'position:fixed;left:6px;top:calc(var(--safe-top, 0px) + 64px);z-index:60;'
    + 'pointer-events:none;font:10px/1.3 ui-monospace,Menlo,monospace;color:#fff;'
    + 'background:rgba(0,0,0,0.6);padding:4px 6px;border-radius:4px;white-space:pre;max-width:96vw';
  document.body.appendChild(element);

  const tags = Object.keys(probes);
  // Seconds of play spent with each tag on and off, and the hitches that landed in each.
  const time = Object.fromEntries(tags.map((t) => [t, { on: 0, off: 0, hOn: 0, hOff: 0 }]));
  const recent = [];
  let lastAt = 0;
  let cpu = 0;
  let started = 0;
  let width = 0;
  let height = 0;
  let total = 0;
  let frames = 0;
  let worst = 0;
  let drawnAt = 0;

  function begin(t) {
    started = performance.now();
    if (!lastAt) { lastAt = t; return; }
    const gap = t - lastAt;
    lastAt = t;
    // A backgrounded tab or a pause hands back one enormous gap; that is not a hitch.
    if (gap > 1000) { links = 0; return; }
    const budget = 1000 / cap();
    const canvas = renderer.domElement;
    const resized = canvas.width !== width || canvas.height !== height;
    width = canvas.width;
    height = canvas.height;
    const on = tags.filter((tag) => { try { return Boolean(probes[tag]()); } catch { return false; } });
    for (const tag of tags) time[tag][on.includes(tag) ? 'on' : 'off'] += gap / 1000;
    frames += 1;
    worst = Math.max(worst, gap);
    if (gap > budget * SLOW) {
      total += 1;
      for (const tag of tags) time[tag][on.includes(tag) ? 'hOn' : 'hOff'] += 1;
      recent.unshift(`${gap.toFixed(0).padStart(4)}ms cpu ${cpu.toFixed(1).padStart(4)}`
        + `${links ? ` link ${links}` : ''}${resized ? ' rs' : ''}${on.length ? ` ${on.join(' ')}` : ''}`);
      recent.length = Math.min(recent.length, KEEP);
    }
    links = 0;
    if (t - drawnAt > 500) {
      drawnAt = t;
      const rate = (h, s) => (s > 1 ? (h / s * 60).toFixed(1) : '–');
      const rows = tags.map((tag) => {
        const r = time[tag];
        return `${tag.padEnd(8)} ${rate(r.hOn, r.on).padStart(5)}/min on (${r.on.toFixed(0)}s)`
          + `  ${rate(r.hOff, r.off).padStart(5)}/min off`;
      });
      element.textContent = [
        `hitches ${total} / ${frames} frames · worst ${worst.toFixed(0)}ms · cap ${cap()}`,
        ...recent,
        ...rows,
      ].join('\n');
      worst = 0;
    }
  }

  function end() {
    cpu = performance.now() - started;
  }

  return { begin, end };
}
