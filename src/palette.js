import * as THREE from 'three';

// Single source of colour truth, same discipline as the terrain prototype: per-instance variety
// comes from small HSL jitters around these bases, never from free colour choices.

export const PALETTE = {
  // Light sky blue overhead, going paler — not white — at the horizon.
  //
  // This used to be golden hour: the same blue falling into a warm beige haze. The haze read as
  // smog against pale asphalt and dragged the whole frame towards sepia, which is a strange look
  // for a bright, toy-coloured city. The sun and the hemisphere fill are still warm, so the light
  // on the buildings is unchanged — only what's behind them moved.
  //
  // Must be kept in step with the 16.4 keyframe in game/daylight.js, which is where the parked
  // sky actually comes from: createDaylight() applies its keyframe over these on construction.
  skyTop: '#8CC4E8',
  skyBottom: '#DCEDF7',
  fog: '#DCEDF7',

  sun: '#FFDEBB',
  hemiSky: '#F0C79B',
  hemiGround: '#6B5A48',

  asphalt: '#636972',
  asphaltEdge: '#6B717A',
  laneMark: '#D6D2C4',
  crosswalk: '#DAD7CB',
  sidewalk: '#9E9C94',
  kerb: '#8A887F',
  park: '#6F9A5A',

  // Building envelopes — deliberately muted so height and massing read before colour does.
  concrete: '#B7B2A6',
  pale: '#D2CFC5',
  tan: '#C6B189',
  brick: '#A06A57',
  glass: '#7B93A8',
  slate: '#767B85',
  roof: '#565A61',
  rooftop: '#6B6F76',

  // Windows stay dark in every lighting condition, which is what sells scale on a blocky mass.
  window: '#3A424C',

  // Yellow is reserved for the taxi. An amber car used to sit in this list and was genuinely
  // mistakable for the player's vehicle at play zoom, where both are a few pixels of warm colour.
  carBody: ['#C9503F', '#2F8F94', '#4E7FC0', '#E4E1DA', '#3F8A63', '#8A6BB0', '#D9D2C3', '#455160'],
  // The ghost rim worn by a nearby car while it is hidden behind a building — see
  // game/carghosts.js. Index-aligned with carBody, so a car's `colorIndex` addresses both and each
  // ghost is unmistakably *that* car rather than a generic hazard mark.
  //
  // Each one is its own paint with the lightness pulled 70% of the way to 0.74 and **hue and
  // saturation left exactly alone**. Two things that rule is doing:
  //
  //   - Pulled *toward* a target, not lifted by a fixed amount. The slate (#455160) sits at L 0.32
  //     and needs the whole lift to read at all from the shadowed side of a tower; the off-white
  //     (#E4E1DA) sits at L 0.87 and a fixed lift would take it to pure white, which stops being
  //     that car's paint and starts being a generic glare. One target normalises both.
  //   - Saturation must NOT rise, which is the one that bites. #E4E1DA and #D9D2C3 are hue 42° and
  //     41° — *yellow* — and only read as off-white because their saturation is 0.16 and 0.22.
  //     Push it up and both become pale gold, sitting in taxiGhost's own hue family (48°) where a
  //     2px outline is indistinguishable from the player's own car. Yellow is reserved; leaving
  //     saturation where it is, is what reserves it. tools/probe.mjs asserts the clearance.
  carBodyGhost: ['#DA887D', '#71CDD2', '#85A7D4', '#D0CABE', '#80C5A1', '#AC96C7', '#D0C7B4', '#8D9BAD'],
  carGlass: '#2E3640',

  // --- Game entities. Deliberately higher-chroma than anything in the city so they read
  // instantly against the muted buildings and grey roads.
  policeBody: '#2E5FA8',
  policeRoof: '#F2F4F7',

  // The ambient flyover — see geometry/plane.js. A white aeroplane against a pale sky is a blank
  // shape, so it carries a cheatline; red because it is the one hue in the game with nothing else
  // to say (yellow is the taxi's, teal is the drop-off's, and the urgency scale owns the rest of
  // the warm end). Deliberately a shade off `carBody[0]`, which is a red car: at play zoom the two
  // never share a frame region, but nothing is gained by making them the same paint.
  planeBody: '#EDEEF0',
  planeStripe: '#C0524A',
  planeProp: '#33383F',

  taxiBody: '#F5C130',
  taxiTrim: '#2B2B30',
  taxiSign: '#F2F0E8',
  // The ghost outline traced where the taxi is hidden behind a building — see
  // geometry/ghostoutline.js. The body yellow lightened a touch: it has to say "your taxi is
  // here" while sitting on the dark side of a tower, where the body colour itself goes muddy.
  // Deliberately close to `routeLine` — both are the taxi's own yellow speaking from under other
  // geometry — but not the same entry, so the band can be retuned without moving the ghost.
  taxiGhost: '#FFDD55',
  // A waiting passenger is deliberately colourless — before pickup any taxi could take any rider,
  // so a colour there would imply a commitment that doesn't exist yet.
  passenger: '#FFFFFF',

  // Urgency, indexed by how much of the clock is left, in quarters. Deliberately not a ramp: a
  // colour that changes imperceptibly tells the player nothing, so it snaps at each quarter lost.
  // 1 and 0 share red — by then there is nothing redder to go to.
  //
  // This is what a fare's diamond and the disc under its rider are painted in, and it is the only
  // thing those markers say. A four-segment bar used to carry it, where the count of lit blocks was
  // the level and the colour merely agreed with the count; a hue on a single crystal says it in a
  // glance rather than in a read.
  urgency: ['#E8433A', '#E8433A', '#E8922E', '#E0D233', '#3ECF5A'],

  // The drop-off marker: one teal, fixed, worn by the ring on the tarmac and by the off-screen
  // pointer that stands in for it. Only one drop-off is ever on the board — the rider currently
  // aboard — so it has nothing to be told apart from, and a per-fare hue there was saying something
  // the player could not use.
  //
  // Teal because the marker has no state to report. Hue on a *fare* marker means urgency now — that
  // is what the diamond over a waiting rider is saying — and the drop-off has no clock of its own,
  // so it has to sit outside that scale entirely. It wore the taxi's yellow for a while, on the
  // grounds that the car, the route band and the place it is driving to were one statement; but
  // yellow is the taxi's, and borrowing it put a marker that reports nothing inside a vocabulary it
  // is not part of.
  //
  // One entry rather than two. It used to be a head colour plus the same hue lightened for the disc
  // beneath it — and before that a third for the post under the head. The head is gone and the disc
  // is the whole marker, so there is one weight left to name.
  destination: '#5FE0D9',
  // The taxi's own yellow, lightened. This used to be `select` as well, worn by a pool on the road
  // marking the taxi as selected; that pool is gone and the route band is the only thing wearing
  // it now. Yellow rather than white because white is the unclaimed-passenger marker.
  routeLine: '#FFE873',

  // The crash — see game/blast.js. Three stops of one ramp rather than three separate effects:
  // every fireball puff walks core → flame → smoke over its own life, so the cluster carries the
  // hot centre, the flame front and the smoke tail at the same time. It is drawn unlit, which is
  // why the smoke stop is a lit-looking grey rather than a true black: nothing here picks up the
  // sun, so the colour has to arrive already looking like it did.
  // The ember stop is not decoration, it is what keeps the ramp out of the mud: lerped straight
  // from flame to smoke a puff spends its whole tail somewhere around #9A603D, which is the brick
  // in the building list — a fireball dying the colour of the wall behind it. Going through a deep
  // ember first is both how fire actually dies and a colour that cannot be mistaken for masonry.
  blastCore: '#FFF3C4',
  blastGold: '#FFA828',
  blastFlame: '#FF7A1F',
  blastEmber: '#8C3A12',
  blastSmoke: '#4B4B55',
  // The shockwave on the tarmac. A pale warm yellow rather than white — white on this asphalt
  // reads as a lighting artefact, and the ring belongs to the fireball above it.
  blastRing: '#FFE9A8',

  lightRed: '#E24B3C',
  lightYellow: '#F0B23A',
  lightGreen: '#4FBF63',
  lightOff: '#333940',
  pole: '#4C5158',

  trunk: '#6B4E35',
  foliage: '#4F8F4A',
};

export function color(value) {
  return new THREE.Color(PALETTE[value] ?? value);
}

export function jitterColor(base, rng, { h = 0.01, s = 0.05, l = 0.06 } = {}) {
  const c = base instanceof THREE.Color ? base.clone() : color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(
    (hsl.h + rng.jitter(h) + 1) % 1,
    THREE.MathUtils.clamp(hsl.s + rng.jitter(s), 0, 1),
    THREE.MathUtils.clamp(hsl.l + rng.jitter(l), 0.05, 0.95),
  );
}

export const BUILDING_COLORS = ['concrete', 'pale', 'tan', 'brick', 'glass', 'slate'];
