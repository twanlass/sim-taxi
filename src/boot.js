/**
 * The page's entry: the startup screen first, then the game behind it.
 *
 * The game is a dynamic import rather than this page's module script because evaluating it is one
 * long synchronous task (the whole city is built at module scope), and the startup screen has to be
 * built — its materials compiled — *before* that runs; see game/splash.js for why. The import is
 * issued the moment the splash is built, so the download overlaps nothing but a black screen
 * either way.
 *
 * Without a startup screen (`?splash=classic`, shot mode, `?dev`, `?title=off`, "Play again") the
 * game is imported straight away, and the page's black (`html.booting`) gives way to the sky once
 * the city has drawn.
 */
import { createSplash, wantsSplash } from './game/splash.js';

const splash = wantsSplash() ? createSplash(document.getElementById('splash')) : null;
if (!splash) document.getElementById('splash')?.remove();
const loading = import('./main.js');
if (splash) {
  splash.run(loading);
} else {
  const unblack = () => requestAnimationFrame(() => requestAnimationFrame(
    () => document.documentElement.classList.remove('booting')));
  loading.then(unblack, unblack);
}
