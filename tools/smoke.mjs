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

  // --- Tap the taxi: it should select.
  // Synthetic DOM click rather than CDP's Input domain. Input.dispatchMouseEvent is accepted in
  // this headless configuration but never synthesises a DOM click — the page observes nothing at
  // all — so it silently tests neither the picker nor anything else. This does exercise the real
  // listener, raycast and hit-test path; it just doesn't cover Chrome's OS-level input plumbing.
  // `body > canvas` rather than `canvas`. The game's canvas is appended to the body, but every
  // rider-finder chip carries a 38px WebGL canvas of its own inside `#rider-finder-stack`, which
  // is *earlier* in the DOM — so as soon as a rider is waiting, a bare `querySelector('canvas')`
  // hands back a chip. Every gesture below was landing on that: the drag check failed because
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

  // --- Pause holds the whole frame, and a tap anywhere lets it go.
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

  // `pointerdown`, which is what the veil actually listens for — a `click` here would pass while
  // the press-to-resume path was broken.
  await evaluate(`(() => { document.getElementById('pause-veil').dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 7, isPrimary: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(700);
  const resumed = await elapsed();
  check('and a tap anywhere resumes it',
    resumed > stillHeld && (await evaluate("document.getElementById('pause-veil').hidden")),
    `elapsed ${stillHeld.toFixed(2)} → ${resumed.toFixed(2)}`);

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
    // *taxi* to have covered ground and then asks whether the camera came with it. The follow-cam
    // trails by design (rate 1.5 against ~8.5 u/s is a steady-state lag of about 5.7 units, and
    // this page renders slowly enough to stretch that), so the gap is checked loosely and the
    // camera's own travel is what carries the assertion.
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
    // Asserted as "the taxi got well clear of where the camera was left, and the camera is not
    // there": a parked camera ends up `drove` units behind, so the two thresholds together are
    // what separate following from parked. The taxi's own travel has to clear the follow-cam's
    // steady-state lag for that to mean anything, which is why it is polled for rather than timed.
    check('and the camera stays with the taxi afterwards',
      ended !== null && drove > 12 && gap < 10,
      `taxi drove ${drove.toFixed(1)}, camera moved ${camMoved.toFixed(1)}, `
      + `trailing by ${gap.toFixed(1)}`);
  } else {
    check('a chip tap pans instead of cutting', false,
      narrow ? 'no waiting rider on screen to tap' : 'viewport is not narrow');
  }

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

      // ...and the fare loop starts, which means the hold was released rather than just hidden.
      let spawned = false;
      const spawnDeadline = Date.now() + 20000;
      while (Date.now() < spawnDeadline) {
        if (await iosEval('window.__taxi.fares.waitingAll().length > 0')) { spawned = true; break; }
        await sleep(400);
      }
      check('the run starts once it is dismissed', spawned);

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
    await evaluate(`(() => { document.getElementById('pause-veil').dispatchEvent(
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

    await key('keyUp');
    await sleep(200);
    const released = await mode();
    // 'cooldown', not 'ready': releasing passes through the one-second momentum window first.
    check('and releasing it lets go', released !== 'active', `${held} → ${released}`);

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
