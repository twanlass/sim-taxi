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

  const beforeDrag = await camTarget();
  await dragFrom(200, 420, 120, 80);
  check('dragging pans the camera', (await camTarget()) !== beforeDrag);

  // A press that never crosses the slop must leave the camera exactly where it was.
  const beforeTap = await camTarget();
  await dragFrom(200, 420, 3, 2);
  check('a tap does not pan the camera', (await camTarget()) === beforeTap);

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

    // And it arrives. Generous wait: the pan is under 0.75s of sim time, but this page renders in
    // software at ~10fps and the frame loop clamps dt, so wall-clock runs longer than sim time.
    await sleep(2000);
    const landed = JSON.parse(await camTarget());
    check('the pan lands and stops', !(await evaluate('window.__taxi.camera.isGliding()'))
      && Math.hypot(landed[0], landed[2]) > 5, `landed ${Math.hypot(landed[0], landed[2]).toFixed(1)} units out`);
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
