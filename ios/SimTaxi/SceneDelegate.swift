import UIKit

/// Window ownership, under the scene lifecycle.
///
/// **This exists because iOS 27 made scenes mandatory, not because the app wants them.** The
/// reasoning in `AppDelegate` still holds — one window, `UIRequiresFullScreen`, nothing here will
/// ever open a second scene — but an app linked against the iOS 27 SDK with no
/// `UIApplicationSceneManifest` and no `UIWindowSceneDelegate` is terminated by the OS at launch,
/// before `didFinishLaunchingWithOptions` runs. It leaves no crash report, because from the
/// system's point of view nothing crashed: it declined to start the app at all. The symptom is an
/// icon that bounces once and returns to the Home Screen, and it arrives the moment the *toolchain*
/// updates — the trigger is the SDK you link against, so code that ran yesterday fails today with
/// no commit in between.
///
/// Deliberately the minimum: this owns the window and nothing else. The run's pause-on-background
/// hook stays on `UIApplication.willResignActiveNotification` in `GameViewController`, which still
/// fires under scenes, so there is one lifecycle story rather than two.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        // `UIScreen.main.bounds` is deprecated under scenes and wrong on principle — the window
        // belongs to *this* scene, so it is sized from the scene's own coordinate space.
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = GameViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
