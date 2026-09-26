/**
 * Page-side autopilot and camera operator for the trailer recorder. Evaluated into the page after
 * boot; `__hype.tick()` runs once before every virtual-clock step.
 *
 * The driving is the player's, not a cheat: it does exactly what a tap on a rider does
 * (`routeTo` + `markDirected`), and holds Loco Mode through `boost.press()`, the same call the
 * pill makes. Everything else — the pickup, the drive on to the drop-off, the red lights — is the
 * game's own.
 */
(() => {
  const T = window.__taxi;
  const taxi = T.traffic.taxi;
  const cam = T.camera.state;
  const V = cam.target.constructor;

  const s = {
    autoplay: true,
    boost: 'auto',        // 'auto' | 'hold' | 'off'
    boostMin: 1.6,        // seconds of a hold
    boostMax: 3.2,
    boostGap: 2.5,        // seconds between holds
    follow: true,
    zoom: 20,
    zoomLerp: 0.04,
    lerp: 0.1,
    lead: 0.5,            // seconds of velocity to lead the framing by
    offset: [0, 0],       // framing offset in world units
    fixed: null,          // [x, z] — park the camera here instead of following
  };

  let t = 0;
  // Seeded, so a re-record holds the same boosts.
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let holdLeft = 0;
  let gap = 1.5;
  let lastX = taxi.x;
  let lastZ = taxi.z;
  let vx = 0;
  let vz = 0;
  let clickCd = 0;
  const log = [];

  function drive(dt) {
    if (T.fares.state.gameOver) return;
    const job = T.fares.carrying() ?? T.fares.waiting();
    if (job && !job.directed && T.routeTo(job.target)) T.fares.markDirected(job);
  }

  function pedal(dt) {
    if (s.boost === 'off') { T.boost.release(); return; }
    if (s.boost === 'hold') { T.boost.press(); return; }
    if (holdLeft > 0) {
      holdLeft -= dt;
      if (holdLeft <= 0) { T.boost.release(); gap = s.boostGap * (0.6 + rand() * 0.8); }
      return;
    }
    gap -= dt;
    const moving = Math.hypot(vx, vz) > 3;
    if (gap <= 0 && moving && T.boost.isReady() && taxi.route?.length) {
      T.boost.press();
      holdLeft = s.boostMin + rand() * (s.boostMax - s.boostMin);
    }
  }

  function frame(dt) {
    const k = 1 - Math.exp(-dt * 12);
    vx += ((taxi.x - lastX) / dt - vx) * k;
    vz += ((taxi.z - lastZ) / dt - vz) * k;
    lastX = taxi.x;
    lastZ = taxi.z;
    if (s.fixed) {
      cam.target.lerp(new V(s.fixed[0], 0, s.fixed[1]), s.lerp);
    } else if (s.follow) {
      const want = new V(taxi.x + vx * s.lead + s.offset[0], 0, taxi.z + vz * s.lead + s.offset[1]);
      cam.target.lerp(want, s.lerp);
    }
    cam.zoom += (s.zoom - cam.zoom) * s.zoomLerp;
    // The live loop only re-applies the projection when something asks it to.
    T.camera.update(innerWidth / innerHeight);
  }

  // The HUD, switched off for the cinematic shots. The story beats (the robber's line, the radio,
  // the siren wash) stay: they are the game talking, not chrome.
  const clean = document.createElement('style');
  clean.textContent = `#hud, #streak, #pause, #boost, #brake, #rider-finder-stack, #fare-pointers,
    #coach, #spotlight, #home-tip, #taxi-finder { visibility: hidden !important; }`;

  window.__hype = {
    s,
    log,
    hud(on) {
      if (on) clean.remove();
      else document.head.appendChild(clean);
    },
    tick(dt) {
      t += dt;
      // The robber's line stops the world until somebody taps it.
      const talk = document.getElementById('robber-talk');
      clickCd -= dt;
      if (document.body.classList.contains('robber-talk') && talk && clickCd <= 0) {
        talk.click();
        clickCd = 0.9;
      }
      if (s.autoplay) drive(dt);
      pedal(dt);
      frame(dt);
    },
    snap() {
      const tx = taxi.x + s.offset[0];
      const tz = taxi.z + s.offset[1];
      cam.target.set(s.fixed ? s.fixed[0] : tx, 0, s.fixed ? s.fixed[1] : tz);
      cam.zoom = s.zoom;
      T.camera.update(innerWidth / innerHeight);
    },
    status() {
      return {
        t: +t.toFixed(2),
        x: +taxi.x.toFixed(1),
        z: +taxi.z.toFixed(1),
        speed: +Math.hypot(vx, vz).toFixed(1),
        boost: T.boost.isEngaged(),
        crashed: Boolean(taxi.crashed),
        over: T.fares.state.gameOver,
        delivered: T.fares.state.delivered,
        carrying: Boolean(T.fares.carrying()),
        fares: T.fares.state.fares.length,
        robbery: Boolean(T.robbery?.state.active),
        cops: T.traffic.policeCars?.length ?? 0,
        bridge: T.drawbridge?.state.phase ?? null,
        opening: T.opening()?.phase?.() ?? null,
      };
    },
  };
})();
