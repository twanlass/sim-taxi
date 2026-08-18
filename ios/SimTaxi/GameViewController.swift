import UIKit
import WebKit

/// Hosts the game's `WKWebView` and owns everything the web layer cannot do for itself.
///
/// The controlling idea: **the shell adds capability, it does not adjust layout.** `index.html` and
/// `src/util/viewport.js` already solve notches, home indicators, rotation and cold-start viewport
/// settling, and they solve them against measurements taken on real hardware (the comments in both
/// files record the numbers). So the web view is pinned to the window's full bounds and left alone.
/// Anything UIKit does to "help" here — a safe-area inset, an automatic content inset, a scroll
/// view that bounces — fights code that is already correct and better tested.
final class GameViewController: UIViewController {

    /// The scheme the bundled build is served on. Any string works as long as it is not a scheme
    /// WebKit already handles (`http`, `https`, `file`, `about`, `data`…), which it refuses to let
    /// an app override.
    private static let scheme = "simtaxi"
    private static let startURL = URL(string: "\(scheme)://app/index.html")!

    /// `PALETTE.skyBottom` from `src/palette.js`, and the `background_color` in the web manifest.
    /// Used for the view behind the canvas so the frame before WebGL's first paint is sky rather
    /// than a flash of black — the same reasoning as the `background` on `html, body` in
    /// `index.html`. `LaunchScreen.storyboard` is this colour too, which makes launch continuous.
    private static let sky = UIColor(red: 0xDC / 255, green: 0xED / 255, blue: 0xF7 / 255, alpha: 1)

    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: Self.scheme)

        // The game is silent today (there is no audio anywhere in `src/`), but these are the two
        // settings that decide whether it *can* make a sound later, and getting them wrong shows up
        // as "audio works in Safari, not in the app". Inline playback stops iOS taking media
        // fullscreen; the empty `mediaTypesRequiringUserActionForPlayback` lifts the gesture
        // requirement, which a game needs because its sounds are triggered by simulation events
        // rather than by the tap that happens to precede them.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // **The native flag, injected before any of the page's own script runs.**
        // `.atDocumentStart` matters: `index.html`'s inline error handler reads `window.__native`
        // as it evaluates, and it evaluates ahead of the module bundle precisely so it can catch a
        // context-creation failure. See `src/util/platform.js` for why this is a runtime global
        // rather than a build-time constant — the short version is that it keeps one `dist/`
        // shipping to both the web and the App Store.
        let flag = WKUserScript(
            source: "window.__native = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(flag)

        webView = WKWebView(frame: .zero, configuration: config)

        // Not a document. Every one of these turns off a browser affordance that reads as a bug in
        // a game: rubber-banding the whole city when a drag runs past the edge of the screen,
        // scrolling a viewport that is already exactly one screen tall, and pinch-zooming a fixed
        // 3/4 camera that has no zoom. `contentInsetAdjustmentBehavior = .never` is the one that
        // matters most — the default insets the content by the safe area, which would double up on
        // the `env(safe-area-inset-*)` padding the CSS already applies and push the HUD inward
        // twice.
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.isOpaque = true
        webView.backgroundColor = Self.sky
        webView.scrollView.backgroundColor = Self.sky
        webView.allowsBackForwardNavigationGestures = false

        // Safari Web Inspector against the running app — Develop ▸ <device> ▸ Sim Taxi. This is the
        // only realistic way to debug the game on device: it gives the console `?diag` prints to,
        // the network pane that shows what the scheme handler served, and a storage inspector for
        // the `localStorage` question. DEBUG only, so a shipped build is not inspectable.
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // **Keep the screen awake.** There is no wake-lock code anywhere in `src/` — the Web
        // Wake Lock API is not available in WKWebView, so the web build simply cannot do this and
        // the screen dims mid-run. A fare has a 60-second clock and a player who is thinking rather
        // than tapping is still playing, so the idle timer's "no input means idle" assumption is
        // just wrong for this game. Set for the app's lifetime rather than per-run: iOS clears it
        // automatically whenever the app is not frontmost, which is exactly the scope wanted, and
        // it saves plumbing a run-state signal across the bridge for something the OS already does.
        UIApplication.shared.isIdleTimerDisabled = true

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(pauseGame),
                           name: UIApplication.willResignActiveNotification, object: nil)

        webView.load(URLRequest(url: Self.startURL))
    }

    /// Pause the run when the app stops being frontmost — a call, a notification pulled into a full
    /// screen, the app switcher.
    ///
    /// Without this, a fare's clock keeps draining behind whatever took the screen and the player
    /// comes back to a run they lost while not looking at it. WebKit stops firing
    /// `requestAnimationFrame` in the background, but the fare clocks are budgeted in *wall* time
    /// and `frame()` reconciles against it on the next tick, so the deadline is gone regardless.
    ///
    /// Driven through `window.__taxi`, the hook `docs/architecture.md` documents, rather than a new
    /// message channel: `pause` is already exposed there and `setPaused` is already the supported
    /// way to move it, including all the things a pause has to get right (releasing a held boost,
    /// clamping the frame delta on resume). Every hop is optional-chained because this can fire
    /// before the bundle has evaluated, and because `pause` is deliberately `null` in shot mode.
    @objc private func pauseGame() {
        webView.evaluateJavaScript("window.__taxi?.pause?.setPaused?.(true)", completionHandler: nil)
    }

    // MARK: - Chrome

    /// No status bar. The game draws edge to edge and the HUD keeps its own clearance from the
    /// hardware via the `--safe-*` custom properties in `index.html`. Paired with
    /// `UIViewControllerBasedStatusBarAppearance = false` in Info.plist so this is honoured.
    override var prefersStatusBarHidden: Bool { true }

    /// Defer the home-indicator gesture on first touch. The bottom of the screen is where the Loco
    /// Mode pill and the brake live — both are *hold* controls, and a thumb that rests there is
    /// exactly the gesture iOS reads as a swipe home. Deferring means the first swipe reveals the
    /// indicator instead of backgrounding a run in progress.
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    /// The camera is orthographic and fits the whole city to whatever viewport it is given, and
    /// `isNarrow()` in `src/main.js` already switches the HUD over on narrow ones — so every
    /// orientation is genuinely playable and there is no reason to lock one. Info.plist carries the
    /// same list; this is here so the answer does not depend on which one UIKit consults.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .pad ? .all : [.portrait, .landscape]
    }
}
