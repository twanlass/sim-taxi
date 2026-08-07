// The other half of a drop-off's payout: a handful of little yellow sparks that break off the taxi
// and get pulled into the Punch It pill.
//
// The delivery pays two currencies and they were only ever showing one. The flying `$20` says
// "money"; nothing said "and a third of a tank", so the meter simply grew on its own in the corner
// of the screen with no visible cause. These are that cause — the fuel *travelling* from the car
// that earned it to the button that spends it.
//
// Deliberately sequenced behind the payout rather than fired alongside it: two swarms leaving the
// same car at the same time for two different corners is noise, and the two currencies stop reading
// as two. HANDOFF is set from the payout's own flight (620ms rise + 460ms fly, see popEarning in
// main.js) so the coin has landed and gone before the first spark appears.
//
// DOM rather than three.js, for the same reason the payout is: the target is a piece of HUD, and
// chasing a DOM element's viewport box from inside the scene graph means unprojecting a rectangle
// that moves on every resize. Both endpoints are resolved as functions at burst time, not baked in
// at call time, so a taxi that has driven on — and a pill that a resize has moved — are both still
// aimed at correctly.

const BITS = 6;
const HANDOFF = 1000;   // ms after the drop-off before the first spark appears — see above
const STAGGER = 38;     // ...and between each spark after it, so they leave as a ripple not a ring
const BURST = 200;      // ms breaking away from the taxi
const FLY = 420;        // ms being pulled into the pill

// Where each spark scatters to before it gets pulled in. Fixed angles rather than random ones:
// this is the only randomness the effect would need, and it isn't worth another seed stream (see
// the two-seeds rule in CLAUDE.md) when an even fan with alternating reach looks the same. The 0.7
// offset just stops the first spark from leaving dead horizontal.
const scatter = (i) => {
  const angle = (i / BITS) * Math.PI * 2 + 0.7;
  const radius = i % 2 ? 44 : 30;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
};

/**
 * Fire the sparks. Both `from` and `to` are functions returning viewport `{x, y}` — see above.
 * `onArrive` fires once, when the first spark reaches the pill, and is what should actually hand
 * the fuel over: the meter starting to fill before the energy lands reads exactly backwards.
 */
export function flyEnergyToBoost({ from, to, onArrive }) {
  setTimeout(() => {
    const start = from();
    const target = to();
    // The pill is `display: none` in shot mode and once the run is over, so by the time the sparks
    // are due there may be nothing to fly to. Hand the fuel over anyway and skip the flight —
    // losing earned boost to a presentation detail would be a real bug wearing a cosmetic one.
    if (!start || !target) {
      onArrive?.();
      return;
    }
    let landed = false;

    for (let i = 0; i < BITS; i++) {
      const bit = document.createElement('div');
      bit.className = 'energy-bit';
      bit.style.left = `${start.x}px`;
      bit.style.top = `${start.y}px`;
      document.body.append(bit);

      const out = scatter(i);
      const dx = target.x - start.x;
      const dy = target.y - start.y;

      const burst = bit.animate([
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.3)' },
        { opacity: 1, transform: `translate(-50%, -50%) translate(${out.x}px, ${out.y}px) scale(1)` },
      ], { duration: BURST, delay: i * STAGGER, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' });

      burst.onfinish = () => {
        // Ease *in* on the way to the pill, not out: the spark should look pulled, accelerating
        // into the button, which is what sells the button as the thing collecting it.
        const fly = bit.animate([
          { opacity: 1, transform: `translate(-50%, -50%) translate(${out.x}px, ${out.y}px) scale(1)` },
          { opacity: 0.9, transform: `translate(-50%, -50%) translate(${dx * 0.55}px, ${dy * 0.55}px) scale(0.75)`, offset: 0.6 },
          { opacity: 0, transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.25)` },
        ], { duration: FLY, easing: 'cubic-bezier(0.5, 0, 0.75, 0.2)', fill: 'forwards' });

        fly.onfinish = () => {
          bit.remove();
          if (!landed) {
            landed = true;
            onArrive?.();
          }
        };
      };
    }
  }, HANDOFF);
}
