/**
 * The page's entry: the startup screen first, then the game behind it.
 *
 * The game is a dynamic import rather than this page's module script because evaluating it is one
 * long synchronous task (the whole city is built at module scope), and the startup screen has to be
 * built — its materials compiled — *before* that runs; see game/splash.js for why. The import is
 * issued once the splash's first frame — the ROCKET RIDES word, standing — has been presented: two
 * animation frames after it is drawn, so that frame, and not the black under it, is what stays on
 * screen while main.js evaluates (game/splash.js, `WAIT_LOGO`). It costs ~33ms on a load of seconds.
 * `?splashwait=classic` issues it at once, behind black, as it first shipped.
 *
 * Without a startup screen (`?splash=classic`, shot mode, `?dev`, `?title=off`, "Play again") the
 * game is imported straight away, and the page's black (`html.booting`) gives way to the sky once
 * the city has drawn.
 */
import { createSplash, wantsSplash, WAIT_LOGO } from './game/splash.js';
import { BACKDROP, announceReady } from './game/backdrop.js';

if (BACKDROP) document.documentElement.classList.add('backdrop');

const splash = wantsSplash() ? createSplash(document.getElementById('splash')) : null;
if (!splash) document.getElementById('splash')?.remove();
// With a timeout beside it, because a tab opened in the background runs no animation frames at all
// and would otherwise not start loading the game until it was looked at.
const presented = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, 100);
});
const loading = splash && WAIT_LOGO ? presented().then(() => import('./main.js')) : import('./main.js');
if (splash) {
  splash.run(loading);
} else {
  const unblack = () => requestAnimationFrame(() => requestAnimationFrame(
    () => { document.documentElement.classList.remove('booting'); announceReady(); }));
  loading.then(unblack, unblack);
}
