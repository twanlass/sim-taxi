import UIKit

/// Application entry point.
///
/// **The scene lifecycle, adopted under protest.** Scenes exist to let an app show several
/// independent windows — iPad Split View, Stage Manager, multiple documents — and this app declares
/// `UIRequiresFullScreen`, so it will never have a second one: the city is framed to fill the
/// screen, and a window that can be resized to a third of it mid-run reframes the camera under the
/// player. For that reason this was the pre-scenes lifecycle for as long as that was allowed.
///
/// It is not allowed any more. An app linked against the **iOS 27 SDK** with no
/// `UIApplicationSceneManifest` and no `UIWindowSceneDelegate` is terminated at launch by the OS —
/// see `SceneDelegate` for what that failure looks like and why it is so hard to read. So the
/// window moved to `SceneDelegate` and this type keeps only the process-wide half of the lifecycle,
/// which for this app is nothing at all.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        // Named to match the single entry in Info.plist's `UIApplicationSceneManifest`. Returning a
        // configuration here as well as declaring it there is belt and braces: the OS accepts
        // either, and the launch-time termination for having *neither* is silent.
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}
