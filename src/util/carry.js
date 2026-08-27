// The momentum a crash carries downfield.
//
// A wreck used to detonate on the spot: the two shells froze at the impact point, the fireball
// bloomed out of a fixed centre and the shards fanned off a stationary origin. Nothing in the
// picture remembered that a taxi had just arrived there at 22 u/s, so the beat read as "car stops,
// *then* explodes" — and under the crash slow-mo, which stretches those first frames out to five
// times their length, that is exactly the frame the eye has time to notice.
//
// So everything the wreck throws is given a slice of the taxi's speed along its heading. How big a
// slice is each effect's own business — a shard keeps most of it, a fireball is buoyant gas and
// keeps less, the smoke collar least of all — but they all spend it against the same drag, which
// is what keeps the wreck reading as one object coming apart rather than as five effects that each
// happen to be drifting.
//
// It is a **closed form**, in the same spirit as game/blast.js's puffs and its tyre roll: position
// is `origin + velocity × carryTravel(age)`, evaluated from scratch every frame. Nothing
// accumulates, so a slow-motion frame is the same shape as a full-speed one — which matters here
// more than anywhere, since the whole point is a beat that is played back at 0.18× speed.

// 1/s. Sized off what it has to do rather than off any real drag: a car-sized thing launched at
// 22 u/s covers 22/1.7 = 12.9 units before it stops, and reaches 44% of that in the first third of
// a second. That is a wreck sliding roughly its own length through the fireball's opening frames,
// which is the read — a shove, not a launch.
export const CARRY_DRAG = 1.7;

// Loco Mode tops out at BOOST_SPEED 22.1 u/s and overdrive takes it to 34, half again as fast. The
// carry saturates rather than scaling all the way up: at 34 the shards left frame, and — worse —
// the two wrecks looked like different *events* rather than the same one at different speeds. The
// cap sits a little above the boost top so an overdrive wreck still throws harder than an ordinary
// one, just not by half again.
export const CARRY_CAP = 26;

/** The usable momentum in an impact at `speed` u/s: signless, and saturated at CARRY_CAP. */
export const carrySpeed = (speed) => Math.min(Math.abs(speed || 0), CARRY_CAP);

/**
 * How far something launched at 1 u/s into CARRY_DRAG has travelled by `age` seconds — the closed
 * form of an exponential drag, `(1 − e^−k·age) / k`. Multiply by the launch speed for the offset.
 *
 * Bounded at 1/CARRY_DRAG = 0.588 units per u/s of launch, so every reach in the wreck is known in
 * advance and nothing can wander out of the frame the camera pulls into.
 */
export const carryTravel = (age) => (1 - Math.exp(-CARRY_DRAG * age)) / CARRY_DRAG;
