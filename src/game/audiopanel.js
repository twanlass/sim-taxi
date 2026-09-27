/**
 * The sound designer's panel: every number in `assets/audio/mix.json`, live, behind a 🔊 button.
 *
 * Its own panel and its own flag (`?audio`) rather than a section of the ⚙️ one, because the
 * person using it is not the person using that — a designer tuning a crash does not want to scroll
 * past the sun. The two can be open together (`?debug&audio`); the 🔊 then sits beside the ⚙️.
 *
 * Export is a **file**, not a description: "Download mix.json" writes exactly the shape sfx.js
 * imports, so a finished mix goes back into the game by dropping it over `assets/audio/mix.json`.
 * Import takes the same file (or a pasted one), cleaned by `sfx.tune` like any other change.
 *
 * Every change is stashed in `localStorage` as it lands, for the reason game/locostash.js gives:
 * a crash ends the run and Retry reloads the page, which is exactly when a tuning session gets
 * interrupted. The stash is only ever read here, and this panel is only built under `?audio`, so
 * a half-finished mix can never leak into an ordinary session. Storage failing is "no stash".
 *
 * Levels are shown in dB and rates in semitones, because that is how a designer thinks about
 * them; the file keeps linear gain and a playback rate, because that is what Web Audio takes.
 */
import { SFX_EVENTS, SHIPPED_MIX, IDLE_TAKES, LOCO_TAKES } from './sfx.js';

const STASH_KEY = 'simtaxi.audio.v1';

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function loadStash() {
  try {
    const text = storage()?.getItem(STASH_KEY);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}
function saveStash(mix) {
  try { storage()?.setItem(STASH_KEY, JSON.stringify(mix)); return true; } catch { return false; }
}
function clearStash() {
  try { storage()?.removeItem(STASH_KEY); } catch { /* soft */ }
}

const toDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
const fromDb = (db) => (db <= -60 ? 0 : 10 ** (db / 20));
const toSemis = (rate) => 12 * Math.log2(rate);
const fromSemis = (st) => 2 ** (st / 12);
const dbText = (gain) => (gain > 0 ? `${toDb(gain) >= 0 ? '+' : ''}${toDb(gain).toFixed(1)} dB` : '-∞ dB');
const stText = (rate) => {
  const st = toSemis(rate);
  return `${st >= 0 ? '+' : ''}${st.toFixed(1)} st · ×${rate.toFixed(3)}`;
};

// The beds that one-shot `minGap` does not apply to, and the files that are loops.
const LOOPS = new Set([...IDLE_TAKES, ...LOCO_TAKES, 'signal']);

// The engine knobs: label, range, step and readout. Keys match mix.json's `engine`.
const ENGINE = [
  ['idleRateLo', 'Idle pitch · stopped', 0.25, 2, 0.01, (v) => `×${v.toFixed(2)}`],
  ['idleRateHi', 'Idle pitch · cruise', 0.25, 3, 0.01, (v) => `×${v.toFixed(2)}`],
  ['locoRateLo', 'Loco pitch · cruise', 0.25, 2, 0.01, (v) => `×${v.toFixed(2)}`],
  ['locoRateHi', 'Loco pitch · top', 0.25, 3, 0.01, (v) => `×${v.toFixed(2)}`],
  ['idleUnderLoco', 'Idle under Loco', 0, 1, 0.01, (v) => dbText(v)],
  ['locoLoopAt', 'Loco loop in at', 0, 12, 0.1, (v) => `${v.toFixed(1)}s into hold`],
  ['locoLoopFade', 'Loco loop fade', 0, 8, 0.1, (v) => `${v.toFixed(1)}s`],
  ['pitchGlide', 'Pitch glide', 0.005, 0.5, 0.005, (v) => `${(v * 1000).toFixed(0)} ms τ`],
  ['release', 'Release', 0.005, 1, 0.005, (v) => `${(v * 1000).toFixed(0)} ms τ`],
  ['selfBrakeGain', 'Self-brake level', 0, 1.5, 0.01, (v) => `${dbText(v)} of pedal`],
  ['pullAwayHold', 'Pull-away after', 0, 3, 0.05, (v) => `${v.toFixed(2)}s stopped`],
];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function row(parent, label, input) {
  const name = el('span', { textContent: label });
  const value = el('em');
  parent.append(el('label', { className: 'dbg-row' }, name, input, value));
  return value;
}

const slider = (min, max, step, value) => el('input', { type: 'range', min, max, step, value });

/**
 * @param {object} opts
 * @param {object} opts.sfx  The handle from createSfx — `state`, `tuning`, `tune`, `reset`,
 *   `beds`, `setBed`, `audition`, `stopAuditions`, `play`.
 */
export function createAudioPanel({ sfx }) {
  const stashed = loadStash();
  if (stashed) sfx.tune(stashed);

  const toggle = el('button', { id: 'aud-toggle', type: 'button', textContent: '🔊', title: 'Audio mix' });
  const panel = el('div', { id: 'aud-panel', hidden: true });
  // Beside the ⚙️ when both are up, rather than on top of it.
  if (document.getElementById('dbg-toggle')) document.body.classList.add('aud-beside-dbg');
  document.body.append(toggle, panel);

  // The panel types (the import box) and plays (the ▶ buttons); neither should steer the taxi,
  // pause the game or mute it. The game's key handlers are on `window`, bubbling.
  panel.addEventListener('keydown', (event) => event.stopPropagation());

  const heading = (text) => panel.append(el('h4', { textContent: text }));
  const note = (text) => {
    const p = el('p', { className: 'dbg-note', textContent: text });
    panel.append(p);
    return p;
  };

  // Everything that paints a control from the live mix, so Reset and Import can resync them all.
  const syncs = [];
  const sync = () => { for (const s of syncs) s(); };

  const status = note('');
  const saveNote = el('p', { className: 'dbg-note' });
  function changed() {
    const same = JSON.stringify(sfx.tuning()) === JSON.stringify(SHIPPED_MIX);
    if (same) { clearStash(); saveNote.textContent = 'Shipped mix (mix.json).'; return; }
    saveNote.textContent = saveStash(sfx.tuning())
      ? 'Edited · kept in this browser across reloads.'
      : 'Edited · storage refused, so a reload will lose this.';
  }

  function paintStatus() {
    const s = sfx.state;
    status.textContent = !s.ready
      ? (s.loaded ? `Decoding… ${s.loaded}/${s.total}` : 'Tap or press a key in the game to start the audio.')
      : `${s.loaded}/${s.total} files loaded${s.muted ? ' · MUTED (M)' : ''}${s.held ? ' · paused' : ''}`;
  }

  // --- Master ---------------------------------------------------------------
  heading('Master');
  {
    const input = slider(-30, 12, 0.5, 0);
    const value = row(panel, 'Level', input);
    const paint = () => {
      const g = sfx.tuning().master;
      input.value = String(Math.max(-30, toDb(g)));
      value.textContent = dbText(g);
    };
    input.addEventListener('input', () => { sfx.tune({ master: fromDb(Number(input.value)) }); paint(); });
    input.addEventListener('change', changed);
    syncs.push(paint);
  }

  // --- Beds -----------------------------------------------------------------
  heading('Engine');
  note('Beds run all the time and follow the taxi. Drive to hear these.');
  for (const [kind, takes, label] of [['idle', IDLE_TAKES, 'Idle take'], ['loco', LOCO_TAKES, 'Loco take']]) {
    const select = el('select');
    for (const key of takes) select.append(el('option', { value: key, textContent: `${key} · ${SHIPPED_MIX.sounds[key].file}` }));
    row(panel, label, select);
    select.addEventListener('change', () => sfx.setBed(kind, select.value));
    syncs.push(() => { select.value = sfx.beds()[kind]; });
  }
  for (const [key, label, min, max, step, show] of ENGINE) {
    const input = slider(min, max, step, sfx.tuning().engine[key]);
    const value = row(panel, label, input);
    const paint = () => {
      const v = sfx.tuning().engine[key];
      input.value = String(v);
      value.textContent = show(v);
    };
    input.addEventListener('input', () => { sfx.tune({ engine: { [key]: Number(input.value) } }); paint(); });
    input.addEventListener('change', changed);
    syncs.push(paint);
  }

  // --- Per file -------------------------------------------------------------
  heading('Sounds');
  note('▶ plays the file once at its level and pitch. In the game some one-shots are '
    + 'scaled again where they fire (a bump is a quieter crash, say) — see docs/audio.md.');
  const stopAll = el('button', { type: 'button', className: 'dbg-wide', textContent: '■ Stop previews' });
  stopAll.addEventListener('click', () => sfx.stopAuditions());
  panel.append(stopAll);

  for (const key of Object.keys(SHIPPED_MIX.sounds)) {
    const box = el('div', { className: 'aud-sound' });
    const play = el('button', { type: 'button', className: 'aud-play', textContent: '▶', title: `Play ${key}` });
    const title = el('div', { className: 'aud-name' }, play,
      el('strong', { textContent: key }),
      el('span', { textContent: `${SHIPPED_MIX.sounds[key].file}${LOOPS.has(key) ? ' · loop' : ''}` }));
    box.append(title);
    panel.append(box);
    play.addEventListener('click', () => {
      if (!sfx.audition(key)) paintStatus();
    });

    const gain = slider(-40, 18, 0.5, 0);
    const gainValue = row(box, 'Level', gain);
    const rate = slider(-24, 24, 0.1, 0);
    const rateValue = row(box, 'Pitch', rate);
    let gap = null;
    let gapValue = null;
    if (SFX_EVENTS.has(key)) {
      gap = slider(0, 3, 0.05, 0);
      gapValue = row(box, 'Min gap', gap);
    }
    const paint = () => {
      const t = sfx.tuning();
      const s = t.sounds[key];
      gain.value = String(Math.max(-40, toDb(s.gain)));
      gainValue.textContent = `${dbText(s.gain)} · ×${s.gain.toFixed(3)}`;
      rate.value = String(toSemis(s.rate));
      rateValue.textContent = stText(s.rate);
      if (gap) {
        gap.value = String(t.minGap[key]);
        gapValue.textContent = t.minGap[key] ? `${t.minGap[key].toFixed(2)}s` : 'none';
      }
      box.classList.toggle('is-edited', JSON.stringify(s) !== JSON.stringify(SHIPPED_MIX.sounds[key])
        || (gap && t.minGap[key] !== SHIPPED_MIX.minGap[key]));
    };
    // `-40 dB` is the bottom of the slider and means silence, so a sound can be muted outright.
    gain.addEventListener('input', () => {
      sfx.tune({ sounds: { [key]: { gain: Number(gain.value) <= -40 ? 0 : fromDb(Number(gain.value)) } } });
      paint();
    });
    rate.addEventListener('input', () => { sfx.tune({ sounds: { [key]: { rate: fromSemis(Number(rate.value)) } } }); paint(); });
    gap?.addEventListener('input', () => { sfx.tune({ minGap: { [key]: Number(gap.value) } }); paint(); });
    for (const input of [gain, rate, gap]) input?.addEventListener('change', changed);
    // A double-click on a slider puts that one knob back.
    gain.addEventListener('dblclick', () => { sfx.tune({ sounds: { [key]: { gain: SHIPPED_MIX.sounds[key].gain } } }); paint(); changed(); });
    rate.addEventListener('dblclick', () => { sfx.tune({ sounds: { [key]: { rate: SHIPPED_MIX.sounds[key].rate } } }); paint(); changed(); });
    gap?.addEventListener('dblclick', () => { sfx.tune({ minGap: { [key]: SHIPPED_MIX.minGap[key] } }); paint(); changed(); });
    syncs.push(paint);
  }

  // --- Export ---------------------------------------------------------------
  heading('Export');
  panel.append(saveNote);

  const json = () => `${JSON.stringify(sfx.tuning(), null, 2)}\n`;
  const output = el('textarea', { className: 'dbg-out', rows: 10, spellcheck: false,
    placeholder: 'Paste a mix.json here and press Apply' });

  const download = el('button', { type: 'button', textContent: 'Download mix.json' });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    const a = el('a', { href: url, download: 'mix.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const copy = el('button', { type: 'button', textContent: 'Copy JSON' });
  copy.addEventListener('click', async () => {
    output.value = json();
    try {
      await navigator.clipboard.writeText(output.value);
      copy.textContent = 'Copied ✓';
    } catch {
      output.select();
      copy.textContent = 'Select below';
    }
    setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1800);
  });
  panel.append(el('div', { className: 'dbg-actions' }, download, copy));

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  const open = el('button', { type: 'button', textContent: 'Open file…' });
  open.addEventListener('click', () => file.click());
  const importNote = el('p', { className: 'dbg-note' });
  function applyText(text) {
    try {
      sfx.reset();
      sfx.tune(JSON.parse(text));
      sync();
      changed();
      importNote.textContent = 'Applied. Anything unknown in it was ignored.';
    } catch (err) {
      importNote.textContent = `Not valid JSON: ${err.message}`;
    }
  }
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) applyText(await f.text());
    file.value = '';
  });
  const apply = el('button', { type: 'button', textContent: 'Apply pasted' });
  apply.addEventListener('click', () => applyText(output.value));
  panel.append(output, el('div', { className: 'dbg-actions' }, open, apply), file, importNote);

  const reset = el('button', { type: 'button', className: 'dbg-wide', textContent: 'Reset to shipped mix' });
  reset.addEventListener('click', () => { sfx.reset(); sync(); changed(); });
  panel.append(reset);
  note('To ship a mix: drop the downloaded file over assets/audio/mix.json.');

  // The status line is the one readout that moves on its own (files decoding after the first tap,
  // mute, pause), so it polls while the panel is open rather than asking sfx for events.
  let timer = 0;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    clearInterval(timer);
    if (!panel.hidden) {
      sync();
      paintStatus();
      timer = setInterval(paintStatus, 500);
    }
  });

  sync();
  changed();
  paintStatus();
  return { panel, toggle };
}
