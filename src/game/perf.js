/**
 * The on-device profiler — `?perf`.
 *
 * `?hitch` (game/hitch.js) is a readout you hold in your hand: it shows the last few late frames on
 * screen and nothing leaves the phone. That made every iOS hitch report a relay — someone reading
 * numbers off a glass card to someone else — and it kept only eight frames, so "what was the worst
 * thing in that run" was never answerable. This records **every** frame of the run, plus the
 * startup, and saves it somewhere a Mac can pull it from without anyone touching the phone:
 *
 *   - in the iOS shell, through the `perf` message handler (`ios/SimTaxi/PerfBridge.swift`), into
 *     the app's `Documents/perf/`, where `node tools/ios-perf.mjs pull` copies it off with
 *     `devicectl` and ranks it (docs/testing.md, "Profiling on the phone");
 *   - in a browser, onto `window.__perfCapture.last`, with `__perfCapture.download()` to save it.
 *
 * **What a frame records, and why each column is there.**
 *
 *   - `gap` — rAF time since the last drawn frame. The only number the player feels.
 *   - `cpu` — how long `tick()` took, split into phases (`perfPhase`): `sim` is everything before
 *     the render starts, then one column per render pass (`ao`, `bloom`, `main`, …), and `after`
 *     what `tick` did once the frame was submitted. These are **JS submission** times. A hitch
 *     whose `cpu` is small was not the game's JavaScript.
 *   - `link` — `gl.linkProgram` calls. A link is a synchronous stall in the driver.
 *   - `up` / `tex` — kilobytes through `bufferData`/`bufferSubData`, and texture uploads. A first
 *     draw of anything uploads; game/warmup.js exists to move those into the load.
 *   - `calls` / `tris` — `renderer.info`, summed over every pass of the frame.
 *   - `rs` — the drawing buffer changed size (the heat governor stepping, game/governor.js).
 *   - `tags` — whatever `probes` answer true for (a speech card up, paused…), as a bitmask.
 *
 * **What it cannot see is the GPU.** WebKit exposes no `EXT_disjoint_timer_query`, so a frame the
 * GPU took 40 ms over shows up here only as a long `gap` with a short `cpu`. That half comes from
 * Instruments' Metal System Trace, recorded alongside (`tools/ios-perf.mjs trace`); the two line up
 * on wall-clock time, which is why the capture carries `timeOrigin`.
 *
 * Nothing runs without the flag — every export is a no-op — and the module imports in node.
 */

const SAVE_EVERY_MS = 60_000;
/** At 60 fps, twenty minutes of play. Past this the oldest frames go. */
const MAX_FRAMES = 72_000;
const HUD_EVERY_MS = 500;
const SLOW = 1.7;

export const PERF = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('perf');

let active = null;

/** A named moment in the startup, or an event worth seeing in the timeline. No-op without `?perf`. */
export function perfMark(name) {
  if (!PERF) return;
  const t = performance.now();
  if (active) active.note(name, t);
  else early.push([Math.round(t), name]);
}
const early = [];

/** Close the current phase of this frame's `tick` and open `name`. No-op without `?perf`. */
export function perfPhase(name) {
  if (active) active.phase(name);
}

/**
 * @param renderer  the context whose calls are counted
 * @param cap       `() => fps` — the cap a frame is judged against
 * @param probes    `{ tag: () => boolean }`
 * @param context   `() => object` — settings worth saving beside the frames (quality, ratio…)
 */
export function createPerfCapture(renderer, { cap = () => 60, probes = {}, context = () => ({}) } = {}) {
  const noop = { begin: () => {}, end: () => {}, save: () => null };
  if (!PERF) return noop;

  const gl = renderer.getContext();
  const counters = { link: 0, up: 0, tex: 0 };
  const boot = { link: 0, up: 0, tex: 0 };
  const wrap = (name, fn) => {
    const original = gl[name];
    if (typeof original !== 'function') return;
    const bound = original.bind(gl);
    gl[name] = (...args) => { fn(args); return bound(...args); };
  };
  const bytesOf = (data) => (data && typeof data.byteLength === 'number' ? data.byteLength
    : typeof data === 'number' ? data : 0);
  wrap('linkProgram', () => { counters.link += 1; });
  wrap('bufferData', (a) => { counters.up += bytesOf(a[1]); });
  wrap('bufferSubData', (a) => { counters.up += bytesOf(a[2]); });
  for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D',
    'compressedTexImage2D', 'texStorage2D']) wrap(name, () => { counters.tex += 1; });

  const tags = Object.keys(probes);
  const columns = ['t', 'gap', 'cpu', 'link', 'up', 'tex', 'calls', 'tris', 'rs', 'tags'];
  const frames = Object.fromEntries(columns.map((c) => [c, []]));
  const phaseNames = [];
  const phaseCols = {};
  const notes = early.splice(0);
  let lastAt = 0;
  let started = 0;
  let boundary = 0;
  let current = '';
  let phases = {};
  let width = 0;
  let height = 0;
  let firstFrameAt = 0;
  let saves = 0;
  let savedAt = 0;
  let saving = false;
  let wasHidden = false;
  let count = 0;
  let calls = 0;
  let tris = 0;

  // `renderer.info` resets on every `render()` call and a frame here is several of them (AO, bloom,
  // the main pass), so it is summed per call rather than read once at the end.
  const info = renderer.info;
  info.autoReset = false;
  const render = renderer.render.bind(renderer);
  renderer.render = (...args) => {
    info.reset();
    const out = render(...args);
    calls += info.render.calls;
    tris += info.render.triangles;
    return out;
  };

  const hud = document.createElement('div');
  hud.id = 'perf-hud';
  hud.style.cssText = 'position:fixed;right:6px;top:calc(var(--safe-top, 0px) + 6px);z-index:60;'
    + 'pointer-events:none;font:10px/1.3 ui-monospace,Menlo,monospace;color:#fff;'
    + 'background:rgba(0,0,0,0.55);padding:3px 6px;border-radius:4px;white-space:pre';
  document.body.appendChild(hud);
  let hudAt = 0;
  let window0 = { frames: 0, hitches: 0, since: 0, worst: 0, last: '' };

  function note(name, t = performance.now()) {
    notes.push([Math.round(t), name]);
  }

  function phase(name) {
    if (!started) return;
    const now = performance.now();
    phases[current] = (phases[current] ?? 0) + (now - boundary);
    boundary = now;
    current = name;
  }

  function begin(t) {
    started = performance.now();
    boundary = started;
    current = 'sim';
    phases = {};
    calls = 0;
    tris = 0;
    if (!firstFrameAt) {
      firstFrameAt = t;
      Object.assign(boot, counters);
      counters.link = 0; counters.up = 0; counters.tex = 0;
      note('first-frame', t);
    }
    if (!lastAt) lastAt = t;
  }

  function end() {
    if (!started) return;
    const now = performance.now();
    phase('');
    const t = started;
    started = 0;
    // A gap that spans the app being in the background is not a slow frame, and is saved as -1.
    // Judged by visibility rather than by length, as the governor does: on a phone the frames that
    // matter most — the first one after the warm-up, a pipeline build — can run past two seconds.
    let gap = t - lastAt;
    lastAt = t;
    if (wasHidden) { wasHidden = false; gap = -1; note('away', t); }
    const canvas = renderer.domElement;
    const rs = canvas.width !== width || canvas.height !== height ? 1 : 0;
    if (rs && width) note(`resize ${canvas.width}x${canvas.height}`, t);
    width = canvas.width;
    height = canvas.height;
    let mask = 0;
    tags.forEach((tag, i) => { try { if (probes[tag]()) mask |= 1 << i; } catch { /* a probe that throws is off */ } });
    if (saving) { mask |= 1 << tags.length; saving = false; }
    const row = [Math.round(t), +gap.toFixed(1), +(now - t).toFixed(2), counters.link,
      Math.round(counters.up / 1024), counters.tex, calls, tris, rs, mask];
    columns.forEach((c, i) => frames[c].push(row[i]));
    for (const [name, ms] of Object.entries(phases)) {
      if (!name) continue;
      if (!phaseCols[name]) { phaseCols[name] = new Array(count).fill(0); phaseNames.push(name); }
    }
    for (const name of phaseNames) phaseCols[name].push(+((phases[name] ?? 0).toFixed(2)));
    count += 1;
    if (count > MAX_FRAMES) {
      for (const c of columns) frames[c].shift();
      for (const name of phaseNames) phaseCols[name].shift();
      count -= 1;
    }
    counters.link = 0; counters.up = 0; counters.tex = 0;

    const budget = 1000 / cap();
    window0.frames += 1;
    window0.worst = Math.max(window0.worst, gap);
    if (gap > budget * SLOW) {
      window0.hitches += 1;
      window0.last = `${gap.toFixed(0)}ms cpu ${(now - t).toFixed(1)}${row[3] ? ` link ${row[3]}` : ''}`
        + `${row[4] ? ` up ${row[4]}k` : ''}${rs ? ' rs' : ''}`;
    }
    if (!window0.since) window0.since = t;
    if (t - hudAt > HUD_EVERY_MS) {
      hudAt = t;
      const secs = (t - window0.since) / 1000;
      hud.textContent = `perf ${(window0.frames / Math.max(secs, 0.001)).toFixed(0)}fps/${cap()}`
        + ` · late ${window0.hitches} · worst ${window0.worst.toFixed(0)}ms`
        + `${window0.last ? `\nlast ${window0.last}` : ''}${saves ? `\nsaved ×${saves}` : ''}`;
      if (secs > 10) window0 = { frames: 0, hitches: 0, since: t, worst: 0, last: window0.last };
    }
    if (t - savedAt > SAVE_EVERY_MS) save('periodic');
  }

  function snapshot(reason) {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const resources = performance.getEntriesByType?.('resource') ?? [];
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: 1,
      reason,
      savedAt: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      url: window.location.href,
      native: Boolean(window.__native),
      nativeVersion: window.__nativeVersion ?? null,
      ua: navigator.userAgent,
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
      canvas: { w: renderer.domElement.width, h: renderer.domElement.height },
      cap: cap(),
      context: (() => { try { return context(); } catch { return {}; } })(),
      tags: [...tags, 'save'],
      boot: {
        ...boot,
        up: Math.round(boot.up / 1024),
        firstFrame: Math.round(firstFrameAt),
        nav: nav ? {
          responseEnd: Math.round(nav.responseEnd),
          domInteractive: Math.round(nav.domInteractive),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          load: Math.round(nav.loadEventEnd),
        } : null,
        marks: performance.getEntriesByType?.('mark')?.map((m) => [Math.round(m.startTime), m.name]) ?? [],
        resources: resources.map((r) => [r.name.replace(/^.*\/\/[^/]+/, ''), Math.round(r.startTime),
          Math.round(r.duration), r.transferSize ?? 0]),
      },
      notes,
      frames,
      phases: phaseCols,
    };
  }

  /** Serialise and hand the capture off. The frame it happens on is tagged `save`. */
  function save(reason = 'manual') {
    savedAt = lastAt || performance.now();
    saving = true;
    const data = snapshot(reason);
    const name = `perf-${new Date(performance.timeOrigin).toISOString().replace(/[:.]/g, '-')}`;
    const body = JSON.stringify(data);
    saves += 1;
    window.__perfCapture.last = data;
    const handler = window.webkit?.messageHandlers?.perf;
    if (handler) {
      try { handler.postMessage({ name, body }); } catch (error) { console.warn('[perf] save', error); }
    }
    return data;
  }

  function download() {
    const data = window.__perfCapture.last ?? save('download');
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `perf-${Date.now()}.json`;
    a.click();
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) { wasHidden = true; save('hidden'); } });
  window.addEventListener('pagehide', () => save('pagehide'));

  window.__perfCapture = { save, download, note, last: null };
  active = { note, phase };
  return { begin, end, save };
}
