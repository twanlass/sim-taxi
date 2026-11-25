/**
 * The in-page half of tools/trailer.mjs: watches for each beat's moment and frames the camera.
 * Injected after page-init.js. Driving is mostly `?bot=<scene>` (src/game/perfbot.js); the beats it
 * has no scene for (the drawbridge jump, the end card) are staged here.
 *
 * `__director.update()` runs after every step and answers `{ event }` on the frame the beat's moment
 * happens, so the recorder can find it on a quick pass with nothing drawn and come back for it.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const beat = params.get('trailer') || '';
  const zoomPin = Number(params.get('trailerzoom') || 0);

  let prev = {};
  let since = {};
  let frames = 0;
  let mega = { routed: false, requested: false, held: false };
  let zoomNow = null;
  let lastKick = -1;
  const stalls = [];
  const heistLog = [];
  let kickBefore = null;

  const T = () => window.__taxi;
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : 'b', bubbles: true }));

  /** Rising edge of a condition, latched per name. */
  function rose(name, on) {
    const was = prev[name];
    prev[name] = on;
    return on && !was;
  }
  /** How many consecutive frames a condition has held. */
  function held(name, on) {
    since[name] = on ? (since[name] ?? 0) + 1 : 0;
    return since[name];
  }

  const EVENTS = {
    loco() {
      const t = T();
      const taxi = t.traffic.taxi;
      return t.perfBot?.scene() === 'loco' && held('loco', t.boost.isActive() && taxi.v > 12) === 40;
    },
    pickup() {
      const t = T();
      const riding = Boolean(t.fares.carrying());
      return t.perfBot?.scene() === 'fares' && frames > 600 && rose('ride', riding);
    },
    drift() {
      const t = T();
      return t.perfBot?.scene() === 'drift' && rose('drift', Boolean(t.traffic.taxi.drift?.kicked));
    },
    bigair() {
      const t = T();
      const taxi = t.traffic.taxi;
      // Any hop off an arch on Loco. (Big Air proper — the drift launch carried over a bridge, with
      // the barrel roll — is the drift scene's to stumble on; see the bigroll beat.)
      return t.perfBot?.scene() === 'bigair' && rose('hop', taxi.hopFrom != null);
    },
    // True Big Air: the drift launch off an arched crest (the bot's bigroll scene stages it).
    bigroll() {
      const t = T();
      const taxi = t.traffic.taxi;
      if (rose('kick', Boolean(taxi.drift?.kicked))) lastKick = frames;
      const on = taxi.hopFrom != null && taxi.hopBig === true && taxi.hopKind !== 'bridge';
      if (rose('bigroll', on)) { kickBefore = lastKick < 0 ? null : (frames - lastKick) / 60; return true; }
      return false;
    },
    mega() {
      const taxi = T().traffic.taxi;
      return rose('mega', taxi.hopFrom != null && taxi.hopKind === 'bridge');
    },
    robbery() {
      const t = T();
      const r = t.robbery;
      // The getaway, once the robber's line has been answered and the taxi is moving.
      const cls = document.body.classList;
      const frozen = cls.contains('bankjob') || cls.contains('robber-talk');
      return held('getaway', Boolean(!frozen && r?.state.active && t.fares.carrying() && t.traffic.taxi.v > 6)) === 20;
    },
    // The whole job in one take: from the bank cut (the shove) through the robber's line and the
    // getaway until the police helicopter has been on the taxi a while. The moment is the cut's
    // first frame; the take's end is `heistEnd` below, so the recorder runs on to it.
    heist() {
      const t = T();
      const r = t.robbery;
      const cls = document.body.classList;
      const cut = rose('h-cut', cls.contains('bankjob'));
      if (cut) heistLog.push([`cut (range ${t.robbery?.range?.().toFixed?.(1)}, ${t.perfBot?.robbery?.().via})`, frames]);
      if (rose('h-cutend', !cls.contains('bankjob') && heistLog.some(([k]) => k === 'cut'))) heistLog.push(['cut end', frames]);
      if (rose('h-line', cls.contains('robber-talk'))) heistLog.push(['line', frames]);
      if (rose('h-lineend', !cls.contains('robber-talk') && heistLog.some(([k]) => k === 'line'))) heistLog.push(['line end', frames]);
      if (rose('h-active', Boolean(r?.state.active))) heistLog.push(['active', frames]);
      if (rose('h-ride', Boolean(r?.state.active && t.fares.carrying()))) heistLog.push(['robber in', frames]);
      if (rose('h-heli', t.policeHeli?.state.mode === 'track')) heistLog.push(['heli', frames]);
      return cut;
    },
    bankjob() {
      const t = T();
      return rose('bank', Boolean(t.robbery?.state.active));
    },
    cops() {
      const t = T();
      return t.perfBot?.scene() === 'cops' && held('chase', t.patrols.some((p) => p.state.phase === 'chase')) === 30;
    },
    crash() {
      const t = T();
      return rose('crashed', Boolean(t.traffic.taxi.crashed));
    },
    title() {
      return frames === 90;
    },
  };

  /**
   * The drawbridge jump: route across the drawbridge's crossing, ask for a lift as the taxi nears
   * the gate, hold Loco while it waits. The rest is the game's own rule (`'go'` in drawbridge.js).
   */
  function stageMega() {
    const t = T();
    const taxi = t.traffic.taxi;
    const db = t.drawbridge;
    if (!db || !t.warmedUp || taxi.state == null) return;
    if (frames < 240) return;
    // Ask for the lift first and route only once the deck is clear and the arms are coming down:
    // routed any earlier, the taxi is itself the car the span is waiting to clear, and crosses.
    if (!mega.asked) { db.request(); mega.asked = true; return; }
    if (!mega.routed && db.state.phase !== 'closing' && db.state.phase !== 'lifting') return;
    if (!mega.routed) {
      const line = db.line ?? null;
      const span = db.span ?? null;
      if (line == null || !span) { mega.routed = 'none'; return; }
      // From whichever bank the taxi is on, to the junction two rows past the far end.
      const north = taxi.z < span.z0;
      const target = { i: line, j: north ? Math.min(span.row + 3, 99) : Math.max(span.row - 2, 0) };
      const near = { i: line, j: north ? span.row + 1 : span.row };
      const far = { i: line, j: north ? span.row : span.row + 1 };
      mega.routed = Boolean(t.routeTo(target, { along: { a: near, b: far } }));
      mega.target = target;
      // Asked for at once: the gate holds a taxi whose route crosses while the span is clearing,
      // closing or on the first 45° of the lift, so arriving early just means a wait at the arm.
      mega.requested = true;
      return;
    }
    if (!mega.requested && db.state.phase === 'open') {
      const dz = Math.abs(taxi.z - (db.span.z0 + db.span.z1) / 2);
      if (dz < 28 && taxi.route?.length) { db.request(); mega.requested = true; }
    }
    if (mega.requested && !mega.held && db.state.phase === 'lifting') { key('Space', 'keydown'); mega.held = true; }
    if (mega.held && taxi.hopKind === 'bridge' && taxi.hopFrom == null && frames % 2) key('Space', 'keyup');
  }

  /** Ends of takes that run to a second event rather than a fixed length: true on the take's last frame. */
  const ENDS = {
    // The helicopter flies in from off screen (ENTRY_DIST in game/policeheli.js); seven seconds of
    // it brings it over the taxi with the searchlight down and a moment of chase under it.
    heist: () => held('h-heli-on', T().policeHeli?.state.mode === 'track') === 420,
  };

  function frame() {
    const t = T();
    if (!t?.warmedUp) return {};
    frames += 1;
    if (beat === 'mega') stageMega();
    // The wreck's own camera (the pull-in, the replay) owns the framing from the crash on.
    if (zoomPin && t.camera?.state && !t.traffic.taxi.crashed) {
      zoomNow = zoomNow == null ? t.camera.state.zoom : zoomNow + (zoomPin - zoomNow) * 0.08;
      t.camera.state.zoom = zoomNow;
    }
    // Every frame the taxi rams something (sim/collisions.js stalls it), so the recorder can turn
    // down a take with a ram inside it.
    if (rose('stall', Boolean(t.traffic.taxi.stalled))) stalls.push(frames);
    const fn = EVENTS[beat];
    const event = fn ? Boolean(fn()) : false;
    const end = ENDS[beat] ? Boolean(ENDS[beat]()) : false;
    return { event, end };
  }

  window.__director = {
    beat,
    /** Frames (counted from the first warmed frame) on which the taxi rammed something. */
    stalls: () => stalls.slice(),
    get frames() { return frames; },
    update: () => { try { return frame(); } catch (error) { return { error: String(error?.stack || error) }; } },
    info: () => {
      const t = T();
      const taxi = t?.traffic?.taxi;
      return taxi && { heist: heistLog.map(([k, f]) => `${k}@${frames - f}f ago`).join(', '), kickBefore, errand: t.perfBot?.errand?.(), bot: t.perfBot?.robbery?.(), heli: t.policeHeli?.state.mode, scene: t.perfBot?.scene(), x: +taxi.x.toFixed(1), z: +taxi.z.toFixed(1), v: +taxi.v.toFixed(1), st: taxi.state, route: taxi.route?.length, mega, db: t.drawbridge?.state?.phase, span: t.drawbridge && [t.drawbridge.line, t.drawbridge.span.cx, +t.drawbridge.span.z0.toFixed(1), +t.drawbridge.span.z1.toFixed(1), t.drawbridge.span.row] };
    },
  };
})();
