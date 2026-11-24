/**
 * Injected before any of the game's scripts by tools/trailer.mjs (Playwright `addInitScript`).
 * Three things, each so a take comes out the same every time from the same seeds:
 *
 * 1. **A fake clock.** `performance.now` and `requestAnimationFrame` are replaced; the game only
 *    moves when the recorder calls `__trailer.step()`, exactly 1/FPS of a second each time. A frame
 *    that takes the software renderer four seconds still advances the world by 16.7 ms.
 * 2. **A seeded `Math.random`.** The game seeds its own generators off `?seed=` and `?run=`, but
 *    some effects (skid jitter, the replay's angle, impact sparks) still draw from Math.random.
 * 3. **The game's own audio, rendered in lockstep.** `AudioContext` becomes an
 *    `OfflineAudioContext` that pretends to be running. Every step renders exactly one frame of audio
 *    (suspend at the next frame's time, resume, await), so every sound the game schedules lands on
 *    the frame it was scheduled on — the real mix, the real files, nothing re-created afterwards.
 *    `__trailer.audio(from, to)` hands back that span as 16-bit WAV bytes.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const FPS = Number(params.get('trailerfps') || 60);
  const DT = 1000 / FPS;
  const SR = 48000;
  const MAX_SECONDS = Number(params.get('trailermax') || 150);

  // --- 2. Math.random -------------------------------------------------------------------------
  let s = (Number(params.get('run') || 1) * 2654435761) >>> 0 || 1;
  Math.random = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // --- 1. Clock -------------------------------------------------------------------------------
  let now = 1000;
  let frame = 0;
  let queue = [];
  let nextId = 1;
  performance.now = () => now;
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { queue = queue.filter((q) => q.id !== id); };

  // --- 3. Audio -------------------------------------------------------------------------------
  const RealOffline = window.OfflineAudioContext;
  const realSuspend = RealOffline.prototype.suspend;
  const realResume = RealOffline.prototype.resume;
  const realStart = RealOffline.prototype.startRendering;
  let actx = null;
  let rendered = null;      // the AudioBuffer, once the context has run to its end
  let started = false;
  let lastSuspend = 0;
  class LockstepContext extends RealOffline {
    constructor() {
      super({ numberOfChannels: 2, length: SR * MAX_SECONDS, sampleRate: SR });
      if (!actx) { actx = this; actx.t0 = now; }
    }
    get state() { return 'running'; }
    get baseLatency() { return 0; }
    get outputLatency() { return 0; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  window.AudioContext = LockstepContext;
  window.webkitAudioContext = LockstepContext;

  const quantum = (t) => Math.ceil((t * SR) / 128) * 128 / SR;

  async function advanceAudio() {
    if (!actx || rendered) return;
    const target = quantum((now - actx.t0) / 1000);
    if (target <= lastSuspend || target >= MAX_SECONDS - 0.01) return;
    lastSuspend = target;
    const reached = realSuspend.call(actx, target);
    if (!started) {
      started = true;
      realStart.call(actx).then((buf) => { rendered = buf; });
    } else {
      realResume.call(actx);
    }
    await reached;
  }

  function wav(buffer, from, to) {
    const a = Math.max(0, Math.floor(from * SR));
    const b = Math.min(buffer.length, Math.floor(to * SR));
    const n = Math.max(0, b - a);
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
    out.setUint32(24, SR, true); out.setUint32(28, SR * 4, true); out.setUint16(32, 4, true);
    out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[a + i])) * 32767, true);
      out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[a + i])) * 32767, true);
    }
    return new Uint8Array(out.buffer);
  }

  // --- 4. CSS animations and transitions on the same clock --------------------------------------
  // The HUD's motion (the taxi marker's bob, fades, the combo flame) runs on the compositor's wall
  // clock, and a captured frame takes a second or two of wall clock: left alone, every frame samples
  // the bob at a random phase and the marker jumps about. Each one is paused and placed at its own
  // fake-clock age instead.
  function stepDomAnimations() {
    if (typeof document === 'undefined' || !document.getAnimations) return;
    for (const a of document.getAnimations()) {
      try {
        if (a.__born == null) { a.__born = now - (a.currentTime ?? 0); a.pause(); }
        const t = now - a.__born;
        const end = a.effect?.getComputedTiming?.().endTime;
        // Past its end, finish it for real: a paused animation never fires `finish`/`animationend`,
        // and the HUD removes its coin bursts and cash pops on those (they piled up on the taxi).
        if (Number.isFinite(end) && t >= end) a.finish();
        else a.currentTime = t;
      } catch {}
    }
  }

  window.__trailer = {
    FPS,
    get frame() { return frame; },
    get now() { return now; },
    /** Seconds of audio-context time at this moment, or null before the first gesture made one. */
    get audioTime() { return actx ? (now - actx.t0) / 1000 : null; },
    /** Advance the world by n frames. */
    async step(n = 1) {
      for (let k = 0; k < n; k++) {
        now += DT;
        frame += 1;
        await advanceAudio();
        const run = queue;
        queue = [];
        for (const { cb } of run) {
          try { cb(now); } catch (error) { console.error('[trailer] frame', error); }
        }
        stepDomAnimations();
      }
    },
    /** Run the audio context to its end and return [from, to) seconds of it as WAV, base64. */
    async audio(from, to) {
      if (!actx) return null;
      if (!rendered) {
        if (!started) { started = true; rendered = await realStart.call(actx); }
        else {
          realResume.call(actx);
          while (!rendered) await new Promise((r) => setTimeout(r, 20));
        }
      }
      const bytes = wav(rendered, from, to);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
  };
})();
