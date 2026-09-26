/**
 * The audio player: buses, voices, ducking, and one `play(event)` the game calls.
 *
 * **Nothing here touches an `AudioContext` until `unlock()` runs**, and that is the rule the whole
 * file is shaped around. `tools/check.mjs` boots this module in node, where there is no `window` and
 * no Web Audio at all, so a context built at construction would take the entire headless suite down
 * — the same rule `isNative()` in util/platform.js and `tap()` in util/haptics.js are written to.
 * Constructing a player is inert: it validates the manifest, builds its bookkeeping, and waits.
 *
 * It also cannot run before a gesture even in a browser: every engine starts a context suspended
 * and keeps it that way until a real user interaction resumes it. So `unlock()` is not a nicety, it
 * is the only way sound ever happens, and a still-suspended context is an ordinary state rather than
 * an error.
 *
 * **Clips are injected rather than imported.** `clips.js` is Vite-only syntax; handing its map in
 * keeps this file importable by node and by `tools/audio.mjs`, and lets the lab hand in a map of
 * `blob:` URLs from dropped files instead. Same injectable-seam reasoning as `createScores()` taking
 * a store in game/highscores.js, for the same payoff: the half a browser never reaches gets tested.
 */

import { EVENTS, assertEvent } from './events.js';
import { shippedMix, STEAL } from './mix.js';

/** True only where Web Audio actually exists. Read at call time, never at import. */
function audioAvailable() {
  if (typeof window === 'undefined') return false;
  return typeof (window.AudioContext ?? window.webkitAudioContext) === 'function';
}

/**
 * Build a player.
 *
 * `clips` is `basename` → URL (see clips.js). `mix` is a `shippedMix()`-shaped object. `muted` starts
 * it silent, which is what `?mute` and the whole headless/shot path want — see `getMuted()` in
 * util/shot.js. Returns the same shape whether or not audio is available, so no caller needs to ask.
 */
export function createAudio({ clips = {}, mix = shippedMix(), muted = false } = {}) {
  const state = {
    /** `true` once a gesture has resumed the context and the clips have been decoded. */
    ready: false,
    muted,
    /** Names whose sample is missing. Every one of them, right now — no clip has been chosen yet. */
    missing: [],
    /** Live voice counts, per bus and per event, for the lab's readout. */
    voices: { bus: {}, event: {} },
    /** Set when a context could not be created at all. The game carries on silent. */
    error: null,
  };

  // Which events have a sample and which do not, worked out once at construction so the lab can
  // list the empty slots without waiting for a gesture. A clip named in the manifest but absent
  // from the folder is the interesting case and the one `tools/audio.mjs` fails on; here it simply
  // reads as missing, because a player that throws on a half-filled folder would make the game
  // unlaunchable during exactly the week the artist is filling it.
  const resolved = {};
  for (const [name, spec] of Object.entries(EVENTS)) {
    const urls = spec.clips.map((base) => clips[base]).filter(Boolean);
    resolved[name] = urls;
    if (urls.length === 0) state.missing.push(name);
  }

  let ctx = null;
  let masterGain = null;
  const busGain = new Map();
  const buffers = new Map();   // url -> AudioBuffer
  const lastPlayed = new Map(); // event -> ctx.currentTime of its last start
  const live = [];              // { event, bus, source, started }
  const roundRobin = new Map(); // event -> next clip index
  let currentMix = mix;

  const busOf = (name) => EVENTS[name].bus;

  function countVoices() {
    const bus = {};
    const event = {};
    for (const v of live) {
      bus[v.bus] = (bus[v.bus] ?? 0) + 1;
      event[v.event] = (event[v.event] ?? 0) + 1;
    }
    state.voices = { bus, event };
  }

  /** Build the graph. Called once, from `unlock()`, behind a gesture. */
  function buildGraph() {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = state.muted ? 0 : currentMix.master;
    masterGain.connect(ctx.destination);
    for (const [name, spec] of Object.entries(currentMix.buses)) {
      const g = ctx.createGain();
      g.gain.value = spec.gain;
      g.connect(masterGain);
      busGain.set(name, g);
    }
  }

  /**
   * Fetch and decode every clip the manifest actually resolved.
   *
   * Failures are per-clip and non-fatal: a decode that fails leaves that event silent and everything
   * else audible, which is the right trade for a folder being filled in by hand. `decodeAudioData`
   * is called with an `ArrayBuffer`, never a stream, because Safari's implementation of the
   * streaming form has historically been the flakier of the two.
   */
  async function decodeAll() {
    const urls = [...new Set(Object.values(resolved).flat())];
    await Promise.all(urls.map(async (url) => {
      if (buffers.has(url)) return;
      try {
        const bytes = await (await fetch(url)).arrayBuffer();
        buffers.set(url, await ctx.decodeAudioData(bytes));
      } catch (err) {
        console.warn('[audio] could not decode', url, err);
      }
    }));
  }

  /**
   * Resume the context behind a user gesture, then decode.
   *
   * Idempotent and safe to call on every `pointerdown` — which is how it is wired, because the first
   * gesture of a session is not something to try to identify in advance.
   */
  async function unlock() {
    if (state.ready || state.error) return;
    if (!audioAvailable()) { state.error = 'no Web Audio'; return; }
    try {
      if (!ctx) buildGraph();
      if (ctx.state === 'suspended') await ctx.resume();
      await decodeAll();
      state.ready = true;
    } catch (err) {
      state.error = String(err?.message ?? err);
    }
  }

  /** Free the oldest voice on a bus that is at its cap. See `STEAL` in mix.js. */
  function steal(bus) {
    if (STEAL !== 'oldest') return;
    let oldest = -1;
    for (let i = 0; i < live.length; i += 1) {
      if (live[i].bus !== bus) continue;
      if (oldest < 0 || live[i].started < live[oldest].started) oldest = i;
    }
    if (oldest >= 0) {
      try { live[oldest].source.stop(); } catch { /* already ended */ }
      live.splice(oldest, 1);
    }
  }

  /**
   * Play one event.
   *
   * `screenX` is a fraction of the frame's half-width, −1 to 1, from `projectToScreen` — see the
   * note on `PAN_MAX` in mix.js for why screen position is the whole of the spatialisation here.
   * `offscreen` dims a sound whose source is outside the frame rather than dropping it, because a
   * siren two blocks away should still be heard coming.
   *
   * Returns `false` when nothing sounded, which is the ordinary answer right now: no clip has been
   * chosen for any event, so every call is a no-op and the game is exactly as silent as before.
   */
  function play(event, { screenX = 0, offscreen = false, gain = 1 } = {}) {
    const spec = assertEvent(event);
    if (state.muted || !state.ready || !ctx) return false;

    const urls = resolved[event];
    if (urls.length === 0) return false;

    const now = ctx.currentTime;
    const last = lastPlayed.get(event);
    if (last !== undefined && now - last < spec.cooldown) return false;

    // Per-event cap first, then the bus. The narrower limit is the one the artist tunes per sound;
    // the bus cap is the mix's ceiling and only ever steals.
    const mine = live.filter((v) => v.event === event).length;
    if (mine >= spec.voices) return false;
    const bus = busOf(event);
    const busCap = currentMix.buses[bus]?.voices ?? 8;
    if (live.filter((v) => v.bus === bus).length >= busCap) steal(bus);

    // Round robin rather than random: with two or three variants, random repeats audibly and reads
    // as the variation being broken. The lab shows which index fired so "it sounds repetitive" can
    // be checked rather than argued about.
    const next = roundRobin.get(event) ?? 0;
    const url = urls[next % urls.length];
    roundRobin.set(event, next + 1);

    const buffer = buffers.get(url);
    if (!buffer) return false;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // ±`pitch` as a fraction, so 0.04 is ±4% of playback rate. Applied to rate rather than to a
    // detune node because a buffer source has it for free and the two are indistinguishable at this
    // depth.
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * spec.pitch;

    const level = ctx.createGain();
    level.gain.value = spec.gain * gain * (offscreen ? currentMix.pan.offscreen : 1);

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, screenX)) * currentMix.pan.max;

    source.connect(level).connect(panner).connect(busGain.get(bus) ?? masterGain);

    const voice = { event, bus, source, started: now };
    live.push(voice);
    countVoices();
    source.onended = () => {
      const i = live.indexOf(voice);
      if (i >= 0) live.splice(i, 1);
      countVoices();
    };

    source.start();
    lastPlayed.set(event, now);
    return true;
  }

  function setMuted(next) {
    state.muted = Boolean(next);
    if (masterGain && ctx) {
      // Ramped rather than stepped: a hard cut on a sounding voice clicks, and the mute is on the
      // same control surface as the pause.
      masterGain.gain.setTargetAtTime(state.muted ? 0 : currentMix.master, ctx.currentTime, 0.02);
    }
  }

  /** Apply a whole mix object live — what the lab's sliders and a pasted blob both go through. */
  function setMix(next) {
    currentMix = next;
    if (!ctx) return;
    masterGain.gain.setTargetAtTime(state.muted ? 0 : next.master, ctx.currentTime, 0.02);
    for (const [name, g] of busGain) {
      g.gain.setTargetAtTime(next.buses[name]?.gain ?? 1, ctx.currentTime, 0.02);
    }
  }

  /**
   * Hold and release the whole graph, for the pause veil and for backgrounding.
   *
   * `game/pause.js` returns out of the frame loop before a single `update()`, so the sim is frozen;
   * a bus still droning over a frozen city is the one thing that would give that away. The iOS shell
   * already routes backgrounding through `pause.setPaused(true)` (docs/ios.md), so it arrives here
   * for free; a browser tab needs `visibilitychange` wired to the same pair.
   */
  async function suspend() { if (ctx && ctx.state === 'running') await ctx.suspend(); }
  async function resume() { if (ctx && ctx.state === 'suspended' && state.ready) await ctx.resume(); }

  return {
    state,
    /** The manifest as resolved against the clips actually present — what the lab draws its board from. */
    resolved,
    unlock,
    play,
    setMuted,
    setMix,
    suspend,
    resume,
    mix: () => currentMix,
    /** The live context, or null. Exposed for the lab's readout, not for the game to reach into. */
    context: () => ctx,
  };
}
