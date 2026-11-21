import UIKit
import WebKit

/// Answers `window.webkit.messageHandlers.feedback.postMessage("open")` from Settings' "Send beta
/// feedback" row (`src/game/menupage.js`) by opening the TestFlight app.
///
/// **Why it opens TestFlight rather than the feedback form itself.** Apple has no public API that
/// presents TestFlight's "Share Beta Feedback" sheet from inside an app (checked 2026-10-28). The
/// sheet only comes up from TestFlight's own gestures: a screenshot, a long press on the Home Screen
/// icon, or the app's page in TestFlight. Opening TestFlight is the nearest a button can get, and
/// what the tester sends from there lands in App Store Connect with the build and device attached,
/// beside every other piece of feedback, which a home-made form or an email would not.
///
/// A standalone object for the same retain-cycle reason as `HapticsBridge`.
final class FeedbackBridge: NSObject, WKScriptMessageHandler {

    /// The name the page posts to. Must match `messageHandlers.feedback` in `src/game/menupage.js`.
    static let name = "feedback"

    /// True when this install came from TestFlight. TestFlight builds carry a sandbox receipt;
    /// App Store installs carry a production one, named `receipt`. A build Xcode installed directly
    /// has the sandbox *path* but no file there, hence the existence check: the row would open a
    /// TestFlight that has never heard of this build.
    ///
    /// `appStoreReceiptURL` is deprecated from iOS 18 in favour of StoreKit 2's
    /// `AppTransaction.environment`, which is async and iOS 16+ against a 15.6 deployment target.
    /// The flag has to be in the page before its first script runs, so the synchronous answer wins
    /// and the deprecation is a warning, not a failure.
    static var isTestFlight: Bool {
        guard let url = Bundle.main.appStoreReceiptURL,
              url.lastPathComponent == "sandboxReceipt" else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// TestFlight's own scheme. It opens on the list of beta apps, one tap from Rocket Rides' page
    /// and its "Send Beta Feedback" button.
    private static let testFlight = URL(string: "itms-beta://")!

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.body as? String == "open" else { return }
        // `open` rather than `canOpenURL` first: the check needs the scheme listed under
        // LSApplicationQueriesSchemes and adds nothing, since the row only shows in a TestFlight
        // install, which means TestFlight is on the phone.
        UIApplication.shared.open(Self.testFlight) { opened in
            if !opened { NSLog("[feedback] TestFlight did not open") }
        }
    }
}
