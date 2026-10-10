// A cue that says what a bump cost, and then goes away. Off by default; `?hitcue=chip`, `edge` or
// `both` to compare on a phone.
//
// The car is already the gauge (game/taxidamage.js): there was an HP bar in the HUD and it came out,
// because a bar beside the car turned the car into decoration for a number. What the car cannot say
// is *how much that hit took*. Its tiers are steps at 67% and 34%, and a 24-HP rear-end from 90
// changes nothing you can see — so the player learns the price of a hit only when it is the one that
// wrecks them. Both cues here answer at the moment of the hit and are gone a second and a half later,
// so the screen goes back to being the car.
//
//   chip   a short bar over the taxi's roof. The part the hit took flashes red and drains, the rest
//          stays white (red once the car is smoking). Pinned to the car, where the eye already is
//          when it hits something. Ticks at the two tier lines, so the bar and the car agree.
//   edge   a red wash in from the frame edge, the shooter's "you're hurt", harder for a bigger hit
//          and the less HP is left. Says *that* it hurt and roughly how badly, not how much is left.
//          The frame edge is already spoken for in red: the siren wash (game/sirenglow.js) and the
//          getaway's frame (game/robberyglow.js) both come in from there, so this one is drawn as a
//          plain multiply-style vignette rather than their screen-blended blooms.
//
// Both run on game time, so a pause holds them.

/** Which cues the URL asked for. */
export function hitCueMode(params) {
  const v = params.get('hitcue');
  return {
    chip: v === 'chip' || v === 'both',
    edge: v === 'edge' || v === 'both',
  };
}

// The chip's beat, in seconds of game time.
export const CHIP_POP = 0.12;          // grows in off the roof
export const CHIP_DRAIN_AT = 0.28;     // the lost chunk sits red this long, then drains...
export const CHIP_DRAIN = 0.35;        // ...over this
export const CHIP_HOLD = 1.2;          // up in full, counted from the hit
export const CHIP_FADE = 0.35;
// Over the roof: the taxi's deck is ~1.6, its sign ~2.2, and the bar wants clear air above both.
const CHIP_Y = 3.4;

// The edge wash. Instant on, a short hold, then out — it is a flinch, not a state.
export const EDGE_HOLD = 0.08;
export const EDGE_FADE = 0.9;
// Strength 0..1: a floor for any hit, more for a harder one (bumpDamage tops out at 60), more again
// the emptier the car. A tap at full HP is a hint; the hit that leaves you smoking is not.
export function edgeStrength(damage, hpFraction) {
  const s = 0.3 + 0.35 * Math.min(1, damage / 60) + 0.35 * (1 - hpFraction);
  return Math.max(0, Math.min(1, s));
}

const ease = (t) => 1 - (1 - t) * (1 - t);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * @param mode      hitCueMode(...)
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param maxHp     the taxi's full HP
 * @param lowAt     fraction at which the car starts smoking (SMOKE_FRACTION)
 * @param midAt     fraction at which the boot comes up
 */
export function createHitCue({ mode, project, maxHp, lowAt, midAt }) {
  const idle = { hit: () => {}, update: () => {}, clear: () => {} };
  if (!mode.chip && !mode.edge) return idle;

  const chip = mode.chip ? buildChip(lowAt, midAt) : null;
  const edge = mode.edge ? document.getElementById('hit-edge') : null;
  if (edge) edge.hidden = false;

  const c = { t: Infinity, before: 1, after: 1, x: 0, z: 0 };
  const e = { t: Infinity, strength: 0 };

  function hit({ damage, hp, taxi }) {
    const after = clamp01(hp / maxHp);
    const before = clamp01((hp + damage) / maxHp);
    if (chip) {
      // HP before this hit is where the last one left the white, so a second knock while the chip
      // is still up carries straight on from it.
      c.before = before;
      c.after = after;
      c.t = 0;
      c.x = taxi.x;
      c.z = taxi.z;
      chip.root.hidden = false;
      chip.root.classList.toggle('is-low', after <= lowAt);
    }
    if (edge) {
      e.strength = Math.max(e.strength * fadeOf(e.t), edgeStrength(damage, after));
      e.t = 0;
    }
  }

  const fadeOf = (t) => (t <= EDGE_HOLD ? 1 : 1 - clamp01((t - EDGE_HOLD) / EDGE_FADE));

  function update(dt, taxi) {
    if (chip && c.t < CHIP_HOLD + CHIP_FADE) {
      c.t += dt;
      if (taxi) { c.x = taxi.x; c.z = taxi.z; }
      const p = project(c.x, CHIP_Y, c.z);
      const pop = ease(clamp01(c.t / CHIP_POP));
      const fade = 1 - clamp01((c.t - CHIP_HOLD) / CHIP_FADE);
      const drain = ease(clamp01((c.t - CHIP_DRAIN_AT) / CHIP_DRAIN));
      chip.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%) scale(${0.6 + 0.4 * pop})`;
      chip.el.style.opacity = String(pop * fade);
      chip.fill.style.width = `${c.after * 100}%`;
      chip.lost.style.width = `${(c.before + (c.after - c.before) * drain) * 100}%`;
      if (c.t >= CHIP_HOLD + CHIP_FADE) chip.root.hidden = true;
    }
    if (edge && e.t < EDGE_HOLD + EDGE_FADE) {
      e.t += dt;
      const a = e.strength * fadeOf(e.t);
      edge.style.setProperty('--hit-a', a.toFixed(3));
      if (e.t >= EDGE_HOLD + EDGE_FADE) { e.strength = 0; edge.style.setProperty('--hit-a', '0'); }
    }
  }

  function clear() {
    c.t = Infinity;
    e.t = Infinity;
    e.strength = 0;
    if (chip) chip.root.hidden = true;
    if (edge) edge.style.setProperty('--hit-a', '0');
  }

  return { hit, update, clear, state: { chip: c, edge: e } };
}

function buildChip(lowAt, midAt) {
  const root = document.getElementById('hit-chip');
  root.innerHTML = `
    <div class="hit-chip">
      <div class="hit-chip-lost"></div>
      <div class="hit-chip-fill"></div>
      <div class="hit-chip-tick" style="left:${lowAt * 100}%"></div>
      <div class="hit-chip-tick" style="left:${midAt * 100}%"></div>
    </div>`;
  return {
    root,
    el: root.querySelector('.hit-chip'),
    fill: root.querySelector('.hit-chip-fill'),
    lost: root.querySelector('.hit-chip-lost'),
  };
}
