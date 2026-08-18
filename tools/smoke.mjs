/**
 * Browser smoke test. The Node probe covers the simulation's logic far more thoroughly and much
 * faster; this only checks the things that require a real page — that it boots, that the render
 * loop advances the sim, that signals cycle, and that camera controls respond.
 *
 *   node tools/smoke.mjs --url http://localhost:4173
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same env overrides as tools/shoot.mjs: Linux boxes keep Chromium somewhere else, and a
// container running as root needs CHROME_FLAGS=--no-sandbox.
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9338;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const baseUrl = arg('url', 'http://localhost:4173');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function fetchJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return JSON.parse(await res.text());
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    ready,
    errors,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const profile = await mkdtemp(join(tmpdir(), 'taxi-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=900,600',
  '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--no-first-run', '--disable-extensions',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
  'about:blank',
], { stdio: 'ignore' });

let client;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); break; } catch { await sleep(200); }
  }

  const target = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  // Pin the motion preference to what an ordinary player's browser reports, rather than inheriting
  // whatever this headless build happens to default to. Several HUD entrances — the cargo chip's
  // flight in from the city is the one asserted below — hand over to a plain fade under `reduce`, so
  // a build that answers `reduce` turns those checks into assertions about the fallback while still
  // printing PASS.
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await client.send('Page.navigate', { url: baseUrl });

  const evaluate = async (expression) => {
    const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value;
  };

  const bootDeadline = Date.now() + 120000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    if (await evaluate('Boolean(window.__taxi)')) { booted = true; break; }
    await sleep(300);
  }
  check('game boots', booted);
  if (!booted) throw new Error('never booted');

  check('taxi exists', (await evaluate('Boolean(window.__taxi.traffic.taxi)')));

  // --- The opening vignette has to land before anything below has something to tap.
  //
  // A run opens on a cut scene now — camera onto the garage door, door up, taxi out, camera back
  // (see gameplay.md#the-opening-vignette) — and the fare board is held empty for the whole of it,
  // deliberately. So this is both a wait and the one end-to-end assertion the vignette can only get
  // in a real page: that the sequence actually finishes and hands the taxi back to the traffic
  // model, rather than parking the run in a garage forever.
  //
  // Polled on the sequence's own phase rather than slept. Under the software renderer the
  // vignette's clock advances at a fraction of wallclock — a couple of seconds on a GPU is a minute
  // here — so any fixed wait is either far too long or a flake.
  const vignetteDeadline = Date.now() + 180000;
  let openingPhase = 'wait';
  while (Date.now() < vignetteDeadline) {
    openingPhase = await evaluate(
      'window.__taxi.opening() ? window.__taxi.opening().phase() : "done"');
    if (openingPhase === 'done') break;
    await sleep(500);
  }
  check('the opening vignette runs and lands', openingPhase === 'done', `phase ${openingPhase}`);
  check('...and hands the taxi back to the traffic model',
    (await evaluate('window.__taxi.traffic.taxi.staged')) === false
    && (await evaluate('Boolean(window.__taxi.traffic.taxi.lane)')));
  // The board is seeded by the first `fares.update`, which the vignette was holding — so a rider
  // appearing at all is the evidence that hold was released rather than left on.
  const boardDeadline = Date.now() + 20000;
  while (Date.now() < boardDeadline
    && !(await evaluate('window.__taxi.fares.state.fares.length > 0'))) await sleep(300);
  check('...and the fare board opens behind it',
    await evaluate('window.__taxi.fares.state.fares.length > 0'));

  // --- ...and the tap that gets out of it.
  //
  // A second page, because the two claims are mutually exclusive: the one above needs a vignette
  // that runs all the way to its end, and this one needs one that doesn't. It is here rather than
  // in the node suite because every part of it is browser — a `pointerdown` on the canvas, a black
  // div that has to be on top of everything and taking the taps, and a fade that has to take itself
  // back down afterwards. `probe.mjs` covers the other half (the handover and the camera snap the
  // black is hiding); none of the wiring that reaches them exists outside a page.
  {
    const skip = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    const skipClient = connect(skip.webSocketDebuggerUrl);
    await skipClient.ready;
    await skipClient.send('Runtime.enable');
    await skipClient.send('Page.enable');
    await skipClient.send('Page.navigate', { url: baseUrl });

    const skipEval = async (expression) => {
      const { result } = await skipClient.send('Runtime.evaluate', {
        expression, returnByValue: true,
      });
      return result.value;
    };

    // Wait for the sequence to be genuinely under way rather than merely built: the skip is armed
    // on `holdsCamera()`, so a tap during `wait` — the city's own entrance still rising — is
    // deliberately not one. Same polling argument as above; under a software renderer the phases
    // advance at a fraction of wallclock. "none" is a city with no depot, which the probe's sweep
    // says does not happen, and which would leave nothing here to skip.
    let phase = 'boot';
    const armedDeadline = Date.now() + 180000;
    while (Date.now() < armedDeadline) {
      phase = await skipEval('window.__taxi'
        + ' ? (window.__taxi.opening() ? window.__taxi.opening().phase() : "none") : "boot"');
      if (phase !== 'boot' && phase !== 'wait') break;
      await sleep(300);
    }
    const armed = phase !== 'boot' && phase !== 'wait' && phase !== 'none' && phase !== 'done';
    check('a second page reaches the vignette with it still running', armed, `phase ${phase}`);

    if (armed) {
      // Read back in the same evaluate as the tap, not on the next poll: the fade to black is
      // 160ms and the whole cut is under half a second, so anything asked afterwards is a race.
      // `elementFromPoint` is the load-bearing half — it says the black is genuinely on top of the
      // HUD *and* taking the taps, which a `hidden` flag alone does not.
      const cut = JSON.parse(await skipEval(`(() => {
        document.querySelector('body > canvas')
          .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const wipe = document.getElementById('wipe');
        return JSON.stringify({
          up: !wipe.hidden,
          onTop: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id ?? '',
        });
      })()`));
      check('a tap during it cuts to black', cut.up && cut.onTop === 'wipe',
        `wipe ${cut.up ? 'up' : 'down'}, top element "${cut.onTop}"`);

      // And behind that black, the same landing the vignette would have reached on its own — plus
      // the framing, which is the whole of what the skip has to do that settling doesn't.
      let landed = false;
      const landDeadline = Date.now() + 20000;
      while (Date.now() < landDeadline) {
        if (await skipEval('window.__taxi.opening().phase() === "done"')) { landed = true; break; }
        await sleep(200);
      }
      check('...and the run is on the road behind it', landed
        && (await skipEval('window.__taxi.traffic.taxi.staged')) === false
        && (await skipEval('Boolean(window.__taxi.traffic.taxi.lane)')));
      check('...at the zoom the game plays at',
        Math.abs((await skipEval('window.__taxi.camera.state.zoom')) - 52) < 0.5,
        `zoom ${await skipEval('window.__taxi.camera.state.zoom')}`);

      // The fade back in has to end with the element gone. A black sheet left over the city is the
      // one failure of this feature that would be total, and it is invisible to every check above.
      let lifted = false;
      const liftDeadline = Date.now() + 10000;
      while (Date.now() < liftDeadline) {
        if (await skipEval("document.getElementById('wipe').hidden")) { lifted = true; break; }
        await sleep(200);
      }
      check('...and the black lifts off it', lifted);
      check('...leaving the city taking the taps again',
        (await skipEval(
          "document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName ?? ''")) === 'CANVAS');
    }

    skipClient.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${skip.id}`).catch(() => {});
  }

  // --- Tap the taxi: it should select.
  // Synthetic DOM click rather than CDP's Input domain. Input.dispatchMouseEvent is accepted in
  // this headless configuration but never synthesises a DOM click — the page observes nothing at
  // all — so it silently tests neither the picker nor anything else. This does exercise the real
  // listener, raycast and hit-test path; it just doesn't cover Chrome's OS-level input plumbing.
  // `body > canvas` rather than `canvas`. The game's canvas is appended to the body, but the HUD
  // chips each carry a small WebGL canvas of their own — 38px inside `#rider-finder-stack`, 42px
  // inside `#cargo-chip`, which is earlier still, being the first element in the body — and both
  // sit *before* the game's in the DOM, so a bare `querySelector('canvas')` hands back a chip.
  // Every gesture below was landing on that: the drag check failed because
  // `attachDragPan` never saw the events, and the tap check passed for the wrong reason, since a
  // click on a chip's canvas bubbles to the chip's button and dispatches the taxi anyway.
  const GAME_CANVAS = "document.querySelector('body > canvas')";

  const clickAt = async (pt) => {
    await evaluate(`(() => { const c = ${GAME_CANVAS};`
      + " c.dispatchEvent(new MouseEvent('click', { clientX: " + Math.round(pt.x)
      + ", clientY: " + Math.round(pt.y) + ", bubbles: true, cancelable: true })); })()");
    await sleep(300);
  };

  check('the taxi is always selected', await evaluate('window.__taxi.isSelected()'));

  // Tapping the taxi, or empty ground, must not be able to turn selection off any more.
  await clickAt(JSON.parse(await evaluate('JSON.stringify(window.__taxi.taxiScreenPosition())')));
  await clickAt({ x: 12, y: 12 });
  check('selection cannot be turned off', await evaluate('window.__taxi.isSelected()'));

  // --- Tap the fare marker: it should produce a route.
  const targetPt = JSON.parse(await evaluate('JSON.stringify(window.__taxi.targetScreenPosition())'));
  await clickAt(targetPt);

  const routeLen = await evaluate('window.__taxi.traffic.taxi.route.length');
  const hasTarget = await evaluate('Boolean(window.__taxi.traffic.taxi.pendingTarget)');
  check('tapping the fare routes the taxi', hasTarget, `route ${routeLen} turns`);

  // ...and the band it draws is painted in that rider's clock, not the taxi's old yellow. Only the
  // frame loop performs that join (the band's colour, the fare's colour and `directed` are three
  // separate objects headlessly), so this is the one place it is checked end to end.
  const bandPaint = JSON.parse(await evaluate(`JSON.stringify((() => {
    const t = window.__taxi, fare = t.fares.directed();
    return { band: t.routeLine.color().getHexString(),
      fare: fare ? t.fares.colorOf(fare).getHexString() : null };
  })())`));
  check('the band wears the clock it is spending',
    bandPaint.fare !== null && bandPaint.band === bandPaint.fare,
    `band ${bandPaint.band}, fare ${bandPaint.fare}`);

  // --- The taxi should be consuming that route as it drives.
  // Poll rather than sample a fixed window: the taxi may be legitimately stopped at a red for
  // several seconds, and under software rendering sim time advances only a fraction of real time.
  const start = JSON.parse(await evaluate(
    'JSON.stringify({x: window.__taxi.traffic.taxi.x, z: window.__taxi.traffic.taxi.z})'));
  let travelled = 0;
  for (let attempt = 0; attempt < 20 && travelled <= 1; attempt++) {
    await sleep(1000);
    const now = JSON.parse(await evaluate(
      'JSON.stringify({x: window.__taxi.traffic.taxi.x, z: window.__taxi.traffic.taxi.z})'));
    travelled = Math.hypot(now.x - start.x, now.z - start.z);
  }
  check('the taxi drives', travelled > 1, `moved ${travelled.toFixed(1)} units`);

  check('signals still hold for the taxi',
    (await evaluate('window.__taxi.traffic.stats.violations')) === 0);

  // --- Pause holds the whole frame, a tap elsewhere on the veil leaves it held, and only the
  // Resume pill lets it go.
  //
  // `fares.state.elapsed` is the probe rather than the taxi's position: it advances by `dt` on
  // every `fares.update` no matter what else is happening, so a taxi legitimately sitting at a red
  // cannot read as a paused game. That makes this the check that would catch a pause which only
  // held the clocks — or one the frame loop kept updating behind the veil.
  const elapsed = () => evaluate('window.__taxi.fares.state.elapsed');
  await evaluate("document.getElementById('pause').click()");
  await sleep(150);
  const veilUp = await evaluate("!document.getElementById('pause-veil').hidden");
  const held = await elapsed();
  await sleep(900);
  const stillHeld = await elapsed();
  check('the pause button holds the run', veilUp && stillHeld === held,
    veilUp ? `elapsed ${held.toFixed(2)} → ${stillHeld.toFixed(2)}` : 'no veil');

  // A tap on the veil's title, away from the Resume pill, must not resume — otherwise reading the
  // paused screen risks dropping straight back into traffic.
  await evaluate(`(() => { document.querySelector('#pause-veil .pause-title').dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 7, isPrimary: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  const afterStrayTap = await elapsed();
  check('a tap elsewhere on the veil does not resume it',
    afterStrayTap === stillHeld && !(await evaluate("document.getElementById('pause-veil').hidden")),
    `elapsed ${stillHeld.toFixed(2)} → ${afterStrayTap.toFixed(2)}`);

  // `pointerdown`, which is what the Resume pill actually listens for — a `click` here would pass
  // while the press-to-resume path was broken.
  await evaluate(`(() => { document.querySelector('#pause-veil .pause-resume').dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 7, isPrimary: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(700);
  const resumed = await elapsed();
  check('and the Resume pill resumes it',
    resumed > afterStrayTap && (await evaluate("document.getElementById('pause-veil').hidden")),
    `elapsed ${afterStrayTap.toFixed(2)} → ${resumed.toFixed(2)}`);

  // --- Everything below is a phone. Drag-to-pan, both follow-cams and the rider pan are all gated
  // on `isNarrow()` — under NARROW_VIEWPORT = 768 — so at the 900px window this tool launches with,
  // the drag check below was asserting a feature that is *deliberately* off and had been failing
  // for it. The checks above are viewport-agnostic and keep the desktop framing they ran at.
  await client.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);   // a resize has to reach the renderer before a gesture means anything

  // --- Drag pans, tap does not. The two share one gesture, so both halves need asserting: this
  // is the check that would catch drag-panning eating taps, which is what sank the first attempt
  // at a movable camera here. (The old version of this check compared a literal against null and
  // could not fail.)
  const camTarget = () => evaluate(
    'JSON.stringify(window.__taxi.camera.state.target.toArray())');

  const dragFrom = async (x, y, dx, dy) => {
    await evaluate(`(() => {
      const c = ${GAME_CANVAS};
      const ev = (type, cx, cy) => c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, isPrimary: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      c.setPointerCapture = () => {};
      ev('pointerdown', ${x}, ${y});
      for (let s = 1; s <= 6; s++) ev('pointermove', ${x} + ${dx} * s / 6, ${y} + ${dy} * s / 6);
      ev('pointerup', ${x} + ${dx}, ${y} + ${dy});
    })()`);
    await sleep(200);
  };

  // Pick an origin that is *not* on the route band. Pressing the band takes the gesture away from
  // the camera on purpose (see below), so a pan check that happened to start on it would go on
  // passing while measuring the wrong feature entirely — and there has been a route on screen
  // since the fare tap above.
  const panStart = JSON.parse(await evaluate(`(() => {
    const spots = [[200, 420], [80, 700], [320, 200], [60, 180], [330, 770], [200, 640]];
    for (const [x, y] of spots) if (!window.__taxi.pathDrag.hitTest(x, y)) return JSON.stringify({x, y});
    return JSON.stringify({x: 200, y: 420});
  })()`));

  const beforeDrag = await camTarget();
  await dragFrom(panStart.x, panStart.y, 120, 80);
  check('dragging pans the camera', (await camTarget()) !== beforeDrag,
    `from (${panStart.x}, ${panStart.y})`);

  // A press that never crosses the slop must leave the camera exactly where it was.
  const beforeTap = await camTarget();
  await dragFrom(panStart.x, panStart.y, 3, 2);
  check('a tap does not pan the camera', (await camTarget()) === beforeTap);

  // --- Dragging the route band re-routes the taxi, and does *not* pan.
  //
  // The routing itself is asserted in tools/probe.mjs, where a whole drive can be run headlessly.
  // What only a browser can check is the wiring, and specifically the ordering: the grab listens
  // on `window` in the capture phase precisely so it beats `attachDragPan`'s listener on the
  // canvas, because listener order *within* one element is registration order whatever the capture
  // flag says. Get that wrong and the symptom is not an error — it is the map sliding out from
  // under a drag that was meant to move the route, which is invisible to every headless tool here.
  //
  // The gesture is held open across round trips (no pointerup until the end) because the re-plan
  // happens in the frame loop rather than in the move handler: the route the drag produces does
  // not exist yet at the moment the last `pointermove` returns.
  const bandGrab = JSON.parse(await evaluate(`(() => {
    const taxi = window.__taxi.traffic.taxi;
    // Try a few points along the band rather than trusting one. The taxi keeps driving, so the
    // route can be down to its last leg by the time this runs, and on a short band most of it is
    // inside the head gap where a grab is deliberately refused. A failure here has to be able to
    // say *why* — an intermittent 'the drag is broken' with no state attached is unactionable.
    let pt = null;
    for (const f of [0.45, 0.6, 0.35, 0.75, 0.25]) {
      const p = window.__taxi.routeScreenPosition(f);
      if (p && window.__taxi.pathDrag.hitTest(p.x, p.y)) { pt = p; break; }
    }
    if (!pt) return JSON.stringify({ ok: false, why: 'no grabbable point on the band'
      + ' — legs ' + taxi.route.length + ', target ' + Boolean(taxi.pendingTarget)
      + ', over ' + window.__taxi.fares.state.gameOver });
    const c = ${GAME_CANVAS};
    const before = window.__taxi.camera.state.target.toArray().join();
    const ev = (type, cx, cy) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 4, isPrimary: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    c.setPointerCapture = () => {};
    ev('pointerdown', pt.x, pt.y);
    const grabbed = window.__taxi.pathDrag.isGrabbing();
    for (let s = 1; s <= 8; s++) ev('pointermove', pt.x + 7 * s, pt.y + 5 * s);
    return JSON.stringify({
      ok: true,
      grabbed,
      via: window.__taxi.pathDrag.via(),
      legs: taxi.route.length,
      panned: window.__taxi.camera.state.target.toArray().join() !== before,
    });
  })()`));

  check('a press on the route band takes hold of it', bandGrab.ok && bandGrab.grabbed,
    bandGrab.why ?? `via a point ${bandGrab.legs ?? '?'} legs from the destination`);
  check('dragging the band names a waypoint', Boolean(bandGrab.via),
    bandGrab.via ? `via (${bandGrab.via.i}, ${bandGrab.via.j})` : 'none named');
  check('and does not pan the camera', bandGrab.ok && !bandGrab.panned);

  // Let the frame loop turn the waypoint into a route, then release. The band having been lit the
  // whole way is the other half of the promise, so the flourish is read back too — it is a shader
  // uniform, which no screenshot of this software renderer would settle anyway.
  await sleep(400);
  //
  // Asserted on the *destination* and on the band still being drawn, not on a leg count. An empty
  // `route` is a legitimate state — it is `routeTo`'s "the destination is the intersection the taxi
  // is already heading toward" — and it is what the last leg of every trip looks like. The band is
  // still painted there (routePath runs from the car to the destination whether or not any turns
  // remain) and still grabbable, so a check gated on `legs > 0` went red for a state that is
  // correct, on whichever runs the taxi happened to be one junction out.
  const midDrag = JSON.parse(await evaluate(`JSON.stringify({
    grabbing: window.__taxi.pathDrag.isGrabbing(),
    legs: window.__taxi.traffic.taxi.route.length,
    target: Boolean(window.__taxi.traffic.taxi.pendingTarget),
    band: Boolean(window.__taxi.routeScreenPosition()),
  })`));
  check('the route survives being dragged',
    midDrag.grabbing && midDrag.target && midDrag.band,
    `${midDrag.legs} legs still planned`);

  await evaluate(`${GAME_CANVAS}.dispatchEvent(new PointerEvent('pointerup', {`
    + ' pointerId: 4, isPrimary: true, bubbles: true, cancelable: true }))');
  await sleep(200);
  check('letting go of the band ends the gesture',
    (await evaluate('window.__taxi.pathDrag.isGrabbing()')) === false);

  // --- Tapping a rider-finder chip pans the camera to that rider rather than cutting to them.
  // The curve itself is covered in tools/probe.mjs; what only a browser can check is the wiring —
  // the chip's click reaching main.js, and the frame loop stepping the pan afterwards. Both are
  // invisible in a screenshot, since a pan and a cut are identical once they have landed.
  //
  // Narrow-viewport behaviour, so it needs the window this tool launches with (900px would put it
  // over NARROW_VIEWPORT and the chip would dispatch without touching the camera). The drag checks
  // above depend on the same thing.
  const CHIP = "document.querySelector('#rider-finder-stack button:not([hidden])')";
  const narrow = await evaluate('window.innerWidth < 768');
  const chipShown = await evaluate(`Boolean(${CHIP})`);
  if (narrow && chipShown) {
    // Park the camera away from the rider, tap, and read the result back — all inside one
    // evaluate, with no await in the middle. Split across CDP round-trips the page renders a frame
    // or two in between and the pan is already under way, which is exactly what a cut would look
    // like. Synchronously after the tap: a pan is queued and the camera has not moved yet.
    const tap = JSON.parse(await evaluate(`(() => {
      const cam = window.__taxi.camera;
      cam.cancelGlide();
      cam.state.target.set(0, 0, 0);
      ${CHIP}.click();
      return JSON.stringify({ gliding: cam.isGliding(), target: cam.state.target.toArray() });
    })()`));
    const stillParked = tap.target.every((v) => v === 0);
    check('a chip tap pans instead of cutting', tap.gliding && stillParked,
      !tap.gliding ? 'no pan started'
        : stillParked ? 'pan queued, camera still parked'
          : `camera cut straight to ${JSON.stringify(tap.target)}`);

    // And it arrives, holds the rider for a beat, and rides back to the taxi — the pan out is only
    // half of what a chip tap does (see camera.js's peekAt). Leaving the camera parked on the kerb
    // is what used to cost the player a drag back across the map to their own car.
    //
    // Polled rather than sampled once: the whole sequence is about two and a half seconds of sim
    // time, and this page renders in software at ~10fps with a clamped dt, so wall-clock runs
    // considerably longer than that. The gap to the taxi is what's watched — how far the camera
    // ever got is the evidence it really went to the rider, and where it ends up is the evidence it
    // came home rather than being abandoned there.
    const gapToTaxi = () => evaluate(`(() => {
      const t = window.__taxi.camera.state.target, taxi = window.__taxi.traffic.taxi;
      return JSON.stringify({ gliding: window.__taxi.camera.isGliding(),
        gap: Math.hypot(t.x - taxi.x, t.z - taxi.z) });
    })()`);
    let farthest = 0;
    let ended = null;
    for (let attempt = 0; attempt < 40 && ended === null; attempt++) {
      await sleep(250);
      const s = JSON.parse(await gapToTaxi());
      farthest = Math.max(farthest, s.gap);
      if (!s.gliding && farthest > 5) ended = s.gap;
    }
    check('the peek visits the rider and rides back to the taxi',
      ended !== null && ended < 6,
      ended === null ? `never settled, got ${farthest.toFixed(1)} units from the taxi`
        : `out to ${farthest.toFixed(1)} units, ended ${ended.toFixed(1)} from the taxi`);

    // ...and the framing stays with the car. Landing on the taxi is only half of what the return
    // leg is for: the peek hands the camera back to the opening follow-cam on arrival, and without
    // that handover the taxi simply drives out of the frame the peek just put it in — which is the
    // same "where is my car" the whole feature exists to answer.
    //
    // Waiting a fixed few seconds would be no evidence at all, since the taxi may spend them
    // sitting at a red — where a camera that was left parked also stays put. So this waits for the
    // *taxi* to have covered ground and then asks whether the camera came with it.
    //
    // The gap cannot carry that on its own, because the follow does not sit on the taxi: it aims
    // past it, by up to 13 units at cruise on this viewport (camera.js's LEAD_FRACTION). What
    // separates following from parked is that the camera *travelled* — a parked one has moved
    // nothing at all — so `camMoved` is the assertion and the gap is only a sanity bound.
    const before = JSON.parse(await evaluate(
      `JSON.stringify({ taxi: [window.__taxi.traffic.taxi.x, window.__taxi.traffic.taxi.z],
        cam: window.__taxi.camera.state.target.toArray() })`));
    let drove = 0;
    let camMoved = 0;
    let gap = 0;
    // Polls out to 15s: it exits the moment the taxi has covered its 20 units, and only a run that
    // spends the window at a red — or a stopped sim — ever pays the whole wait.
    for (let attempt = 0; attempt < 60 && drove < 20; attempt++) {
      await sleep(250);
      const s = JSON.parse(await evaluate(`(() => {
        const t = window.__taxi.camera.state.target, taxi = window.__taxi.traffic.taxi;
        return JSON.stringify({ taxi: [taxi.x, taxi.z], cam: t.toArray(),
          gap: Math.hypot(t.x - taxi.x, t.z - taxi.z) });
      })()`));
      drove = Math.hypot(s.taxi[0] - before.taxi[0], s.taxi[1] - before.taxi[1]);
      camMoved = Math.hypot(s.cam[0] - before.cam[0], s.cam[2] - before.cam[2]);
      gap = s.gap;
    }
    // Asserted as "the taxi covered real ground and the camera covered most of it too". The taxi's
    // own travel has to clear the follow's lag and lead for either half to mean anything, which is
    // why it is polled for rather than timed.
    check('and the camera stays with the taxi afterwards',
      ended !== null && drove > 12 && camMoved > drove * 0.5 && gap < 20,
      `taxi drove ${drove.toFixed(1)}, camera moved ${camMoved.toFixed(1)}, `
      + `${gap.toFixed(1)} off the car`);
  } else {
    check('a chip tap pans instead of cutting', false,
      narrow ? 'no waiting rider on screen to tap' : 'viewport is not narrow');
  }

  // --- A VIP's chip keeps its clock to itself. See game/riderfinder.js.
  //
  // Browser-only twice over: the ring is a CSS conic gradient on a DOM node, and what is being
  // asserted is that it does *not* move — which is a claim about a value the node is holding, not
  // about anything the fare system knows. The rest of a VIP's surfaces have never spoken the
  // urgency scale (the crystal, its disc, the drop-off ring); this chip was the one that still
  // reported how long you had, and not knowing is the whole of what makes a purple diamond a
  // gamble rather than a sum.
  //
  // The fare is promoted to a VIP in place rather than waited for: `VIP_COOLDOWN` alone is 55
  // seconds of a software-rendered sim, and the chip reads `fare.vip` every frame, so a rider who
  // becomes one is exactly the state under test.
  //
  // Polled for a rider rather than run against the board as it stands: by this point the taxi has
  // been dispatched at whoever was waiting and the loop is somewhere between a pickup and the next
  // spawn. Promoting the rider and reading the chip happen a frame apart, so a rider collected in
  // between simply costs an attempt.
  if (narrow) {
    let shown = null;
    for (let attempt = 0; attempt < 24 && shown === null; attempt++) {
      const promoted = JSON.parse(await evaluate(`(() => {
        const fare = window.__taxi.fares.state.fares.find((f) => f.stage === 'waiting');
        if (!fare || !${CHIP}) return JSON.stringify({ none: true });
        // A fifth of the clock left: an ordinary rider's ring would be a fifth of a turn and red.
        fare.vip = true;
        fare.timeLeft = fare.limit * 0.2;
        return JSON.stringify({ ok: true });
      })()`));
      if (promoted.none) { await sleep(500); continue; }
      // Two frames, so `riderfinder.update` has certainly run against the flag.
      await sleep(400);
      shown = JSON.parse(await evaluate(`(() => {
        const el = ${CHIP};
        if (!el) return JSON.stringify({ gone: true });
        return JSON.stringify({
          pct: el.style.getPropertyValue('--pct'),
          color: el.style.getPropertyValue('--ring-color'),
        });
      })()`));
      if (shown.gone) shown = null;
    }
    if (shown === null) {
      check('a VIP\'s chip shows no countdown', false, 'no rider stayed on the kerb long enough');
    } else {
      // Read as numbers rather than as a string: the ring colour arrives through
      // `THREE.Color.getStyle()`, which is a colour-space conversion and free to land a channel a
      // digit off. What is being asserted is "still purple, still full", not a spelling.
      const rgb = (shown.color.match(/\d+/g) ?? []).map(Number);
      const purple = rgb.length === 3
        && Math.abs(rgb[0] - 166) < 3 && Math.abs(rgb[1] - 77) < 3 && Math.abs(rgb[2] - 255) < 3;
      check('a VIP\'s chip shows no countdown',
        parseFloat(shown.pct) > 99.9 && purple,
        `ring ${shown.pct} ${shown.color}`);
    }
  }

  // --- The courier box in the HUD, while a package is aboard. See src/game/cargochip.js.
  //
  // Here rather than in the node suite because the whole thing is browser-only: a WebGL context
  // inside a DOM node, carried in by a Web Animation. And driven through `__taxi.cargoChip` rather
  // than by couriering a real package, which would mean playing a fare, waiting out the spawn gap and
  // dragging the route band through a pad — several minutes of software-rendered sim for a chip whose
  // states are the thing being asserted. `setCarrying(true)` is the flightless half of what a
  // `'pickup'` does to it; `flyIn` is the other half, and is checked on its own below.
  //
  // The pixel count is the half that matters. The chip's framing is *computed* — the frustum is
  // derived from the box's own dimensions at the camera's elevation — so the failure mode is not a
  // missing element, it is a correct element with the box framed off the side of it, which reads in
  // a screenshot as an empty disc and reads in the DOM as a pass. Everything is done inside one
  // `evaluate` with no await in the middle: the renderer does not preserve its drawing buffer, so
  // the readback has to happen in the same task as the draw.
  const chipState = (expr = 'null') => evaluate(`(() => {
    const chip = window.__taxi.cargoChip;
    if (!chip) return JSON.stringify({ missing: true });
    ${expr};
    const el = document.getElementById('cargo-chip');
    const src = el.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let drawn = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) drawn += 1;
    return JSON.stringify({
      on: el.classList.contains('is-on'),
      hidden: el.getAttribute('aria-hidden'),
      drawn: drawn / (data.length / 4),
    });
  })()`);

  const chipDown = JSON.parse(await chipState());
  check('the cargo chip starts down', chipDown.on === false && chipDown.hidden === 'true',
    chipDown.missing ? 'no courier layer on this page' : `aria-hidden ${chipDown.hidden}`);

  const chipUp = JSON.parse(await chipState('chip.setCarrying(true); chip.render()'));
  // A 1.16-unit box in a frustum half-height of 1.15 measures 52% of the canvas, so 0.3 is a floor
  // with room under it rather than a reading to keep in step. What it rules out is the two ways
  // this can be wrong and still look fine from the DOM: nothing drawn at all, and a box framed
  // outside the canvas.
  check('a package aboard raises the cargo chip',
    chipUp.on === true && chipUp.hidden === 'false' && chipUp.drawn > 0.3,
    `${(chipUp.drawn * 100).toFixed(0)}% of the canvas drawn`);

  // ...and it is riding along rather than sitting there as a picture. The chip turns a full circle
  // every 20s and bobs half a pixel, both driven from `render` off wall time — so the way this fails
  // is not an exception, it is a chip that draws once and never changes again, which is precisely
  // what a *correct* static icon looks like from the DOM and from any single screenshot.
  //
  // Two draws a second apart, differenced **per pixel**. Not by coverage and not by mean brightness:
  // the box's footprint is square by design, so a turn barely moves the silhouette, and the two
  // visible faces swing through the sun in opposite directions, so a mean over the whole box nets
  // most of it out — 18° of turn moves the mean by 2 of 255 and moves individual pixels by ten times
  // that. The first sample is stashed on the page rather than returned: the renderer does not
  // preserve its drawing buffer, so each grab has to happen in the same task as its own draw.
  const chipGrab = (stash) => evaluate(`(() => {
    const chip = window.__taxi.cargoChip;
    if (!chip) return JSON.stringify({ missing: true });
    const src = document.querySelector('#cargo-chip canvas');
    chip.render();
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    if (${stash}) { window.__chipFrame = px; return JSON.stringify({ ok: true }); }
    const was = window.__chipFrame;
    delete window.__chipFrame;
    let diff = 0;
    for (let i = 0; i < px.length; i += 4) {
      diff += Math.abs(px[i] - was[i]) + Math.abs(px[i + 1] - was[i + 1])
        + Math.abs(px[i + 2] - was[i + 2]);
    }
    return JSON.stringify({ diff: diff / (px.length / 4 * 3) });
  })()`);

  await chipGrab(true);
  await sleep(1000);
  const chipMoved = JSON.parse(await chipGrab(false));
  // Measured: **18.4** of 255 for a second of the real thing, **2.3** with the turn stopped and only
  // the bob left running, 0 for a frozen box — there is nothing else in this canvas to move. So the
  // floor is 8: comfortably under a real turn, and above the reading for a chip that only wobbles,
  // which is the near miss this check would otherwise pass.
  check('and it turns while it rides', chipMoved.diff > 8,
    chipMoved.missing ? 'no courier layer on this page'
      : `${chipMoved.diff.toFixed(1)} of 255 mean pixel change over 1s`);

  // --- Tapping a package: a detour with a rider aboard, a dispatch with the seat empty. See
  // src/game/parcels.js.
  //
  // Here rather than in the node suite because the half that can go wrong here is the **picker**:
  // a hit box that was never added to the target list, a `pickable` kind main.js doesn't switch on,
  // or a `parcelFor` walk that stops one node short all fail by doing precisely nothing, which is
  // also what a tap on the road does. The routing itself is `findRouteVia`, which `tools/probe.mjs`
  // covers far better than a software-rendered page can.
  //
  // The board is loaded by hand rather than played into: a package spawns on a drawn 18–45s gap and
  // only after the first delivery, which is minutes of sim under llvmpipe for a marker whose two
  // states are the thing being asserted. `delivered: 9` is passed to this one call only — the frame
  // loop goes on ticking it with the run's real count, which never removes a package already on the
  // board.
  const parcelTap = async () => {
    const setup = JSON.parse(await evaluate(`JSON.stringify((() => {
      const t = window.__taxi;
      if (!t.parcels) return { missing: true };
      t.parcels.state.nextSpawnAt = -Infinity;
      t.parcels.update(1 / 60, t.traffic.taxi,
        { fareSpots: t.fares.occupiedSpots(), delivered: 9 });
      const box = t.parcels.state.parcels[0];
      if (!box) return { missing: true };
      // Give the tap a route to act on. Whether the run happens to have a rider aboard right now
      // decides which branch this reads — a detour around a fare's route, or a dispatch that
      // replaces it — so the seat is recorded rather than assumed.
      const job = t.fares.carrying() ?? t.fares.waiting();
      if (job) t.routeTo(job.target);
      return {
        carried: Boolean(t.fares.carrying()),
        target: t.traffic.taxi.pendingTarget,
        box: { i: box.target.i, j: box.target.j },
        legs: t.traffic.taxi.route.length,
        acked: box.ackAt !== null,
      };
    })())`));
    if (setup.missing) return { missing: true };

    await clickAt(JSON.parse(await evaluate('JSON.stringify(window.__taxi.parcelScreenPosition())')));

    const after = JSON.parse(await evaluate(`JSON.stringify((() => {
      const t = window.__taxi, box = t.parcels.state.parcels[0];
      return {
        // Collected counts as gone: a pickup moves the box aboard, resets its ack for the drop-off
        // corner, and retires a dispatch's route — nothing below is assertable against it.
        gone: !box || box.stage !== 'waiting',
        acked: Boolean(box) && box.ackAt !== null,
        amp: box?.ackAmp ?? 0,
        target: t.traffic.taxi.pendingTarget,
        legs: t.traffic.taxi.route.length,
        band: t.routeLine.color().getHexString(),
        parcelHue: t.parcels.colorOf().getHexString(),
      };
    })())`));
    return { before: setup, after };
  };

  const tapped = await parcelTap();
  if (tapped.missing) {
    check('tapping a package is answered', false, 'no package to tap');
  } else if (tapped.after.gone) {
    // The taxi drove through the pad in the second the tap took. Nothing is wrong; there is just
    // nothing left to assert against, and a check that failed on it would be flaky by construction.
    check('tapping a package is answered', true, 'collected before the tap landed — skipped');
  } else {
    check('tapping a package is answered on its corner',
      tapped.before.acked === false && tapped.after.acked === true,
      `ack ${tapped.before.acked} -> ${tapped.after.acked}`);
    check('and the answer is taken, not a refusal',
      tapped.after.amp > 0, `amplitude ${tapped.after.amp}`);
    if (tapped.before.carried) {
      // The seat is a commitment: whatever the tap did to the route, the place the taxi is being
      // driven to is the one it was already being driven to.
      check('with a rider aboard, tapping a package never re-aims the taxi at it',
        tapped.after.target !== null
        && tapped.after.target.i === tapped.before.target.i
        && tapped.after.target.j === tapped.before.target.j,
        `${JSON.stringify(tapped.before.target)} -> ${JSON.stringify(tapped.after.target)}`
        + `, ${tapped.before.legs} -> ${tapped.after.legs} legs`);
    } else {
      // No rider, no committed clock: the tap is a dispatch, and the box's own junction is now the
      // destination — even when the taxi was mid-drive at a waiting rider.
      check('with the seat empty, tapping a package re-aims the taxi at it',
        tapped.after.target !== null
        && tapped.after.target.i === tapped.before.box.i
        && tapped.after.target.j === tapped.before.box.j,
        `${JSON.stringify(tapped.before.target)} -> ${JSON.stringify(tapped.after.target)}`);
      // The band on a dispatch wears the courier cyan — a package has no clock, so no urgency hue.
      // Read back through routeLine.color() after the frame loop has repainted it.
      check('and the band repaints in the courier cyan',
        tapped.after.band === tapped.after.parcelHue,
        `band #${tapped.after.band}, courier #${tapped.after.parcelHue}`);
    }
  }

  const chipAfter = JSON.parse(await chipState('chip.setCarrying(false)'));
  check('delivering it puts the chip back down',
    chipAfter.on === false && chipAfter.hidden === 'true');

  // --- ...and the arrival that puts it up. See `flyIn` in src/game/cargochip.js.
  //
  // The second half of a pickup: the world box has lifted off its pad and is fading out somewhere
  // across the city, and the chip grows and fades in with a short slide **from that direction**. Three
  // things are assertable from outside and each rules out a way this reads as a pop rather than an
  // arrival: it starts *away* from its slot (an identity transform is a chip appearing in the corner
  // with the box vanishing across town), it starts *small* and *transparent*, and it ends square in
  // its slot at full size.
  //
  // Driven with a hand-made hand-off rather than a real one, for the reason the states above are: a
  // courier job is minutes of software-rendered sim away. The numbers are a plausible one — a box a
  // few hundred pixels down and right of the HUD corner.
  const flightStart = JSON.parse(await evaluate(`(() => {
    const chip = window.__taxi.cargoChip;
    if (!chip) return JSON.stringify({ missing: true });
    chip.setCarrying(false);
    chip.flyIn({ x: 420, y: 380, yaw: 0.8 });
    const el = document.getElementById('cargo-chip');
    const s = getComputedStyle(el);
    const m = new DOMMatrix(s.transform);
    return JSON.stringify({
      on: el.classList.contains('is-on'),
      flying: el.classList.contains('is-flying'),
      // How far the chip is from its resting place, how big it is, and how visible, on frame one.
      offset: Math.hypot(m.e, m.f),
      scale: m.a,
      opacity: Number(s.opacity),
      // ...and that the slide points the right way: the box is down and to the right of the corner,
      // so the chip must start down and to the right of its slot. A sign error here is a chip sliding
      // in from the opposite quadrant, which is the one way the direction can be wrong and still move.
      down: m.f > 0,
      right: m.e > 0,
      animations: el.getAnimations().length,
    });
  })()`));
  check('a pickup brings the chip in from the direction the box left in',
    flightStart.missing !== true
    && flightStart.on === true && flightStart.flying === true
    && flightStart.offset > 40 && flightStart.scale < 0.9 && flightStart.opacity < 0.5
    && flightStart.down === true && flightStart.right === true
    && flightStart.animations > 0,
    flightStart.missing ? 'no courier layer on this page'
      : `starts ${flightStart.offset.toFixed(0)}px out at ${flightStart.scale.toFixed(2)}x, `
        + `opacity ${flightStart.opacity.toFixed(2)}, ${flightStart.animations} animation(s)`);

  // ...and lands. Waited out rather than awaited on `animation.finished`, which needs a promise this
  // `evaluate` does not resolve. 460ms of slide, generously over-waited: a check that raced the
  // animation would be flaky in the one direction that matters, reporting a landing that never came.
  await sleep(1200);
  const flightEnd = JSON.parse(await evaluate(`(() => {
    const el = document.getElementById('cargo-chip');
    const s = getComputedStyle(el);
    const m = new DOMMatrix(s.transform);
    return JSON.stringify({
      flying: el.classList.contains('is-flying'),
      offset: Math.hypot(m.e, m.f),
      scale: m.a,
      opacity: Number(s.opacity),
      hidden: el.getAttribute('aria-hidden'),
    });
  })()`));
  check('and settles it square in its slot',
    flightEnd.offset < 0.5 && Math.abs(flightEnd.scale - 1) < 0.01
    && flightEnd.opacity > 0.99
    && flightEnd.flying === false && flightEnd.hidden === 'false',
    `${flightEnd.offset.toFixed(1)}px out at ${flightEnd.scale.toFixed(2)}x, `
    + `opacity ${flightEnd.opacity.toFixed(2)}, still flying ${flightEnd.flying}`);

  await evaluate('window.__taxi.cargoChip?.setCarrying(false)');

  // --- The "back to the taxi" chip, once the player's own car is off-frame. See
  // src/game/taxifinder.js.
  //
  // Browser-only in the same three ways at once: the edge test runs off a projection through the
  // live camera, the chip is a WebGL context in a DOM node, and the tap has to reach main.js. The
  // node suite covers the boundary arithmetic and the camera curve; this covers the wiring between
  // them, which is the part that fails silently — a chip that never comes up looks exactly like a
  // taxi that is never off screen.
  //
  // The tutorial is dismissed first rather than waited out. While it is framing the city it owns
  // the camera, and this parks the camera somewhere deliberate — two claims on the same thing, and
  // the one that loses is this test.
  await evaluate(`(() => {
    const t = window.__taxi.tutorial;
    for (let i = 0; i < 8 && t && t.holdsCamera(); i++) t.dismiss();
  })()`);

  // A real swipe first, and it is not decoration: on a narrow viewport the opening follow-cam is
  // still trailing the taxi, and it would tow the framing straight back onto the car this test is
  // about to lose. The swipe is how the camera becomes the player's — which is also the only way a
  // player ever ends up in this state.
  //
  // The origin is picked again rather than reusing `panStart` from the pan checks above: a press on
  // the route band is a grab rather than a pan (deliberately — see the band checks), the taxi has
  // driven half the city since that point was chosen, and a swipe that silently became a band drag
  // leaves the follow-cam holding the camera and this whole block failing several steps later.
  const swipeFrom = JSON.parse(await evaluate(`(() => {
    const spots = [[200, 420], [80, 700], [320, 200], [60, 180], [330, 770], [200, 640]];
    for (const [x, y] of spots) if (!window.__taxi.pathDrag.hitTest(x, y)) return JSON.stringify({x, y});
    return JSON.stringify({x: 200, y: 420});
  })()`));
  await dragFrom(swipeFrom.x, swipeFrom.y, 120, 80);

  // Then 250 units clear of the taxi, which puts it off the frame on any viewport this could run
  // at — the frustum is 52 world units tall and the widest this page gets is a couple of hundred
  // across. Written onto the camera target rather than swiped the whole way, because how far a
  // finger can drag is not what is being asserted.
  //
  // `update()` after the write, and it is not optional: `state.target` is where the camera *wants*
  // to be, and only `apply()` copies that onto the camera itself. Nothing in the frame loop does it
  // for an idle camera — the pan branch is a no-op when there is no pan — so a written target with
  // no repaint leaves the projection this chip reads pointing exactly where it was, and the car
  // sitting in the middle of the frame while `state.target` says otherwise.
  await evaluate(`(() => {
    const cam = window.__taxi.camera, taxi = window.__taxi.traffic.taxi;
    cam.cancelGlide();
    cam.state.target.set(taxi.x + 250, 0, taxi.z + 250);
    cam.update(innerWidth / innerHeight);
  })()`);

  // Polled: the chip waits out a short dwell before it appears (SHOW_DELAY), and this page renders
  // in software at ~10fps with a clamped dt, so sim time runs at a fraction of wall clock.
  let finderUp = false;
  for (let attempt = 0; attempt < 20 && !finderUp; attempt++) {
    await sleep(250);
    finderUp = await evaluate('window.__taxi.taxiFinder.isUp()');
  }
  // Drawn as well as up. The framing is *computed* from the car's own dimensions, so the failure
  // mode is a live chip with the taxi framed off the side of it — which reads as an empty disc on
  // screen and as a pass from the DOM. Same one-task readback as the cargo chip above: the
  // renderer does not preserve its drawing buffer.
  const finder = JSON.parse(await evaluate(`(() => {
    window.__taxi.taxiFinder.render();
    const el = document.getElementById('taxi-finder');
    const src = el.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let drawn = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) drawn += 1;
    return JSON.stringify({ on: el.classList.contains('is-on'),
      hidden: el.getAttribute('aria-hidden'), drawn: drawn / (data.length / 4) });
  })()`));
  // A chip that never appears has half a dozen reasons it might not have, all of them off-screen
  // state — an unfinished tutorial still holding the camera, a run that ended during the sleeps
  // above, a camera that was towed back onto the car. An intermittent "it never appeared" with
  // none of that attached is unactionable, so the failure carries it.
  const finderWhy = finderUp ? '' : ` — ${await evaluate(`JSON.stringify({
    over: window.__taxi.fares.state.gameOver,
    gliding: window.__taxi.camera.isGliding(),
    holds: Boolean(window.__taxi.tutorial && window.__taxi.tutorial.holdsCamera()),
    car: window.__taxi.taxiScreenPosition(),
    frame: [innerWidth, innerHeight],
  })`)}`;
  check('the taxi chip comes up once the car is off screen',
    finderUp && finder.on === true && finder.hidden === 'false' && finder.drawn > 0.15,
    finderUp ? `${(finder.drawn * 100).toFixed(0)}% of the canvas drawn`
      : `the chip never appeared${finderWhy}`);

  // The taxi's flourish, summed across the car rather than maxed. `setTaxiHighlight` lifts the
  // emissive of five parts together (shell, roof sign, both steered wheels, the deck box), and the
  // sign and the lamps already sit at a constant 1 — so the *brightest* part of this car is 1 with
  // or without a flash, and only the total moves. Read at rest first: what is asserted below is the
  // rise, not an absolute.
  const taxiLift = () => evaluate(`(() => {
    let sum = 0;
    window.__taxi.traffic.taxiGroup.traverse((n) => {
      if (n.material && n.material.emissive) sum += n.material.emissive.r;
    });
    return sum;
  })()`);
  const restLift = await taxiLift();

  // The tap rides the camera back rather than cutting to the car — the same distinction the rider
  // peek is checked on, and invisible for the same reason: a pan and a cut are identical once they
  // have landed. Synchronously after the click: a glide is queued and the camera has not moved.
  const backTap = JSON.parse(await evaluate(`(() => {
    const cam = window.__taxi.camera;
    const before = cam.state.target.toArray();
    document.getElementById('taxi-finder').click();
    return JSON.stringify({ gliding: cam.isGliding(), before, after: cam.state.target.toArray() });
  })()`));
  const backParked = backTap.before.every((v, i) => v === backTap.after[i]);
  check('tapping the taxi chip rides back instead of cutting', backTap.gliding && backParked,
    !backTap.gliding ? 'no ride started'
      : backParked ? 'ride queued, camera still parked' : 'the camera cut straight to the taxi');

  // ...and it arrives, on a car that has been driving the whole way — and the car flashes as it
  // lands. Both are watched by the one loop, because the flash *starts* on the frame the ride
  // retires: a poll that stopped at `!gliding` would exit one tick before the thing it is looking
  // for. It runs on at 120ms until the lift has been seen, which is well inside the flourish's
  // 0.29s of sim time (this page renders in software, so sim time runs slower than the clock).
  let backGap = null;
  let peakLift = restLift;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(120);
    const s = JSON.parse(await evaluate(`(() => {
      const t = window.__taxi.camera.state.target, taxi = window.__taxi.traffic.taxi;
      let lift = 0;
      window.__taxi.traffic.taxiGroup.traverse((n) => {
        if (n.material && n.material.emissive) lift += n.material.emissive.r;
      });
      return JSON.stringify({ gliding: window.__taxi.camera.isGliding(), lift,
        gap: Math.hypot(t.x - taxi.x, t.z - taxi.z) });
    })()`));
    peakLift = Math.max(peakLift, s.lift);
    if (!s.gliding) {
      if (backGap === null) backGap = s.gap;
      if (peakLift > restLift + 0.05) break;
    }
  }
  // A few units of slack for the frames between the landing and the poll that reads it: the car is
  // still driving, and on a wide viewport nothing follows it once the ride has handed over.
  check('the ride back lands on the taxi', backGap !== null && backGap < 12,
    backGap === null ? 'never settled' : `${backGap.toFixed(1)} units off the car`);
  // The flourish that says *this car, here* — the same one a courier box landing fires. Measured as
  // a rise over rest rather than against a number: five parts take `HIGHLIGHT * popHighlight(t)`
  // together, so a peak-height flash is 5 × 0.32 × 0.944 = 1.51 and any tick inside the envelope is
  // some fraction of that. Anything clearly over the noise floor means it fired.
  check('and the taxi flashes when it lands', peakLift > restLift + 0.2,
    `emissive across the car ${restLift.toFixed(2)} → ${peakLift.toFixed(2)}`);
  check('and the chip takes itself down again',
    (await evaluate('window.__taxi.taxiFinder.isUp()')) === false);

  // --- The "Add to Home Screen" nudge shows on iOS and nowhere else.
  //
  // This is here rather than in the node suite because the whole feature is a user-agent test, and
  // it is here rather than left to a phone because it is the kind of check that rots silently: the
  // card is invisible on every machine the game is developed on, so a broken condition would ship
  // and only ever be noticed as "it never prompts" (or, worse, as a desktop player being told to
  // tap a share sheet that isn't there).
  //
  // The counter in localStorage is the signal, not just the card: `createHomeScreenTip` writes it
  // only on a load it has decided to show on, so an absent key means the module bowed out — where
  // an absent card could equally be one that has already timed out.
  // Nothing is remembered between loads any more — the screen shows until the game is *installed* —
  // so the absence of the overlay is the whole signal, and it is a sound one here: this page was
  // never tapped on `#home-tip`, and the screen has no timeout of its own, so one that had appeared
  // would still be up.
  const tipSheet = "Boolean(document.querySelector('#home-tip .home-tip-sheet'))";
  check('no Home Screen screen off iOS', (await evaluate(tipSheet)) === false);

  // A second page, this one pretending to be an iPhone. Emulation has to be in place before the
  // navigation, so it can't be done to the page above.
  {
    const ios = await fetchJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    const iosClient = connect(ios.webSocketDebuggerUrl);
    await iosClient.ready;
    await iosClient.send('Runtime.enable');
    await iosClient.send('Page.enable');
    await iosClient.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await iosClient.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
    await iosClient.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await iosClient.send('Page.navigate', { url: baseUrl });

    const iosEval = async (expression) => {
      const { result } = await iosClient.send('Runtime.evaluate', {
        expression, returnByValue: true,
      });
      return result.value;
    };

    // The screen is on a timer from load, and this page renders in software — poll rather than
    // sleeping a guessed amount.
    let shown = false;
    const tipDeadline = Date.now() + 20000;
    while (Date.now() < tipDeadline) {
      if (await iosEval(tipSheet)) { shown = true; break; }
      await sleep(300);
    }
    check('Home Screen screen shows on iOS', shown);

    if (shown) {
      // The route to the share sheet, in order. Current iOS collapses Share behind the ⋯ menu, so
      // the list opens there — a two-step list starting at Share would name a first tap that is not
      // on the player's screen, and it would render perfectly while doing it, so only reading the
      // labels back catches it.
      const steps = JSON.parse(await iosEval(
        "JSON.stringify([...document.querySelectorAll('#home-tip .step-name')].map(s => s.textContent.trim()))",
      ));
      check('the steps name the route in order',
        JSON.stringify(steps) === JSON.stringify(['More', 'Share', 'Add to Home Screen']),
        steps.join(' → '));

      // The run is parked behind it: no fare may spawn while the screen is waiting to be tapped,
      // or its 60-second clock is draining under the black.
      check('the run is held while it is up',
        (await iosEval('window.__taxi.fares.waitingAll().length')) === 0
        && (await iosEval('window.__taxi.fares.carrying() === null')));

      // Tapping anywhere puts it away...
      await iosEval("document.getElementById('home-tip')"
        + ".dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
      await sleep(600);
      check('tapping dismisses it', await iosEval("document.getElementById('home-tip').hidden"));

      // ...and the run starts, which means the hold was released rather than just hidden.
      //
      // What comes off that hold first is the **opening vignette**, not the fare board: `isBlocked`
      // chains the three openers, so the board is not seeded until the taxi is out of its garage,
      // which is a minute of wallclock under a software renderer. The vignette leaving `wait` is
      // the same evidence a spawn used to be and it arrives immediately — with the spawn still
      // accepted, for a seed that happens to host no depot at all.
      let started = false;
      const startDeadline = Date.now() + 20000;
      while (Date.now() < startDeadline) {
        const phase = await iosEval(
          'window.__taxi.opening() ? window.__taxi.opening().phase() : "none"');
        if ((phase !== 'wait' && phase !== 'none')
          || await iosEval('window.__taxi.fares.waitingAll().length > 0')) {
          started = true;
          break;
        }
        await sleep(400);
      }
      check('the run starts once it is dismissed', started);

      // It comes back on the next load: nothing is remembered, because the thing it asks for is the
      // thing that switches it off. Dismissing it must not have persisted anything.
      await iosClient.send('Page.reload');
      let returned = false;
      const againDeadline = Date.now() + 20000;
      while (Date.now() < againDeadline) {
        if (await iosEval(tipSheet)) { returned = true; break; }
        await sleep(300);
      }
      check('it returns on the next load', returned);
    }

    iosClient.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${ios.id}`).catch(() => {});
  }

  // --- The high-score table survives a real page load.
  //
  // `tools/scores.mjs` covers the ranking and every way storage can misbehave, but it does that
  // against a fake store — so the one thing it cannot prove is that the real `localStorage` round
  // trip works in a browser. That is the whole feature: a score written on one load has to be
  // there on the next. Done over `__taxi.scores` rather than by playing a run to its end, which
  // would take a minute of wall clock to assert a persistence property that has nothing to do
  // with how the run finished.
  {
    await evaluate(`(() => {
      window.__taxi.scores.clear();
      window.__taxi.scores.record({ cash: 321, fares: 7, seconds: 140, shift: 'Busy' })
        .setName('SMK');
    })()`);
    check('a score lands in real localStorage',
      (await evaluate('window.__taxi.scores.load()[0]?.name')) === 'SMK');

    await client.send('Page.reload');
    let reloaded = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate('Boolean(window.__taxi?.scores)').catch(() => false)) { reloaded = true; break; }
      await sleep(300);
    }
    const kept = reloaded ? await evaluate('window.__taxi.scores.load()[0]?.cash') : null;
    check('and is still there after a reload', kept === 321, reloaded ? `cash ${kept}` : 'page never came back');

    // Leave nothing behind: the offline check below reloads this same page, and a table seeded by
    // the smoke test is not something a later run should find sitting there.
    await evaluate('window.__taxi.scores.clear()');
  }

  // --- A Loco Mode tuning survives a reload, and only under `?debug`.
  //
  // `tools/probe.mjs` drives `game/locostash.js` against a fake store, so the storage behaviour is
  // covered. What only a browser can prove is the half that lives in main.js: that a stash written
  // on one load is applied on the next, and — the one that matters — that it is *not* applied
  // without `?debug`. A wreck ends the run and Retry is a page reload, so this is the path a
  // tuning session actually takes, and the gate is what keeps a 170 u/s taxi out of an ordinary
  // run whose score goes on the table.
  {
    const boot = async (query) => {
      await client.send('Page.navigate', { url: `${baseUrl}${query}` });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await evaluate('Boolean(window.__taxi?.loco)').catch(() => false)) return true;
        await sleep(300);
      }
      return false;
    };

    const up = await boot('?debug');
    // A tuning nothing else would produce, so a "restored" reading cannot be the defaults in
    // disguise. Written through the same handle the panel's sliders use.
    if (up) {
      await evaluate(`(() => {
        window.__taxi.loco.set({ overdriveSpeed: 3.9, accel: 41 });
        window.__taxi.loco.save();
      })()`);
    }
    check('a Loco tuning lands in real localStorage', up
      && (await evaluate('JSON.parse(localStorage.getItem("simtaxi.loco.v1")).overdriveSpeed')) === 3.9,
      up ? 'stashed' : 'page never came back');

    const back = await boot('?debug');
    const restored = back ? await evaluate('window.__taxi.loco.get()') : null;
    check('and is applied on the next load under ?debug',
      restored?.overdriveSpeed === 3.9 && restored?.accel === 41,
      JSON.stringify(restored));

    const plain = await boot('');
    const shipped = plain ? await evaluate('window.__taxi.loco.get()') : null;
    const defaults = plain ? await evaluate('window.__taxi.loco.defaults') : null;
    check('but never without it — an ordinary run is the shipped game',
      JSON.stringify(shipped) === JSON.stringify(defaults),
      JSON.stringify(shipped));
    // The stash is still there; a load without ?debug must not have cleared it either, or the
    // gate would be "forget on sight" rather than "ignore".
    check('and the stash is left intact for the next debug session',
      (await evaluate('JSON.parse(localStorage.getItem("simtaxi.loco.v1")).overdriveSpeed')) === 3.9,
      'kept');

    // Leave nothing behind, and leave the page where the checks below expect it: freshly booted
    // on the plain URL, same as the score check above left it.
    await evaluate('localStorage.removeItem("simtaxi.loco.v1")');
    await boot('');
  }

  // --- The spacebar holds Loco Mode.
  //
  // Here rather than in the node suite because the whole feature is key plumbing: `boost.press()`
  // is already covered there, and what only a browser can prove is that a real keystroke reaches
  // it — through the modifier and auto-repeat guards, through the focus test that decides whether
  // the key belongs to the game or to whatever control has focus, and past a raised pause veil.
  //
  // Last of the checks on this page on purpose. Collision detection is armed for the whole of a
  // boost and its one-second tail, so a burst of speed can legitimately end the run — every check
  // above wants a live one, and everything below (service worker, offline reload) does not care.
  // The page was reloaded by the score check just above, so the tank is full-ish and fresh.
  //
  // These *are* CDP `Input` events rather than synthetic DOM ones: unlike `dispatchMouseEvent`
  // (see the tap checks near the top, which this configuration swallows), key events do arrive.
  {
    const mode = () => evaluate('window.__taxi.boost.state.mode');
    const key = (type) => client.send('Input.dispatchKeyEvent', {
      type, code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });

    // A paused run takes no input at all. First, before anything below has spent fuel or risked a
    // wreck: `canPause` refuses on a game over, so a crashed taxi would fail this for the wrong
    // reason. `frame()` returns before `boost.update`, so a press behind the veil would sit in
    // 'active' burning nothing and then resume into a launch nobody asked for.
    // Blurred on purpose: leaving focus on ⏸ would make the *focus* guard bow out first, and this
    // check would pass without the pause guard existing at all.
    await evaluate("document.getElementById('pause').click();"
      + ' document.activeElement?.blur();');
    await sleep(150);
    await key('rawKeyDown');
    await key('keyUp');
    await sleep(150);
    const behindVeil = await mode();
    check('a paused run ignores the key', behindVeil !== 'active', `mode ${behindVeil}`);
    await evaluate(`(() => { document.querySelector('#pause-veil .pause-resume').dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 8, isPrimary: true, bubbles: true, cancelable: true }));
    })()`);
    await sleep(300);

    const before = await mode();
    await key('rawKeyDown');
    await sleep(200);
    const held = await mode();
    const engaged = await evaluate('window.__taxi.traffic.taxi.boost');
    check('space holds Loco Mode', before === 'ready' && held === 'active' && engaged === true,
      `${before} → ${held}, taxi.boost ${engaged}`);

    // ...and the frame pushes in behind it (LOCO_PUNCH in game/camera.js). Checked here rather than
    // only in the probe because everything that could kill it lives outside the camera module: the
    // narrow-viewport gate, the hold clock, and the two claims that set the zoom themselves. A dead
    // gate leaves the module perfect and the effect absent, with nothing failing anywhere. Polled
    // on *sim* time — the hold has to clear LOCO_PUNCH_HOLD, and this page renders in software.
    let pushed = 1;
    for (let attempt = 0; attempt < 40 && pushed > 0.99; attempt++) {
      await sleep(250);
      pushed = await evaluate('window.__taxi.camera.state.punch');
    }
    check('and the frame pushes in behind the hold', pushed < 0.99,
      `punch ${pushed.toFixed(3)}`);

    await key('keyUp');
    await sleep(200);
    const released = await mode();
    // 'cooldown', not 'ready': releasing passes through the one-second momentum window first.
    check('and releasing it lets go', released !== 'active', `${held} → ${released}`);

    // And gives it back. Same poll, other direction: the way out rides the release rather than
    // snapping, so this is a wait, not a read.
    let reopened = pushed;
    for (let attempt = 0; attempt < 40 && reopened < 1; attempt++) {
      await sleep(250);
      reopened = await evaluate('window.__taxi.camera.state.punch');
    }
    check('and the frame opens back up on the release', reopened === 1, `punch ${reopened}`);

    // Wait out the tail — it is a second of *sim* time, and this page renders in software.
    let settled = released;
    for (let attempt = 0; attempt < 40 && settled === 'cooldown'; attempt++) {
      await sleep(250);
      settled = await mode();
    }

    // Space is the browser's own activation key for whatever has focus. A player typing their
    // initials into the score prompt must not be flooring it with every word break — and the key
    // has to stay the field's, which means the game must not `preventDefault` one it declined to
    // act on. The probe listener reads that back: it is registered after the game's, on the same
    // target and phase, so it sees the decision the game just made.
    await evaluate(`(() => {
      const i = document.createElement('input');
      i.id = 'smoke-focus-probe';
      document.body.appendChild(i);
      i.focus();
      window.__spaceProbe = null;
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') window.__spaceProbe = e.defaultPrevented;
      }, { once: true });
    })()`);
    await key('rawKeyDown');
    await key('keyUp');
    await sleep(200);
    const swallowed = await evaluate('window.__spaceProbe');
    const whileTyping = await mode();
    check('a focused text field keeps the key',
      whileTyping !== 'active' && swallowed === false,
      `mode ${settled} → ${whileTyping}, key ${swallowed ? 'taken by the game' : 'left alone'}`);
    await evaluate("document.getElementById('smoke-focus-probe').remove();"
      + ' delete window.__spaceProbe;');

    // ...but the pill is the one control where the key and the focus mean the same thing, so it
    // keeps working after a player has clicked it — the case that would otherwise go quietly dead,
    // since the browser answers a focused button with a synthesised `click` nothing listens for.
    await evaluate("document.getElementById('boost').focus()");
    await key('rawKeyDown');
    await sleep(200);
    const onPill = await mode();
    check('the key survives clicking the pill', onPill === 'active', `mode ${onPill}`);
    await key('keyUp');
    await evaluate('document.activeElement?.blur()');

    // The pill's gesture surface. Reported as "the button text is selectable, and double-tapping it
    // zooms": on iOS a thumb resting on the pill picked out "Loco Mode™", raised the magnifier and
    // zoomed the whole city in, because iOS 15 stopped honouring `-webkit-user-select: none` for
    // those gestures (webkit.org/b/231161). Three things hold it off and none of them is visible in
    // a screenshot, so they are asserted here.
    //
    // The hit test is the load-bearing one, and it is a hit test rather than a style read on
    // purpose: what matters is that a finger on the middle of the pill lands on the *button*, which
    // is true only while the label stays wrapped and out of hit-testing. Unwrap it and this fails;
    // read `.boost-label`'s `pointer-events` instead and it would still pass with the span gone.
    //
    // `hud-ready` first, and then a wait for the entrance to land. The score check above reloaded
    // the page, so the tutorial is talking and the pill is still parked 200% below the bottom edge —
    // where `elementFromPoint` is outside the viewport and answers "nothing" whatever the label is
    // doing. The keyboard checks above never noticed because a keystroke does not care where the
    // pill is.
    await evaluate("document.body.classList.add('hud-ready')");
    await sleep(600);
    const gestures = JSON.parse(await evaluate(`(() => {
      const b = document.getElementById('boost');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const cs = getComputedStyle(b);
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const inherited = getComputedStyle(probe).touchAction;
      probe.remove();
      return JSON.stringify({
        hit: hit ? (hit.id || hit.className || hit.tagName) : 'nothing',
        touchAction: cs.touchAction, userSelect: cs.userSelect, unstyled: inherited,
      });
    })()`));
    check('a thumb on the pill lands on the pill, not its label',
      gestures.hit === 'boost', `hit ${gestures.hit}`);
    check('the pill takes no browser gesture',
      gestures.touchAction === 'none' && gestures.userSelect === 'none',
      `touch-action ${gestures.touchAction}, user-select ${gestures.userSelect}`);
    // `touch-action` does not inherit, so the root-level declaration that covers selection cannot
    // cover this — every element computes its own. The `*` rule is what stops an unstyled corner of
    // the HUD from zooming the city on a double tap; a fresh div is the cheapest way to read it.
    check('nothing else on the page double-taps to zoom',
      gestures.unstyled === 'manipulation', `unstyled element ${gestures.unstyled}`);

    // --- The brake, the other half of the bottom row.
    //
    // All of it is browser-only wiring: the sim's side (`taxi.braking` stops the car, hard, from
    // anywhere) is asserted deterministically in the probe, and none of that is reachable if the
    // key never lands on the flag or the button sits under the pill. Last on this page for the same
    // reason the Loco key block is late — this stops the taxi in the road, and every check above
    // wants it driving.
    const brakeKey = (type) => client.send('Input.dispatchKeyEvent', {
      type, code: 'KeyB', key: 'b', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66,
    });

    const row = JSON.parse(await evaluate(`(() => {
      const b = document.getElementById('boost').getBoundingClientRect();
      const k = document.getElementById('brake').getBoundingClientRect();
      const hit = document.elementFromPoint(k.x + k.width / 2, k.y + k.height / 2);
      const cs = getComputedStyle(document.getElementById('brake'));
      return JSON.stringify({
        share: k.width / (b.width + k.width), gap: Math.round(k.x - (b.x + b.width)),
        sameRow: Math.abs(k.bottom - b.bottom) < 1 && Math.abs(k.height - b.height) < 1,
        hit: hit ? (hit.id || hit.className || hit.tagName) : 'nothing',
        touchAction: cs.touchAction, userSelect: cs.userSelect,
      });
    })()`));
    // 40% of the two buttons together, give or take the gap between them.
    check('the brake takes the right 40% of the bottom row',
      row.sameRow && row.gap > 0 && Math.abs(row.share - 0.4) < 0.03,
      `${(row.share * 100).toFixed(1)}% of the row, ${row.gap}px gap, same row ${row.sameRow}`);
    check('a thumb on the brake lands on the brake, not its label',
      row.hit === 'brake' && row.touchAction === 'none' && row.userSelect === 'none',
      `hit ${row.hit}, touch-action ${row.touchAction}, user-select ${row.userSelect}`);

    // Press it on a moving car — a taxi sitting at a red would stop trivially and lay no rubber.
    // Bounded: if it never moves the checks below say so rather than hanging.
    let rolling = 0;
    for (let attempt = 0; attempt < 60 && rolling < 4; attempt++) {
      await sleep(250);
      rolling = await evaluate('window.__taxi.traffic.taxi.v');
    }
    // Live marks in the skid ring buffer, counted off the alpha the fade writes. main.js is
    // browser-only, so this stamping — four wheels, on the press itself — has no other home: the
    // probe can assert the physics but never that anything was drawn for it.
    const liveMarks = `(() => {
      const c = window.__taxi.skids.mesh.geometry.attributes.color;
      let live = 0;
      for (let i = 0; i < c.count; i += 6) if (c.array[i * 4 + 3] > 0) live += 1;
      return live;
    })()`;
    const marksBefore = await evaluate(liveMarks);

    await brakeKey('rawKeyDown');
    await sleep(200);
    const pedal = await evaluate('window.__taxi.traffic.taxi.braking');
    const lit = await evaluate("document.getElementById('brake').classList.contains('is-on')");
    const marksAfter = await evaluate(liveMarks);
    check('and lays rubber off all four wheels as it goes',
      rolling >= 4 && marksAfter - marksBefore >= 4,
      `${marksAfter - marksBefore} marks stamped at ${rolling.toFixed(1)} u/s`);
    // Polled on sim time: this page renders in software, and the stop is 16.5 units at the very
    // worst. Zero, not "slow" — the pedal's whole claim is a dead stop.
    let speed = 1;
    for (let attempt = 0; attempt < 40 && speed > 0; attempt++) {
      await sleep(250);
      speed = await evaluate('window.__taxi.traffic.taxi.v');
    }
    check('holding B screeches the taxi to a halt',
      pedal === true && lit === true && speed === 0,
      `braking ${pedal}, button lit ${lit}, taxi at ${speed} u/s`);

    await brakeKey('keyUp');
    await sleep(200);
    const lifted = await evaluate('window.__taxi.traffic.taxi.braking');
    const dark = await evaluate("document.getElementById('brake').classList.contains('is-on')");
    check('and letting go hands the car back', lifted === false && dark === false,
      `braking ${lifted}, button lit ${dark}`);
  }

  // --- The initials prompt: after a tap, the field still has to be editable.
  //
  // The value is one centred 16px text run inside a box of three big cells, so a tap on the *first*
  // cell is a tap well left of the text and the browser collapses the caret to offset 0. With a
  // pre-filled name that is a dead field — backspace at the start of the value deletes nothing, and
  // `maxlength` blocks every letter because three characters are already in there. The keyboard is
  // up, the player types, and nothing on screen moves. That is what "I can't delete or edit" was.
  // `caretToEnd` in runend.js pins the caret to the end of the value; this is the check that it
  // still does.
  //
  // A real touch, not a synthesised one. An untrusted event does not place a caret, so a synthetic
  // click would sail through this check against the exact bug it exists to catch.
  //
  // Reduced motion, so the prompt is on screen in one frame rather than 3.5s into the stat count —
  // and, usefully, that path deliberately skips the programmatic `focus()`, which leaves the tap as
  // the only thing that can focus the field. Which is the case on a phone anyway: iOS only opens
  // the keyboard inside a user gesture.
  await client.send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`window.__taxi.showRunEnd({
    scores: { rank: 1, id: 'smoke', name: 'TWA', entries: [], onName: () => [] },
  })`);
  await sleep(400);

  const firstCell = JSON.parse(await evaluate(`(() => {
    const cell = document.querySelector('.score-cell');
    if (!cell) return 'null';
    const r = cell.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`) ?? 'null');

  if (!firstCell) {
    check('tapping the initials leaves an editable field', false, 'no prompt on screen');
  } else {
    await client.send('Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [{ x: firstCell.x, y: firstCell.y, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);

    const focused = await evaluate(
      "document.activeElement === document.querySelector('.score-input')");
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type, code: 'Backspace', key: 'Backspace', text: type === 'keyDown' ? '\b' : undefined,
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
    }
    await sleep(200);
    const typed = JSON.parse(await evaluate(`(() => {
      const i = document.querySelector('.score-input');
      return JSON.stringify({ value: i.value, cells: [...document.querySelectorAll('.score-cell')].map((c) => c.textContent).join('') });
    })()`));

    check('a tap on the initials focuses the field', focused);
    // The cells are the display, so they are checked alongside the value — a field that edits
    // correctly behind three stale letters is the same bug from the player's side.
    check('tapping the initials leaves an editable field',
      typed.value === 'TW' && typed.cells === 'TW',
      `"TWA" + tap cell 0 + backspace → value "${typed.value}", cells "${typed.cells}"`);
  }

  await evaluate("document.getElementById('run-end').hidden = true");
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await client.send('Emulation.setEmulatedMedia', { features: [] });

  // --- The crash panel opens for this page's crashes and nobody else's.
  //
  // A cross-origin script's exception reaches `window.onerror` anonymised — `Script error.` at
  // `:0:0`, no `error` object — and iOS Safari raises one from the page menu's Search item on an
  // ordinary tab. The panel is `inset: 0`, so honouring that paints a message naming nothing over
  // a game that is running perfectly. Both directions are checked, because "ignore errors" passes
  // the first half on its own and takes the boot-failure panel down with it.
  const panelOpensFor = async (init) => evaluate(`(() => {
    const el = document.getElementById('error');
    el.textContent = ''; el.hidden = true;
    window.dispatchEvent(new ErrorEvent('error', ${JSON.stringify(init)}));
    const open = !el.hidden;
    el.textContent = ''; el.hidden = true;
    return open;
  })()`);

  check('a foreign script error leaves the game on screen',
    (await panelOpensFor({ message: 'Script error.', filename: '', lineno: 0, colno: 0 })) === false);
  check('and this page\'s own crashes still open the panel',
    (await panelOpensFor({ message: 'boom', filename: `${baseUrl}/src/main.js`, lineno: 12, colno: 3 })) === true);

  // --- Offline: a Home Screen launch has to work with no connection at all. This only proves
  // anything run against a built preview (`--url http://localhost:4173`) — the worker registration
  // in main.js is skipped under `import.meta.env.DEV` on purpose, since the dev server rewrites
  // module URLs on every change and a worker caching those responses would serve stale code back
  // mid-session. See public/sw.js.
  //
  // The HTTP cache is disabled before going offline so a pass can only mean the reload was served
  // from the worker's Cache Storage — Chrome's ordinary disk cache would otherwise paper over a
  // worker that isn't actually caching anything, since both are populated by the same first visit.
  const swControlled = await evaluate('Boolean(navigator.serviceWorker.controller)');
  check('page is controlled by the service worker', swControlled);

  if (swControlled) {
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await client.send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await client.send('Page.reload');

    let bootedOffline = false;
    const offlineDeadline = Date.now() + 15000;
    while (Date.now() < offlineDeadline) {
      if (await evaluate('Boolean(window.__taxi?.traffic?.taxi)').catch(() => false)) {
        bootedOffline = true;
        break;
      }
      await sleep(300);
    }
    check('the game boots with no connection', bootedOffline);

    await client.send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await client.send('Network.setCacheDisabled', { cacheDisabled: false });
  } else {
    check('the game boots with no connection', false, 'no service worker controlling the page');
  }

  check('no uncaught exceptions', client.errors.length === 0, client.errors.join(' | '));
} catch (err) {
  check('smoke run completed', false, err.message);
} finally {
  client?.close();
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
