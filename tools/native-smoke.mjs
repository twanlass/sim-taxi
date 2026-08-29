/**
 * Browser smoke test for the **iOS native fork** — the one behavioural difference between the web
 * build and the App Store build.
 *
 *   npm run build && npm run preview &
 *   node tools/native-smoke.mjs --url http://localhost:4173
 *
 * The shell injects `window.__native = true` before any page script runs (a `WKUserScript` at
 * `.atDocumentStart` — see `ios/SimTaxi/GameViewController.swift`), and three places in the web code
 * read it through `isNative()` in `src/util/platform.js`. This loads the *same production bundle*
 * twice, once with that injection and once without, and asserts each fork in both directions.
 *
 * **Why this needs to exist.** Every one of these differences is invisible on the web — the whole
 * point of the flag is that the web build behaves exactly as it always did — so nothing else in the
 * suite would notice any of them regressing. The one that matters most is the Add-to-Home-Screen
 * gate: neither `navigator.standalone` nor `display-mode: standalone` is true inside a WKWebView, so
 * left alone the App Store build opens, every launch, on a full-screen panel telling the player to
 * go install the game from Safari's share sheet — with the run held behind it. That is an App Store
 * rejection, and it would ship completely silently.
 *
 * Not part of `npm run check`: that suite is node-only and ~2s, and this needs a browser and a
 * server. Same standing as `tools/smoke.mjs`, which it borrows its Chrome handling from.
 *
 * **Two Chrome instances, two profiles, one per probe.** A shared profile makes the service-worker
 * assertion meaningless — a registration persists per origin, so the second probe reads back the
 * first probe's worker and "not registered" passes for the wrong reason. That is not hypothetical;
 * it is what the first version of this file did.
 *
 * **Both probes spoof an iPhone.** `game/homescreen.js` asks `isIOS()` before it asks
 * `isInstalled()`, so on a desktop UA the gate never constructs either way and the most important
 * check here would pass against a completely broken build.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same env overrides as tools/smoke.mjs and tools/shoot.mjs.
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const baseUrl = arg('url', 'http://localhost:4173');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// The gate shows at `SHOW_AT = 800`ms; the rest is boot and the opening. Generous on purpose —
// a flaky "it didn't appear yet" reads identically to the bug this is here to catch.
const SETTLE_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Load the production bundle as one host would see it, and read back what forked. */
async function probe({ native, port }) {
  const profile = await mkdtemp(join(tmpdir(), 'native-smoke-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    '--headless=new', `--user-data-dir=${profile}`,
    // The trio tools/shoot.mjs uses to get real WebGL out of headless Chromium. Without them the
    // renderer throws, the game never reaches `window.__taxi`, and half of this file passes
    // vacuously against a page that did not run.
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ').filter(Boolean) : []),
    'about:blank',
  ], { stdio: 'ignore' });

  const cdpJson = async (path, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return JSON.parse(await res.text());
  };

  let client;
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try { await cdpJson('/json/version'); up = true; break; } catch { await sleep(200); }
    }
    if (!up) throw new Error(`chrome never opened a CDP port (tried ${CHROME})`);

    const target = await cdpJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
    });
    if (native) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__native = true;' });
    }
    await client.send('Page.navigate', { url: `${baseUrl}/` });
    await sleep(SETTLE_MS);

    const evalJs = async (expression) => {
      const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return r?.result?.value;
    };

    return {
      iosUA: await evalJs('/iPhone/.test(navigator.userAgent)'),
      booted: await evalJs('typeof window.__taxi === "object" && window.__taxi !== null'),
      nativeFlag: await evalJs('window.__native === true'),
      serviceWorkers: await evalJs('navigator.serviceWorker.getRegistrations().then((r) => r.length)'),
      dataNative: await evalJs("document.documentElement.hasAttribute('data-native')"),
      // `#home-tip` is a static empty `<div hidden>` that homescreen.js fills and unhides, so its
      // mere existence proves nothing — this asks whether it was populated and actually shown.
      gateShown: await evalJs(
        "(() => { const el = document.getElementById('home-tip');"
        + ' return Boolean(el) && !el.hidden && el.children.length > 0; })()',
      ),
      // The shell drives this on `applicationWillResignActive` to pause a run when the app stops
      // being frontmost. If the hook moves, backgrounding silently stops pausing.
      pauseHook: await evalJs('typeof window.__taxi?.pause?.setPaused === "function"'),
      // Haptics reach UIKit through a `WKScriptMessageHandler`, which does not exist in a browser —
      // so what is checked here is the *gate*, which is the half that can silently go wrong in
      // either direction. A stub stands in for the handler and records what the page posts to it:
      // the app build must post the event name it was given, and the web build must not post at
      // all, because on the open web `window.webkit` belongs to WebKit rather than to this app and
      // a stray `postMessage` into it is somebody else's message. The device half — whether the
      // Taptic Engine actually fires — has no witness but a thumb; `window.__taxi.haptic()` in
      // Safari Web Inspector is the manual counterpart, see src/main.js.
      // Every event in the vocabulary is fired, not a sample: the list in `util/haptics.js` and the
      // switch in `HapticsBridge.swift` are two halves of one contract kept in step by hand, and
      // the only failure this side can catch is a name the *web* half has stopped accepting.
      hapticPosted: await evalJs(`(() => {
        const seen = [];
        window.webkit = { messageHandlers: { haptics: { postMessage: (m) => seen.push(m) } } };
        for (const e of ['pick', 'grab', 'snap', 'brake', 'loco', 'parcel-in', 'parcel-out',
          'burger']) {
          window.__taxi.haptic(e);
        }
        return seen.join(',');
      })()`),
      // A name neither half knows must be loud on the way out rather than dropped on the way in:
      // the web bundle and the Swift shell ship separately, and an unrecognised event that fails
      // silently here would look exactly like a Taptic Engine that isn't firing.
      hapticRejectsUnknown: await evalJs(`(() => {
        try { window.__taxi.haptic('nope'); return false; } catch { return true; }
      })()`),

      // The panel must be *invisible* until something goes wrong, and `hidden` on its own does not
      // buy that here: `html[data-native] #error` sets an author `display`, and any author
      // `display` outranks the UA stylesheet's `[hidden] { display: none }`. So the attribute can
      // be present and correct while the element paints anyway — which is exactly what shipped:
      // the App Store build opened on a flat #2b1b1b screen laid over the whole game, with the HUD
      // still drawn on top of it and no text inside it, because `report()` had never run to fill
      // it in. Asked of the computed style rather than the attribute, and asked *before* the
      // synthetic error below, which is the thing that legitimately unhides it.
      panelIdleHidden: await evalJs(
        "(() => { const el = document.getElementById('error');"
        + " return el.hidden === true && getComputedStyle(el).display === 'none'; })()",
      ),
      // Forced rather than waited for: report a synthetic error and read what the panel decided
      // to say about it.
      panelText: await evalJs(`(() => {
        window.dispatchEvent(new ErrorEvent('error', {
          message: 'SYNTHETIC', filename: 'x.js', lineno: 1, colno: 1, error: new Error('SYNTHETIC'),
        }));
        return document.getElementById('error').textContent;
      })()`),
      errorLogged: await evalJs("(window.__errorLog || '').includes('SYNTHETIC')"),
    };
  } finally {
    client?.close();
    chrome.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  const web = await probe({ native: false, port: 9340 });
  const app = await probe({ native: true, port: 9341 });

  // Preconditions. If either fails, every assertion below is vacuous rather than wrong.
  check('both loads are on an iPhone UA', web.iosUA && app.iosUA);
  check('both loads boot the game', web.booted && app.booted,
    `web ${web.booted}, app ${app.booted}`);

  check('web: no native flag', web.nativeFlag === false);
  check('app: native flag set before page scripts', app.nativeFlag === true);

  check('web: service worker registers', web.serviceWorkers === 1, `${web.serviceWorkers} found`);
  check('app: service worker does not register', app.serviceWorkers === 0, `${app.serviceWorkers} found`);

  check('web: add-to-home-screen gate shows', web.gateShown === true);
  check('app: add-to-home-screen gate never shows', app.gateShown === false);

  const HAPTICS = 'pick,grab,snap,brake,loco,parcel-in,parcel-out,burger';
  check('app: every haptic event reaches the shell, in order',
    app.hapticPosted === HAPTICS, app.hapticPosted);
  check('web: haptics stay off the bridge entirely', web.hapticPosted === '', web.hapticPosted);
  check('both: an unknown haptic event throws rather than vanishing',
    app.hapticRejectsUnknown === true && web.hapticRejectsUnknown === true);

  check('web: error panel stays out of the way until it has something to say', web.panelIdleHidden === true);
  check('app: error panel stays out of the way until it has something to say', app.panelIdleHidden === true);

  check('web: error panel prints the stack', web.panelText.includes('SYNTHETIC'));
  check('app: error panel hides the stack', !app.panelText.includes('SYNTHETIC'));
  check('app: error panel says something a player can act on',
    app.panelText.includes('Something went wrong'));
  check('app: the detail is still captured for Web Inspector', app.errorLogged === true);
  check('app: root carries data-native for the panel CSS', app.dataNative === true);
  check('web: root does not', web.dataNative === false);

  check('app: the pause hook the shell calls still exists', app.pauseHook === true);
} catch (err) {
  check('native smoke run completed', false, err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
