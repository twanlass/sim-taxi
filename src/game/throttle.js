// The throttle: one spring-loaded lever where Loco Mode and the brake used to be two buttons.
//
// **PROTOTYPE.** It replaces the bottom control row outright — see docs/gameplay.md#the-throttle.
//
// Push the knob up and the taxi floors it, pull it down and the taxi stands on the brakes, let go
// and it springs back to the middle, which is the game's resting state: the taxi driving itself.
// That last part is why this is a lever and not two buttons. "Drives itself" was always the thing
// underneath both pedals, and a control that *returns* to it says so with its geometry — there is
// a middle, the middle is where the car is left, and both of the things you can do are departures
// from it in opposite directions.
//
// Kept as a pure clock with no knowledge of the taxi, the tank or the DOM, for the same reason
// game/boost.js is one: the sim, the pointer plumbing, the CSS and the headless tests all read the
// same position, and none of them owns it. main.js maps a finger's y to `hold()`, reads `zone()`
// to decide which pedal is down, and paints `state.pos` onto a CSS variable.
//
// The travel is deliberately **not** symmetric. Boost is the thing a player reaches for, and it is
// the thing they hold for seconds at a time, so it gets the long half of the lever; the brake is a
// stab, and a short throw is a faster stab.

/** Fraction of the track above the rest line — the boost half. The rest is the brake's. */
export const THROTTLE_NEUTRAL = 0.6;

// How far out of the middle the knob has to be before that half engages, as a fraction of *that
// half's* travel. It is a dead zone rather than a hair trigger because the rest position has to be
// somewhere a thumb can sit: this control answers a drag, and the frame in which a finger lands on
// the knob and has not yet moved must not fire a wheelie, a flame burst and a haptic tick.
//
// A fraction of each half rather than one absolute number, so the brake's short throw is not most
// of a dead zone: 0.28 is 25px up the boost side and 17px down the brake side at the shipped
// geometry (150px of track, 60/40), and both of those are a comfortable deliberate movement
// against the ~8px of jitter a resting thumb produces.
export const THROTTLE_DEADZONE = 0.28;

// The spring that puts the knob back. Second order rather than an exponential ease because a
// released lever *snaps* — it arrives with a little energy left and settles, where an exponential
// creeps the last 10% and reads as the knob being dragged home by something.
//
// ζ = 0.59 at ω = 20.5 rad/s. Measured: a release from full boost overshoots the middle by 8.5% and
// is at rest 0.52s later — which on the shipped geometry is 5px past centre, enough to read as a
// tick of life and not as a bounce. The damping was picked by sweeping it: at ζ = 0.71 the overshoot
// is 2.7% (under two pixels — the spring may as well not be one) and at ζ = 0.49 it is 16% and takes
// 0.63s, which starts to look like the knob is loose.
//
// None of this reaches the car: `zone` is read off the input and not off `pos` (see `state.input`),
// so the dip past centre is a picture of a lever and never a stab of the brake.
const RETURN_K = 420;
const RETURN_C = 24;
// The spring is integrated in fixed slices rather than in one step of `dt`, and that is not a
// refinement — semi-implicit Euler goes unstable somewhere above ω·h ≈ 1, and `frame()` clamps dt to
// **0.05**, which is ω·dt = 1.03. Stepped whole, a release on one slow frame sends the knob to −0.05
// and then to +0.21, diverging: the lever flies apart on exactly the frames a phone is most likely
// to drop. At 1/120 the worst case is ω·h = 0.17 and six substeps, and the settle is identical at
// 60Hz, 30Hz and one long stall.
const RETURN_STEP = 1 / 120;
// Below this the knob is a fifth of a pixel off centre with nothing left to carry it — cut the
// integration rather than trail a tail nobody can see.
const REST_POS = 0.002;
const REST_V = 0.02;

const clamp = (v) => (v < -1 ? -1 : (v > 1 ? 1 : v));

export function createThrottle(deadzone = THROTTLE_DEADZONE) {
  const state = {
    // Where the knob is drawn, -1 (full brake) .. 0 (middle) .. +1 (full boost). Follows the finger
    // exactly while held and springs home when it lets go.
    pos: 0,
    // Where the *input* is holding it, or null when nothing is. Kept apart from `pos` because the
    // two answer different questions: the finger decides what the car does, and it decides it on
    // the frame the finger moves. The spring is only ever a picture of a lever that has already
    // been let go of — if `zone` came off `pos` instead, a release would leave the taxi boosting
    // for the third of a second the knob takes to come home.
    input: null,
    v: 0,                              // spring velocity, only ever non-zero on the way back
    zone: 'idle',                      // 'boost' | 'brake' | 'idle'
  };

  function settleZone() {
    const at = state.input ?? 0;
    if (at > deadzone) state.zone = 'boost';
    else if (at < -deadzone) state.zone = 'brake';
    else state.zone = 'idle';
  }

  return {
    state,
    zone: () => state.zone,
    /** Is anything — a thumb, a key — currently holding the lever off its spring? */
    isHeld: () => state.input !== null,

    /**
     * Put the lever at `v` (-1..1) and hold it there. Idempotent; called on every pointermove and
     * on a keydown, which is why it costs nothing to call with the value it already has.
     */
    hold(v) {
      state.input = clamp(v);
      state.pos = state.input;
      state.v = 0;
      settleZone();
    },

    /** Let go. The spring takes it from wherever the knob is, at rest. Idempotent. */
    release() {
      state.input = null;
      settleZone();
    },

    /**
     * Drop the lever *and* the picture of it — the knob is at the middle on the next frame drawn,
     * with no spring. For the cuts, not for the player: a pause, a blur, a run ending. A lever
     * caught mid-travel and then revealed springing home describes a hold nobody is doing.
     */
    reset() {
      state.input = null;
      state.pos = 0;
      state.v = 0;
      settleZone();
    },

    update(dt) {
      if (state.input !== null) return;                 // held: the finger is the position
      if (state.pos === 0 && state.v === 0) return;
      let left = dt;
      while (left > 0) {
        const h = left > RETURN_STEP ? RETURN_STEP : left;
        left -= h;
        state.v += (-RETURN_K * state.pos - RETURN_C * state.v) * h;
        state.pos += state.v * h;
        if (Math.abs(state.pos) < REST_POS && Math.abs(state.v) < REST_V) {
          state.pos = 0;
          state.v = 0;
          return;
        }
      }
    },

    /**
     * The knob's offset from the rest line as a fraction of the *whole* track, which is what the
     * CSS needs: the two halves are different lengths, so a position of +0.5 and one of -0.5 are
     * not the same distance up and down the same lever.
     */
    knobFraction() {
      const span = state.pos >= 0 ? THROTTLE_NEUTRAL : 1 - THROTTLE_NEUTRAL;
      return state.pos * span;
    },
  };
}
