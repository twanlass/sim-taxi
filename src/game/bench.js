/**
 * The on-device benchmark — `?bench`.
 *
 * The perf pass (tools/perf.mjs) counts exactly what a frame asks of the GPU, but it runs on
 * SwiftShader, so it cannot say what any of it *costs* on a phone. `?diag` can, one flag at a time,
 * and nobody runs ten loads by hand holding a phone. This runs them: one page load per setting,
 * the same pinned city and situation each time, the taxi driving itself from fare to fare, and a
 * table at the end that can be copied off the screen.
 *
 * **One reload per setting, not a live toggle.** MSAA is a context attribute and AO is compiled
 * into every material (see `getAmbientOcclusion`), so half the settings worth measuring cannot be
 * changed on a live renderer. Reloading for all of them keeps every row measured the same way.
 * The state rides in the URL (`bench=<step>&br=<results>`) rather than in storage, because the iOS
 * shell's origin is exactly where storage has failed soft before (CLAUDE.md, `file://`).
 *
 * **Baseline runs first and last.** A phone heats up over five minutes of rendering flat out and
 * throttles, so a later row is measured on a warmer device than an earlier one. The second
 * baseline is how far that drifted, and a row that beats baseline by less than the drift has not
 * shown anything.
 *
 * **What the columns can and cannot say.** The display caps the frame rate (60 on an iPhone in
 * Safari), so a setting that frees up GPU time on a phone that already holds 60 shows nothing in
 * `fps` — `cpu` and `jank` are the columns that still move then. `cpu` is the time spent inside the
 * frame callback: the game's JS plus three's draw submission, *not* the GPU's work. A frame
 * interval well above `cpu` is time spent waiting on the GPU.
 */

/** Seconds: settle after the taxi is handed over (shader links, the city's entrance), then measure. */
export const BENCH_WARMUP = 4;
export const BENCH_SECONDS = 15;
/** Seconds to wait for the taxi before measuring anyway — a run that never hands it over still counts. */
const READY_TIMEOUT = 30;
/** A frame interval this many vsyncs long or more is a visible hitch. */
const JANK_VSYNCS = 1.5;
const VSYNC_MS = 1000 / 60;

/**
 * What every step shares. A pinned city (shot mode's own default) and situation, so each row sees
 * the same streets; no title, vignette or tutorial; `debug` for the held fare clocks, so the run
 * cannot end on timeouts mid-measurement; the end of the difficulty ramp, so the city carries its
 * full 22 cars; and no squall, which arrives twelve seconds in and would land in some rows and
 * not others. The squall gets a row of its own, pinned overhead. And the resolution governor off
 * (game/governor.js): each row is one fixed setting, and a governor stepping the ratio under it
 * would turn the dpr rows into the same row. `dpr=2` pins the baseline against the player's own
 * Resolution setting.
 */
export const BENCH_BASE = {
  seed: '71624', run: '7', title: 'off', vignette: 'off', debug: '', d: '1', squall: 'off', governor: 'off', dpr: '2',
};

/** The settings, in order. Each is one page load. */
export const BENCH_STEPS = [
  { label: 'baseline', params: {} },
  { label: 'dpr 3', params: { dpr: '3' } },
  { label: 'dpr 1', params: { dpr: '1' } },
  { label: 'msaa off', params: { msaa: 'off' } },
  { label: 'shadows 1024', params: { shadows: '1024' } },
  { label: 'shadows off', params: { shadows: 'off' } },
  { label: 'ao off', params: { ao: 'off' } },
  { label: 'bloom off', params: { bloom: 'off' } },
  // The layered car paint against the one before it (util/geo.js). Cars are a few percent of the
  // frame at play zoom, so this row is expected to sit inside the drift between the two baselines.
  { label: 'paint classic', params: { paint: 'classic' } },
  { label: '30 fps', params: { fps: '30' } },
  { label: 'squall overhead', params: { squall: '0.5' } },
  // Everything off at once: the floor this renderer can reach without changing what it draws.
  { label: 'minimum', params: { dpr: '1', msaa: 'off', shadows: 'off', ao: 'off', bloom: 'off' } },
  { label: 'baseline again', params: {} },
];

/**
 * Where the bench is: null without `?bench`, `{ step: -1 }` on the start card, otherwise the step
 * this load measures and the rows measured before it.
 */
export function readBench(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  if (!params.has('bench')) return null;
  const step = Number.parseInt(params.get('bench'), 10);
  let results = [];
  try { results = JSON.parse(params.get('br') ?? '[]'); } catch { results = []; }
  if (!Array.isArray(results)) results = [];
  return { step: Number.isInteger(step) && step >= 0 && step < BENCH_STEPS.length ? step : -1, results };
}

/** The query string for `step`, carrying `results` forward. */
export function benchSearch(step, results) {
  const params = new URLSearchParams({ ...BENCH_BASE, ...BENCH_STEPS[step].params });
  params.set('bench', String(step));
  params.set('br', JSON.stringify(results));
  return `?${params.toString()}`;
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * One row from a step's raw samples: `intervals` between frames and `cpu` time inside each, in ms.
 * Kept short-keyed because every row rides in the URL of every load after it.
 */
export function summarize(label, intervals, cpu, extra = {}, work = [], seconds = 0) {
  const iv = [...intervals].sort((a, b) => a - b);
  const cp = [...cpu].sort((a, b) => a - b);
  const total = intervals.reduce((s, v) => s + v, 0);
  const avg = intervals.length ? total / intervals.length : 0;
  return {
    k: label,
    fps: r1(avg ? 1000 / avg : 0),
    avg: r1(avg),
    p95: r1(pct(iv, 0.95)),
    max: r1(iv.at(-1) ?? 0),
    // Late against the row's own cadence, so a 30 fps row is not 100% late by construction.
    jank: r1(intervals.length ? (100 * intervals.filter((v) => v >= JANK_VSYNCS * Math.max(VSYNC_MS, pct(iv, 0.5))).length) / intervals.length : 0),
    cpu: r1(cp.length ? cp.reduce((s, v) => s + v, 0) / cp.length : 0),
    cpu95: r1(pct(cp, 0.95)),
    // Work: frame start until the GPU has actually finished it (see `syncGpu`), and busy: the
    // share of wall time spent on that. Busy is the column that tracks power — it falls when a
    // frame gets cheaper even though the display cap holds the fps column still, and it halves
    // at 30 fps while work per frame stays the same.
    ...(work.length ? {
      work: r1(work.reduce((s, v) => s + v, 0) / work.length),
      busy: r1(seconds ? (100 * work.reduce((s, v) => s + v, 0)) / (seconds * 1000) : 0),
    } : {}),
    ...extra,
  };
}

/** The copyable table. Plain text, fixed width, so it pastes into a chat legibly. */
export function formatResults(results, header = '') {
  const base = results.find((r) => r.k === 'baseline');
  const cols = ['fps', 'p95', 'jank%', 'cpu', 'work', 'busy%', 'vs base'];
  const pad = (s, n) => String(s).padStart(n);
  const lines = [header, `${'setting'.padEnd(20)}${cols.map((c, i) => pad(c, i === cols.length - 1 ? 10 : 8)).join('')}`]
    .filter(Boolean);
  for (const r of results) {
    // Busy time relative to the first baseline: the power proxy. Rows from before the work column
    // existed fall back to CPU time.
    let vs = '';
    if (base && r !== base) {
      const [a, b] = r.busy != null && base.busy != null ? [r.busy, base.busy] : [r.cpu, base.cpu];
      if (b > 0) vs = `${a <= b ? '' : '+'}${Math.round((100 * (a - b)) / b)}%`;
    }
    const flags = `${r.lost ? ' CONTEXT LOST' : ''}${r.over ? ' run ended' : ''}${r.late ? ' taxi never ready' : ''}`;
    lines.push(`${r.k.padEnd(20)}${[r.fps, r.p95, r.jank, r.cpu, r.work ?? '-', r.busy ?? '-'].map((v) => pad(v, 8)).join('')}${pad(vs, 10)}${flags}`
      + (r.buf ? `  ${r.buf}` : ''));
  }
  return lines.join('\n');
}

/**
 * The bench, live. Null without `?bench`.
 *
 * @param renderer  the main WebGLRenderer, for its context and drawing-buffer size
 * @param ready     true once the taxi is the player's — measuring starts a warm-up after this
 * @param drive     keeps the taxi on a job; called about once a second while the bench runs
 * @param ended     true once the run is over (a wreck), so a row that measured a crash cam says so
 * @param gpu       the GPU's own name for itself, for the table's header
 */
export function createBench({ renderer, ready, drive, ended, gpu = '?' }) {
  const state = readBench();
  if (!state || typeof document === 'undefined') return null;

  const el = document.createElement('div');
  el.id = 'bench';
  document.body.append(el);
  // Taps on the bar must never reach the city — they are what keeps a phone with a short
  // auto-lock awake when the wake lock is refused.
  for (const type of ['pointerdown', 'pointerup', 'click', 'touchstart']) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }

  const go = (step, results) => {
    window.location.replace(`${window.location.pathname}${benchSearch(step, results)}`);
  };
  const button = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  // A reload drops any wake lock the page held, so each step asks again. Safari may refuse one that
  // no tap asked for; the bar says so, and a tap on it now and then does the same job.
  let awake = false;
  const keepAwake = () => navigator.wakeLock?.request('screen')
    .then(() => { awake = true; }).catch(() => {});

  if (state.step === -1) {
    const total = BENCH_STEPS.length * (BENCH_WARMUP + BENCH_SECONDS + 6);
    el.innerHTML = `<b>Benchmark</b><p>${BENCH_STEPS.length} runs of the same city, one setting each,`
      + ` about ${Math.round(total / 60)} minutes in all. The taxi drives itself; don't touch the city.`
      + ' Keep the screen on (set Auto-Lock to Never, or tap this box now and then).</p>';
    el.append(button('Start', () => { keepAwake(); go(0, state.results); }));
    return { begin() {}, end() {} };
  }

  keepAwake();
  const step = BENCH_STEPS[state.step];
  const intervals = [];
  const cpu = [];
  const work = [];
  // One pixel read back from the frame just drawn. A read cannot return until the GPU has finished
  // everything queued before it, so the time to here is the frame's whole cost, GPU included —
  // which is exactly what the display cap hides from the frame interval. It stalls the pipeline
  // while measuring, so it only runs during `measure`, and only under `?bench`.
  const pixel = new Uint8Array(4);
  const syncGpu = () => {
    const gl = renderer.getContext();
    if (!gl.isContextLost()) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
  const startedAt = performance.now();
  let phase = 'wait';
  let phaseAt = startedAt;
  let late = false;
  let lastT = 0;
  let frameStart = 0;
  let lastDrive = 0;
  let lastLabel = 0;
  let over = false;

  const label = (now) => {
    if (now - lastLabel < 250) return;
    lastLabel = now;
    const left = phase === 'measure' ? Math.max(0, BENCH_SECONDS - (now - phaseAt) / 1000) : null;
    el.textContent = `Bench ${state.step + 1}/${BENCH_STEPS.length} · ${step.label} · `
      + (phase === 'wait' ? 'loading' : phase === 'warm' ? 'warming up' : `measuring ${left.toFixed(0)}s`)
      + (awake ? '' : '\nTap here now and then to keep the screen on');
  };

  function finish() {
    const gl = renderer.getContext();
    const results = [...state.results, summarize(step.label, intervals, cpu, {
      buf: `${renderer.domElement.width}x${renderer.domElement.height}`,
      ...(gl.isContextLost() ? { lost: 1 } : {}),
      ...(over ? { over: 1 } : {}),
      ...(late ? { late: 1 } : {}),
    }, work, (performance.now() - phaseAt) / 1000)];
    if (state.step + 1 < BENCH_STEPS.length) {
      go(state.step + 1, results);
      return;
    }
    const header = `Rocket Rides bench · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
      + ` · ${gpu} · ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}\n${navigator.userAgent}`
      + `\nms; jank = frames over ${JANK_VSYNCS}x the usual interval; cpu = JS in the frame; work = until the GPU finished it;`
      + ' busy = share of time spent on work (the power proxy; vs base compares it)';
    const text = formatResults(results, header);
    el.classList.add('is-done');
    el.textContent = '';
    const pre = document.createElement('pre');
    pre.textContent = text;
    el.append(pre);
    el.append(button('Copy results', () => {
      const fallback = () => {
        const range = document.createRange();
        range.selectNodeContents(pre);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
      else fallback();
    }));
    el.append(button('Run again', () => go(0, [])));
  }

  return {
    /** First thing in the frame callback, with the rAF timestamp. */
    begin(t) {
      frameStart = performance.now();
      if (phase === 'done') return;
      const now = frameStart;
      if (phase === 'measure' && lastT) intervals.push(t - lastT);
      lastT = t;
      if (phase !== 'wait' && now - lastDrive > 1000) { lastDrive = now; drive(); }
      if (phase === 'wait' && (ready() || now - startedAt > READY_TIMEOUT * 1000)) {
        late = !ready();
        phase = 'warm';
        phaseAt = now;
      } else if (phase === 'warm' && now - phaseAt > BENCH_WARMUP * 1000) {
        phase = 'measure';
        phaseAt = now;
      } else if (phase === 'measure' && now - phaseAt > BENCH_SECONDS * 1000) {
        phase = 'done';
        finish();
        return;
      }
      label(now);
    },
    /** Last thing in the frame callback. */
    end() {
      if (phase !== 'measure') return;
      cpu.push(performance.now() - frameStart);
      syncGpu();
      work.push(performance.now() - frameStart);
      if (ended()) over = true;
    },
  };
}
