/**
 * Game Center, through the iOS shell (`ios/SimTaxi/GameCenterBridge.swift`). One leaderboard:
 * Arcade's cash per run, all-time (Tyler, 2026-11-21). Apple's own screen shows it — there is no
 * in-game table for it.
 *
 * **A no-op everywhere but the app.** Every call checks `isNative()` and the handler, and wraps the
 * `postMessage` in a `try` for the reason `util/haptics.js` gives: a shell built before this existed
 * has no `gamecenter` handler, and a lost submit is never worth an error.
 *
 * The page cannot know at boot whether the player is signed in — that is the shell's sign-in, which
 * may still be on screen — so `init()` says hello and the shell answers through
 * `window.__gameCenterState(ready)`, again on every later change. `onChange` is how the title menu
 * shows its button only while there is a leaderboard to open.
 *
 * Not a file named after the thing it shows, on purpose: see the ad-blocker trap in CLAUDE.md.
 */

import { isNative } from './platform.js';

let ready = false;
const listeners = new Set();

function post(message) {
  if (!isNative()) return false;
  try {
    const handler = window.webkit?.messageHandlers?.gamecenter;
    if (!handler) return false;
    handler.postMessage(message);
    return true;
  } catch { return false; }
}

/** Say hello to the shell and start listening for its sign-in state. Call once, at boot. */
export function initGameCenter() {
  if (!isNative()) return;
  window.__gameCenterState = (on) => {
    const next = on === true;
    if (next === ready) return;
    ready = next;
    for (const fn of listeners) fn(ready);
  };
  post({ type: 'hello' });
}

/** True while the player is signed in to Game Center inside the app. */
export function gameCenterReady() {
  return ready;
}

/** Hear every change of `gameCenterReady()`. */
export function onGameCenterChange(fn) {
  listeners.add(fn);
}

/** Send an Arcade run's cash. Game Center keeps each player's best, so every run can go. */
export function submitArcadeScore(cash) {
  const score = Math.floor(Number(cash));
  if (!ready || !Number.isFinite(score) || score <= 0) return false;
  return post({ type: 'submit', score });
}

/** Open Apple's leaderboard screen. */
export function showGameCenterBoard() {
  if (!ready) return false;
  return post({ type: 'show' });
}
