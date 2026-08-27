import AVFoundation
import UIKit

/// Application entry point.
///
/// **Deliberately the pre-scenes lifecycle**: one window, one view controller, no
/// `UIApplicationSceneManifest` in Info.plist and no `SceneDelegate`. Scenes exist to let an app
/// show several independent windows — iPad Split View, Stage Manager, multiple documents — and
/// this app declares `UIRequiresFullScreen`, so it will never have a second one. Adopting them here
/// would add a file and a lifecycle to reason about in exchange for capability the app has ruled
/// out on purpose: the city is framed to fill the screen, and a window that can be resized to a
/// third of it mid-run reframes the camera under the player.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        configureAudioSession()

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = GameViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// Put the app's audio in the category a game's sound effects belong in, before anything can
    /// play a note.
    ///
    /// **`.ambient` is the whole decision, and it is a product one rather than a technical one.**
    /// The default category for a WKWebView playing Web Audio is `.soloAmbient`, which *interrupts
    /// whatever the player is already listening to* — a podcast, an album, a running app's
    /// coaching. This game's sounds are a fare chime and a tyre screech; they are not worth
    /// somebody's music, and an app that stops it gets muted permanently, in Settings, on the first
    /// run. `.ambient` mixes instead, and obeys the ring/silent switch, which is the behaviour a
    /// player expects from a game they are playing on a train.
    ///
    /// `mixWithOthers` is implied by `.ambient` and passed anyway: the option is what the category
    /// actually means here, and spelling it out is what stops a later edit changing the category
    /// without noticing that mixing was the point.
    ///
    /// Not activated, deliberately. `setActive(true)` is the call that takes the session for this
    /// app, and there is nothing to take: the web view activates its own the moment the page starts
    /// a context, and it inherits the category set here. Activating an empty session at launch would
    /// interrupt the player's music *before the game has made a single sound* — which is the exact
    /// thing `.ambient` was chosen to avoid, arriving by another door.
    ///
    /// Failures are swallowed. There is no category this can fall back to that is better than "the
    /// default one", and no game should fail to launch over its sound effects — the same rule
    /// `src/game/sfx.js` and `src/game/highscores.js` both follow on the web side.
    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
        } catch {
            // A game with the wrong audio category is still a game.
        }
    }
}
