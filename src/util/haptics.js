/**
 * Taptic Engine feedback, for the native shell only.
 *
 * **There is no web fallback, and that is not an omission.** The Vibration API
 * (`navigator.vibrate`) has never shipped in Safari on any platform, so on the web build of this
 * game — which is an iPhone game people play in Safari — the call would be absent on exactly the
 * hardware the feedback is designed for. Chrome on Android does have it, but its buzz is a coarse
 * duration-in-milliseconds motor pulse rather than the Taptic Engine's tuned transients, and lining
 * the two up so `tap('pick')` means something on both is a real design problem rather than a
 * one-liner. So this is a bridge to UIKit and nothing else, and every call is a no-op in a browser.
 *
 * The bridge is a `WKScriptMessageHandler` named `haptics`, installed by `HapticsBridge.swift` and
 * registered in `GameViewController.loadView`. Sending a name rather than a duration/intensity pair
 * is the load-bearing choice: `UIImpactFeedbackGenerator` styles are calibrated per device
 * generation by Apple, so naming the *event* lets the native side pick the transient that is
 * actually right on that phone. A game that posts "8ms at 0.7" instead has hard-coded one model.
 *
 * **Read at call time, never at import** — the same rule as `isNative()` next door. `tools/check.mjs`
 * boots the whole module graph in node, where there is no `window`, and a module-level probe for
 * `window.webkit` would take the headless suite down with it.
 */

import { isNative } from './platform.js';

/**
 * The events the native side knows how to answer, and what each one is *for*.
 *
 * Kept as an explicit list so a typo is a caught error here rather than silence on the phone: a
 * `postMessage` naming an event Swift doesn't recognise is dropped without a word, which is the
 * worst possible failure for a feature whose only symptom is a feeling.
 *
 * The set is deliberately small and the names describe *events*, not intensities — see the note at
 * the top of this file. Which transient each one gets is `HapticsBridge.swift`'s call, and it is
 * made there so it can be made per device generation.
 *
 * They divide into two kinds, and the division is the whole design:
 *
 * **The player did something**, and the buzz is the control answering the hand. These fire under a
 * thumb that is already touching the glass, so they are sharp and short, and they are all gated on
 * the input being *accepted* — a refused tap or a press the game ignored stays silent, because a
 * confirming buzz on a refusal says the opposite of what the screen is saying.
 *
 * - `pick`       — a tap that re-aimed the taxi: a rider, a destination pin, a package pin.
 * - `grab`       — a press that took hold of the route band. `pick`'s twin for the other half of
 *                  the interface: the tap says *where*, this says *you have the route*. Its own
 *                  event rather than a second `pick` because it opens a hold rather than closing
 *                  an instruction, and what follows it is a run of `snap`s it has to read apart from.
 * - `snap`       — the dragged route re-planning through a new junction. The one event here that
 *                  repeats within a single gesture, which is most of what decides how it should
 *                  feel: it is a detent in a run of detents, not an announcement. Fired only when
 *                  the band it reports actually moved — see `game/pathdrag.js`.
 * - `brake`      — the brake going down. Distinct from `pick` on purpose: it is a pedal, not a
 *                  confirmation, and it wants to feel mechanical rather than polite.
 * - `loco`       — Loco Mode engaging under a hold. The heaviest of this group, partly because the
 *                  thing it reports is heavy and partly because it fires against a thumb that is
 *                  already pressed down and holding still, where a light transient is hard to feel.
 *
 * **The world did something**, and the buzz is news. These arrive on a frame the player was not
 * necessarily touching anything, so they carry the weight instead of the timing:
 *
 * - `parcel-in`  — a package collected. Something landed in the car.
 * - `burger`     — an order handed through the drive-through window (game/burgerrun.js). The same
 *                  shape of event as `parcel-in` — something landed in the car — and deliberately
 *                  the lightest thing in this group, because it reports the smallest reward in the
 *                  game. A paper bag, not a package.
 * - `parcel-out` — a package delivered. The payoff, and the only one of the eight that is *earned*
 *                  rather than merely done — which is why the native side answers it with a
 *                  notification pattern rather than a single knock. See `HapticsBridge.swift`.
 */
const EVENTS = new Set(['pick', 'grab', 'snap', 'brake', 'loco', 'parcel-in', 'parcel-out',
  'burger']);

/**
 * Fire one haptic. Silent everywhere it cannot work, which is most places.
 *
 * Wrapped in a `try` for the same reason `highscores.js` wraps `localStorage`: the handler is
 * installed by the shell, so a shell that is mid-load, or one built before this existed, throws on
 * the `postMessage` rather than returning falsy. Dropping a haptic is never worth an error — but
 * unlike a lost high score there is nothing to degrade to, so it really is nothing.
 */
export function tap(event) {
  if (!EVENTS.has(event)) throw new Error(`unknown haptic event: ${event}`);
  if (!isNative()) return;
  try {
    window.webkit?.messageHandlers?.haptics?.postMessage(event);
  } catch { /* no handler installed — the game does not care */ }
}
