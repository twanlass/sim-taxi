/**
 * Crushin' It's slow-mo (Tyler, 2026-10-25: "when we land and cars explode, we need to do a little
 * bit of slow mo there to really sell that effect").
 *
 * A hit-stop rather than a ramp in: the clock drops straight to `MIN` on the frame the car goes up,
 * because easing *into* it spends the slam — the Big Air hang (main.js, `launchTimeScale`) was keyed
 * to land at full speed for exactly that reason, and an instant drop is what keeps the hit while
 * still giving the fireball room. It then holds at the bottom while the splash is still popping
 * (main.js, `crushPops`, which run on sim time and so stretch with it), at least `HOLD` and at most
 * `HOLD_MAX`, and eases back to 1 over `OUT` on a smoothstep. All three are wall-clock ms, like the
 * wreck's SLOW_MO_DURATION, so the beat is the same length whatever the frame rate.
 *
 * Shallower than the wreck's 0.18: the run-ending crash is the one thing this must not outdo. At
 * 0.3 a lone crush is ~1.1s on the clock for ~0.6s of sim, and a three-car splash (last pop at
 * 0.14 + 2 × 0.12 = 0.38s of sim) holds ~1.3s before it lets go.
 *
 * Input stays live — the taxi can be routed straight through it — and the audio is left alone:
 * the chain already pitches each pop down, and a global rate drop warbles the radio.
 */

export const CRUSH_SLOW_MIN = 0.3;
export const CRUSH_SLOW_HOLD = 280;
export const CRUSH_SLOW_HOLD_MAX = 1400;
export const CRUSH_SLOW_OUT = 800;

export function createCrushSlowMo({ enabled = true } = {}) {
  let startAt = null;   // wall ms of the crush, or null when idle
  let releaseAt = null; // wall ms the hold let go, once it has

  /** The crush went off at wall time `now`. A second one during the beat drops it to the bottom again. */
  function start(now) {
    if (!enabled) return;
    startAt = now;
    releaseAt = null;
  }

  /**
   * The factor to scale this frame's dt by. `holding` is whether anything the beat is waiting on —
   * a splash pop still to fire — is outstanding.
   */
  function scale(now, holding = false) {
    if (startAt === null) return 1;
    if (releaseAt === null) {
      const held = now - startAt;
      if (held < CRUSH_SLOW_HOLD || (holding && held < CRUSH_SLOW_HOLD_MAX)) return CRUSH_SLOW_MIN;
      releaseAt = now;
    }
    const u = (now - releaseAt) / CRUSH_SLOW_OUT;
    if (u >= 1) {
      startAt = releaseAt = null;
      return 1;
    }
    const s = u * u * (3 - 2 * u);
    return CRUSH_SLOW_MIN + (1 - CRUSH_SLOW_MIN) * s;
  }

  function reset() { startAt = releaseAt = null; }
  const active = () => startAt !== null;

  return { start, scale, reset, active };
}
