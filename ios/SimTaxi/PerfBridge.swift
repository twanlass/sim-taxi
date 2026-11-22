import Foundation
import WebKit

/// Answers `window.webkit.messageHandlers.perf.postMessage({ name, body })` from `src/game/perf.js`.
///
/// `?perf` records every frame of a run on the phone, and the point of it is that nobody has to read
/// numbers off the glass: the capture lands here as a JSON string and is written to
/// `Documents/perf/<name>.json`, inside the app's own data container, where
/// `node tools/ios-perf.mjs pull` copies it to the Mac with `devicectl device copy from
/// --domain-type appDataContainer`. No network, no Web Inspector, no file-sharing entitlement — a
/// development-signed app's container is readable over the same pairing that installs it.
///
/// **DEBUG only**, registered under the same `#if DEBUG` as `isInspectable` in
/// `GameViewController`. A Release build has no handler, so the page's `postMessage` finds
/// `messageHandlers.perf` undefined and keeps the capture in memory instead.
///
/// Each save overwrites the file of the same name: the page names a capture after its own load
/// (`performance.timeOrigin`), and saves the whole run every time, so the latest write is a superset
/// of every earlier one. Written off the main thread because a twenty-minute capture is a few
/// megabytes, and a synchronous write on the main queue is the very hitch this exists to find.
final class PerfBridge: NSObject, WKScriptMessageHandler {

    static let name = "perf"

    private let queue = DispatchQueue(label: "perf-bridge", qos: .utility)

    static var directory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("perf", isDirectory: true)
    }

    /// The page that asked to hear about heat (`{ thermal: true }`), told on every change.
    private weak var thermalListener: WKWebView?
    private var thermalObserver: NSObjectProtocol?

    /// **The phone's thermal state, into the capture.** A warm iPhone throttles its GPU, and a run
    /// that starts warm reads a few fps slower than the same build started cool — enough to swamp a
    /// fix being measured. The page has no way to know (no web API exposes it), so the shell tells
    /// it: once when it asks and again on every `thermalStateDidChangeNotification`, and the capture
    /// notes each one (`thermal nominal|fair|serious|critical`) where the report and
    /// `tools/ios-perfloop.mjs` can see which scenes ran hot.
    private func tellThermal() {
        let name: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: name = "nominal"
        case .fair: name = "fair"
        case .serious: name = "serious"
        case .critical: name = "critical"
        @unknown default: name = "unknown"
        }
        DispatchQueue.main.async { [weak self] in
            self?.thermalListener?.evaluateJavaScript("window.__perfThermal?.('\(name)')", completionHandler: nil)
        }
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if let dict = message.body as? [String: Any], dict["thermal"] as? Bool == true {
            thermalListener = message.webView
            if thermalObserver == nil {
                thermalObserver = NotificationCenter.default.addObserver(
                    forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
                ) { [weak self] _ in self?.tellThermal() }
            }
            tellThermal()
            return
        }
        guard let dict = message.body as? [String: Any],
              let name = dict["name"] as? String,
              let body = dict["body"] as? String else { return }
        // A file name the page cannot steer out of the folder.
        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        guard !safe.isEmpty else { return }
        queue.async {
            let dir = Self.directory
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? body.data(using: .utf8)?.write(to: dir.appendingPathComponent("\(safe).json"),
                                                options: .atomic)
        }
    }
}
