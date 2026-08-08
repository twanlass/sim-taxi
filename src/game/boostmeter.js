// The Punch It pill's read-out: how the meter *looks* while fuel is arriving, kept apart from both
// the fuel itself (game/boost.js) and the DOM it ends up on (main.js sets three CSS variables from
// this and nothing else). Same reason boost.js is a pure clock — the animation is the reward for a
// drop-off now that a drop-off is the only source of fuel, so it's worth being able to assert on it
// headlessly rather than squinting at a screenshot.
//
// Three outputs, all 0..1:
//   pct    the bar to draw — the real fuel level plus the overshoot, clamped to the pill
//   fill   envelope for "fuel is arriving": drives the glow's alpha and the leading edge's opacity
//   pulse  the throb inside that envelope, drives the glow's blur radius and the pill's scale

// The overrun is scripted, not simulated. The obvious version — model the drawn bar as a spring
// chasing the real fuel level and let its momentum carry it past the mark — was tried first and
// measured at 3.3% of a tank of overshoot at its best (K=160, C=4), about 4px on the pill, and it
// wobbled for 1.4s getting back. A spring following a ramp can only overshoot by around v/ω, and a
// 0.5-tank/s pour against any ω fast enough to not look sluggish leaves nothing to work with. So
// the bounce is authored. It starts on the frame the pour finishes, which is why it doesn't read as
// a jump: the bar is already travelling at the pour rate and the kick just carries it further.
export const OVERSHOOT = 0.045;       // 4.5% of a tank past the mark ≈ 6px on the pill — small, but it reads
export const OVERSHOOT_RISE = 0.1;    // seconds out to the peak: faster than the pour, so it snaps

// Coming back is a damped ring, not a curve back to the mark. An eased fall reached the mark and
// simply stopped, which is the one moment the eye is watching and it read as linear — the bar
// *arrived* rather than *settled*. This is the spring the scripted kick doesn't get for free:
// the peak releases into a decaying cosine, so the bar dips a little under the mark, comes back
// over it smaller, and converges. Amplitudes off 4.5%: -1.7%, +0.6%, -0.2%, done. Tuned down from
// a 7%/7-decay original that read as too bouncy — smaller kick, faster decay, quicker to rest.
const SETTLE_HZ = 4;                  // ring frequency — one full wobble every 250ms
const SETTLE_DECAY = 8;               // e-folding rate: each wobble is ~33% of the one before
// Below this the ring is under a fifth of a pixel, so cut it and snap to the real level rather
// than trailing a tail nobody can see. Works out at ~0.43s of settle.
const SETTLE_FLOOR = 0.0015;
const SETTLE_TIME = Math.log(OVERSHOOT / SETTLE_FLOOR) / SETTLE_DECAY;

// Attack is short enough that the glow is up while the first fuel is still landing. Release is the
// length of the bounce, so the glow and the leading edge finish fading exactly as the bar stops.
const FILL_ATTACK = 0.09;
const FILL_RELEASE = OVERSHOOT_RISE + SETTLE_TIME;
// The glow and the pill's scale both ride this. It ran at 8Hz originally so it would read as a
// flutter rather than the 5Hz "breathing" that was tried and rejected — but against a burst of
// several energy circles landing in the same pour, that many pulses stacked up read as chaotic
// rather than lively. Halved to land one clear pulse where there used to be two; slower than the
// old breathing threshold, but the pour is short enough that it still reads as urgency, not calm.
const PULSE_HZ = 4;

export function createBoostMeter() {
  const state = { pct: 0, fill: 0, pulse: 0 };
  let bounceT = -1;        // seconds into the overshoot, or <0 when no bounce is running
  let wasPouring = false;
  let phase = 0;           // pulse phase in turns, so it doesn't care about frame length

  return {
    state,

    /**
     * @param dt        seconds since the last frame
     * @param fraction  the real fuel level, 0..1
     * @param pouring   is a top-up still draining into the tank this frame?
     */
    update(dt, fraction, pouring) {
      // The last of the fuel just landed — kick.
      if (wasPouring && !pouring) bounceT = 0;
      wasPouring = pouring;

      let bounce = 0;
      if (bounceT >= 0) {
        bounceT += dt;
        if (bounceT < OVERSHOOT_RISE) {
          const t = bounceT / OVERSHOOT_RISE;
          bounce = OVERSHOOT * (1 - (1 - t) * (1 - t));       // ease-out: quick off the mark
        } else if (bounceT < OVERSHOOT_RISE + SETTLE_TIME) {
          // Released from the peak at rest, so the ring starts at +OVERSHOOT with no discontinuity
          // and the first thing it does is fall — cos, not sin.
          const t = bounceT - OVERSHOOT_RISE;
          bounce = OVERSHOOT * Math.exp(-SETTLE_DECAY * t) * Math.cos(2 * Math.PI * SETTLE_HZ * t);
        } else {
          bounceT = -1;
        }
      }

      state.fill = Math.max(0, Math.min(1, state.fill + dt / (pouring ? FILL_ATTACK : -FILL_RELEASE)));
      phase = (phase + dt * PULSE_HZ) % 1;
      state.pulse = state.fill * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
      // Clamped: at a full tank the overshoot has nowhere to go, and a leading edge parked past
      // 100% would sit outside the pill.
      state.pct = Math.max(0, Math.min(1, fraction + bounce));
    },
  };
}
