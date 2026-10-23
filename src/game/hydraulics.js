// The street racer's hydraulics: a lowrider's pumps under the body, worked during the race's scenes
// (Tyler: "give the racer some hydraulics to bounce their car during scenes").
//
// Two motions, because that is what a lowrider does with them:
//
//   - **The body on its rams** (`lift`, `pitch`, `roll`): the shell moves on the wheels, which stay
//     on the road. Three damped springs, kicked by `kick()` and pulled toward a rest pose
//     (`setRest`), so a pump overshoots and settles the way a car on a coil does rather than
//     easing like a tween. Underdamped on purpose (ζ ≈ 0.25): two or three bounces is the look.
//   - **The front hop** (`hop`): the whole car — wheels too — pitched up about the rear axle and
//     let fall, ballistic, with a small rebound off the road. A spring would ease it down; a hop
//     drops.
//
// Pure state and arithmetic, so the probe can step it without a scene; game/race.js decides when
// to kick and applies the pose to the racer's mesh.

// Body springs: ~2.2 Hz. Stiff enough that a pump reads as a shove and not a float, soft enough to
// show its bounces at 60 fps.
const K = (2 * Math.PI * 2.2) ** 2;
const DAMP = 2 * 0.25 * Math.sqrt(K);
// How far the rams can take the body. Down is short: the body is arched over the wheels and stops
// on them a little under 0.15 below its ride height (geometry/wheels.js). Up is a lowrider's stance.
export const LIFT_MIN = -0.12;
export const LIFT_MAX = 0.42;
const PITCH_MAX = 0.16;
const ROLL_MAX = 0.14;
// The hop's fall, in rad/s² about the rear axle. With HOP_KICK that is ~0.42 rad of nose-up and
// ~0.5s in the air, measured off the formula: θmax = ω² / 2G, t = 2ω / G.
const HOP_G = 9.5;
// What a hop keeps of its speed when the front wheels land: a little bounce, not a second hop.
const HOP_REBOUND = 0.25;

// The kicks, as velocities. A `pump` is the whole body up; `nose`/`tail` one end; `left`/`right`
// one side (a three-wheel dance is these alternating). `hop` lifts the front wheels too.
const KICKS = {
  pump: { lift: 2.6 },
  bigPump: { lift: 3.6 },
  nose: { pitch: 1.4, lift: 0.8 },
  tail: { pitch: -1.4, lift: 0.8 },
  left: { roll: 1.3, lift: 0.5 },
  right: { roll: -1.3, lift: 0.5 },
  hop: { hop: 2.8, lift: 1.2 },
};

export function createHydraulics() {
  const s = {
    lift: 0, pitch: 0, roll: 0, hop: 0,
    vLift: 0, vPitch: 0, vRoll: 0, vHop: 0,
    rest: { lift: 0, pitch: 0, roll: 0 },
  };

  function spring(x, v, target, dt) {
    const a = -K * (x - target) - DAMP * v;
    v += a * dt;
    return [x + v * dt, v];
  }

  function step(dt) {
    [s.lift, s.vLift] = spring(s.lift, s.vLift, s.rest.lift, dt);
    [s.pitch, s.vPitch] = spring(s.pitch, s.vPitch, s.rest.pitch, dt);
    [s.roll, s.vRoll] = spring(s.roll, s.vRoll, s.rest.roll, dt);
    // The rams end their stroke rather than the spring going on past it.
    if (s.lift < LIFT_MIN) { s.lift = LIFT_MIN; s.vLift = Math.max(0, s.vLift); }
    if (s.lift > LIFT_MAX) { s.lift = LIFT_MAX; s.vLift = Math.min(0, s.vLift); }
    s.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, s.pitch));
    s.roll = Math.max(-ROLL_MAX, Math.min(ROLL_MAX, s.roll));
    if (s.hop > 0 || s.vHop > 0) {
      s.vHop -= HOP_G * dt;
      s.hop += s.vHop * dt;
      if (s.hop <= 0) {
        s.hop = 0;
        s.vHop = -s.vHop * HOP_REBOUND;
        if (s.vHop < 0.3) s.vHop = 0;
      }
    }
  }

  return {
    state: s,
    /** Fire the pumps: one of KICKS's names. */
    kick(kind) {
      const k = KICKS[kind];
      if (!k) return;
      s.vLift += k.lift ?? 0;
      s.vPitch += k.pitch ?? 0;
      s.vRoll += k.roll ?? 0;
      if (k.hop && s.hop === 0) s.vHop = k.hop;
    },
    /** Where the body settles: ride height (0), slammed (negative), or a sulk. */
    setRest(lift = 0, pitch = 0, roll = 0) {
      s.rest.lift = lift;
      s.rest.pitch = pitch;
      s.rest.roll = roll;
    },
    /** Fixed substeps: a 2.2 Hz spring at a dropped frame's 1/15 s would ring up rather than settle. */
    update(dt) {
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < n; i++) step(dt / n);
    },
    /** Straight back to ride height, nothing moving — a car dissolving in or written off. */
    reset() {
      Object.assign(s, { lift: 0, pitch: 0, roll: 0, hop: 0, vLift: 0, vPitch: 0, vRoll: 0, vHop: 0 });
      s.rest = { lift: 0, pitch: 0, roll: 0 };
    },
    /** Anything still moving? */
    busy: () => s.hop > 0 || Math.abs(s.vLift) + Math.abs(s.vPitch) + Math.abs(s.vRoll) > 1e-3
      || Math.abs(s.lift - s.rest.lift) > 1e-3,
  };
}
