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

  // --- The meter over a waiting rider: an urgency bar above a distance bar.
  //
  // Both bars share one unfilled colour and one dark backing, so the only thing that ever changes
  // is how many segments are lit and what colour the urgency ones are.
  meterBack: '#14161A',        // the plate behind both bars, drawn at 0.75 alpha
  meterEmpty: '#3A3F47',       // an unlit segment on either bar
  meterDistance: '#8A4FE8',    // a lit distance segment — flat, the same purple at every tier
  // Ring around the plate once the taxi has been sent at this rider. The Loco Mode pill's yellow,
  // which is the taxi's own — the two things on screen that mean "you told me to do this".
  meterSelected: '#F5C130',

  // Urgency, indexed by how many of the four segments are still lit. Deliberately not a ramp: a
  // colour that changes imperceptibly tells the player nothing, so it snaps at each segment lost.
  // 1 and 0 share red — by then the number of segments is the news, not the hue.
  urgency: ['#E8433A', '#E8433A', '#E8922E', '#E0D233', '#3ECF5A'],

  destination: '#E24BC4',
  destinationPost: '#8C2E79',
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
