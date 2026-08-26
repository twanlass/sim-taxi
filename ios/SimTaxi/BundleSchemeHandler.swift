import Foundation
import WebKit

/// Serves the bundled web build over a custom scheme, so the game runs on a **real origin**.
///
/// This class is the reason the port works at all. The obvious way to load a bundled web app —
/// `webView.loadFileURL(_:allowingReadAccessTo:)` — hands the page a `file://` origin, and four
/// things break at once on that origin:
///
///  1. **ES modules fail CORS.** Vite emits `<script type="module">`, module fetches are
///     CORS-checked, and a `file://` origin fails the check. The game does not boot. This one is
///     fatal and immediate, so at least it is not subtle.
///  2. **`localStorage` throws `SecurityError`** — and this one *is* subtle, which makes it the
///     dangerous one. `src/game/highscores.js` wraps every storage call in a `try` on purpose
///     (Safari private mode throws on write, blocked storage throws on the property access itself)
///     and degrades to an empty table rather than killing a run over a saved score. Under `file://`
///     that safety net turns into silent data loss: scores appear to save, and every relaunch comes
///     up empty, with nothing logged anywhere.
///  3. **Root-absolute paths resolve to the filesystem root.** `vite.config.js` leaves `base` at
///     `/`, so every emitted asset URL is `/assets/…`.
///  4. **Service workers never register.** Harmless here — `src/main.js` skips registration in the
///     native shell anyway — but worth knowing it is not available as a fallback.
///
/// A custom scheme fixes all four: WebKit treats `simtaxi://app` as an ordinary secure-ish origin
/// with its own persistent storage, module CORS passes, and `/assets/…` resolves against the
/// scheme's root, which is what this handler maps onto the bundle directory.
///
/// **Known caveat, verify on device.** Persistence of `localStorage` across app launches under a
/// custom scheme has historically been inconsistent across iOS versions. The test is in
/// `docs/ios.md`: play a run, enter initials, force-quit, relaunch, confirm the table survived.
/// If it does not, the fix is cheap — `createScores()` in `src/game/highscores.js` takes an
/// injectable store, so a `UserDefaults`-backed one bridged over `WKScriptMessageHandler` drops in
/// behind the existing interface without touching the ranking logic.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {

    /// The directory inside the app bundle holding the output of `npm run build:ios`.
    private let root: URL

    /// What the scheme serves when the path is a directory or empty.
    private static let indexFile = "index.html"

    init(resourceDirectory: String = "web") {
        // A missing `web/` means the sync step never ran, or the folder went into Xcode as a yellow
        // *group* rather than a blue *folder reference* — a group flattens the hierarchy, so
        // `assets/main-*.js` lands at the bundle root and every path below 404s. Failing loudly
        // here beats shipping an app that opens on a blank sky.
        guard let url = Bundle.main.url(forResource: resourceDirectory, withExtension: nil) else {
            fatalError("""
                Bundle is missing '\(resourceDirectory)/'. Run `npm run build:ios`, and check that \
                the folder is added to the target as a folder reference (blue), not a group (yellow).
                """)
        }
        self.root = url
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        // **Resolve from the path, discarding the query.** This is load-bearing rather than tidy:
        // `src/game/recovery.js` responds to a second WebGL context loss by reloading into
        // `?safe=1`, which is the entire escape hatch for a device that cannot render the full
        // budget. Resolving against the raw URL would look for a file literally named
        // `index.html?safe=1`, 404, and turn a recoverable device into a permanently blank one.
        // The fragment is dropped for the same reason; the page still sees both, because the
        // navigation URL is unaffected by what this handler chooses to open.
        let rawPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? "/"
        let relative = rawPath.hasPrefix("/") ? String(rawPath.dropFirst()) : rawPath
        let resolved = relative.isEmpty || relative.hasSuffix("/")
            ? relative + Self.indexFile
            : relative

        // `standardized` collapses any `..` segments, and the prefix check then confirms the result
        // is still inside the bundle. Nothing in this app builds a URL from untrusted input today,
        // but the handler is the boundary and boundaries get to be dull about it.
        let fileURL = root.appendingPathComponent(resolved).standardized
        guard fileURL.path.hasPrefix(root.standardized.path) else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            // A 404 with a body, not `didFailWithError`. A failed scheme task surfaces as an opaque
            // WebKit error with no URL attached; a real response shows the missing path in the Web
            // Inspector network pane, which is the difference between a five-second diagnosis and
            // an afternoon.
            respond(to: task, url: url, status: 404, mimeType: "text/plain", data: Data("Not found: \(resolved)".utf8))
            return
        }

        respond(to: task, url: url, status: 200, mimeType: Self.mimeType(for: fileURL), data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Every response above is delivered synchronously inside `start`, so by the time WebKit can
        // ask to cancel, the task is already finished. Nothing to tear down.
    }

    private func respond(to task: WKURLSchemeTask, url: URL, status: Int, mimeType: String, data: Data) {
        let headers = [
            "Content-Type": mimeType,
            "Content-Length": String(data.count),
            // The bundle is immutable for the lifetime of an installed build, but an App Store
            // update replaces it underneath the same origin — and WebKit's cache does not
            // necessarily notice. `no-cache` costs nothing (these reads are local file reads) and
            // removes the class of bug where a player updates the app and keeps the old game. This
            // is the same hazard that makes the service worker wrong here; see `src/main.js`.
            "Cache-Control": "no-cache",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    /// Content types for everything `dist/` can contain.
    ///
    /// **`.js` must be a JavaScript type or the game does not start.** WebKit enforces the module
    /// MIME check strictly: a module served as `application/octet-stream` — which is what an
    /// unknown extension falls back to — is rejected before it is parsed, and the failure reads as
    /// a blank page with one console line about the MIME type. `text/javascript` is the type the
    /// HTML spec now names for this.
    ///
    /// The list is deliberately short: `npm run build` emits HTML, JS and the handful of icons in
    /// `public/`, and there are no fonts, no CSS files (all styles are inline in `index.html`) and
    /// no media, because the project ships zero external assets.
    private static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm":     return "text/html; charset=utf-8"
        case "js", "mjs":       return "text/javascript; charset=utf-8"
        case "css":             return "text/css; charset=utf-8"
        case "json":            return "application/json; charset=utf-8"
        case "webmanifest":     return "application/manifest+json; charset=utf-8"
        case "svg":             return "image/svg+xml"
        case "png":             return "image/png"
        case "ico":             return "image/x-icon"
        default:                return "application/octet-stream"
        }
    }
}
