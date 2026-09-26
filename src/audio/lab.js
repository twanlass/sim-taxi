/**
 * The sound lab at `/audio/` — a workbench, not part of the game.
 *
 * Nothing in the game links here and the game does not import a line of this file, which is the same
 * arrangement `/lab/` has and for the same reasons (docs/lab.md). It exists so the artist can hear a
 * cue without playing a run to reach it: half these events take a good run to trigger and two of them
 * require crashing.
 *
 * **What it is for, in the order the work happens.** The board lists every event in the manifest —
 * including, right now, all eight with no sample at all, which is the state it is designed to make
 * legible rather than hide. A file dropped onto a card plays from a `blob:` URL immediately: no build,
 * no commit, nothing written to the repo, so a take can be tried and thrown away. When the levels are
 * right, "Copy mix as JSON" is the hand-off — the numbers go back into `src/audio/mix.js` as a diff.
 *
 * **What it deliberately cannot do is tune the game's mix in context.** A cue heard alone is not a cue
 * heard over twelve cars, a siren and a drawbridge, and the one sound that will decide whether this
 * game feels right — the engine loop — only sounds wrong at speeds you have to earn. That is the
 * debug panel's job (`?debug`), and the reason docs/audio.md argues for both tools rather than one.
 */

import { EVENTS, EVENT_NAMES, assertEvent } from './events.js';
import { shippedMix } from './mix.js';
import { createAudio } from './index.js';
import { CLIP_URLS, CLIP_COUNT } from './clips.js';

const $ = (id) => document.getElementById(id);

// Dropped files live only here, keyed by the basename the manifest would use. Merged over `CLIP_URLS`
// so an audition shadows a committed clip of the same name rather than fighting it — which is exactly
// what trying a replacement take means.
const dropped = new Map();

let mix = shippedMix();
let audio = null;

/** Rebuild the player against the current clip map. Cheap: construction is inert until unlocked. */
function rebuild() {
  const clips = { ...CLIP_URLS, ...Object.fromEntries(dropped) };
  const wasReady = audio?.state.ready ?? false;
  audio = createAudio({ clips, mix });
  // A rebuild after the gate has already been passed must not send the page back to asleep: the
  // gesture happened, and asking for it twice because a file was dropped would read as a bug.
  if (wasReady) audio.unlock();
  return audio;
}

/**
 * Which basenames an event can currently reach.
 *
 * Reads the manifest rather than the player so an empty slot is still describable — the player only
 * knows about clips that resolved, and "nothing resolved" is the case the board has to explain.
 */
function clipsFor(name) {
  const all = { ...CLIP_URLS, ...Object.fromEntries(dropped) };
  return EVENTS[name].clips.filter((base) => all[base]);
}

/** Basenames dropped onto an event that the manifest does not name — an audition, not a commitment. */
const auditionKey = (name) => `__audition__${name}`;

function slider(min, max, step, value) {
  const el = document.createElement('input');
  Object.assign(el, { type: 'range', min, max, step, value });
  return el;
}

function knob(parent, label, min, max, step, value, onInput) {
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  const input = slider(min, max, step, value);
  const out = document.createElement('em');
  out.textContent = Number(value).toFixed(2);
  input.addEventListener('input', () => {
    out.textContent = Number(input.value).toFixed(2);
    onInput(Number(input.value));
  });
  wrap.append(name, input, out);
  parent.append(wrap);
  return input;
}

/** One card per event. The cards *are* the taxonomy, so an empty one still gets drawn. */
function buildBoard() {
  const board = $('board');
  board.textContent = '';

  for (const name of EVENT_NAMES) {
    const spec = assertEvent(name);
    const card = document.createElement('div');
    card.className = 'cue';

    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'name';
    title.textContent = name;
    const bus = document.createElement('span');
    bus.className = 'bus';
    bus.textContent = spec.bus;
    head.append(title, bus);

    const status = document.createElement('div');
    status.className = 'status';

    const fire = document.createElement('button');
    fire.className = 'fire';
    fire.type = 'button';
    fire.textContent = `▶  ${name}`;

    const rr = document.createElement('div');
    rr.className = 'rr';

    const refresh = () => {
      const audition = dropped.has(auditionKey(name));
      const have = clipsFor(name).length + (audition ? 1 : 0);
      status.className = `status ${have ? 'live' : 'empty'}`;
      status.textContent = have
        ? `${have} clip${have === 1 ? '' : 's'}${audition ? ' (1 dropped)' : ''}`
        : 'no clip — drop a file here';
    };
    refresh();
    card.refresh = refresh;

    // Round-robin proof. "It sounds repetitive" is otherwise a feeling rather than a fact, and with
    // two or three variants a random pick audibly repeats — which is why the player rotates instead.
    let fired = 0;
    fire.addEventListener('click', () => {
      const played = audio.play(name);
      fired += 1;
      const list = clipsFor(name);
      const audition = dropped.get(auditionKey(name));
      const pool = audition ? [...list, `(dropped)`] : list;
      rr.textContent = played
        ? `fired ${fired} · clip ${pool.length ? pool[(fired - 1) % pool.length] : '?'}`
        : `fired ${fired} · nothing sounded${pool.length ? ' (cooldown or voice cap)' : ' (no clip)'}`;
      // Pressed look as a class rather than `:active`, the rule this project arrived at the hard way
      // on the pedal row: `:active` names the element the press *started* on, so a press that moves
      // lights the wrong control. Harmless here, consistent everywhere.
      fire.classList.add('is-held');
      setTimeout(() => fire.classList.remove('is-held'), 90);
    });

    const knobs = document.createElement('div');
    knobs.className = 'knobs';
    knob(knobs, 'gain', 0, 2, 0.01, spec.gain, (v) => { spec.gain = v; });
    knob(knobs, 'pitch ±', 0, 0.3, 0.005, spec.pitch, (v) => { spec.pitch = v; });
    knob(knobs, 'cooldown', 0, 1, 0.01, spec.cooldown, (v) => { spec.cooldown = v; });

    // Drag and drop. The feature that turns this page from a demo into a workbench: a take can be
    // heard in the game's own mix without a build step and without anything entering the repo.
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    card.addEventListener('dragover', (e) => { stop(e); card.classList.add('drop'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      stop(e);
      card.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const key = auditionKey(name);
      const previous = dropped.get(key);
      // Revoked rather than left to the GC: a long session of A/B-ing two takes would otherwise pin
      // every version of both in memory.
      if (previous) URL.revokeObjectURL(previous);
      dropped.set(key, URL.createObjectURL(file));
      // The manifest is not edited — the audition is injected under its own key and named on the
      // event for the life of the page, so `clips` in `events.js` stays the committed truth.
      if (!EVENTS[name].clips.includes(key)) EVENTS[name].clips.push(key);
      rebuild();
      refresh();
      rr.textContent = `dropped ${file.name} (${(file.size / 1024).toFixed(0)}kB) — not saved`;
    });

    card.append(head, status, fire, rr, knobs);
    board.append(card);
  }
}

/** Master and the four buses, plus a live readout of what is actually sounding. */
function buildMix() {
  const host = $('mix');
  host.textContent = '';

  const master = document.createElement('label');
  master.append(Object.assign(document.createElement('span'), { textContent: 'master' }));
  const mi = slider(0, 1, 0.01, mix.master);
  const mo = document.createElement('em');
  mo.textContent = mix.master.toFixed(2);
  mi.addEventListener('input', () => {
    mix.master = Number(mi.value);
    mo.textContent = mix.master.toFixed(2);
    audio.setMix(mix);
  });
  master.append(mi, mo, Object.assign(document.createElement('span'), { className: 'cap', textContent: '' }));
  host.append(master);

  for (const [name, spec] of Object.entries(mix.buses)) {
    const row = document.createElement('label');
    row.append(Object.assign(document.createElement('span'), { textContent: name }));
    const input = slider(0, 1.5, 0.01, spec.gain);
    const out = document.createElement('em');
    out.textContent = spec.gain.toFixed(2);
    input.addEventListener('input', () => {
      spec.gain = Number(input.value);
      out.textContent = spec.gain.toFixed(2);
      audio.setMix(mix);
    });
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = `${spec.voices} voices`;
    row.append(input, out, cap);
    host.append(row);
  }
}

/** The readout, ticked rather than pushed — the voice counts change on `onended`, off any input. */
function tickReadout() {
  const out = $('out');
  const ctx = audio.context();
  const v = audio.state.voices;
  const chips = [
    `context ${ctx ? ctx.state : 'none'}`,
    `ready ${audio.state.ready}`,
    `clips in repo ${CLIP_COUNT}`,
    `dropped ${dropped.size}`,
    `voices ${Object.values(v.bus).reduce((a, b) => a + b, 0)}`,
    ...Object.entries(v.bus).map(([b, n]) => `${b} ${n}`),
  ];
  if (audio.state.error) chips.push(`error: ${audio.state.error}`);
  out.textContent = '';
  for (const text of chips) out.append(Object.assign(document.createElement('span'), { textContent: text }));
  requestAnimationFrame(tickReadout);
}

function eventOverrides() {
  return Object.fromEntries(EVENT_NAMES.map((n) => {
    const { gain, pitch, cooldown, voices } = EVENTS[n];
    return [n, { gain: Number(gain.toFixed(3)), pitch: Number(pitch.toFixed(3)), cooldown, voices }];
  }));
}

function wireActions() {
  const dump = () => JSON.stringify({ mix, events: eventOverrides() }, null, 2);
  $('json').value = dump();

  $('copy').addEventListener('click', async () => {
    const text = dump();
    $('json').value = text;
    try {
      await navigator.clipboard.writeText(text);
      $('copy').textContent = 'Copied ✓';
    } catch {
      // Clipboard is permissioned and fails on plenty of setups. The textarea already holds the
      // text, so selecting it is a complete fallback rather than a degraded one.
      $('json').select();
      $('copy').textContent = 'Select-and-copy ↓';
    }
    setTimeout(() => { $('copy').textContent = 'Copy mix as JSON'; }, 1400);
  });

  $('apply').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('json').value);
      if (parsed.mix) { mix = parsed.mix; audio.setMix(mix); buildMix(); }
      for (const [name, over] of Object.entries(parsed.events ?? {})) {
        // Unknown names are reported rather than ignored: a pasted blob from a future manifest is
        // the one case where silence would be actively misleading.
        assertEvent(name);
        Object.assign(EVENTS[name], over);
      }
      buildBoard();
      $('apply').textContent = 'Applied ✓';
    } catch (err) {
      $('apply').textContent = `✗ ${err.message}`.slice(0, 40);
    }
    setTimeout(() => { $('apply').textContent = 'Apply pasted JSON'; }, 1800);
  });

  $('reset').addEventListener('click', () => {
    mix = shippedMix();
    // The per-event numbers are module state that the sliders mutated in place, so a reload is the
    // honest way back to the shipped values rather than keeping a shadow copy in sync.
    location.reload();
  });
}

function boot() {
  rebuild();
  buildBoard();
  buildMix();
  wireActions();

  $('intro').innerHTML = CLIP_COUNT === 0
    ? 'No clips are committed yet, so every cue below is an <strong>empty slot</strong> and the game is '
      + 'silent. <strong>Drag an audio file onto a card</strong> to hear it in the game’s own mix — '
      + 'it plays from memory, is never written to the repo, and is gone on reload. To commit one, put '
      + 'it in <code>src/audio/clips/</code> and name it in <code>src/audio/events.js</code>.'
    : `${CLIP_COUNT} clip${CLIP_COUNT === 1 ? '' : 's'} committed in <code>src/audio/clips/</code>. `
      + 'Drag a file onto a card to audition a replacement without committing it.';

  const gate = $('gate');
  const wake = async () => {
    await audio.unlock();
    if (audio.state.ready) gate.hidden = true;
  };
  $('gate-go').addEventListener('click', wake);
  // Any press anywhere counts as the gesture, so the gate is a hint rather than a toll booth.
  window.addEventListener('pointerdown', wake, { capture: true, once: false });
  gate.hidden = false;

  tickReadout();

  /**
   * The lab's own test hook, for the same reason the game has `window.__taxi`: a sound is the one
   * thing on this page that **cannot be observed** from the outside. A headless check can see that
   * eight cards rendered, but "did a voice actually start?" has no answer from the DOM — and reading
   * it by listening is not something CI can do.
   *
   * `player()` rather than the object, because a dropped file rebuilds it.
   */
  window.__audiolab = {
    player: () => audio,
    events: EVENT_NAMES,
    clipsFor,
    mix: () => mix,
    droppedCount: () => dropped.size,
  };
}

boot();
