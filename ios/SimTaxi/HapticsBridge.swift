import UIKit
import WebKit

/// Answers `window.webkit.messageHandlers.haptics.postMessage(<event>)` from the game.
///
/// See `src/util/haptics.js` for the web half, including why the message is an event *name* rather
/// than an intensity: feedback styles are calibrated per device generation by Apple, so naming the
/// event lets this side pick the transient that is right on the phone it is actually running on.
/// A page that posted "8ms at 0.7" would have hard-coded one model.
///
/// **A separate object rather than a `GameViewController` extension, on purpose.**
/// `WKUserContentController` retains its message handlers strongly, and the controller owns the web
/// view that owns the content controller — so registering the controller as its own handler builds
/// a retain cycle that never releases the web view. It is the standard trap with this API and the
/// standard workaround is a weak proxy; this needs no reference back to the controller at all, so it
/// simply doesn't have one and there is no cycle to break.
final class HapticsBridge: NSObject, WKScriptMessageHandler {

    /// The name the page posts to. Must match `messageHandlers.haptics` in `src/util/haptics.js`.
    static let name = "haptics"

    /// **Held for the app's lifetime rather than made per-event, which is the whole reason these
    /// are properties.** A freshly constructed generator has to spin the Taptic Engine up before it
    /// can play anything, and the first `impactOccurred()` after construction is either late or
    /// dropped entirely — which reads as "haptics work, but not the first time, and not on the tap
    /// that matters". `prepare()` after each fire keeps the engine warm for the next one, and iOS
    /// spins it back down on its own after a couple of seconds if nothing follows.
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)

    /// A different class, not a fourth impact style, and the difference is the point: a notification
    /// plays a short *pattern* rather than one knock. That is the right shape for a payoff — it
    /// reads as "that completed" instead of "something hit the car" — and it is the one feedback in
    /// this file the player earned rather than merely caused.
    private let notice = UINotificationFeedbackGenerator()

    /// Silently ignored on hardware without a Taptic Engine — every iPad, and the Simulator. Worth
    /// knowing before concluding a bridge is broken: in the Simulator the JavaScript arrives here
    /// and the generator runs, and nothing whatsoever happens. This needs a real phone to test.
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let event = message.body as? String else { return }

        switch event {
        case "pick":
            // A tap that was accepted and re-aimed the taxi. Light: it confirms an instruction.
            light.impactOccurred()
            light.prepare()
        case "brake":
            // The brake going down. `.rigid` rather than a heavier `.medium`: rigid is the hardest,
            // shortest transient UIKit offers and it is the one that reads as a mechanism engaging
            // rather than as an impact. The pedal should feel like it has a detent.
            rigid.impactOccurred()
            rigid.prepare()
        case "loco":
            // Loco Mode engaging. Heavy — it fires against a thumb that is already pressed down and
            // holding still, where a light transient is genuinely hard to feel.
            heavy.impactOccurred()
            heavy.prepare()
        case "parcel-in":
            // A package collected. Medium: something landed in the car — more than a confirmation,
            // less than the delivery it is only the first half of.
            medium.impactOccurred()
            medium.prepare()
        case "parcel-out":
            // Delivered. `.success` is a three-part pattern rather than a single knock, which is
            // what makes it read as a *completion*; every other case here is one event in the world.
            notice.notificationOccurred(.success)
            notice.prepare()
        default:
            // An event name this build does not know. Nothing to do, but say so: the web and native
            // halves ship separately (the bundle is rebuilt far more often than the shell), and a
            // silent drop is invisible for a feature whose only symptom is a feeling.
            NSLog("[haptics] unknown event: \(event)")
        }
    }
}
