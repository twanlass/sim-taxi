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
  // The distance haze at the parked hour — see `hazeColor()` in game/scene.js, which is what
  // computes this and what keeps it in step with the sky all day. Deliberately **not** `skyBottom`,
  // which is where it started: that near-white has 27 points of spread between its channels, and a
  // haze with no chroma of its own can only take chroma away — the far city came out grey rather
  // than distant. This is `skyTop` at full saturation: the same hue, 181 points of spread.
  fog: '#4AC6FF',

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
  // This is the *bottom* of a pane now rather than the whole of it — see `windowSky`.
  window: '#3A424C',
  // What a pane catches of the sky. Glass is lerped from `window` toward this across each opening
  // and across each façade, which is the whole of the reflection: no envelope map, no second
  // material, no texture — just a vertex colour that interpolates. See `bakeColors` in util/geo.js
  // for why that works on a flat-shaded mesh at all.
  //
  // Nowhere near `skyTop` (#8CC4E8), and deliberately: this is a **reflection coefficient**, not
  // the sky. Glass returns a few percent of what hits it and the rest is the dark room behind, so
  // a pane painted the colour of the sky reads as a hole cut in the building. It also has to
  // survive the rule above — windows sell a building's scale by staying dark, and a façade lerped
  // all the way to this at the top still averages darker than the old flat `window` did, because
  // the streak that reaches full strength covers about a fifth of a face.
  //
  // It has two blues to stay clear of and clears both on saturation rather than hue: `policeBody`
  // (#2E5FA8) at 226° and the blue car (#4E7FC0) at 222°, against this one's 217°. Nine degrees and
  // five is nothing — what separates them is 0.47 saturation against 0.87 and 0.75, and the fact
  // that both of those are *moving boxes on a road* while this is a grid of eight-pixel rectangles
  // ruled across a wall. A first pass at 0.33 was safer still and read as grey lightening rather
  // than as sky.
  windowSky: '#6E8CB0',
  // The ground floor is a different animal from the storeys above it: one continuous pane rather
  // than a punched hole, so it is a stop lighter than `window` (L 0.10 against 0.06) — a shopfront
  // catches the sky where a recessed window catches the room behind it. Keeping it a separate
  // entry is also what lets the base of a building read as a base at play zoom, where a window
  // upstairs is eight pixels and the shopfront band is the whole width of the façade.
  shopfront: '#4C5A67',
  // The door — the one warm note on a façade, a door being the part of a building made of
  // something other than glass and stone.
  //
  // It sits at hue 23° where getHSL measures (the working space, not the colour picker's — see the
  // long note on `cone`), which is the urgency ramp's own family at 20° and four degrees off the
  // trunk of every tree in the city. What keeps it out of that vocabulary is **value, not hue**:
  // at L 0.05 against the ramp's 0.42 it is very nearly black, and seven pixels of near-black brown
  // cannot be read as "this fare is running out of time" however warm it technically is.
  door: '#4A3D33',
  // The canopy over a door, and the frame around the door itself. A canvas grey — awnings want to
  // be striped scarlet and cannot be here, for the reason above.
  awning: '#8A8478',
  // The tank on a rooftop water tower. Weathered cedar, which is what those are actually made of,
  // and the one thing up there that isn't grey — a skyline of nothing but `rooftop` boxes reads as
  // one repeated smudge rather than as roofs with things on them. Deliberately the trunk's own
  // family (23° against 22°, saturation 0.61 against 0.61): a water tank and a tree are the two
  // wooden things in this city and there is nothing to gain from giving them separate browns.
  watertank: '#7C5C3E',
  // The hoop bands around that tank, its legs, and the fan grilles on the AC units. One dark for
  // every piece of rooftop ironwork, same argument as `birdBill`.
  rooftopIron: '#43484F',

  // --- The taxi garage --------------------------------------------------------
  // The one building the player owns, and the only one the tower generator doesn't draw. Its
  // envelope stays *outside* BUILDING_COLORS on purpose: a depot is a shed among offices, and
  // giving it a family of its own is what stops it reading as one more block of flats with a hole
  // in the front.
  garageWall: '#8C8D8A',
  // Parapet cap, door frame, shutter drum. One dark for every piece of the building's ironwork,
  // the same argument as `rooftopIron` above.
  garageTrim: '#5E6167',
  // The shutter curtain. Pale, because the whole read of a roller door is the horizontal line
  // between one slat and the next — on a dark curtain those lines are shadow on shadow.
  garageDoor: '#B9BCC0',
  // Its bottom rail: the leading edge, and the one part of the door the eye tracks while it opens.
  garageDoorRail: '#4E5257',
  // Everything lining the bay. Dark enough that the taxi inside is the light thing in the hole,
  // which is the entire point of the reveal.
  garageBay: '#3B3E44',
  // The strip light on the bay ceiling. Unlit (see `unlitMaterial`) — it *is* a light source, and
  // a pale box standing in its own shadow reads as grey paint.
  garageLight: '#FFE7B8',
  // The fascia band over the door, and a deliberate exception to "yellow is reserved for the taxi"
  // below. It is reserved for the taxi; this is the taxi's building, and a band 0.45 units tall on
  // a vertical face four units up is not mistakable for a car on the road.
  garageSign: '#F5C130',

  // Yellow is reserved for the taxi. An amber car used to sit in this list and was genuinely
  // mistakable for the player's vehicle at play zoom, where both are a few pixels of warm colour.
  carBody: ['#C9503F', '#2F8F94', '#4E7FC0', '#E4E1DA', '#3F8A63', '#8A6BB0', '#D9D2C3', '#455160'],
  // The ghost rim worn by a nearby vehicle while it is hidden behind a building — see
  // game/carghosts.js. Index-aligned with carBody, so a vehicle's `colorIndex` addresses both and
  // each ghost is unmistakably *that* vehicle rather than a generic hazard mark. Box trucks read
  // from this same list: a truck's cab is painted from carBody at its own index (see truckBox
  // below), so the outline that traces it is that cab's paint lightened, exactly as a car's is.
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
  // A box truck's cab is painted from carBody, same colorIndex and everything — one taxi-company
  // fleet's palette covers both, and it is what makes a truck read as "one more vehicle in this
  // traffic" rather than a prop dropped in from elsewhere. Only the cargo box breaks from that: it
  // is baked at this one fixed tan/white rather than tinted per instance, because a real box
  // truck's box is bare aluminium or cardboard-coloured regardless of the cab up front. It gets no
  // ghost variant of its own even though a truck does wear a ghost outline: the rim traces the
  // whole vehicle as one hull in one colour (carBodyGhost at the cab's index), because the outline
  // says "there is a vehicle there", not "these are its panels".
  truckBox: '#DDD4BE',

  // --- Game entities. Deliberately higher-chroma than anything in the city so they read
  // instantly against the muted buildings and grey roads.
  policeBody: '#2E5FA8',
  policeRoof: '#F2F4F7',

  // The ambient flyover — see geometry/plane.js. A white aeroplane against a pale sky is a blank
  // shape, so it carries a cheatline; red because it is the one hue in the game with nothing else
  // to say (yellow is the taxi's, purple is a VIP's, and the urgency scale owns the rest of the
  // warm end — both ends of a trip and the band between them). Deliberately a shade off
  // `carBody[0]`, which is a red car: at play zoom the two never share a frame region, but nothing
  // is gained by making them the same paint.
  planeBody: '#EDEEF0',
  planeStripe: '#C0524A',
  planeProp: '#33383F',

  // The helicopter that visits a rooftop pad — see geometry/helicopter.js. Near-white with a warm
  // cast, and the reason is the deck it parks on: this machine spends half its vignette sitting
  // eleven storeys down on `roof`/`rooftop` rather than up against the sky, and the dark slate it
  // used to wear (#4A5462) was within 1.11 contrast of `roof` — the two were the same value, which
  // is why a parked helicopter read as a smudge on the deck rather than a thing standing on it.
  // Against the same greys this beige is 6.03 and 4.39. The beige rather than the plane's neutral
  // white because everything else on a roof is cold grey and a warm body is the cheapest way to
  // sit apart from it.
  //
  // That does put it near the aeroplane's value, which the two used to be told apart by. They are
  // told apart by paint now — the plane's single red cheatline against this one's orange-over-gold
  // pair — and by where they are: a plane is only ever a shape crossing open sky at 30 units, and
  // this is only ever a shape on or just above a roof.
  heliBody: '#F3EFE4',
  // The two cheatline bands, orange over gold. Neither can be checked against the body alone —
  // they sit stacked, so the pair has to separate from the white *and* from each other, and the
  // gold is the one under pressure from both sides: 1.60 against the body, 1.83 against the
  // orange. Lightening it wins the second and loses the first.
  heliStripeOrange: '#D96F22',
  heliStripeGold: '#EDB733',
  // The rotors, a stop lighter than `planeProp` — a main rotor is 5 units of blade sweeping over a
  // pale deck rather than a 2-unit bar against the sky, and at the plane's near-black it read as a
  // crack in the roof.
  heliRotor: '#3C424B',
  // Painted tips, the way a real machine wears them, and here they earn it twice over: they are
  // what makes the blade legible as *turning* at 40 pixels, and on a near-white airframe the
  // outboard third of a dark bar otherwise vanishes the moment it swings over the fuselage (4.01
  // against `heliBody`). A stop deeper than `heliBeacon` so the fin's lamp stays the brighter red.
  heliRotorTip: '#D9382F',
  // The anti-collision beacon on the tail. Pure and bright rather than the traffic light's
  // `lightRed`: it is drawn unlit at four pixels across and has to survive being that small, and a
  // signal red at this size reads as a brake light on a car parked on a roof.
  heliBeacon: '#FF2E2E',

  // The park flock — see geometry/bird.js. These bases are kept near-neutral on purpose: a bird
  // is a couple of pixels of moving colour, which is exactly the description of a fare marker,
  // and the way to keep the eye from reading a takeoff as something it has to act on is to give
  // it almost nothing to read. (Per-bird pigeon morphs — pale, blue-grey, green-sheen — exist,
  // but as muted instance-tint *multipliers* over these, in `birdTint` in game/birds.js; the hue
  // budget and the marker argument for keeping them greyed are documented there.) The bases
  // still have to separate from two backgrounds a bird
  // is guaranteed to sit on — the park (#6F9A5A) and the sky (#8CC4E8 → #DCEDF7) — and both are
  // lighter than these, so a dark bird reads against the grass it walks on and against the sky it
  // leaves in. `birdWing` is a stop darker than the body so a spread wing separates from the flank
  // it grew out of; `birdPale` is the one value break, on the head, so a walking bird is a shape
  // rather than a pebble.
  //
  // Lifted 20 points of luma over the first pass, which had them at 98/77 and reading as gravel.
  // **This is as light as they go**, and the ceiling is the lawn rather than taste: the grass is
  // luma 134, so a body much past 118 loses the value break it stands on and is left separating
  // from the park by hue alone. Everything else visibility asks for is spent on size instead — a
  // fifth longer, see `BIRD_SCALE` — because a bird can grow without walking into the grass.
  birdBody: '#6E7688',           // luma 118, against grass at 134 and sky at 183 → 233
  birdWing: '#5A6070',           // 96
  birdPale: '#D8DEE8',           // 221 — the patch on the head, and the whole of how a bird reads
  // Bill, legs and feet. One dark for every hard part — a warm bill would be correct for a pigeon
  // and would also be four pixels of amber in a palette where amber means "this fare is running
  // out of time". See the note on `cone` for the same argument made at length. Lifted with the
  // rest, and by less: it is the shadow line under a lighter bird and wants to stay a dark.
  birdBill: '#343943',           // 57

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

  // A VIP fare's diamond and disc — a fixed purple, never drawn from the urgency scale, so "this
  // one is a VIP" is never confusable with how much time it has left. High-chroma like every other
  // game-entity colour here: it has to read against muted buildings from across the board.
  vip: '#A64DFF',

  // The package courier — see game/parcels.js.
  //
  // `parcel` is the hue of both of a package's discs (the corner it waits on and the pad it is
  // going to) and of the route band while the taxi is driving at either. Fixed, and outside the
  // urgency scale, on exactly the argument `vip` above is made on: a package carries **no clock**,
  // so painting it green-through-red would be reporting a countdown that does not exist. Cyan
  // because nothing else here is — clear of urgency's red-to-green, the VIP purple, and the
  // taxi/routeLine yellow, all of which can be on the board at the same moment. (The old
  // `destination` teal noted below was the nearest neighbour, and it is free again.)
  parcel: '#22C3D6',
  // The box itself, built to read as 📦: kraft card, a darker lid slab for the top seam, one
  // semi-white tape strip and a white shipping label. Muted browns on purpose — the parcel is *found*
  // by the cyan pad under it, and a box in the pad's own colour would read as part of the marker
  // rather than as cargo sitting on it.
  //
  // The tape is off-white rather than the darker brown it started as: at ~15px a dark strip on dark
  // card is a shadow, and the strip is the single part that says "parcel" rather than "crate". The
  // label is whiter still, being the one bright mark on the box and the last thing to survive as it
  // shrinks into the taxi. Both are kept off pure white — that belongs to the waiting rider
  // (`passenger` above), and nothing else in the game should reach for it.
  parcelBox: '#C69A63',
  parcelLid: '#A87F4C',
  parcelTape: '#DED6C4',
  parcelLabel: '#F2F0E8',

  // Urgency, indexed by how much of the clock is left, in quarters. Deliberately not a ramp: a
  // colour that changes imperceptibly tells the player nothing, so it snaps at each quarter lost.
  // 1 and 0 share red — by then there is nothing redder to go to.
  //
  // This is what a fare's diamond and the disc under its rider are painted in, and it is the only
  // thing those markers say. A four-segment bar used to carry it, where the count of lit blocks was
  // the level and the colour merely agreed with the count; a hue on a single crystal says it in a
  // glance rather than in a read.
  urgency: ['#E8433A', '#E8433A', '#E8922E', '#E0D233', '#3ECF5A'],

  // **There is no drop-off colour any more.** A `destination` teal (#5FE0D9) lived here, worn by
  // the ring on the tarmac and by the off-screen pointer that stands in for it, on the argument
  // that the marker had no clock of its own and so had to sit outside the urgency scale entirely.
  // (It wore the taxi's yellow before that, and teal-until-tapped before *that*.) Both ends of a
  // trip and the band between them are painted from `urgency` now: the deadline the drive is
  // spending is the rider's, whichever end of the trip you are looking at. See game/urgency.js.

  // The taxi's own yellow, lightened. This used to be `select` as well, worn by a pool on the road
  // marking the taxi as selected; that pool is gone, and what still wears it is the route band on
  // a route with no fare behind it — the recovery re-route. Yellow rather than white because white
  // is the unclaimed-passenger marker.
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
  // The collar of smoke thrown out around a wreck — the construction zone's dust, tinted. It is
  // set against the **road**, not against `blastSmoke` beside it, and that is the whole of why it
  // is this light. The fireball is unlit, so its smoke stop can be a dark #4B4B55 and still read;
  // this pool is Lambert (game/dust.js), it is lying on `asphalt` #636972, and the first attempt
  // at #6E6259 — a sensible smoke grey by eye — came out at the same value as the tarmac under it
  // and vanished for the whole of the fire, leaving smoke that only appeared once the flame had
  // gone. Roughly 1.8× the road's value is what it takes to be seen against it. Warm and well
  // short of the dust's pure white: white here is a dust cloud, and this is what is burning.
  wreckSmoke: '#C9C2BB',

  lightRed: '#E24B3C',
  // The blue half of a police light bar, paired with `lightRed` above. Brighter and bluer than
  // `policeBody` on purpose: the bar has to read as a lamp against the car carrying it, not as more
  // bodywork. `game/sirenglow.js` washes both over the frame edge while the cruiser is off-screen,
  // so the same two colours have to be nameable from more than one place.
  sirenBlue: '#4D9BFF',
  lightYellow: '#F0B23A',
  lightGreen: '#4FBF63',
  // An ambient car's turn signal — deliberately more orange than lightYellow above so a blinking
  // indicator doesn't read as a stop-bar amber lifted onto a car.
  turnSignal: '#FF8A1E',
  lightOff: '#333940',
  pole: '#4C5158',

  trunk: '#6B4E35',
  foliage: '#4F8F4A',

  // Roadworks. The warm end of the wheel is already spoken for twice over — the taxi owns yellow
  // outright and the urgency scale owns the ambers below it. Measured where `getHSL` measures,
  // which is the working colour space (linear-sRGB) rather than the one a colour picker shows for
  // the same hex: taxiBody lands at 34° and urgency[2] at 20°. A construction orange has to sit
  // clearly *redder* than both or it reads as "that fare is running out of time" at play zoom,
  // where a cone is about eight pixels tall. 6° is the answer — 28° clear of the taxi and 14°
  // clear of the urgency ramp. tools/probe.mjs asserts that clearance the same way it asserts the
  // ghost car's.
  cone: '#EE5B24',
  // Bands and stripes are an off-white rather than pure white, which on this asphalt under a
  // golden-hour sun blows out into the same flat sheet the lane markings already are.
  coneBand: '#EDE9DF',
  barrier: '#E5551D',
  barrierBand: '#EDE9DF',
  // The vest is *more* saturated than the cones and lighter, so a worker still reads as a figure
  // against the props standing around them rather than as one more cone.
  hiVis: '#FF7A33',
  hardHat: '#F0ECE0',
  // Dug-up spoil: the road base under the asphalt, not garden soil. Browner than the kerb and
  // darker than the sidewalk, so the heap has an edge against both.
  spoil: '#7C6A52',
  // The hole the spoil came out of, painted flat on the road.
  trench: '#3E3B37',
  // The ramp leaning on the barricade. It borrowed the spoil's brown at first and read as a mud
  // patch on the tarmac rather than as a board propped against something — the eye needs it to be
  // *timber* for the taxi launching off it to make sense. Warm and light enough to separate from
  // both the asphalt and the heap standing next to it.
  plywood: '#B98A54',
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
