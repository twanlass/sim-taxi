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
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = GameViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
