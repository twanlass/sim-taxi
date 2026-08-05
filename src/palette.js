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
  //
  // These are `#8CC4E8` / `#DCEDF7` restated. The sky dome's shader was writing linear colour
  // straight to an sRGB framebuffer — see the note on `colorspace_fragment` in game/scene.js —
  // so every sky in the game rendered darker and more saturated than the hex it was written as.
  // With the conversion in place the hexes finally mean what they say, and these are the ones
  // that reproduce the sky the game actually shipped: the pixels are unchanged, the numbers now
  // describe them.
  skyTop: '#438DCE',
  skyBottom: '#B7D8ED',
  fog: '#B7D8ED',

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

  // Windows stay dark in daylight, which is what sells scale on a blocky mass. After dusk a
  // seeded subset of the panes lights up — see city/buildings.js.
  window: '#3A424C',

  // --- Night. Everything here is drawn *unlit* (see glowMaterial in util/geo.js) and faded in by
  // the day/night cycle, so these are the colours the light actually leaves on screen rather than
  // surface colours that get shaded.
  //
  // Warm indoors against a cool night is the whole reason a lit city reads: the sky, the moonlight
  // and the road are all blue after dusk, so anything sodium-coloured pops off it without needing
  // to be bright. The cool pane is the office-at-2am exception, and stays rare.
  windowLit: '#FFCB78',
  windowLitCool: '#BFD8F5',
  // Street lamps. The head is the same colour as the pool it throws, one bright and one very
  // faint, so a lamp and the light under it read as one object.
  lampLight: '#FFC070',
  // Moonlight. Cool and desaturated rather than blue-grey: a saturated blue moon turns the whole
  // city teal, and the buildings' own colours have to survive the night.
  moon: '#AEC2E6',

  headlight: '#FFF0CC',
  tailLight: '#FF3B2E',

  // Precipitation. Rain is barely coloured — it reads by moving, not by hue — and picks up
  // whatever is behind it. Snow is warm-white so it doesn't disappear into an overcast sky.
  rain: '#C3DAEC',
  snow: '#FFFFFF',

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

  // The drop-off marker: the taxi's own yellow, one state, fixed. Only one is ever on the board —
  // the rider currently aboard — so it has nothing to be told apart from, and a per-fare hue there
  // was saying something the player could not use.
  //
  // It briefly had two states, teal until the pin was tapped and yellow after, on the grounds that
  // a pin above a parked taxi was a question rather than an instruction. That window is gone: the
  // taxi dispatches itself at pickup (see gameplay.md), so a drop-off is never unanswered and the
  // teal was a state the game could no longer reach. Yellow from the first frame is now the honest
  // reading — the route band, the car and the place it is driving to are one colour saying "this is
  // the job".
  //
  // Two weights: the head, and the ring on the tarmac lightened. (There was a third — a post one
  // shade under the head — until the pin lost its shaft and became a floating head.) The ring is
  // `routeLine`, the exact paint the band leading into it is drawn in, so the band and the disc it
  // lands in are one mark rather than two yellows meeting at the kerb.
  destination: '#F5C130',
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
