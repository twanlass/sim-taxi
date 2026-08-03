// Physics-mode toggle. Selects which car-physics implementation runs this session.
//
// Read once at boot by the two physics branches (arcade tilt/roll; rigid-body bubble)
// so each can gate itself. This module is a pure lookup -- it must NOT import three,
// traffic, or anything with side effects, so it's safe to pull into headless code paths
// (tools/check.mjs BOOT list, tools/probe.mjs, etc.) without dragging in WASM.
//
// Query string: ?physics=off | arcade | rigid   (default off)

export const MODES = Object.freeze({
  OFF: 'off',
  ARCADE: 'arcade',
  RIGID: 'rigid',
});

const VALID = new Set(Object.values(MODES));

export function getPhysicsMode() {
  // Headless (Node) has no window -- physics stays off so probe/check/taxi tools
  // don't need to think about it.
  if (typeof window === 'undefined' || !window.location) return MODES.OFF;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('physics');
  if (raw == null) return MODES.OFF;
  const v = raw.toLowerCase();
  return VALID.has(v) ? v : MODES.OFF;
}

export function isArcade() {
  return getPhysicsMode() === MODES.ARCADE;
}

export function isRigid() {
  return getPhysicsMode() === MODES.RIGID;
}

// Arcade tuning. Kept in one place so the ratios between them are visible together — a stiffer
// spring is only interesting relative to its damping, and a higher clamp is only interesting
// relative to the gain that drives up to it.
export const ARCADE = {
  // --- Body pose ---
  // Existing corner roll amplitude is 0.3 rad. 0.55 pushes it firmly into "cartoon lean" territory
  // without the low edge digging through the sagitta lift compensation, which starts failing past
  // about 0.7 rad on this 1.7-wide body.
  ROLL_AMP: 0.55,
  // The boost lane-change leaves a steer angle on `car.steer` (up to about 13°). Preload the body
  // roll off that so the taxi visibly commits into the slide before the manoeuvre completes,
  // rather than snapping upright while translating sideways.
  ROLL_FROM_STEER: 1.4,
  // Baseline pitch clamp is ±0.13 rad; arcade lets braking dip to ±0.22 (~13°). The gain that
  // drives the target rises in step so hard braking still saturates.
  PITCH_CLAMP: 0.22,
  PITCH_GAIN: 0.022,        // 0.014 baseline
  // Existing bob amplitude is 0.045; 1.8x reads as a suspension that's a little too soft for the
  // road, which is the whole tone of arcade physics.
  BOB_GAIN: 1.8,

  // --- Contact ---
  // Taxi ~4.0 x 2.0 units after TAXI_SCALE; ambient cars are 3.4 x 1.7. Half-diagonals sum to ~3.4,
  // so anything under that centre-to-centre distance is really overlapping. Kept at 3.0 so light
  // side-swipes register without every close pass triggering.
  CONTACT_DIST: 3.0,
  // 30% off both cars on contact, per the brief. Enough to feel like a hit; not enough to stall.
  CONTACT_SCRUB: 0.70,
  // Push the *other* car by roughly half the overlap. Taxi position isn't moved — the sim keeps it
  // on its lane coordinate and a nudge here would fight the next frame's resolve.
  CONTACT_PUSH: 0.55,
  // Camera shake magnitude passed up to the game layer. World units of screen-space wobble.
  SHAKE_IMPULSE: 0.9,
  // Cooldown between successive registered contacts against the same car, in seconds. Without it a
  // slow rub against a queued vehicle fires the scrub-and-shake every single frame.
  CONTACT_COOLDOWN: 0.5,
  // Spark burst count per hit. Kept small — the pool in sparks.js is only 48 slots.
  SPARK_COUNT: 6,
};
