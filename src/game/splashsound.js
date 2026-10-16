import { FILES, SOUNDS, SHIPPED_MIX, readMuted } from './sfx.js';
import { createSettings } from './settings.js';

/**
 * The startup screen's sound: the Big Air landing on the slam, a bump on each bounce, and the Loco
 * press — the launch, the activate's roar and a skid for the burnout — as the taxi leaves. The
 * game's own recordings at the game's own mix levels, so it is the same car heard the same way.
 *
 * **It plays before anyone has touched the page, which most browsers will not allow.** game/sfx.js
 * waits for the first tap to create its context; this one cannot, because the drop is over before a
 * player would tap. So it creates one at once and plays only if that context is actually running:
 * - **The iOS app: yes.** The shell's empty `mediaTypesRequiringUserActionForPlayback`
 *   (GameViewController.swift) is what lifts WebKit's gesture rule for Web Audio as well as media.
 * - **A browser: usually not.** Safari never; Chrome only for a site the player already uses a
 *   lot. There the context stays suspended, every call below is a no-op, and the drop plays silent
 *   exactly as it did before it had sound.
 *
 * **It leaves the audio session alone.** sfx.js sets `navigator.audioSession.type = 'playback'` so
 * the game plays through the silent switch and takes over from the player's music. That is right
 * once they have tapped into the game and too much for an app launch, so the sting is left on the
 * default session — not verified on a device which way the silent switch then falls.
 *
 * Its own context, closed when the screen goes: sfx.js creates its own on the first tap as ever.
 */

/** One take of each, fixed: the startup screen is the same shot every launch, so it is the same sound. */
const TAKES = {
  land: SOUNDS.land[0],
  bump: SOUNDS.bump[1],
  locoLaunch: SOUNDS.locoLaunch[0],
  locoActivate: SOUNDS.locoActivate[0],
  skid: SOUNDS.skid[0],
};

/**
 * @returns the sound, or a silent stand-in when muted, effects are at zero, there is no Web Audio,
 *   or on `?splashsound=classic` (the drop as it first shipped, silent).
 */
export function createSplashSound() {
  const silent = { play() {}, fadeLoco() {}, fadeAll() {}, close() {} };
  const AudioCtx = typeof window !== 'undefined' ? window.AudioContext : null;
  if (!AudioCtx || readMuted()) return silent;
  if (new URLSearchParams(window.location.search).get('splashsound') === 'classic') return silent;
  const effects = createSettings().get().effects;
  // The same level sfx.js's master bus sits at: the mix's master times the slider, squared.
  const level = SHIPPED_MIX.master * effects ** 2;
  if (level <= 0) return silent;

  let ctx;
  try { ctx = new AudioCtx(); } catch { return silent; }
  // Without a gesture this resolves only where autoplay is allowed; elsewhere it stays pending.
  ctx.resume?.().catch(() => {});
  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(ctx.destination);

  const buffers = {};
  for (const [name, file] of Object.entries(TAKES)) {
    fetch(FILES[file])
      .then((r) => r.arrayBuffer())
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => { buffers[name] = buffer; })
      .catch(() => { /* a missing take is a quiet one, as in sfx.js */ });
  }

  const voices = new Set();
  let loco = null;
  let closed = false;

  function play(name, gain = 1) {
    if (closed || ctx.state !== 'running' || !buffers[name]) return null;
    const source = ctx.createBufferSource();
    source.buffer = buffers[name];
    source.playbackRate.value = SHIPPED_MIX.sounds[name].rate;
    const g = ctx.createGain();
    g.gain.value = SHIPPED_MIX.sounds[name].gain * gain;
    source.connect(g).connect(out);
    source.start();
    const voice = { source, gain: g };
    voices.add(voice);
    source.onended = () => voices.delete(voice);
    if (name === 'locoActivate') loco = voice;
    return voice;
  }

  function fade(voice, seconds) {
    const t = ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0, t, seconds / 3);
    try { voice.source.stop(t + seconds); } catch { /* already stopped */ }
  }

  return {
    play,
    /**
     * The activate is twelve seconds of roar, written for a held pill. Here the car is out of frame
     * in under one, so it goes with the car rather than playing on over an empty patch.
     */
    fadeLoco(seconds = 0.5) {
      if (closed || !loco) return;
      fade(loco, seconds);
      loco = null;
    },
    /** A skip: everything out with the picture. */
    fadeAll(seconds) {
      if (closed) return;
      for (const voice of voices) fade(voice, seconds);
    },
    close() {
      if (closed) return;
      closed = true;
      ctx.close?.().catch(() => {});
    },
  };
}
