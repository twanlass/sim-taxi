/**
 * The heat test — `?soak` (20 minutes) or `?soak=N`.
 *
 * `?bench` measures each setting for fifteen seconds, which is the right length for asking what a
 * frame costs and the wrong one for asking what a phone does after a while. Its own second baseline
 * showed the difference: 59.4 fps at the start, 52 fps with 16.6% of frames late four minutes later,
 * on an unchanged scene. That is heat, and heat is about the *whole session*, so this runs one
 * setting for a long time and reports it a minute at a time.
 *
 * Whatever flags are on the URL are what it measures, so comparing two budgets is two runs from a
 * cool phone: `?soak` and, say, `?soak&dpr=1.5`. The resolution governor (game/governor.js) is on
 * unless `&governor=off` says otherwise, because what a player gets is with it on — and the canvas
 * size on each row is how far it had to step down.
 *
 * Safari has no battery API, so the start card asks for the battery level to be noted by hand at
 * each end. The same pinned city, situation and self-driving taxi as `?bench` (BENCH_BASE).
 *
 * A wreck ends the run, and twenty minutes is long enough for one to happen, so the soak carries
 * its rows in the URL and reloads into a fresh run when one ends, the way `?bench` moves between
 * steps. The elapsed time carries over; the reload itself is a few seconds the table does not count.
 */
import { BENCH_BASE, summarize, formatResults } from './bench.js';

const MINUTE = 60;

/** `{ minutes, running, rows, elapsed }`, or null without `?soak`. */
export function readSoak(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  if (!params.has('soak')) return null;
  const minutes = Number.parseFloat(params.get('soak'));
  let rows = [];
  try { rows = JSON.parse(params.get('sr') ?? '[]'); } catch { rows = []; }
  return {
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 20,
    running: params.has('st'),
    elapsed: Number.parseFloat(params.get('st')) || 0,
    rows: Array.isArray(rows) ? rows : [],
  };
}

/**
 * The URL of a soak in progress. The page's own flags win over BENCH_BASE — they are the setting
 * being measured — except that the governor is left at its default rather than BENCH_BASE's `off`.
 */
export function soakSearch(search, elapsed, rows) {
  const own = new URLSearchParams(search);
  const params = new URLSearchParams({ ...BENCH_BASE });
  params.delete('governor');
  for (const [k, v] of own) params.set(k, v);
  params.set('st', String(Math.round(elapsed)));
  params.set('sr', JSON.stringify(rows));
  return `?${params.toString()}`;
}

/** The lines under the table: how the run held up, start against end. */
export function soakVerdict(rows) {
  if (!rows.length) return '';
  const mean = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
  const head = rows.slice(0, 2);
  const tail = rows.slice(-5);
  const slipped = rows.find((r) => r.jank >= 5);
  return `first 2 min: ${mean(head, 'fps').toFixed(1)} fps, ${mean(head, 'jank').toFixed(1)}% late`
    + ` · last ${tail.length} min: ${mean(tail, 'fps').toFixed(1)} fps, ${mean(tail, 'jank').toFixed(1)}% late`
    + `\nfirst minute over 5% late: ${slipped ? slipped.k : 'never'}`
    + ` · canvas at the end: ${rows.at(-1).buf ?? '?'}`;
}

/** Same shape and same hooks as `createBench`. Null without `?soak`. */
export function createSoak({ renderer, ready, drive, ended, gpu = '?' }) {
  const state = readSoak();
  if (!state || typeof document === 'undefined') return null;

  const el = document.createElement('div');
  el.id = 'bench';
  document.body.append(el);
  for (const type of ['pointerdown', 'pointerup', 'click', 'touchstart']) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
  const button = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  const go = (elapsed, rows) => window.location.replace(
    `${window.location.pathname}${soakSearch(window.location.search, elapsed, rows)}`);
  let awake = false;
  const keepAwake = () => navigator.wakeLock?.request('screen')
    .then(() => { awake = true; }).catch(() => {});

  if (!state.running) {
    el.innerHTML = `<b>Heat test</b><p>${state.minutes} minutes on one setting, reported a minute at a`
      + ' time. Start from a cool phone, unplugged, and note the battery level now and at the end.'
      + " The taxi drives itself; don't touch the city. Keep the screen on (Auto-Lock: Never).</p>";
    el.append(button('Start', () => { keepAwake(); go(0, []); }));
    return { begin() {}, end() {} };
  }

  keepAwake();
  const rows = [...state.rows];
  let elapsed = state.elapsed;
  let intervals = [];
  let cpu = [];
  let phase = 'wait';
  let bucketAt = 0;
  let lastT = 0;
  let lastNow = 0;
  let frameStart = 0;
  let lastDrive = 0;
  let lastLabel = 0;
  const startedAt = performance.now();
  const stamp = (s) => `${Math.floor(s / MINUTE)}:${String(Math.floor(s % MINUTE)).padStart(2, '0')}`;

  function closeBucket() {
    rows.push(summarize(`min ${rows.length + 1}`, intervals, cpu,
      { buf: `${renderer.domElement.width}x${renderer.domElement.height}` }));
    intervals = [];
    cpu = [];
  }

  function finish() {
    phase = 'done';
    const header = `Rocket Rides heat test · ${state.minutes} min · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
      + ` · ${gpu} · ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`
      + `\n${new URLSearchParams(window.location.search).toString().replace(/&?(st|sr)=[^&]*/g, '')}`
      + '\nms per frame; jank = frames over 25 ms; cpu = time inside the frame callback';
    const text = `${formatResults(rows, header)}\n${soakVerdict(rows)}`;
    el.classList.add('is-done');
    el.textContent = '';
    const pre = document.createElement('pre');
    pre.textContent = text;
    el.append(pre);
    el.append(button('Copy results', () => {
      navigator.clipboard?.writeText(text).catch(() => {});
    }));
  }

  return {
    begin(t) {
      frameStart = performance.now();
      if (phase === 'done') return;
      const now = frameStart;
      if (phase === 'wait') {
        if (ready() || now - startedAt > 30000) { phase = 'run'; bucketAt = now; lastNow = now; }
        el.textContent = 'Heat test · loading';
        return;
      }
      if (lastT) intervals.push(t - lastT);
      lastT = t;
      elapsed += (now - lastNow) / 1000;
      lastNow = now;
      if (now - lastDrive > 1000) { lastDrive = now; drive(); }
      if (now - bucketAt >= MINUTE * 1000) { bucketAt = now; closeBucket(); }
      if (elapsed >= state.minutes * MINUTE) { finish(); return; }
      if (now - lastLabel > 500) {
        lastLabel = now;
        const row = rows.at(-1);
        el.textContent = `Heat test · ${stamp(elapsed)} of ${state.minutes}:00`
          + (row ? ` · last minute ${row.fps} fps, ${row.jank}% late` : '')
          + (awake ? '' : '\nTap here now and then to keep the screen on');
      }
    },
    end() {
      if (phase !== 'run') return;
      cpu.push(performance.now() - frameStart);
      // A wreck ends the run; carry on in a fresh one. The partial minute is dropped rather than
      // counted short — a crash cam is not the frame this is measuring.
      if (ended()) { phase = 'done'; go(elapsed, rows); }
    },
  };
}
