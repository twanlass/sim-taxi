import * as THREE from 'three';

// Single source of colour truth, same discipline as the terrain prototype: per-instance variety
// comes from small HSL jitters around these bases, never from free colour choices.

export const PALETTE = {
  // Golden hour: deep blue overhead falling to a warm haze at the horizon.
  skyTop: '#5E96C7',
  skyBottom: '#DED7D0',
  fog: '#C6DDE8',

  sun: '#FFDEBB',
  hemiSky: '#F0C79B',
  hemiGround: '#6B5A48',

  asphalt: '#4E535B',
  asphaltEdge: '#565B63',
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
  // Back to the taxi's own yellow. White collided with the unclaimed-passenger marker, which is
  // also white — two white rings on screen meaning different things. Yellow is safe because the
  // fare palette deliberately excludes it.
  select: '#FFE873',
  // A waiting passenger is deliberately colourless — before pickup any taxi could take any rider,
  // so a colour there would imply a commitment that doesn't exist yet.
  passenger: '#FFFFFF',
  passengerPost: '#8A9099',

  // The fare colour is assigned at pickup and shared by the taxi and that rider's destination.
  // With one taxi this is flavour; with several it is the whole read of the board — which car is
  // carrying which fare, and which pin it is heading for.
  //
  // Chosen to avoid every colour already doing a job: traffic signals (red / amber / green), the
  // taxi's own yellow body, and the white of an unclaimed passenger.
  fareColors: ['#25D9D2', '#E24BC4', '#A46BFF', '#4D9BFF', '#FF6B9D'],
  destination: '#E24BC4',
  destinationPost: '#8C2E79',
  routeLine: '#FFD84D',

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
