import CoreHaptics
import UIKit

/// Custom Core Haptics patterns for the combo moments — the drift, its exit kick, the bootleg
/// U-turn, the overtake, and the Perfect Run being paid or lost.
///
/// **Why these are not more `UIImpactFeedbackGenerator` cases.** Everything in `HapticsBridge` is a
/// single knock, and before this file every combo fired the same one: the drift's slide, its exit
/// kick and the U-turn's spin were all `loco`, a `.heavy` impact, indistinguishable from simply
/// pressing the Loco pill. A combo is a *move* with a shape in time — a slide that scrubs and
/// fades, a spin that chatters round and catches, a kick that surges — and an impact generator can
/// only say "something happened". `CHHapticEngine` can play a continuous event under an intensity
/// and sharpness envelope, which is the thing a shape needs.
///
/// **The envelopes are timed off the game's own constants**, so changing those is a reason to
/// revisit these: the kick against `DRIFT_EXIT`'s 0.6s (sim/traffic.js), the spin against
/// `SPIN_TIME` 0.76s (game/bootleg.js), the Perfect Run's three beats against the label's pop
/// (`RUN_LABEL_MS` in main.js, which peaks at 20% of 800ms).
///
/// Intensity is 0...1. Sharpness is 0...1 too and is the axis that matters most here: low reads as
/// a dull rumble or thud, high as a crisp click. Every pattern below is distinguishable from the
/// others on sharpness and rhythm alone, which is the test that matters — the player is mid-drive
/// and is not comparing intensities.
///
/// On hardware without Core Haptics support (no Taptic Engine) `play` returns false and the bridge
/// falls back to its impact generators, which themselves do nothing on that hardware.
final class ComboHaptics {

    static let events: Set<String> = ["drift", "drift-kick", "uturn", "overtake", "perfect", "perfect-lost"]

    private let engine: CHHapticEngine?
    private var running = false
    private var patterns: [String: CHHapticPattern] = [:]

    init() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics,
              let engine = try? CHHapticEngine() else {
            self.engine = nil
            return
        }
        self.engine = engine
        // No audio from this engine: the game's sound is the page's, and an engine allowed to make
        // sound would take part in the audio session the radio is playing through.
        engine.playsHapticsOnly = true
        // The system stops the engine when the app is backgrounded, when another app takes the
        // Taptic Engine, and on a media-server reset. All three are recovered from the same way —
        // lazily, on the next play — so a combo after a phone call still lands.
        // The handlers arrive on an engine queue; `running` is read on the main thread, where the
        // script message handler runs.
        engine.stoppedHandler = { [weak self] _ in DispatchQueue.main.async { self?.running = false } }
        engine.resetHandler = { [weak self] in DispatchQueue.main.async { self?.running = false } }
        patterns = Self.build()
        start()
    }

    private func start() {
        guard let engine, !running else { return }
        do {
            try engine.start()
            running = true
        } catch {
            NSLog("[haptics] engine start failed: \(error)")
        }
    }

    /// Play `event`. False when this phone cannot, so the caller can fall back to an impact.
    func play(_ event: String) -> Bool {
        guard let engine, let pattern = patterns[event] else { return false }
        start()
        guard running else { return false }
        do {
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            return true
        } catch {
            NSLog("[haptics] \(event) failed: \(error)")
            return false
        }
    }

    // MARK: - The patterns

    private static func build() -> [String: CHHapticPattern] {
        var out: [String: CHHapticPattern] = [:]
        func add(_ name: String, _ events: [CHHapticEvent], _ curves: [CHHapticParameterCurve] = []) {
            do {
                out[name] = try CHHapticPattern(events: events, parameterCurves: curves)
            } catch {
                NSLog("[haptics] pattern \(name) did not build: \(error)")
            }
        }

        // The drift: a brake tap in Loco Mode kicks the tail out. The tyres let go with a crisp
        // bite, then a low, grainy scrub that dies away as the slide settles — a rumble rather than
        // a knock, which is the whole difference from pressing the brake on its own (`brake` is a
        // single `.rigid`). The micro-ticks on top are the grain: tyre chatter, not a pulse train.
        // (Built in steps with explicit types: one long `+` of literals and maps is the kind of
        // expression Swift's type checker gives up on.)
        var drift: [CHHapticEvent] = [tick(0, 0.85, 0.65), hum(0.02, 0.42, 0.7, 0.18)]
        for k in 1...5 {
            let n = Double(k)
            drift.append(tick(0.06 * n, 0.38 - 0.05 * n, 0.35))
        }
        add("drift", drift, [fade(.hapticIntensityControl, [(0, 1), (0.12, 0.8), (0.44, 0)])])

        // The exit kick: 1.4x for 0.6s, plus the fuel pouring back in. A heavy, dull thump — the
        // rear tyres finding grip — then a surge that *rises in pitch* as it fades, which is how
        // acceleration feels in the hand: the rumble gets finer as the car gets faster.
        add("drift-kick", [
            tick(0, 1, 0.3),
            hum(0.03, 0.55, 0.9, 0.2),
        ], [
            fade(.hapticIntensityControl, [(0, 1), (0.35, 0.55), (0.58, 0)]),
            fade(.hapticSharpnessControl, [(0, 0), (0.55, 0.6)]),
        ])

        // The bootleg U-turn: the taxi swings round over SPIN_TIME (0.76s). A low rumble carries
        // the whole spin; on top of it, tyre chirps that bunch up through the middle of the arc and
        // spread out again, so the rhythm *goes round* — and then one sharp catch where the spin
        // flicks out onto the far lane. The catch is the payoff: it says "done, you're facing the
        // other way".
        let chirps: [Double] = [0, 0.09, 0.17, 0.24, 0.31, 0.38, 0.46, 0.55]
        var uturn: [CHHapticEvent] = [hum(0, 0.7, 0.75, 0.12)]
        for (k, t) in chirps.enumerated() {
            let n = Double(k)
            uturn.append(tick(t, 0.9 - 0.06 * n, 0.45 + 0.03 * n))
        }
        uturn.append(tick(0.72, 1, 1))
        add("uturn", uturn,
            // The rumble fades under the chirps, then the curve jumps back to full for the catch —
            // an intensity curve multiplies transients too, so letting it end at 0 would silence it.
            [fade(.hapticIntensityControl, [(0, 1), (0.5, 0.7), (0.69, 0.15), (0.71, 1)])])

        // The overtake: the taxi swings out and round a car. Light and quick, because it can fire
        // several times a minute — a whoosh that swells and passes, sharpness sweeping up through
        // it like the Doppler of the car going by. No knock at all: nothing was hit, which is
        // exactly what an overtake is.
        add("overtake", [
            hum(0, 0.32, 0.55, 0.15),
        ], [
            fade(.hapticIntensityControl, [(0, 0), (0.12, 1), (0.32, 0)]),
            fade(.hapticSharpnessControl, [(0, 0), (0.3, 0.6)]),
        ])

        // PERFECT RUN x2: three rising clicks, quicker and brighter each time, landing on the
        // label's pop, then a short bright shimmer while it hangs. Built to feel like a little
        // fanfare rather than an impact — the one pattern here that is a *reward*, so it is the
        // one that climbs. `parcel-out`'s `.success` is the nearest thing in the game and this is
        // deliberately bigger than it.
        add("perfect", [
            tick(0, 0.55, 0.4),
            tick(0.09, 0.75, 0.6),
            tick(0.16, 1, 0.9),
            hum(0.17, 0.28, 0.5, 1),
        ], [fade(.hapticIntensityControl, [(0.17, 1), (0.45, 0)])])

        // The Perfect Run lost to a bump: the HUD tag shakes and falls. Two dull thuds, the second
        // weaker and lower — a falling interval, the opposite of `perfect`'s climb, and the only
        // pattern here with no sharpness in it at all.
        add("perfect-lost", [
            tick(0, 0.9, 0.15),
            tick(0.13, 0.55, 0.02),
        ])

        return out
    }

    /// A single transient: one click or knock.
    private static func tick(_ at: Double, _ intensity: Double, _ sharpness: Double) -> CHHapticEvent {
        CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(intensity)),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(sharpness)),
        ], relativeTime: at)
    }

    /// A continuous buzz, shaped by whatever curves the pattern puts over it.
    private static func hum(_ at: Double, _ duration: Double, _ intensity: Double,
                            _ sharpness: Double) -> CHHapticEvent {
        CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(intensity)),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(sharpness)),
        ], relativeTime: at, duration: duration)
    }

    /// An envelope over the whole pattern. Intensity control *multiplies* (0...1); sharpness
    /// control *adds* (-1...1).
    private static func fade(_ id: CHHapticDynamicParameter.ID,
                             _ points: [(Double, Double)]) -> CHHapticParameterCurve {
        CHHapticParameterCurve(
            parameterID: id,
            controlPoints: points.map { .init(relativeTime: $0.0, value: Float($0.1)) },
            relativeTime: 0)
    }
}
