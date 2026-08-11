// The tap acknowledgement: whatever the player just picked swells and settles back.
//
// It is feedback, not information. What the tap *means* — the taxi has been sent — is already said
// by the route band unrolling along the road, but that starts a junction away from the finger and
// runs off across the city. A rider is about 26px tall at play zoom with a 29px crystal over their
// head, so without something moving on the corner itself there is no answer under the finger on the
// frame the tap lands, and a tap that hit reads exactly like a tap that missed.
//
// **One envelope, shared by everything that pops.** The rider figure (game/fares.js) and the
// crystal above them (game/faremarker.js) are two meshes with two owners; on the same curve they
// read as one object reacting. Hand-tuned separately they read as two things that happened to be
// tapped at once — which is what the first version looked like, with the crystal still swelling
// after the figure had settled.

export const POP_TIME = 0.4;

// How far it dips *under* rest on the way back — a percentage of the swell, not of the object.
//
// This is the part that makes it read as sprung. Without it the shape returns to rest along a decay
// curve and the last third of the animation is a barely-moving object slowly stopping, which reads
// as the pop having been laggy rather than as it having finished. Overshooting the other way gives
// the eye an ending to see.
const POP_DIP = 1.2;

/**
 * Pop envelope for `t` seconds since the tap: 0 → 1 → slightly under 0 → 0 over POP_TIME.
 *
 * Peaks at 0.944 a quarter of the way in (~0.09s), crosses back through rest at 0.73 (~0.29s) and
 * bottoms out at −0.131 (~0.35s) before landing on exactly 0 at POP_TIME. The first term is the
 * asymmetric swell the level-change kick already uses — snap up, ease down (see `kickEnvelope` in
 * geometry/diamond.js) — and the second is the undershoot, weighted by t² so it can only bite near
 * the end, where the swell has run out.
 *
 * Callers multiply by their own amplitude below, so 0.944 rather than 1.0 at the peak is baked into
 * those numbers rather than normalised out. Normalising would put a 1.06 fudge factor between the
 * constants and the pixels they were measured in.
 */
export function popEnvelope(t) {
  if (!(t >= 0) || t >= POP_TIME) return 0;
  const u = t / POP_TIME;
  return Math.sin(Math.PI * u ** 0.55) - POP_DIP * Math.sin(Math.PI * u) * u ** 2;
}

// Peak swell per object, as a fraction over rest. They differ because the two objects are different
// sizes on screen and the pop has to look like the same gesture on both:
//
//   the crystal is ~29px and goes to ~35px at the peak, dipping to ~28px before it lands. Bigger
//   than the level-change kick's 0.1 (29px → 32px) on purpose — that one is competing only with
//   itself, this one has to be legible under a fingertip.
//
//   the rider is ~26px and goes to ~31px. A hair less than the crystal because the figure grows out
//   of its own feet (see game/fares.js) while the crystal grows about its centre, so the same
//   fraction travels further on screen.
export const POP_SCALE_DIAMOND = 0.22;
export const POP_SCALE_RIDER = 0.2;
