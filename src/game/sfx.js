/**
 * The game's sound: the taxi's engine, Loco Mode, the doors, the crash, the jump and the blinker.
 *
 * The one thing in this project loaded from files rather than generated in code. The recordings
 * are a sound designer's, encoded from WAV masters by `tools/audio.mjs` into `assets/audio/*.m4a`;
 * `new URL(..., import.meta.url)` below is what makes Vite fingerprint and ship them, and it is
 * inert in node, which is what lets `tools/check.mjs` boot this module headless.
 *
 * **Everything is the taxi.** Ambient traffic is silent on purpose: twenty-odd engines and their
 * blinkers under one fixed overhead camera would be a wash, and every sound here is feedback about
 * the one car the player is driving.
 *
 * Two kinds of sound, and the split is the design:
 *
 * - **Beds**, which run continuously and are *steered* every frame by `update()` off the taxi's
 *   state — the engine idle (pitched by speed), the Loco engine (crossfaded in while the pill is
 *   held), and the blinker (running while `taxi.signalHand` is set). A bed is never started by an
 *   event, so nothing can leave one stuck on: whatever the frame says is what plays.
 * - **One-shots**, fired by `play(name)` from the site in main.js that already knows the thing
 *   happened — the same sites `haptic()` fires from, for the same reason.
 *
 * **Nothing can play until a gesture.** Every browser holds an `AudioContext` suspended until the
 * page has been touched, so the context is created on the first press and the decode happens then.
 * The fetches start at construction, so by the first tap the bytes are usually already here.
 *
 * **Read the browser at call time, never at import** — the rule `haptics.js` states for the same
 * reason: check.mjs imports this in node, where there is no `window`.
 */
// The designer's mix — see SHIPPED_MIX below.
import MIX from '../../assets/audio/mix.json' with { type: 'json' };

// The designer's files, keyed by what the game calls them. Each is a literal `new URL` so Vite can
// see it at build time; a URL assembled from a variable is one Vite cannot find and will not ship.
const FILES = {
  idle1: new URL('../../assets/audio/01_ENG_idle_loop_01.m4a', import.meta.url).href,
  idle2: new URL('../../assets/audio/01_ENG_idle_loop_02.m4a', import.meta.url).href,
  idle3: new URL('../../assets/audio/01_ENG_idle_loop_03.m4a', import.meta.url).href,
  accel: new URL('../../assets/audio/03_ENG_accel_01.m4a', import.meta.url).href,
  brake: new URL('../../assets/audio/04_ENG_brake_01.m4a', import.meta.url).href,
  locoActivate: new URL('../../assets/audio/05_LOCO_activate_01.m4a', import.meta.url).href,
  locoLoop1: new URL('../../assets/audio/06_LOCO_engine_loop_01.m4a', import.meta.url).href,
  locoLoop2: new URL('../../assets/audio/06_LOCO_engine_loop_02.m4a', import.meta.url).href,
  locoLaunch: new URL('../../assets/audio/07_LOCO_launch_01.m4a', import.meta.url).href,
  locoBrake: new URL('../../assets/audio/08_LOCO_brake_hard_01.m4a', import.meta.url).href,
  skid: new URL('../../assets/audio/09_LOCO_skid_turn_01.m4a', import.meta.url).href,
  doorOpen: new URL('../../assets/audio/10_DOOR_open_01.m4a', import.meta.url).href,
  doorClose: new URL('../../assets/audio/11_DOOR_close_01.m4a', import.meta.url).href,
  crash: new URL('../../assets/audio/12_IMPACT_crash_01.m4a', import.meta.url).href,
  takeoff: new URL('../../assets/audio/13_JUMP_takeoff_01.m4a', import.meta.url).href,
  land: new URL('../../assets/audio/14_JUMP_land_01.m4a', import.meta.url).href,
  signal: new URL('../../assets/audio/15_SIGNAL_turn_01.m4a', import.meta.url).href,
};

/** What `play()` accepts — the one-shots. A typo throws here rather than going silent. */
export const SFX_EVENTS = new Set(['accel', 'brake', 'locoActivate', 'locoLaunch', 'locoBrake',
  'skid', 'doorOpen', 'doorClose', 'crash', 'takeoff', 'land']);

// The loops' true lengths, from the masters (afinfo). A decoder that does not trim AAC's 2112
// frames of encoder priming hands back a buffer that long *plus* the pad, and looping the whole
// buffer would put 44ms of silence in every cycle — a hiccup in the engine once every four
// seconds. See `loopWindow`.
/** The alternate takes a bed draws from, one per run. */
export const IDLE_TAKES = ['idle1', 'idle2', 'idle3'];
export const LOCO_TAKES = ['locoLoop1', 'locoLoop2'];

const LOOP_SECONDS = { idle1: 4, idle2: 4, idle3: 4, locoLoop1: 8, locoLoop2: 8, signal: 4.53125 };
const AAC_PRIMING = 2112 / 48000;

/**
 * The mix: every number a sound designer might want to move, kept in `assets/audio/mix.json`
 * rather than here, so the `?audio` panel (game/audiopanel.js) can export a file that drops
 * straight over it. Its four parts:
 *
 * - `master` — the whole game's level, under the mute.
 * - `sounds` — per file, `gain` (linear) and `rate` (playback rate: pitch *and* tempo). The gain
 *   is how the mix is set without re-exporting masters. The deliveries arrive mastered against
 *   each other (the idles and the Loco loop sit at -25 dB RMS), with one exception: idle 2 is the
 *   bright, thin variant and measures 10 dB under the other two, so it gets that back to sit at
 *   the same level whichever one a run draws. `file` is the designer's name, for reading only.
 * - `minGap` — seconds before the same one-shot may fire again: a second skid inside 0.45s is the
 *   same skid. Zero means no limit.
 * - `engine` — the beds' behaviour:
 *   - `idleRateLo`/`idleRateHi`: the idle's playback rate standing still and at cruise. A rate is
 *     pitch and tempo together, which is exactly what an engine note does as it revs.
 *   - `locoRateLo`/`locoRateHi`: the Loco loop's, across the overdrive band (cruise to Loco top).
 *   - `idleUnderLoco`: how far the idle ducks while the Loco engine is up — it is still the same
 *     car underneath, so it ducks rather than cutting out.
 *   - `locoLoopAt`/`locoLoopFade`: when the Loco loop comes in under the activate, and over how
 *     long. The activate is 11.5s, a sustained seven seconds and then a four-second tail, so a
 *     hold that outlasts it needs something to carry on with. Faded in across the tail rather than
 *     started with the press, where the two would stack.
 *   - `pitchGlide`/`release`: time constants for `setTargetAtTime`, in seconds (~95% of the way
 *     in 3x). The glide is short enough to track a speed change and long enough that a frame's
 *     jitter in `v` is not a zipper in the pitch.
 *   - `selfBrakeGain`: the brake sound when the taxi slows *by itself* (a red, a queue), against
 *     the pedal's 1.
 *   - `pullAwayHold`: how long the taxi has to stand still before pulling away plays `accel`. The
 *     hold is what keeps a car creeping in a queue from revving on every inch.
 *
 * `tune()` cleans whatever it is handed against the shape of the shipped file, so a pasted or
 * hand-edited mix can only ever move a known number to a sane value.
 */
// The taxi pulling away from a standstill: below `STOP_V`, then over `GO_V`.
const STOP_V = 0.4;
const GO_V = 1.2;

// What each knob may hold. A gain of zero is silence and is fine; a rate of zero stops the clock.
const LIMITS = {
  master: [0, 4],
  gain: [0, 8],
  rate: [0.25, 4],
  minGap: [0, 10],
  engine: [0, 30],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `raw` cleaned onto the shape of `base` — only keys `base` has, only finite numbers, clamped.
 * With `base` null this *is* the shipped file, and every key it names is taken as the shape.
 */
function cleanMix(raw, base) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const shape = base ?? src;
  const out = {
    master: clamp(num(src.master) ?? shape.master ?? 1, LIMITS.master),
    sounds: {},
    minGap: {},
    engine: {},
  };
  for (const key of Object.keys(FILES)) {
    const from = shape.sounds?.[key] ?? {};
    const given = src.sounds?.[key] ?? {};
    out.sounds[key] = {
      file: from.file ?? key,
      gain: clamp(num(given.gain) ?? from.gain ?? 1, LIMITS.gain),
      rate: clamp(num(given.rate) ?? from.rate ?? 1, LIMITS.rate),
    };
  }
  for (const key of SFX_EVENTS) {
    out.minGap[key] = clamp(num(src.minGap?.[key]) ?? shape.minGap?.[key] ?? 0, LIMITS.minGap);
  }
  for (const key of Object.keys(shape.engine ?? {})) {
    const v = num(src.engine?.[key]) ?? shape.engine[key];
    if (num(v) != null) out.engine[key] = clamp(v, LIMITS.engine);
  }
  return out;
}

/** A deep copy, since a mix is nested and `tune` writes into it. */
const copyMix = (mix) => JSON.parse(JSON.stringify(mix));

/** The mix as shipped, from mix.json. The panel's Reset returns to this. */
export const SHIPPED_MIX = cleanMix(MIX, null);

const MUTE_KEY = 'simTaxi.muted';

function readMuted() {
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(on) {
  try { window.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* soft, as ever */ }
}

/**
 * Where a loop's real audio sits inside the decoded buffer. Trimmed or not, the tail is the tail,
 * so a buffer longer than the master by roughly the priming pad has it at the front.
 */
function loopWindow(buffer, seconds) {
  const extra = buffer.duration - seconds;
  const start = extra > AAC_PRIMING * 0.5 ? Math.min(AAC_PRIMING, extra) : 0;
  return { start, end: Math.min(buffer.duration, start + seconds) };
}

/**
 * @param {object} opts
 * @param {{ pick: (arr: any[]) => any }} opts.rng  Picks which idle and Loco loop this run gets.
 */
export function createSfx({ rng } = {}) {
  const hasAudio = typeof window !== 'undefined'
    && (window.AudioContext || window.webkitAudioContext);
  const state = {
    muted: hasAudio ? readMuted() : true,
    ready: false,
    loaded: 0,
    total: Object.keys(FILES).length,
    held: false,
  };
  let idleKey = rng ? rng.pick(IDLE_TAKES) : IDLE_TAKES[0];
  let locoKey = rng ? rng.pick(LOCO_TAKES) : LOCO_TAKES[0];
  // Live, and read every frame, so the panel can move any number while the car is driving.
  const mix = copyMix(SHIPPED_MIX);
  const tuning = () => copyMix(mix);
  /** Merge a partial mix in. Anything unknown or non-numeric is dropped (see `cleanMix`). */
  function tuneMix(partial) {
    const merged = copyMix(mix);
    const src = partial && typeof partial === 'object' ? partial : {};
    if ('master' in src) merged.master = src.master;
    for (const part of ['sounds', 'minGap', 'engine']) {
      for (const [key, value] of Object.entries(src[part] ?? {})) {
        if (!(key in merged[part])) continue;
        merged[part][key] = part === 'sounds' ? { ...merged[part][key], ...value } : value;
      }
    }
    Object.assign(mix, cleanMix(merged, SHIPPED_MIX));
  }
  const beds = () => ({ idle: idleKey, loco: locoKey });

  if (!hasAudio) {
    // Headless, or a browser without Web Audio: every call is a no-op — except the mix, which is
    // plain data and is what `npm run check` exercises.
    const noop = () => {};
    return {
      state, play: noop, update: noop, hold: noop, setMuted: noop, toggleMuted: () => true,
      locoOn: noop, locoOff: noop,
      tuning, tune: tuneMix, reset: () => tuneMix(SHIPPED_MIX), beds, setBed: noop,
      audition: () => false, stopAuditions: noop, files: FILES,
    };
  }

  // Ask iOS for the "ambient" session: mixes with the player's own music instead of stopping it,
  // and follows the ring/silent switch. Safari 16.4+; elsewhere the property does not exist.
  try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* old */ }

  // Fetched now, decoded once there is a context to decode into.
  const bytes = {};
  for (const [key, url] of Object.entries(FILES)) {
    bytes[key] = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.arrayBuffer();
    });
  }

  let ctx = null;
  let master = null;
  const buffers = {};
  const lastAt = {};

  // --- the beds, built once the buffers are in ---
  let idle = null;       // { src, gain }
  let loco = null;       // the Loco loop bed
  let signal = null;     // the blinker; recreated per indicating window so each opens on a tick
  let activate = null;   // the current Loco activate voice, or null
  let locoSince = -1;    // ctx time the current hold began, or -1
  let signalHand = null;
  let stoppedFor = 0;
  let wasAir = false;
  let wasBraking = false;

  function makeLoop(key, gain = 0) {
    const src = ctx.createBufferSource();
    src.buffer = buffers[key];
    src.loop = true;
    const w = loopWindow(src.buffer, LOOP_SECONDS[key]);
    src.loopStart = w.start;
    src.loopEnd = w.end;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start(0, w.start);
    return { src, gain: g };
  }

  function stopVoice(v, tau = mix.engine.release) {
    if (!v) return;
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, tau);
    try { v.src.stop(t + tau * 6); } catch { /* already stopped */ }
  }

  async function start() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = state.muted ? 0 : mix.master;
    master.connect(ctx.destination);
    await Promise.all(Object.entries(bytes).map(async ([key, p]) => {
      try {
        const buf = await p;
        buffers[key] = await ctx.decodeAudioData(buf);
        state.loaded++;
      } catch (err) {
        console.warn(`sfx: ${key} did not load`, err);
      }
    }));
    if (buffers[idleKey]) idle = makeLoop(idleKey);
    if (buffers[locoKey]) loco = makeLoop(locoKey);
    state.ready = true;
    if (state.held) ctx.suspend();
  }

  // The unlock. Created *inside* the gesture, because Safari only lets a context start running
  // from one; `resume()` again on every later gesture until it is actually running, because iOS
  // will also suspend it behind the app's back (a phone call, the app backgrounded).
  const unlock = () => {
    if (!ctx) start();
    else if (ctx.state !== 'running' && !state.held) ctx.resume();
  };
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (!state.held) ctx.resume();
  });

  /**
   * Fire a one-shot. `delay` is seconds from now on the audio clock, which stops with a hold, so a
   * door scheduled to close after the rider climbs in waits through a pause with the rest.
   */
  function play(name, { gain = 1, rate = 1, delay = 0 } = {}) {
    if (!SFX_EVENTS.has(name)) throw new Error(`unknown sound: ${name}`);
    if (!state.ready || !buffers[name] || state.muted) return null;
    const now = ctx.currentTime;
    const gap = mix.minGap[name];
    if (gap && lastAt[name] != null && now + delay - lastAt[name] < gap) return null;
    lastAt[name] = now + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate * mix.sounds[name].rate;
    const g = ctx.createGain();
    g.gain.value = gain * mix.sounds[name].gain;
    src.connect(g).connect(master);
    src.start(now + delay);
    return { src, gain: g };
  }

  /** The pill went down — the frame `boost.press()` answered true. */
  function locoOn() {
    if (!state.ready) return;
    play('locoLaunch');
    stopVoice(activate);
    activate = play('locoActivate');
    locoSince = ctx.currentTime;
  }

  /** The hold ended — released, braked, run out, or the run over. Idempotent. */
  function locoOff() {
    if (!state.ready || locoSince < 0) return;
    locoSince = -1;
    stopVoice(activate, 0.15);
    activate = null;
  }

  /**
   * Steer the beds off this frame's taxi.
   *
   * @param {number} dt
   * @param {object} taxi       `traffic.taxi`
   * @param {object} opts
   * @param {number} opts.cruise  The ordinary top speed (SPEED).
   * @param {number} opts.top     The Loco top (`boostCruise()`).
   * @param {boolean} opts.holding  The pill is held (not the cooldown tail).
   * @param {boolean} opts.over   The run has ended.
   */
  function update(dt, taxi, { cruise, top, holding, over }) {
    if (!state.ready) return;
    const t = ctx.currentTime;
    const v = Math.max(0, taxi.v);
    const alive = !over && !taxi.crashed;

    if (!holding && locoSince >= 0) locoOff();

    // The engine. Pitched off speed, ducked under Loco, and gone with the run.
    const s = Math.min(1, v / cruise);
    const locoUp = alive && locoSince >= 0;
    const e = mix.engine;
    if (idle) {
      const rate = (e.idleRateLo + (e.idleRateHi - e.idleRateLo) * s) * mix.sounds[idleKey].rate;
      idle.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const g = !alive ? 0 : mix.sounds[idleKey].gain * (locoUp ? e.idleUnderLoco : 1);
      idle.gain.gain.setTargetAtTime(g, t, alive ? e.pitchGlide * 2 : 0.4);
    }
    if (loco) {
      const over01 = Math.max(0, Math.min(1, (v - cruise) / Math.max(1e-6, top - cruise)));
      const rate = (e.locoRateLo + (e.locoRateHi - e.locoRateLo) * over01)
        * mix.sounds[locoKey].rate;
      loco.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const held = locoUp ? t - locoSince : 0;
      const k = locoUp
        ? Math.max(0, Math.min(1, (held - e.locoLoopAt) / Math.max(1e-3, e.locoLoopFade))) : 0;
      loco.gain.gain.setTargetAtTime(mix.sounds[locoKey].gain * k, t, locoUp ? 0.3 : e.release);
    }

    // Pulling away from a stop. Not while the pill is up: the launch is that car's pull-away.
    if (v < STOP_V) stoppedFor += dt;
    else {
      if (v > GO_V && stoppedFor >= e.pullAwayHold && alive && !taxi.boost) play('accel');
      if (v > GO_V) stoppedFor = 0;
    }

    // The taxi slowing on its own — for a red, a queue, a turn. Off the brake *lamp* (eased in
    // sim/traffic.js off the car's real deceleration), on its rising edge, and softer than the
    // pedal's, which is the player's own stop and has already played at the press.
    const braking = taxi.brakeLevel > 0.6 && v > 2.5;
    if (braking && !wasBraking && alive && !taxi.braking) play('brake', { gain: e.selfBrakeGain });
    wasBraking = braking;

    // Off a ramp. The landing has its own event (`traffic.onTaxiLand`); the takeoff is only
    // visible as `hopFrom` turning non-null, so it is read off the edge here.
    const air = taxi.hopFrom != null;
    if (air && !wasAir && alive) play('takeoff');
    wasAir = air;

    // The blinker. A fresh voice per window, so it opens on its first tick exactly as the lamp
    // opens lit (the sim restarts `signalT` on every change of hand — see TURN_SIGNAL_HZ). The
    // master's ticks are 0.9s apart, which is the sim's 1.1 Hz: they stay in step with the lamp.
    const hand = alive ? taxi.signalHand : null;
    if (hand !== signalHand) {
      stopVoice(signal, 0.03);
      signal = hand && buffers.signal && !state.muted ? makeLoop('signal', mix.sounds.signal.gain)
        : null;
      signalHand = hand;
    }
    if (signal) {
      signal.gain.gain.setTargetAtTime(mix.sounds.signal.gain, t, 0.02);
      signal.src.playbackRate.setTargetAtTime(mix.sounds.signal.rate, t, 0.02);
    }
  }

  /** Stop the clock under everything — the pause and the robber's line, which stop the world. */
  function hold(on) {
    if (on === state.held) return;
    state.held = on;
    if (!ctx) return;
    if (on) ctx.suspend();
    else if (!document.hidden) ctx.resume();
  }

  function setMuted(on) {
    state.muted = Boolean(on);
    writeMuted(state.muted);
    if (!ctx) return;
    master.gain.setTargetAtTime(state.muted ? 0 : mix.master, ctx.currentTime, 0.02);
    if (state.muted) { stopVoice(signal, 0.02); signal = null; signalHand = null; }
  }

  function tune(partial) {
    tuneMix(partial);
    if (master && !state.muted) master.gain.setTargetAtTime(mix.master, ctx.currentTime, 0.02);
  }

  /**
   * Swap which take a bed is running — `'idle'` to one of IDLE_TAKES, `'loco'` to one of
   * LOCO_TAKES. A run draws one of each; this is so the panel can compare them on the same car.
   */
  function setBed(kind, key) {
    const takes = kind === 'idle' ? IDLE_TAKES : kind === 'loco' ? LOCO_TAKES : null;
    if (!takes?.includes(key)) return;
    if (kind === 'idle') idleKey = key; else locoKey = key;
    if (!state.ready || !buffers[key]) return;
    if (kind === 'idle') { stopVoice(idle); idle = makeLoop(key); }
    else { stopVoice(loco); loco = makeLoop(key); }
  }

  // The panel's audition voices, tracked so an 11-second activate can be stopped.
  const auditions = new Set();
  /**
   * Play any file once at its mixed gain and rate, loops included and past `minGap` — the panel's
   * ▶. Returns false when nothing could play (no tap yet, the file missing, muted or held).
   */
  function audition(key) {
    if (!state.ready || !buffers[key] || state.muted || state.held) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffers[key];
    src.playbackRate.value = mix.sounds[key].rate;
    const g = ctx.createGain();
    g.gain.value = mix.sounds[key].gain;
    src.connect(g).connect(master);
    const voice = { src, gain: g };
    auditions.add(voice);
    src.onended = () => auditions.delete(voice);
    src.start();
    return true;
  }
  function stopAuditions() {
    for (const v of auditions) stopVoice(v, 0.03);
    auditions.clear();
  }

  return {
    state,
    play,
    tuning,
    tune,
    reset: () => tune(SHIPPED_MIX),
    beds,
    setBed,
    audition,
    stopAuditions,
    files: FILES,
    update,
    hold,
    locoOn,
    locoOff,
    setMuted,
    toggleMuted: () => { setMuted(!state.muted); return state.muted; },
  };
}
