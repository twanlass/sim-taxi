import GameKit
import UIKit
import WebKit

/// Answers `window.webkit.messageHandlers.gamecenter.postMessage({...})` from the game, and owns the
/// app's one Game Center leaderboard: Arcade's best cash in a run, all-time.
///
/// See `src/util/gamecenter.js` for the web half. Three messages come in, as `{ type: ... }`:
///
/// - `hello` — the page has booted and wants to know whether the player is signed in. Answered by
///   calling `window.__gameCenterState(ready)`, and every later change of state is pushed the same
///   way. **The page asks rather than being told at launch** because the sign-in usually resolves
///   before the bundle has evaluated, and a script evaluated into a page that is still loading is
///   simply lost — so nothing is pushed until the page has said it is there to hear it.
/// - `submit` with `score` — an Arcade run's cash. Game Center keeps only each player's best on an
///   all-time "best score" leaderboard, so every finished run can be sent and a worse one is a no-op
///   on Apple's side; there is nothing to compare here.
/// - `show` — open Apple's own leaderboard screen (Tyler, 2026-11-21: Apple's UI rather than an
///   in-game table).
///
/// A standalone object for the same reason `HapticsBridge` is: `WKUserContentController` retains
/// its handlers strongly, so the controller registering itself would never release its web view.
/// The references back to the controller and the web view are weak for the same reason.
final class GameCenterBridge: NSObject, WKScriptMessageHandler, GKGameCenterControllerDelegate {

    /// The name the page posts to. Must match `messageHandlers.gamecenter` in `src/util/gamecenter.js`.
    static let name = "gamecenter"

    /// The leaderboard's ID as created in App Store Connect (Features ▸ Game Center ▸ Leaderboards).
    /// Must match it exactly; a mismatch fails silently at submit and the screen opens on an empty
    /// list. See docs/ios.md.
    static let arcadeLeaderboard = "rocketrides.arcade.cash"

    /// The controller that presents Apple's sheets (sign-in, leaderboard), and the page to report to.
    weak var host: UIViewController?
    weak var webView: WKWebView?

    /// Set by the page's `hello`. Until then, a state change has nowhere to go.
    private var pageListening = false
    private var started = false

    /// Start Game Center sign-in. Called once, at launch: Apple's guidance is to authenticate as
    /// early as possible, and the only screen up at launch is the title menu, which a sign-in sheet
    /// can cover without costing anybody a run.
    ///
    /// Setting the handler is what starts it. GameKit calls it again whenever the state changes
    /// (signed out in Settings, say), so it is also how the page hears about those. Apple asks a
    /// player who cancels the sign-in sheet at most a couple of times before it stops offering it,
    /// and then the game simply has no leaderboard button — nothing here needs to remember a refusal.
    ///
    /// The closure is `@Sendable` and hops to the main actor itself, rather than being inferred
    /// main-actor isolated from this module's default isolation: GameKit documents no queue for it,
    /// and an isolated closure called off the main thread is a runtime trap under strict checking.
    func start() {
        guard !started else { return }
        started = true
        GKLocalPlayer.local.authenticateHandler = { @Sendable [weak self] viewController, error in
            Task { @MainActor in
                guard let self else { return }
                if let viewController {
                    self.host?.present(viewController, animated: true)
                    return
                }
                #if DEBUG
                if let error { print("Game Center sign-in: \(error.localizedDescription)") }
                #endif
                self.report()
            }
        }
    }

    private var ready: Bool {
        GKLocalPlayer.local.isAuthenticated
    }

    /// Tell the page whether the leaderboard is reachable. Optional-chained on the page side so a
    /// bundle built before this existed ignores it.
    private func report() {
        guard pageListening, let webView else { return }
        webView.evaluateJavaScript("window.__gameCenterState?.(\(ready ? "true" : "false"))",
                                   completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "hello":
            pageListening = true
            report()
        case "submit":
            // JS numbers arrive as NSNumber; a whole number of dollars, never negative.
            guard let score = (body["score"] as? NSNumber)?.intValue, score > 0, ready else { return }
            GKLeaderboard.submitScore(score, context: 0, player: GKLocalPlayer.local,
                                      leaderboardIDs: [Self.arcadeLeaderboard]) { @Sendable error in
                #if DEBUG
                if let error { print("Game Center submit: \(error.localizedDescription)") }
                #endif
            }
        case "show":
            guard ready, let host, host.presentedViewController == nil else { return }
            let board = GKGameCenterViewController(leaderboardID: Self.arcadeLeaderboard,
                                                   playerScope: .global, timeScope: .allTime)
            board.gameCenterDelegate = self
            host.present(board, animated: true)
        default:
            break
        }
    }

    func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true)
    }
}
