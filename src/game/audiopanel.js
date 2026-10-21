/**
 * The sound designer's controls: every number in `assets/audio/mix.json`, live, as the Audio
 * sections of the ⚙️ panel (game/debugpanel.js).
 *
 * This used to be its own panel behind a 🔊 button and its own `?audio` flag, on the grounds that a
 * designer tuning a crash does not want to scroll past the sun. Collapsed sections and the panel's
 * search answer that better than a second panel did, so it is one panel now; `?audio` still works
 * and opens the same ⚙️ panel.
 *
 * Export is a **file**, not a description: "Download mix.json" writes exactly the shape sfx.js
 * imports, so a finished mix goes back into the game by dropping it over `assets/audio/mix.json`.
 * Import takes the same file (or a pasted one), cleaned by `sfx.tune` like any other change.
 *
 * Every change is stashed in `localStorage` as it lands, for the reason game/locostash.js gives:
 * a crash ends the run and Retry reloads the page, which is exactly when a tuning session gets
 * interrupted. The stash is only ever read here, and these sections are only built with the ⚙️
 * panel (`?debug`, `?settings` or `?audio`), so a half-finished mix can never leak into an ordinary
 * session. Storage failing is "no stash".
 *
 * Levels are shown in dB and rates in semitones, because that is how a designer thinks about
 * them; the file keeps linear gain and a playback rate, because that is what Web Audio takes.
 */
import { SFX_EVENTS, SHIPPED_MIX, SOUNDS, LOOPS, PICKED, PLACED, RADIO, GROUPS, BUSES, MIX_PARENT } from './sfx.js';

// What each ⚡ does, for its tooltip. The keys are main.js's `soundTriggers`.
const TRIGGER_TIPS = {
  spawn: 'Replay the city\'s entrance, which plays the spawn sound with it.',
  plane: 'Send the plane across now. Heard as it passes, so watch where it flies.',
  heli: 'Bring the rooftop helicopter in now. Heard from its pad: drive near it.',
  birdsUp: 'Scatter the flock nearest the taxi. The landing sound follows when it settles.',
  birdsDown: 'Scatter the flock nearest the taxi; this plays when it settles again.',
  bridge: 'Raise the drawbridge now. Its cycle is about 26s.',
  angry: 'A rider on the same kerb corner every time storms off swearing, bubble and all. The camera goes to look.',
};

// v2 with Block 1: a v1 stash holds levels trimmed for the test files, keyed partly by takes that
// no longer exist, and would quietly override the designer's 0 dB starting point.
const STASH_KEY = 'simtaxi.audio.v2';

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

// Every fader's bottom stop is silence, not a quiet level: Nicolás could still hear the music with
// its old -30 dB floor. FLOOR is that stop, and anything at or under it is a gain of 0 (-∞).
const FLOOR = -60;
const toDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
const fromDb = (db) => (db <= FLOOR ? 0 : 10 ** (db / 20));
const faderAt = (gain) => String(Math.max(FLOOR, toDb(gain)));
const toSemis = (rate) => 12 * Math.log2(rate);
const fromSemis = (st) => 2 ** (st / 12);
const dbText = (gain) => (gain > 0 ? `${toDb(gain) >= 0 ? '+' : ''}${toDb(gain).toFixed(1)} dB` : '-∞ dB');
const stText = (rate) => {
  const st = toSemis(rate);
  return `${st >= 0 ? '+' : ''}${st.toFixed(1)} st · ×${rate.toFixed(3)}`;
};

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
  ['pullAwayHold', 'Pull-away after', 0, 3, 0.05, (v) => `${v.toFixed(2)}s stopped`],
];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/**
 * Hover text for every row, by its label: one line on what the knob does, for whoever opens the
 * panel without having read docs/audio.md. Short on purpose — a tooltip is read mid-drag.
 */
const TIPS = {
  'Master': 'Everything: music and effects together. The meter reads after it.',
  'Music': 'Volume of the radio. Under the player\'s own Music slider.',
  'SFX': 'Volume of every sound effect, Player and World. Under the player\'s own SFX slider.',
  'Player': 'The taxi: Engine & Loco, Taxi and Impacts.',
  'World': 'The city: City events, Ambience, People and Police.',
  'Idle pitch · stopped': 'Engine idle pitch when the taxi is standing still.',
  'Idle pitch · cruise': 'Engine idle pitch at normal top speed. It glides between the two.',
  'Loco pitch · cruise': 'Loco engine pitch at normal top speed.',
  'Loco pitch · top': 'Loco engine pitch at Loco top speed.',
  'Idle under Loco': 'How far the idle drops while the Loco engine plays.',
  'Loco loop in at': 'Seconds into a Loco hold before the Loco engine loop fades in.',
  'Loco loop fade': 'How long the Loco engine loop takes to fade in.',
  'Pitch glide': 'How quickly engine pitch follows speed. Lower is snappier.',
  'Release': 'How quickly a sound fades when it is cut off.',
  'Pull-away after': 'How long the taxi must stand still before pulling away plays the rev.',
  'Level': 'Volume of this sound, every take. Double-click the slider to go back to the shipped value.',
  'Pitch': 'Playback speed in semitones; changes length too. Double-click the slider to go back to the shipped value.',
  'Min gap': 'Shortest time before this sound can play again. Stops rapid repeats.',
  'Stereo': 'Play the stereo file instead of the mono one. Greyed out: only one of the two was delivered.',
  'Plays': 'Which of the delivered versions plays in game.',
  'Full within': 'Full volume within this distance of the 👂 (world units; a block is 20).',
  'Silent past': 'Silent beyond this distance of the 👂. Fades between the two.',
};

function row(parent, label, input, tip = TIPS[label]) {
  const name = el('span', { textContent: label });
  const value = el('em');
  parent.append(el('label', { className: 'dbg-row', title: tip ?? '' }, name, input, value));
  return value;
}

const slider = (min, max, step, value) => el('input', { type: 'range', min, max, step, value });

/**
 * Appends the audio sections to the ⚙️ panel, flat — a heading and what follows it, which the
 * panel folds into sections afterwards.
 *
 * @param {HTMLElement} host  The ⚙️ panel.
 * @param {object} sfx  The handle from createSfx — `state`, `tuning`, `tune`, `reset`,
 *   `audition`, `stopAuditions`, `play`, `monitor`, `setMonitor`.
 * @param {object} [opts]
 * @param {Object<string, () => (string|null)>} [opts.triggers]  By sound: make the thing that
 *   plays it happen in the game (the ⚡ buttons). Answers null, or why it could not.
 * @param {Object<string, {held: () => boolean, set: (on: boolean) => (string|null)}>} [opts.holds]
 *   By sound: freeze the moving thing that plays it, sound looping (the ⏸ buttons).
 * @param {(key: string) => ({d: number, pan: number}|null)} [opts.placeOf]  Where a placed sound
 *   is heard from right now (its pin, measured from the 👂), or null — what ▶ plays it from,
 *   asked again every frame while it plays.
 * @returns {{ open: () => void, close: () => void }}  Called as the ⚙️ panel opens and closes.
 */
export function buildAudioSections(host, sfx, { triggers = {}, holds = {}, placeOf = () => null } = {}) {
  const stashed = loadStash();
  if (stashed) sfx.tune(stashed);

  // These controls type (the import box) and play (the ▶ buttons); neither should steer the taxi,
  // pause the game or mute it. The game's key handlers are on `window`, bubbling. Guarded per
  // element rather than on the whole ⚙️ panel, whose `I` key relies on reaching `window`.
  const panel = {
    append(...nodes) {
      for (const node of nodes) node.addEventListener?.('keydown', (event) => event.stopPropagation());
      host.append(...nodes);
    },
  };

  const heading = (text) => host.append(el('h4', { textContent: text }));
  const note = (text) => {
    const p = el('p', { className: 'dbg-note', textContent: text });
    panel.append(p);
    return p;
  };

  // The sound last touched — pressed, played or dragged — whose falloff the ground rings show
  // (game/soundrings.js, via `focused()` below). One at a time: a dozen overlapping circles answer
  // no question, and the one being edited is the one the designer is asking about.
  let focusedKey = null;
  let focusedBox = null;
  const boxes = new Map();
  function focus(key, box) {
    if (focusedBox === box) return;
    focusedBox?.classList.remove('is-focused');
    focusedKey = key;
    focusedBox = box;
    box.classList.add('is-focused');
  }
  // The selection holds until another sound is picked or Escape lets it go (Tyler, October 2026:
  // so the map can be dragged around with the rings still on it — a press on the map used to clear
  // them, which made panning to the 👂's edge of a ring impossible). Escape here is spent: it does
  // not also pause the game (game/pause.js listens on `window` too), hence capture and
  // stopImmediatePropagation. With nothing selected, Escape is the pause key as ever.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !focusedBox || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusedBox.classList.remove('is-focused');
    focusedKey = null;
    focusedBox = null;
  }, { capture: true });

  // Everything that paints a control from the live mix, so Reset and Import can resync them all.
  const syncs = [];
  const sync = () => { for (const s of syncs) s(); };
  // Every M/S pair's paint — one solo changes how everything else looks, so all repaint together.
  const monitors = [];
  const repaintMonitors = () => { for (const p of monitors) p(); };
  const holdPaints = [];
  // Heard while listening: this node and everything above it passes the mutes and solos.
  const heard = (key) => {
    for (let k = key; k != null; k = MIX_PARENT[k]) if (!sfx.audible(k)) return false;
    return true;
  };
  /**
   * An M and an S for any node of the mix tree — bus, group, sound or track — appended to `into`.
   * `box` is dimmed while the node cannot be heard: muted, under a mute, or left out of a solo.
   */
  function monitorButtons(key, into, box) {
    const mute = el('button', { type: 'button', className: 'aud-ms', textContent: 'M',
      title: 'Mute while listening. Not saved in the mix.' });
    const solo = el('button', { type: 'button', className: 'aud-ms aud-solo', textContent: 'S',
      title: 'Solo: hear only this (and what is under it), in place of whatever was soloed before. '
        + 'Shift-click to add it to the solos instead. Not saved in the mix.' });
    into.append(mute, solo);
    monitors.push(() => {
      const m = sfx.monitor();
      mute.classList.toggle('is-on', m.mute.includes(key));
      solo.classList.toggle('is-on', m.solo.includes(key));
      box.classList.toggle('is-silenced', !heard(key));
    });
    mute.addEventListener('click', () => {
      sfx.setMonitor(key, { mute: !sfx.monitor().mute.includes(key) });
      repaintMonitors();
    });
    // Exclusive by default (Tyler, October 2026): pressing S on something is "let me hear this",
    // so the solo it replaces goes. Shift keeps the DAW's additive solo for comparing two things.
    solo.addEventListener('click', (event) => {
      const on = sfx.monitor().solo.includes(key);
      if (!on && !event.shiftKey) for (const k of sfx.monitor().solo) sfx.setMonitor(k, { solo: false });
      sfx.setMonitor(key, { solo: !on });
      repaintMonitors();
    });
  }

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

  // The peak meter on Master, in dBFS: a bar per channel that falls back at METER_FALL, a tick at
  // the highest peak of the last METER_HOLD seconds, and a readout of the highest peak since it was
  // last clicked. Sample peak, not true peak or loudness — those can wait for the full mix. Read
  // from `sfx.meter()` once a frame while the panel is open, and not at all otherwise.
  const METER_FLOOR = -60;
  const METER_HOLD = 1.5;
  const METER_FALL = 24;   // dB a second
  const meter = { start() {}, stop() {} };
  function buildMeter() {
    const wrap = el('div', { className: 'aud-meter', title: 'Sample peak on Master, dBFS. Click to reset the held peak.' });
    const frac = (db) => Math.max(0, Math.min(1, (db - METER_FLOOR) / -METER_FLOOR));
    const pct = (db) => `${frac(db) * 100}%`;
    const sides = ['L', 'R'].map((label) => {
      const fill = el('div', { className: 'aud-meter-fill' });
      const tick = el('div', { className: 'aud-meter-tick' });
      const bar = el('div', { className: 'aud-meter-bar' }, fill, tick);
      wrap.append(el('div', { className: 'aud-meter-row' }, el('span', { textContent: label }), bar));
      return { fill, tick, level: -Infinity, hold: -Infinity, holdAt: 0 };
    });
    const scale = el('div', { className: 'aud-meter-scale' });
    for (const db of [-48, -36, -24, -12, -6, 0]) {
      const mark = el('span', { textContent: String(db) });
      mark.style.left = pct(db);
      scale.append(mark);
    }
    const readout = el('div', { className: 'aud-meter-read' });
    wrap.append(scale, readout);
    let max = -Infinity;
    let frame = 0;
    let last = 0;
    const fmt = (db) => (db === -Infinity ? '-∞' : db.toFixed(1));
    function draw(now) {
      frame = requestAnimationFrame(draw);
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const peaks = sfx.meter();
      sides.forEach((side, i) => {
        const db = peaks ? toDb(peaks[i] ?? peaks[0]) : -Infinity;
        side.level = Math.max(db, side.level - METER_FALL * dt);
        if (db >= side.hold) { side.hold = db; side.holdAt = now; }
        else if (now - side.holdAt > METER_HOLD * 1000) side.hold = Math.max(db, side.hold - METER_FALL * dt);
        if (db > max) max = db;
        side.fill.style.clipPath = `inset(0 ${(1 - frac(side.level)) * 100}% 0 0)`;
        side.tick.style.left = pct(side.hold);
        side.tick.hidden = side.hold <= METER_FLOOR;
      });
      const level = Math.max(sides[0].level, sides[1].level);
      readout.textContent = peaks
        ? `${fmt(level)} dBFS · peak ${fmt(max)} dBFS${max >= -0.1 ? ' · CLIP' : ''}`
        : 'Tap the game to start the audio.';
      wrap.classList.toggle('is-clipped', max >= -0.1);
    }
    wrap.addEventListener('click', () => { max = -Infinity; for (const s of sides) s.hold = -Infinity; });
    meter.start = () => { cancelAnimationFrame(frame); last = 0; frame = requestAnimationFrame(draw); };
    meter.stop = () => { cancelAnimationFrame(frame); frame = 0; };
    return wrap;
  }

  // --- Mixer ----------------------------------------------------------------
  // The buses (BUSES in sfx.js): Master over Music and SFX, SFX over Player and World. Each a fader
  // that ships in mix.json, down to -∞, and an M and an S for listening.
  heading('Audio');
  const busFader = {
    master: [(t) => t.buses.master.gain, (g) => ({ buses: { master: { gain: g } } })],
    music: [(t) => t.music.master, (g) => ({ music: { master: g } })],
    sfx: [(t) => t.master, (g) => ({ master: g })],
    player: [(t) => t.buses.player.gain, (g) => ({ buses: { player: { gain: g } } })],
    world: [(t) => t.buses.world.gain, (g) => ({ buses: { world: { gain: g } } })],
  };
  const depth = (key) => { let n = 0; for (let k = MIX_PARENT[key]; k != null; k = MIX_PARENT[k]) n++; return n; };
  for (const bus of BUSES) {
    const [read, write] = busFader[bus.key];
    const strip = el('div', { className: 'aud-group aud-bus' });
    strip.style.marginLeft = `${depth(bus.key) * 10}px`;
    strip.dataset.search = `${bus.label} bus mixer`;
    const name = el('div', { className: 'aud-group-name' },
      el('strong', { className: 'aud-bus-name', textContent: bus.label }));
    monitorButtons(bus.key, name, strip);
    strip.append(name);
    const input = slider(FLOOR, 12, 0.5, 0);
    const value = row(strip, 'Level', input, TIPS[bus.label]);
    if (bus.key === 'master') strip.append(buildMeter());
    panel.append(strip);
    const paint = () => {
      const g = read(sfx.tuning());
      input.value = faderAt(g);
      value.textContent = dbText(g);
      strip.classList.toggle('is-edited', g !== read(SHIPPED_MIX));
    };
    input.addEventListener('input', () => { sfx.tune(write(fromDb(Number(input.value)))); paint(); });
    input.addEventListener('change', changed);
    input.addEventListener('dblclick', () => { sfx.tune(write(read(SHIPPED_MIX))); paint(); changed(); });
    syncs.push(paint);
  }

  // --- Beds -----------------------------------------------------------------
  heading('Engine sound');
  note('Beds run all the time and follow the taxi. Drive to hear these.');
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
  note('▶ plays the sound once at its level and pitch. A sound with variants plays a different '
    + 'take each press, as the game does, and names the one it played. Its level and pitch cover '
    + 'every take. In the game some one-shots are scaled again where they fire (a bump by closing '
    + 'speed, say) — see docs/audio.md. ⚡ makes a rare one happen in the game (the plane, the '
    + 'chopper, the birds…) so it is heard where and how it plays. Sounds are grouped; each group '
    + 'has a level that ships with the mix. M and S on every bus, group, sound and track mute or '
    + 'solo it while listening; a solo silences everything not soloed, above or under it.');
  const stopAll = el('button', { type: 'button', className: 'dbg-wide', textContent: '■ Stop previews',
    title: 'Stop every ▶ preview that is still playing.' });
  stopAll.addEventListener('click', () => { sfx.stopAuditions(); for (const p of trackPlays) p(); });
  panel.append(stopAll);

  // One sound's box, appended where the panel has got to — under its group's header (below).
  function buildSound(key) {
    const box = el('div', { className: 'aud-sound' });
    // What the ⚙️ panel's search matches this box on; its only button is a ▶.
    // Every file it can play, by its full name, so a search for `angry_C` or `basketball_loop_ST`
    // lands here and not only on the summary in `file`.
    box.dataset.search = `${key} ${SHIPPED_MIX.sounds[key].file} ${SOUNDS[key].join(' ')}`;
    const play = el('button', { type: 'button', className: 'aud-play', textContent: '▶',
      title: `Play ${key} once at its current level and pitch. A sound with a pin plays from it, heard from the 👂; `
        + 'Shift-click for the raw file.' });
    // A PICK's files are alternatives under audition, not takes: one plays, chosen below.
    const takes = PICKED.has(key) ? 1 : SOUNDS[key].length;
    const fileText = `${SHIPPED_MIX.sounds[key].file}${LOOPS.has(key) ? ' · loop' : ''}`
      + `${takes > 1 ? ` · ${takes} takes` : ''}`;
    const fileLabel = el('span', { textContent: fileText });
    const title = el('div', { className: 'aud-name' }, play, el('strong', { textContent: key }), fileLabel);
    const ms = el('span', { className: 'aud-ms-pair' });
    monitorButtons(key, ms, box);
    title.append(ms);
    // ⚡ makes the thing itself happen — the plane crosses, the chopper comes in, the flock goes up
    // — so the sound is heard as the game plays it, placed and steered, rather than dry as ▶ plays
    // it. Only for sounds tied to something rare; main.js decides what each one does
    // (`soundTriggers` there). A trigger answers null, or why it could not.
    const trigger = triggers[key];
    if (trigger) {
      const fire = el('button', { type: 'button', className: 'aud-trigger', textContent: '⚡',
        title: TRIGGER_TIPS[key] ?? `Make ${key} happen in the game` });
      fire.addEventListener('click', () => {
        const why = trigger();
        fileLabel.textContent = why ? `${fileText} · ${why}` : `${fileText} · triggered`;
      });
      title.insertBefore(fire, title.children[1]);
    }
    // ⏸ freezes a moving source where it is, its sound looping, so its falloff can be tuned by
    // driving to and from it (main.js `holds`). Lit while held; pressed again lets it go.
    const hold = holds[key];
    if (hold) {
      const pin = el('button', { type: 'button', className: 'aud-trigger aud-hold', textContent: '⏸',
        title: 'Freeze it where it is, its sound looping, so you can drive to and from it. '
          + 'Sends it up first if it is not in the air. Press again to let it go.' });
      const paintHold = () => pin.classList.toggle('is-on', hold.held());
      pin.addEventListener('click', () => {
        const why = hold.set(!hold.held());
        fileLabel.textContent = why ? `${fileText} · ${why}` : `${fileText}${hold.held() ? ' · held' : ''}`;
        // Both bird keys hold the same flock, so both buttons repaint.
        for (const p of holdPaints) p();
      });
      holdPaints.push(paintHold);
      paintHold();
      title.insertBefore(pin, title.children[trigger ? 2 : 1]);
    }
    box.append(title);
    // Try files from disk in this sound's place — this session only, nothing saved. Pick several
    // and they are a variant set: a one-shot draws one per trigger, a loop plays the one chosen in
    // the menu that appears. See `replace` in sfx.js.
    const picker = el('input', { type: 'file', multiple: true,
      accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', hidden: true });
    const replaceBtn = el('button', { type: 'button', className: 'aud-replace', textContent: 'Replace…',
      title: 'Try local files in place of this sound, this session only. Pick several to use as variants.' });
    const revertBtn = el('button', { type: 'button', className: 'aud-replace', textContent: 'Revert', hidden: true,
      title: 'Go back to the shipped file.' });
    const replaceNote = el('span', { className: 'aud-replaced' });
    const localPick = el('select', { className: 'aud-local-pick', hidden: true,
      title: 'A loop plays one file at a time. Pick which local file.' });
    localPick.addEventListener('change', () => { sfx.pickReplacement(key, Number(localPick.value)); paintReplaced(); });
    let failedNote = '';
    const paintReplaced = () => {
      const r = sfx.replaced(key);
      const many = r && r.names.length > 1;
      replaceNote.textContent = !r ? failedNote
        : `${many ? `Playing ${r.names.length} local files${LOOPS.has(key) ? ', one at a time' : ' as variants'}`
          : `Playing ${r.names[0]}`}${failedNote ? ` · ${failedNote}` : ''}`;
      replaceNote.title = r ? r.names.join('\n') : '';
      revertBtn.hidden = !r;
      box.classList.toggle('is-replaced', Boolean(r));
      // A loop plays one file, so a set of them needs choosing between — as the PICK menu does.
      localPick.hidden = !(many && LOOPS.has(key));
      if (!localPick.hidden) {
        localPick.replaceChildren(...r.names.map((n, i) => el('option', { value: String(i), textContent: n })));
        localPick.value = String(r.pick);
      }
    };
    replaceBtn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      const files = [...(picker.files ?? [])];
      picker.value = '';
      if (!files.length) return;
      if (!sfx.state.ready) { replaceNote.textContent = 'Tap the game once to start the audio first.'; return; }
      const loaded = await Promise.all(files.map(async (f) => ({ bytes: await f.arrayBuffer(), name: f.name })));
      const { ok, failed } = await sfx.replace(key, loaded);
      failedNote = failed.length ? `could not decode ${failed.join(', ')}` : '';
      paintReplaced();
      if (!ok) replaceNote.textContent = `Could not decode ${failed.join(', ')}.`;
    });
    revertBtn.addEventListener('click', () => { sfx.revert(key); failedNote = ''; paintReplaced(); });
    box.append(el('div', { className: 'aud-replace-row' }, replaceBtn, revertBtn, replaceNote), picker);
    box.append(el('div', { className: 'aud-replace-row' }, localPick));
    panel.append(box);
    boxes.set(key, box);
    box.addEventListener('pointerdown', () => focus(key, box));
    box.addEventListener('focusin', () => focus(key, box));
    // ▶ plays a placed sound from its pin, heard from the 👂, so what it sounds like is what the
    // player would hear from here (Tyler, October 2026: a ▶ at full level on a court the 👂 was
    // well outside read as the falloff being broken). Live: it follows the rings and the 👂 as
    // they move. Shift-▶ is the raw file.
    play.addEventListener('click', (event) => {
      const file = sfx.audition(key, event.shiftKey ? null : () => placeOf(key));
      if (!file) { paintStatus(); return; }
      const r = sfx.replaced(key);
      if (r) fileLabel.textContent = `${fileText} · played ${r.names[r.ids.indexOf(file)] ?? 'local file'}`;
      else if (takes > 1) fileLabel.textContent = `${fileText} · played ${file.slice(-1)}`;
      else fileLabel.textContent = fileText;
    });

    const gain = slider(FLOOR, 18, 0.5, 0);
    const gainValue = row(box, 'Level', gain);
    const rate = slider(-24, 24, 0.1, 0);
    const rateValue = row(box, 'Pitch', rate);
    let gap = null;
    let gapValue = null;
    if (SFX_EVENTS.has(key)) {
      gap = slider(0, 3, 0.05, 0);
      gapValue = row(box, 'Min gap', gap);
    }
    // Which of the designer's alternatives plays. Live: a bed swaps file on the next frame.
    //
    // Mono against stereo is a yes/no, so it is a **Stereo** switch rather than a menu of two file
    // names — and every sound has one, so the answer is on screen for all of them: a sound with no
    // mono cut is stereo, and its switch is on and greyed; one delivered mono only (construction,
    // seagulls, the court) is off and greyed. A PICK that chooses between something else gets a
    // menu instead.
    let pick = null;
    const monoAt = SOUNDS[key].findIndex((f) => f.endsWith('_MONO'));
    const stereoAt = SOUNDS[key].findIndex((f) => f.endsWith('_ST'));
    const stereoPair = PICKED.has(key) && monoAt >= 0 && stereoAt >= 0;
    const monoOnly = monoAt >= 0 && stereoAt < 0;
    const stereo = el('input', { type: 'checkbox', checked: !monoOnly, disabled: !stereoPair });
    if (!stereoPair) stereo.title = monoOnly ? 'Only delivered in mono' : 'Only delivered in stereo';
    row(box, 'Stereo', stereo);
    if (PICKED.has(key) && !stereoPair) {
      pick = el('select', {}, ...SOUNDS[key].map((f, i) => el('option', { value: String(i), textContent: f })));
      row(box, 'Plays', pick);
    }
    // The falloff, for a sound heard from somewhere: full inside Near, silent past Far, in world
    // units from the taxi (a block is 20).
    let near = null, nearValue = null, far = null, farValue = null;
    if (PLACED.has(key)) {
      near = slider(0, 150, 1, 0);
      nearValue = row(box, 'Full within', near);
      far = slider(1, 200, 1, 0);
      farValue = row(box, 'Silent past', far);
    }
    const paint = () => {
      const t = sfx.tuning();
      const s = t.sounds[key];
      gain.value = faderAt(s.gain);
      gainValue.textContent = `${dbText(s.gain)} · ×${s.gain.toFixed(3)}`;
      rate.value = String(toSemis(s.rate));
      rateValue.textContent = stText(s.rate);
      if (gap) {
        gap.value = String(t.minGap[key]);
        gapValue.textContent = t.minGap[key] ? `${t.minGap[key].toFixed(2)}s` : 'none';
      }
      if (pick) pick.value = String(s.pick);
      if (stereoPair) stereo.checked = s.pick === stereoAt;
      if (near) {
        const pl = t.place[key];
        near.value = String(pl.near);
        nearValue.textContent = `${pl.near.toFixed(0)} u`;
        far.value = String(pl.far);
        farValue.textContent = `${pl.far.toFixed(0)} u`;
      }
      box.classList.toggle('is-edited', JSON.stringify(s) !== JSON.stringify(SHIPPED_MIX.sounds[key])
        || (gap && t.minGap[key] !== SHIPPED_MIX.minGap[key])
        || (near && JSON.stringify(t.place[key]) !== JSON.stringify(SHIPPED_MIX.place[key])));
    };
    // The bottom of the slider is silence (FLOOR), so a sound can be faded out outright.
    gain.addEventListener('input', () => {
      sfx.tune({ sounds: { [key]: { gain: fromDb(Number(gain.value)) } } });
      paint();
    });
    rate.addEventListener('input', () => { sfx.tune({ sounds: { [key]: { rate: fromSemis(Number(rate.value)) } } }); paint(); });
    gap?.addEventListener('input', () => { sfx.tune({ minGap: { [key]: Number(gap.value) } }); paint(); });
    pick?.addEventListener('change', () => { sfx.tune({ sounds: { [key]: { pick: Number(pick.value) } } }); paint(); });
    if (stereoPair) {
      stereo.addEventListener('change', () => {
        sfx.tune({ sounds: { [key]: { pick: stereo.checked ? stereoAt : monoAt } } });
        paint();
        changed();
      });
    }
    near?.addEventListener('input', () => { sfx.tune({ place: { [key]: { near: Number(near.value) } } }); paint(); });
    far?.addEventListener('input', () => { sfx.tune({ place: { [key]: { far: Number(far.value) } } }); paint(); });
    for (const input of [gain, rate, gap, pick, near, far]) input?.addEventListener('change', changed);
    // A double-click on a slider puts that one knob back.
    gain.addEventListener('dblclick', () => { sfx.tune({ sounds: { [key]: { gain: SHIPPED_MIX.sounds[key].gain } } }); paint(); changed(); });
    rate.addEventListener('dblclick', () => { sfx.tune({ sounds: { [key]: { rate: SHIPPED_MIX.sounds[key].rate } } }); paint(); changed(); });
    for (const [input, part] of [[near, 'near'], [far, 'far']]) {
      input?.addEventListener('dblclick', () => {
        sfx.tune({ place: { [key]: { [part]: SHIPPED_MIX.place[key][part] } } }); paint(); changed();
      });
    }
    gap?.addEventListener('dblclick', () => { sfx.tune({ minGap: { [key]: SHIPPED_MIX.minGap[key] } }); paint(); changed(); });
    syncs.push(paint);
    return box;
  }

  // The groups (GROUPS in sfx.js), each a header and then its sounds. The header is the group's
  // bus: a fader that is part of the mix, and M and S that are only for listening — solo one
  // group, or several, to hear them without the rest. A group folds to its header; all start
  // folded, since 33 sounds open at once is the scroll hunt sections were made to end. Folding is
  // a class rather than `hidden`, which the panel's search owns, and a search shows a folded box
  // anyway (index.html).
  const groupOfBox = new Map();
  const unfold = [];
  for (const group of GROUPS) {
    const fold = el('button', { type: 'button', className: 'aud-fold',
      title: 'Show or hide this group\'s sounds' });
    const level = slider(FLOOR, 12, 0.5, 0);
    const nameRow = el('div', { className: 'aud-group-name' }, fold);
    const head = el('div', { className: 'aud-group' }, nameRow);
    monitorButtons(group.key, nameRow, head);
    // Every sound in it, so a search for one of them keeps its group's header in view.
    head.dataset.search = `${group.label} group ${group.sounds.join(' ')}`;
    const levelValue = row(head, 'Level', level,
      'Volume of every sound in this group, on top of each sound\'s own. Double-click to reset.');
    panel.append(head);
    const boxesIn = group.sounds.map((key) => buildSound(key));
    for (const key of group.sounds) groupOfBox.set(key, group.key);

    let open = false;
    const setFold = (on) => {
      open = on;
      fold.textContent = `${open ? '▾' : '▸'} ${group.label} · ${group.sounds.length}`;
      fold.title = `In ${BUSES.find((b) => b.key === group.bus).label}. Show or hide this group's sounds.`;
      for (const box of boxesIn) box.classList.toggle('is-folded', !open);
    };
    fold.addEventListener('click', () => setFold(!open));
    unfold.push([group.key, () => setFold(true)]);
    setFold(false);

    const paint = () => {
      const g = sfx.tuning().groups[group.key].gain;
      level.value = faderAt(g);
      levelValue.textContent = dbText(g);
      head.classList.toggle('is-edited', g !== SHIPPED_MIX.groups[group.key].gain);
    };
    level.addEventListener('input', () => {
      sfx.tune({ groups: { [group.key]: { gain: fromDb(Number(level.value)) } } });
      paint();
    });
    level.addEventListener('change', changed);
    level.addEventListener('dblclick', () => {
      sfx.tune({ groups: { [group.key]: { gain: SHIPPED_MIX.groups[group.key].gain } } });
      paint();
      changed();
    });
    syncs.push(paint);
  }
  const clearMonitor = el('button', { type: 'button', className: 'dbg-wide', textContent: 'Clear mutes and solos',
    title: 'Hear everything again: every bus, group, sound and track.' });
  clearMonitor.addEventListener('click', () => { sfx.clearMonitor(); repaintMonitors(); });
  panel.append(clearMonitor);

  // --- Export ---------------------------------------------------------------
  // --- Music -------------------------------------------------------------
  // The radio's four tracks: the intro and the three songs it rotates. Each level is a trim on top
  // of the measured -24 LUFS the track was brought to (`RADIO.gain` in sfx.js), so 0 dB is shipped.
  heading('Music');
  const trackPlays = [];
  note('The radio: the intro, then songs at random, an ad break (tee-up, ad, sting) every 2 songs '
    + 'and the station ID every 3. ▶ plays a track alone, the radio held quiet; ■ stops it. Level '
    + 'is on top of the track\'s own levelling. Replace… takes over the next time it comes round.');
  const kindOf = (key) => (key === RADIO.intro ? 'Intro' : RADIO.songs.includes(key) ? 'Song'
    : RADIO.ads.includes(key) ? 'Ad' : 'Station');
  for (const key of RADIO.all) {
    const box = el('div', { className: 'aud-sound aud-track' });
    box.dataset.search = `music ${key}`;
    const play = el('button', { type: 'button', className: 'aud-play', textContent: '▶',
      title: 'Play this track from the start. The radio goes quiet until it ends.' });
    const label = key === RADIO.intro ? 'intro' : key.replace(/^(\d+_MUS|MUSIC|RADIO)_(ad_)?/, '').replace(/_/g, ' ');
    const trackName = el('div', { className: 'aud-name' }, play,
      el('strong', { textContent: label }),
      el('span', { textContent: `${kindOf(key)} · ${key} · ${RADIO.seconds[key].toFixed(1)}s` }));
    const ms = el('span', { className: 'aud-ms-pair' });
    monitorButtons(key, ms, box);
    trackName.append(ms);
    box.append(trackName);
    // ▶ while it is quiet, ■ while it is the track being previewed — painted from
    // `state.previewTrack`, so it flips back by itself when the track ends or another one starts.
    const paintPlay = () => {
      const on = sfx.state.previewTrack === key;
      play.textContent = on ? '■' : '▶';
      play.title = on ? 'Stop this track.' : 'Play this track from the start. The radio goes quiet until it ends.';
    };
    trackPlays.push(paintPlay);
    play.addEventListener('click', () => {
      if (sfx.state.previewTrack === key) sfx.stopTrackPreview();
      else if (!sfx.auditionTrack(key)) paintStatus();
      for (const p of trackPlays) p();
    });

    const picker = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', hidden: true });
    const replaceBtn = el('button', { type: 'button', className: 'aud-replace', textContent: 'Replace…',
      title: 'Try a local file as this track, this session only. Takes over next time it comes round.' });
    const revertBtn = el('button', { type: 'button', className: 'aud-replace', textContent: 'Revert', hidden: true,
      title: 'Go back to the shipped track.' });
    const replaceNote = el('span', { className: 'aud-replaced' });
    const paintReplaced = () => {
      const name = sfx.trackReplaced(key);
      replaceNote.textContent = name ? `Playing ${name}` : '';
      revertBtn.hidden = !name;
      box.classList.toggle('is-replaced', Boolean(name));
    };
    replaceBtn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      const f = picker.files?.[0];
      picker.value = '';
      if (!f) return;
      if (!sfx.state.ready) { replaceNote.textContent = 'Tap the game once to start the audio first.'; return; }
      const ok = await sfx.replaceTrack(key, await f.arrayBuffer(), f.name);
      if (!ok) { replaceNote.textContent = `Could not decode ${f.name}.`; return; }
      paintReplaced();
    });
    revertBtn.addEventListener('click', () => { sfx.revertTrack(key); paintReplaced(); });
    box.append(el('div', { className: 'aud-replace-row' }, replaceBtn, revertBtn, replaceNote), picker);

    const gain = slider(FLOOR, 18, 0.5, 0);
    const gainValue = row(box, 'Level', gain, 'Volume of this track; 0 dB is shipped. Double-click the slider to go back to the shipped value.');
    const paint = () => {
      const g = sfx.tuning().music.tracks[key].gain;
      gain.value = faderAt(g);
      gainValue.textContent = `${dbText(g)} · ×${g.toFixed(3)}`;
      box.classList.toggle('is-edited', g !== SHIPPED_MIX.music.tracks[key].gain);
    };
    const set = (g) => sfx.tune({ music: { tracks: { [key]: { gain: g } } } });
    gain.addEventListener('input', () => { set(fromDb(Number(gain.value))); paint(); });
    gain.addEventListener('change', changed);
    gain.addEventListener('dblclick', () => { set(SHIPPED_MIX.music.tracks[key].gain); paint(); changed(); });
    syncs.push(paint);
    panel.append(box);
  }

  heading('Audio export');
  panel.append(saveNote);

  const json = () => `${JSON.stringify(sfx.tuning(), null, 2)}\n`;
  const output = el('textarea', { className: 'dbg-out', rows: 10, spellcheck: false,
    placeholder: 'Paste a mix.json here and press Apply' });

  const download = el('button', { type: 'button', textContent: 'Download mix.json',
    title: 'Save the whole mix as a file. Drop it over assets/audio/mix.json to ship it.' });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    const a = el('a', { href: url, download: 'mix.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const copy = el('button', { type: 'button', textContent: 'Copy JSON', title: 'Copy the whole mix to the clipboard.' });
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
  const open = el('button', { type: 'button', textContent: 'Open file…',
    title: 'Load a mix.json. Replaces the current mix.' });
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
  const apply = el('button', { type: 'button', textContent: 'Apply pasted',
    title: 'Load the mix pasted in the box above. Replaces the current mix.' });
  apply.addEventListener('click', () => applyText(output.value));
  panel.append(output, el('div', { className: 'dbg-actions' }, open, apply), file, importNote);

  const reset = el('button', { type: 'button', className: 'dbg-wide', textContent: 'Reset to shipped mix',
    title: 'Throw away every edit and go back to mix.json.' });
  reset.addEventListener('click', () => { sfx.reset(); sync(); changed(); });
  panel.append(reset);
  note('To ship a mix: drop the downloaded file over assets/audio/mix.json.');

  // The status line is the one readout that moves on its own (files decoding after the first tap,
  // mute, pause), so it polls while the panel is open rather than asking sfx for events.
  let timer = 0;
  sync();
  repaintMonitors();
  changed();
  paintStatus();
  return {
    open() {
      clearInterval(timer);
      sync();
      paintStatus();
      // The music ■ goes back to ▶ when a track ends on its own, which nothing announces.
      timer = setInterval(() => { paintStatus(); for (const p of trackPlays) p(); }, 500);
      meter.start();
    },
    close() { clearInterval(timer); meter.stop(); },
    /** The sound whose rings to draw, or null before one has been touched. */
    focused: () => focusedKey,
    /**
     * Move one end of a sound's falloff from outside the panel — the ring handles on the map
     * (game/soundpins.js). Repaints the sliders as it goes; `done` is the release, which is when an
     * edit is stashed, as a slider's `change` is.
     */
    setPlace(key, part, value, done = false) {
      sfx.tune({ place: { [key]: { [part]: value } } });
      sync();
      if (done) changed();
    },
    /** Select a sound and bring its box into view — a 🔊 pin on the map was clicked. */
    reveal(key) {
      const box = boxes.get(key);
      if (!box) return;
      for (const [g, open] of unfold) if (g === groupOfBox.get(key)) open();
      focus(key, box);
      // Instant rather than smooth: the section may have unfolded this same frame, and a smooth
      // scroll started against the old layout stopped short of the box.
      box.scrollIntoView({ block: 'center' });
    },
  };
}
