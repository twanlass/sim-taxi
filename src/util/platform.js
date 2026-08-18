/**
 * Which shell the game is running in.
 *
 * There is exactly one flag here and the native side sets it: `ios/SimTaxi/GameViewController.swift`
 * injects a `WKUserScript` at document start that assigns `window.__native = true`, before any of
 * this page's own script runs. Everything that has to behave differently inside the App Store build
 * reads it through `isNative()`.
 *
 * **Why a global and not a build flag.** The obvious alternative is a Vite mode — `vite build
 * --mode ios` and an `import.meta.env.VITE_NATIVE` check — and it was rejected for two reasons.
 * `import.meta.env` does not exist in the inline `<script>` at the bottom of `index.html`, which is
 * a classic script and is one of the places that needs the answer (the error panel). And a build
 * mode means a *second bundle*: two artefacts to keep in step, `npm run check` and the two-entry
 * Vite config to re-verify against both, and a Netlify deploy that could drift from the one in the
 * app. With the flag injected at runtime there is one `dist/`, byte for byte, on the web and inside
 * the .ipa — the shell is the only thing that differs.
 *
 * **Read at call time, never at import.** Same rule as `isAndroid()` in `util/shot.js` and
 * `isIOS()` in `game/homescreen.js`: `tools/check.mjs` boots the module graph in node, where there
 * is no `window` at all, so a module-level read would take the whole headless suite down.
 */

/**
 * True inside the native iOS shell, false in any browser.
 *
 * Deliberately an identity check against `true` rather than a truthiness test — the property is a
 * global on a page that also runs on the open web, and "somebody else set `window.__native` to a
 * string" should read as false rather than silently turning off the service worker.
 */
export function isNative() {
  if (typeof window === 'undefined') return false;
  return window.__native === true;
}
