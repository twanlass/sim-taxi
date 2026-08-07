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
  carGlass: '#2E3640',

  // --- Game entities. Deliberately higher-chroma than anything in the city so they read
  // instantly against the muted buildings and grey roads.
  policeBody: '#2E5FA8',
  policeRoof: '#F2F4F7',

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

  // The fare colour is assigned at pickup and shared by the taxi and that rider's destination.
  // With one taxi this is flavour; with several it is the whole read of the board — which car is
  // carrying which fare, and which pin it is heading for.
  //
  // Chosen to avoid every colour already doing a job: traffic signals (red / amber / green), the
  // taxi's own yellow body, and the white of an unclaimed passenger.
  fareColors: ['#25D9D2', '#E24BC4', '#A46BFF', '#4D9BFF', '#FF6B9D'],

  // Urgency, indexed by how much of the clock is left, in quarters. Deliberately not a ramp: a
  // colour that changes imperceptibly tells the player nothing, so it snaps at each quarter lost.
  // 1 and 0 share red — by then there is nothing redder to go to.
  //
  // This is what the diamond over a waiting rider is painted in, and it is the only thing that
  // marker says now. A four-segment bar used to carry it, where the count of lit blocks was the
  // level and the colour merely agreed with the count; a hue on a single crystal says it in a
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
