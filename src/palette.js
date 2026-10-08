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
  // than distant. This is `skyTop` sampled 0.73 up the dome and pushed back to full saturation:
  // the same hue, 136 points of spread between red and blue.
  //
  // Derived, never picked — `hazeColor(skyTop, skyBottom)` at `HAZE_SKY_H` 0.73 and
  // `HAZE_SATURATION` 2.5 returns exactly this. Move either of those and this has to be recomputed
  // from them, not nudged by eye.
  fog: '#77CFFF',

  // The clouds ringing the island — see game/clouds.js. Two colours rather than one because a
  // white lump under a directional sun comes back as a white lump: at 28.5° of elevation the top
  // of a cloud and its flanks are lit within a few percent of each other, and the only thing left
  // to say "this is a body and not a cut-out" is the gradient baked into it (geometry/cloud.js).
  //
  // Neither is pure white, for the reason the roadworks' bands aren't (see `coneBand`): a cloud
  // sits against the palest thing in the game — the sky at the top of the dome is #8CC4E8 and its
  // horizon is a near-white — and at #FF the two ends of the gradient stop separating from it and
  // from each other. The lit colour is a shade *cool* on top of that, which is what keeps it
  // reading as white rather than as cream.
  //
  // The shade is a proper cool blue, not a grey: it is standing in for the sky the underside is
  // being lit by, and the hemisphere fill it actually gets down there is the ground's warm brown
  // (`hemiGround`). Left grey, the underside of every cloud came out the colour of the sidewalk.
  cloudLit: '#F4F8FC',
  cloudShade: '#A9C0DA',

  sun: '#CFBD8C',
  // Where the shade goes when the tint is turned up — see `SHADOW_UNIFORMS` in util/geo.js. A cool
  // blue against a warm sun, which is the oldest trick in the book and the reason the control
  // exists: the hemisphere fill alone lights shade in the *sun's* family of hues, so the city has
  // no colour contrast between what the sun reaches and what it doesn't. Applied at `SHADOW_TINT`
  // (0.65) out of the box, so this is a colour the shipped game shows.
  shadowTint: '#6E8CC8',
  hemiSky: '#F0C79B',
  hemiGround: '#6B5A48',

  asphalt: '#636972',
  asphaltEdge: '#6B717A',
  // Tyre rubber on the road. Not black: pure black over a blue-grey asphalt read as a hole cut in
  // the road rather than something lying on it, and a touch of warm brown is what rubber smeared
  // into tarmac actually is.
  skidRubber: '#1E1A18',
  // The squall's tyre tracks (game/skidmarks.js, the wet instance): where a tyre has pressed the
  // water film off a wet street, the road stops mirroring the sky and goes darker — and on dry road
  // past the cell's trail, a wet tread prints darker too. Cool rather than the rubber's warm brown,
  // so the two never read as the same mark.
  wetTrack: '#1A2228',
  // Water thrown off the tyres (game/spray.js). A pale cool white, short of the dust's pure white:
  // white is dust, and this has to read as water against a grey wet street under a rain cell.
  waterSpray: '#DCEAF2',
  waterSprayGlow: '#5E7280',
  // And the same tracks on a street that is still wet: a tyre's groove holds a line of water that
  // catches the sky, so on the darkened wet asphalt the trail reads as a pale sheen.
  wetSheen: '#A9BFCC',
  laneMark: '#D6D2C4',
  crosswalk: '#DAD7CB',
  sidewalk: '#9E9C94',
  kerb: '#8A887F',
  park: '#6F9A5A',
  // The tips of the parks' long grass (city/grass.js); the roots are `park` itself so a tuft grows
  // out of the lawn rather than sitting on it. Lighter and warmer — sun through a blade's tip.
  grassTip: '#AEC664',

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
  // It had two blues to stay clear of and cleared both on saturation rather than hue: the old
  // `policeBody` (#2E5FA8, since repainted white) at 226° and the blue car (#4E7FC0) at 222°, against
  // this one's 217°. Nine degrees and
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
  //
  // It is painted in the company's colours, which is the biggest exception in this file to "yellow
  // is reserved for the taxi" below — a whole building of it. The rule survives because of what it
  // is actually protecting: the read of a *yellow car on a road*, which is a small moving rectangle
  // at play zoom. This is a static mass sitting up on a block, and every seed puts it somewhere
  // different, so there is no learned "the yellow thing is the taxi" to break.
  //
  // What it does have to survive is the opening vignette, where a yellow car drives out of this
  // building — and that is the whole of why it is **#DDA62F and not `taxiBody`'s #F5C130**. Ten
  // points of lightness and four degrees of hue below the car, measured where `getHSL` does (the
  // working space, not the colour picker's — see the long note on `door`), which is enough for the
  // taxi to read as a separate object against its own depot rather than as a hole in it. The bay
  // itself stays `garageBay` dark for the same reason it always did: the reveal is a bright thing
  // coming out of a dark hole, and the hole is what the wall's colour must not become.
  garageWall: '#DDA62F',
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
  // The paint on the forecourt: two guide lines out of the bay, and the only thing left wearing
  // this since the envelope above went yellow. It was a fascia band over the door for a long time
  // and then a course under the coping; on a yellow wall a yellow band is not a band.
  //
  // A stop brighter and more saturated than `garageWall`, because it has to be paint rather than a
  // patch of the building lying down — and it is on asphalt rather than on the wall, so the two
  // never touch. This *is* `taxiBody`'s own hex, which the wall deliberately is not: two lines on
  // the ground under a car, where the car is about to be, are the one place in this city where
  // reading the taxi's yellow is the point.
  garageSign: '#F5C130',
  // The chequer course under the parapet, and the depot's one nod at a cab company's own livery.
  //
  // An off-white and a charcoal rather than #FFF and #000. A true black square against a true white
  // one is the highest-contrast pair available anywhere in this game, and each of these squares is
  // about three and a half pixels wide at play zoom — at that size maximum contrast does not read
  // as a chequer, it fizzes. These two are 0.80 apart in lightness where `getHSL` measures (the
  // working space, not the colour picker's — see the long note on `door`) against the 1.00 they
  // would be, which is still the widest pair on the building and a step back off the edge.
  //
  // Both carry the ironwork's own blue cast — 216° and 217° against `garageTrim`'s 221° — rather
  // than being neutral greys. That was contrast against a grey wall and it is complement against a
  // yellow one: a warm chequer on `garageWall` would read as two more shades of the building.
  //
  garageWhite: '#E9EBEE',
  garageCheck: '#33373D',
  // The wrench turning over the roof (city/garage.js). Steel, on the vehicles' metal finish, which
  // multiplies this by 0.7 and adds sky — so it is picked well under `bumperChrome` and keeps the
  // ironwork's blue cast rather than going neutral: the reflection does the brightening. #C3CBD4
  // was tried first and read as pale plastic once the sky had been added to it.
  wrenchSteel: '#6E7782',

  // --- The burger joint -------------------------------------------------------
  // The city's one drive-through (city/burgerjoint.js). Like the depot above it, its envelope
  // stays **outside** BUILDING_COLORS: the whole read of a roadside restaurant is that it is not
  // one of the boxes around it — a low pale shed under a coloured band, sitting in its own apron
  // of asphalt, where every neighbour is a tower in a muted concrete.
  burgerWall: '#E4DCCB',
  // The mansard band around the parapet, and the fascia the sign's pole stands out of. This is the
  // one saturated thing on the block and it has to survive the same audit `garageSign` did: red is
  // not spoken for anywhere in this game's vocabulary — the urgency ramp ends at #D8503C but on a
  // *rider's crystal nine units in the air*, never on a wall — and a band a unit tall on a
  // single-storey building cannot be read as a fare running out of time.
  burgerBand: '#C4453A',
  // Door frames, the parapet cap, the canopy's edge and the window surrounds: one dark for every
  // piece of the building's ironwork, the same argument as `rooftopIron`.
  burgerTrim: '#4F5259',
  // What is behind the pickup window and the menu board's panel. A warm interior glow rather than
  // the depot's `garageBay` dark: the bay is a hole the taxi is the light thing inside, and this is
  // a lit room seen through a hatch. Unlit, for the reason `garageLight` is.
  burgerGlow: '#FFD79A',
  // The neon tracing the roofline: a tube of it tucked under the parapet cap, on the two faces
  // this camera can ever see. Unlit for the reason the two panels above it are — it is a light —
  // which is also what makes it read as neon rather than as a painted stripe: it stays the same
  // colour on the flank the sun has left, where every surface around it has gone to shadow.
  //
  // Amber rather than the band's own red, and that is contrast rather than taste. A red tube on a
  // #C4453A band is 12° of hue and a tenth of lightness away from what it is fixed to, which at
  // play zoom — the whole tube is about a pixel and a half tall — is no line at all. This sits 35°
  // off the band and a fifth lighter.
  //
  // It has to answer "yellow is reserved for the taxi" below, and it answers it the way
  // `garageSign` does: what that rule is protecting is the read of a *car on the road* at play
  // zoom. This is a 0.2-unit line four and a half units up a building, and the one other warm thing
  // on the block is the light already behind its windows.
  burgerNeon: '#FFC24A',

  // The sign itself: a burger, turning on a pole above the roof. Five colours because it is built
  // as five slices and the whole gag is that they are legible as one at play zoom, where the thing
  // is about fourteen pixels across — so each is picked for *separation from its neighbours* under
  // a warm sun rather than for being the most accurate photograph of a bun.
  //
  // The first pass had the bun at #D9A05B and the cheese at #F0A93C — 22° apart in hue and both of
  // them orange — and the whole sign came back from a screenshot as one orange blob with a green
  // rim. What separates a slice of cheese from the bun it is under is that it is **yellow**, so the
  // cheese moved to 44° and the buns moved *away* from it rather than the other way: a paler,
  // browner bun is still a bun, and a lemon-yellow one is a mistake.
  bunTop: '#DFAE6C',
  bunBase: '#D2A163',
  patty: '#54321F',
  cheese: '#F7C63C',
  lettuce: '#7FB050',
  sesame: '#F7EDD6',

  // The cash a getaway throws out of the back of the taxi (game/cashtrail.js). A note is two-sided:
  // the face is a green somewhere between `cashNote` and `cashPale`, and the back is mixed most of
  // the way to `cashBack` in the shader, so a note turning over flashes pale.
  //
  // Keyed off the HUD's own earnings green (#6BE08A, `.earning` in index.html) so the notes and the
  // number that flies to the counter are visibly the same currency.
  //
  // **Saturated rather than duller, which is a reversal.** The first cut pulled the hue toward a
  // paper green on the argument that the HUD's is 27px of type on a dark scrim while these are
  // small objects on a road — and the result was notes nobody could find. What that argument missed
  // is the ground they are landing on: `asphalt` is luma 104 and the lane dashes painted all over
  // it are 210, so a note at 174 sat between the road and the paint it was competing with. At 179
  // with the saturation back it separates from both — it is nowhere near the dashes in hue, and
  // half again the road in value.
  cashNote: '#5FD182',
  // The back of the note, and it has to be *pale* rather than a second green: what makes a tumble
  // read is the value flipping, not the hue. At 232 it is brighter than the lane dashes, which is
  // the point — the flash as a note turns over is the thing that catches an eye that is on the road
  // ahead rather than on the trail.
  cashBack: '#EDE9CF',
  // A getaway checkpoint's ring and its pulsing centre dot (geometry/targetring.js). White, off
  // the urgency scale on purpose: the clock is cashed at the drop-off, not here.
  waypoint: '#FFFFFF',
  // The pale end of the *face*, which is a different job from `cashBack` and was at first confused
  // with it. The back is a flash — a value flip as a note turns over — and there is one of it. This
  // is a **spread**: every note rolls its own face somewhere between `cashNote` and here, so the
  // shower is a family of greens rather than 160 copies of one swatch. Kept green rather than run
  // all the way to white, because the hue is the only thing on the road saying what these are; at
  // 214 luma it is still under the lane dashes' 210-ish paint in saturation while being clearly a
  // lighter note of the same colour.
  cashPale: '#C3EFD0',
  // The dark end of a note's face spread (game/cashtrail.js). Once the notes were lit, the spread
  // toward `cashPale` made the shower read as glowing — a card square to the sun is already the
  // brightest surface on the road — so it runs down from `cashNote` to here instead.
  cashShade: '#3C9A5E',
  // The paper band round a wrapped bundle of notes: white, like a real currency strap. It was a warm
  // cream (#F4DDA0) to keep it apart from `cashBack`, but lit on a green brick at play zoom the cream
  // read as a yellow stripe, or as nothing, and Tyler asked for a white money band. The brick never
  // shows its back, so there is no pale edge for a white band to be confused with.
  cashBand: '#F7F7F2',

  // --- The bank ---------------------------------------------------------------
  // The city's one bank (city/bank.js), and the third building the tower generator does not draw.
  // Unlike the depot and the burger joint its envelope stays **inside** the muted family every
  // other building is in: it is a bank among offices, not a shed or a roadside box, and the thing
  // that has to make it findable from across the map is its *silhouette* — a colonnade under a
  // pediment with a dome behind it — rather than a colour nothing else is wearing. A bank painted
  // to shout would have read as one more special-case block and taken the shape's job away from it.
  //
  // So the stonework is `pale` (#D2CFC5) pushed a little lighter and warmer, which puts it at the
  // top of the building range without leaving it: luma 214.2 against pale's 206.9 and concrete's
  // 178.2.
  bankStone: '#DCD6C7',
  // The columns and the pediment a shade lighter again, because a colonnade is only a colonnade if
  // the gaps between the columns read — and what reads at play zoom, where a column is three pixels
  // wide, is the column standing *against* the wall behind it rather than the shadow between them.
  // Seventeen points of luma (231.2 against 214.2) is the whole of that separation, and it survives
  // the sun moving because it is a difference in the paint rather than in the shading.
  bankColumn: '#EDE7D8',
  // The steps and the plinth, darker than both so the building looks like it is standing on
  // something. Off `statuePlinth` (#8E8A80) deliberately — a stone base under a pale stone object
  // is the same problem the statue already solved, and solving it twice with two colours is two
  // things to keep in step.
  bankStep: '#A9A499',
  // The dome: patinated copper. The statue's note (`statueStone`) records why a verdigris bronze
  // was refused there — the obvious patina (~#7A8B6E) lands a few points off `park` (#6F9A5A), and
  // a figure standing on grass in the colour of grass is a figure nobody sees. A dome stands on a
  // roof, so that particular collision cannot happen; what is still true is that a yellow-green
  // reads as foliage wherever it is. This one is pulled round to the **blue** side of green —
  // 158.7° against park's 104.6°, measured where `getHSL` measures — so it reads as weathered metal
  // against sky and never as a tree that has got onto a roof.
  bankDome: '#7FA89B',
  // The doorway under the portico, and the one dark thing on the building. `window` (#3A424C) is
  // the city's own glass, and this is darker and flatter than it — luma 48.9 against 65.0 at
  // saturation 0.18 against 0.26 — because a bank's door is a shadowed reveal rather than a pane
  // with a room behind it.
  bankDoor: '#2E3138',

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
  // The inside of a wheel arch (geometry/wheels.js): the well's back wall, seen past the tyre. Darker
  // than the tyre (linear 0.08, `TYRE` in geometry/wheels.js) so the tread still has an edge against it, and
  // dark enough that the fleet's instance tint leaves it dark on every paint.
  wheelWell: '#1E2024',
  // Hubcaps (geometry/wheels.js), on the metal finish. Light enough to read as steel inside the
  // tyre's near-black. The fleet's paint tint is kept off metal (util/geo.js), so it stays steel.
  hubcap: '#C4C8CC',
  // The bumpers (geometry/bumpers.js) — metal too, and a step brighter than the hubcaps: chrome.
  bumperChrome: '#E6EAEE',
  // A box truck's cab is painted from carBody, same colorIndex and everything — one taxi-company
  // fleet's palette covers both, and it is what makes a truck read as "one more vehicle in this
  // traffic" rather than a prop dropped in from elsewhere. Only the cargo box breaks from that: it
  // is baked at this one fixed tan/white rather than tinted per instance, because a real box
  // truck's box is bare aluminium or cardboard-coloured regardless of the cab up front. It gets no
  // ghost variant of its own even though a truck does wear a ghost outline: the rim traces the
  // whole vehicle as one hull in one colour (carBodyGhost at the cab's index), because the outline
  // says "there is a vehicle there", not "these are its panels".
  truckBox: '#DDD4BE',
  // A rammed box truck's rear doors (game/boxspill.js): the leaves are the box's own colour, the
  // latch bar down each free edge is dark steel, and the hold the doors open on is a deep shadow —
  // nothing inside is lit, and a hold the colour of the box reads as the doors having opened on a
  // wall.
  truckDoorBar: '#4A5058',
  truckHold: '#2B2723',
  // The flatbed that sheds its load (game/flatbed.js). Timber crates rather than cardboard on
  // purpose: the courier's parcels are cardboard browns (parcelBox below), and a box lying in the
  // road that looked like one would read as a package to collect. Slatted pine with darker
  // battens is a different object at a glance. The deck is weathered planking, the headboard dark
  // steel like the cab it guards.
  flatbedDeck: '#8A6E52',
  flatbedRail: '#3C434C',
  crate: '#D9B477',
  crateBatten: '#9C7445',
  crateStencil: '#4E3A26',
  // Per-crate multipliers on the two above (geometry/crate.js `crateLook`), so the stack is not one
  // crate over and over. Kept near white: the darkest still reads as pine, not as kraft cardboard.
  crateTintFresh: '#FFFFFF',
  crateTintDark: '#CBB8A2',
  crateTintGrey: '#BCBAB3',
  crateTintWarm: '#F2C8AA',

  // --- Game entities. Deliberately higher-chroma than anything in the city so they read
  // instantly against the muted buildings and grey roads.
  // The police two-tone, after the 1980s NYPD cruiser: a light-blue body under a white cab. It
  // used to be a solid blue (#2E5FA8) a few steps off the ordinary blue car (#4E7FC0), which at
  // play zoom made a cop one blue car among several. This blue is lighter and a good deal more
  // cyan than that civilian, but the body alone still would not carry it — the white cab is the
  // half no civilian has (every other car's cabin is dark glass), and it is what says police.
  // See policeCabGeometry() in sim/traffic.js. (A first pass ran it the other way round, white
  // under baby blue; a pastel cab rendered grey-teal under the low warm sun.)
  policeBody: '#55A8E6',
  // Cooler and brighter than the two cream civilians (#E4E1DA, #D9D2C3).
  policeCab: '#F2F4F7',

  // --- The building fire (game/fire.js) -----------------------------------------------------
  //
  // The engine is a fire-engine red a step deeper than `lightRed`, so the lamps on its roof still
  // read as lamps against the bodywork carrying them, with a white band down each flank and the
  // ladder in bare aluminium. The flames run hot yellow at the core to orange at the tips and are
  // drawn additive, so their colours are what they *add* to the facade behind them, not what they
  // cover it with. Smoke is a warm soot rather than a neutral grey, and turns to `steam` where the
  // water is landing — the one colour change that says the hose is winning.
  fireTruckBody: '#C8261E',
  fireTruckTrim: '#F3EFE6',
  fireTruckLadder: '#C9CFD6',
  fireTruckLocker: '#9E1E18',
  flameCore: '#FFC04A',
  flameTip: '#FF6A1A',
  smoke: '#3B3633',
  steam: '#E6ECEF',
  hoseWater: '#CFEBFF',

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
  // The getaway's police helicopter (game/policeheli.js) has no colours of its own: it is painted
  // the cruisers' `policeCab` white with a `policeBody` stripe (LIVERIES in geometry/helicopter.js),
  // so the machine overhead is plainly the same fleet as the cars under it. Its tail lamps are
  // `heliBeacon` and `sirenBlue`. (It used to be a solid blue a stop deeper than the cars, with a
  // white-over-navy band; Tyler asked for it all white with the cars' blue as the stripe.)

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
  // What a VIP says on their way out of a cab that didn't get them there in time — the outburst
  // bubble in geometry/cursebubble.js.
  //
  // **The bubble is filled with the `vip` purple above, not outlined in it.** A white bubble with a
  // purple rim put the identity in a 2px border and the mass in a colour that says nothing: at 57px
  // across, most of what reaches the eye was blank paper, and the thing it had to say — *that was
  // your VIP* — was the thinnest part of it. Filled, the shape itself carries the identity and the
  // glyphs read as white-on-purple, which is also the higher-contrast way round at 7px a mark.
  //
  // So these two are the *other* two colours: the outline that separates a saturated bubble from a
  // pale sky or a dark road, and the grawlix inside it. The text is a whisker off pure white, which
  // belongs to the waiting rider and nothing else (see `passenger`) — at this size the difference is
  // invisible and the rule stays intact.
  curseText: '#F6F2FA',
  curseRim: '#241C2E',

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

  // The courier's other load: an oversized burger and a soda cup (geometry/food.js). **Two colours,
  // and neither of them is the burger's** — that whole stack is the drive-through's own mesh and
  // arrives already painted out of `bunTop`/`bunBase`/`patty`/`cheese`/`lettuce`/`sesame` above. The
  // city has one burger, tuned once; a second set of slice colours mixed for the same object at half
  // the size is how two things that should match drift apart.
  //
  // The cup: an off-white body under a **red** lid, and the lid is the working half. Paper and bun
  // are near neighbours under this sun, so an off-white cap on an off-white cup was one shade of one
  // colour and the drink did not read at all until the thing capping it was neither. It is a shade
  // off `burgerBand` rather than the same red, so the lid and the pale straw coming out of it stay
  // two objects at 10px.
  //
  // The body is kept off pure white for the reason the parcel's label is: white belongs to the
  // waiting rider, and nothing else in the game should reach for it.
  foodCup: '#EFEBDF',
  foodCupLid: '#B0433B',

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
  // The big-air landing's ring (`blast.shock`): the colour of the dust the slam throws up beside
  // it, so it reads as the ground taking the hit rather than as fire. The dust itself is pure white
  // under Lambert and lands a touch below white once lit; the ring is unlit, so it is set there by
  // hand.
  landRing: '#ECEAE4',

  // The tailpipe flame Loco Mode burns for as long as it is held — see game/locoflame.js. Three
  // stops read as one nested cutout: the outer tongue, the gold under it, and the near-white at the
  // pipe itself.
  //
  // Its own three rather than a borrow of the crash's, and the difference is which end is hot. A
  // fireball is a cluster cooling *outward over time*, so `blastCore`→`blastFlame` is a ramp each
  // puff walks; this is a jet, hottest where it leaves the pipe and coolest at the tip, so the ramp
  // is a fact about *position* and all three stops are on screen at once. That also lets the core
  // go whiter than a puff's ever does — a still-burning nozzle against a car, rather than the
  // hottest instant of something that is on its way to smoke.
  //
  // The middle stop is the one that had to be argued with. `taxiBody` is #F5C130 — hue 44°, 80%
  // saturated — and the first gold here came out at 42° and 82%, which is the taxi's own paint
  // burning two units behind the taxi's own paint: it read as a lit panel rather than as fire.
  // Pulling it to 35° puts it in the fireball's neighbourhood (`blastGold` is 36°) and nine degrees
  // clear of the car. The core is at 46° and looks nothing like either, because at 15% saturation
  // it is white with a warm cast rather than a yellow.
  locoFlameOuter: '#FF5D18',
  locoFlameMid: '#FF9E12',
  locoFlameCore: '#FFF6D8',
  // The drift kick's double-barrelled plume (game/locoflame.js `surge`): the same three tongues in
  // violet, so the combo reads as a different fire from the ordinary Loco one at a glance. Same
  // ramp shape — saturated outside, pale at the pipe — so it still reads as a flame and not a light.
  locoFlameDriftOuter: '#9B3DFF',
  locoFlameDriftMid: '#C77DFF',
  locoFlameDriftCore: '#F3E6FF',
  // ...and up a drift chain (DRIFT_CHAIN in sim/traffic.js), cooling as it climbs: blue at the
  // second kick, teal at the third. Same ramp shape again.
  locoFlameChain2Outer: '#2F6BFF',
  locoFlameChain2Mid: '#6FA0FF',
  locoFlameChain2Core: '#E3EEFF',
  locoFlameChain3Outer: '#00BFA6',
  locoFlameChain3Mid: '#4DE8D0',
  locoFlameChain3Core: '#E0FFF9',

  // Sparks off the underside of the taxi as it lands a jump — see game/sparks.js. Two stops, one
  // per end of a shower rather than a ramp each spark walks: a spark is on screen for half a second
  // and fading the whole time, so what a spread across the *shower* buys is metal at several
  // temperatures at once, which is what a real one looks like.
  //
  // Hues below are as `getHSL` reads them, which is the working space (linear-sRGB) and not what a
  // colour picker shows. The hot end sits on `locoFlameCore`'s own hue (45°) four points lighter at
  // l 0.88 — white with a warm cast rather than a yellow, which is what struck metal is and what
  // survives being drawn additive on top of itself where two sparks cross. The tail is 19°, a
  // degree off `locoFlameMid`, and that closeness is deliberate: the tailpipe is often burning two
  // units away from this, and two warm effects a few degrees apart read as one car doing one thing.
  // What it must clear is `taxiBody` at 34°, so a shower under the car never reads as the car's own
  // paint coming off.
  sparkHot: '#FFF8E2',
  sparkTail: '#FF9A22',
  // The comic starburst a bump pops at the point of contact — see game/impact.js. A warm yellow
  // body round a near-white core, the "POW" of a cartoon rather than anything physical, so it is
  // kept off both spark stops above: a burst the same hue as the sparks under it reads as more
  // sparks. The rim is a dark warm brown, the one thing that holds its edge against pale asphalt.
  impactBody: '#FFD23F',
  impactCore: '#FFFBEA',
  impactRim: '#6B2E12',
  // The collar of smoke thrown out around a wreck — the construction zone's dust, tinted. It is
  // set against the **road**, not against `blastSmoke` beside it, and that is the whole of why it
  // is this light. The fireball is unlit, so its smoke stop can be a dark #4B4B55 and still read;
  // this pool is Lambert (game/dust.js), it is lying on `asphalt` #636972, and the first attempt
  // at #6E6259 — a sensible smoke grey by eye — came out at the same value as the tarmac under it
  // and vanished for the whole of the fire, leaving smoke that only appeared once the flame had
  // gone. Roughly 1.8× the road's value is what it takes to be seen against it. Warm and well
  // short of the dust's pure white: white here is a dust cloud, and this is what is burning.
  wreckSmoke: '#C9C2BB',
  // The depot at work, behind a door left a fifth open — game/repairfx.js. The arc is a welder's
  // blue-white rather than the sparks' warm white: the flash is the one thing in the shot that has
  // to read as *electric* rather than as fire, and a warm glow under a yellow building reads as the
  // building's own paint lit up. The grit is the collar's warm grey a step darker, because it comes
  // out onto the pale forecourt asphalt low and thin rather than as a wall of smoke.
  weldFlash: '#BCD6FF',
  repairDust: '#B3ACA4',
  // The damaged taxi's bonnet smoke — game/taxidamage.js — walked from the first stop to the second
  // as the last third of its hit points goes. Both are set against the **road**, because that is
  // what a puff over a moving car is seen against from this camera: the first cut ran to #45403D,
  // "burning oil", and on dark asphalt that is no smoke at all — the red tier's billows and the
  // critical plume were both drawn and neither could be found in a screenshot. So the dark end is a
  // grey that still clears the asphalt by a clear step in lightness, and "worse" reads as denser and
  // faster rather than as blacker.
  damageSmokeLight: '#F4F1ED',
  damageSmokeDark: '#A8A19B',

  // What a wreck's paint is pulled toward as it scorches — see SCORCH_MIX in game/wreckage.js. Only
  // a fifth of the way, and behind a plain multiply that does most of the darkening, because the
  // whole reason the two cars are left lying on the road is so the player can see *what they hit*:
  // a lerp far enough to read as charred takes the hue with it and both wrecks come out the same
  // dark grey. Warm rather than neutral — this is soot over paint, and the pull is doing the last
  // fifth of the work on top of a multiply that has already taken a third of the value off.
  wreckChar: '#3A322C',

  lightRed: '#E24B3C',
  // The blue half of a police light bar, paired with `lightRed` above. Brighter and bluer than
  // `policeBody` on purpose: the bar has to read as a lamp against the car carrying it, not as more
  // bodywork. `game/sirenglow.js` washes both over the frame edge while the cruiser is off-screen,
  // so the same two colours have to be nameable from more than one place.
  sirenBlue: '#4D9BFF',
  // The box a cop car's bar is bolted into — what stays on the roof once the lamps go off, so a
  // stood-down cop still reads as police. See sirenBaseGeometry() in geometry/lights.js.
  sirenHousing: '#23262D',
  // The bar's two lenses while it is *off*: red one side, blue the other, painted rather than lit.
  // Deep enough that a lit lamp is plainly a change of state and not the same colour a bit brighter,
  // saturated enough that a parked cop's roof still says red-and-blue at 4px a lens.
  sirenRedOff: '#8E2A22',
  sirenBlueOff: '#23489A',
  lightYellow: '#F0B23A',
  lightGreen: '#4FBF63',
  // An ambient car's turn signal — deliberately more orange than lightYellow above so a blinking
  // indicator doesn't read as a stop-bar amber lifted onto a car.
  turnSignal: '#FF8A1E',
  // Headlights, and the beam each one throws — Rain Mode only (`?rain`). A warm white rather than a
  // pure one: under the overcast grade a pure white lamp reads as a hole in the frame. The lens is
  // a deeper amber than the beam because it draws unlit and then blooms, and both push it toward
  // white: at '#FFF1CF', and even at the beam's own '#FFE2A6', it rendered as plain white next to a
  // warm beam. This value lands on screen at roughly the beam's colour.
  headlight: '#FFD98C',
  headlightBeam: '#FFE2A6',
  // Street lamps (game/citylights.js): the post, and the sodium-ish glow of the head and its pool.
  // The post was #2E3238 and read as a black stroke against the asphalt (#636972); a galvanised
  // grey a step above the road keeps it a thin dark line once its shaded faces are lit.
  lampPost: '#7A818A',
  lampHead: '#FFD38A',
  lampPool: '#FFB85C',
  // Lit windows, drawn from at random: mostly warm rooms, a few cool screens.
  litWarm: '#FFC56E',
  litPale: '#FFE4AE',
  litCool: '#A9D2FF',
  lightOff: '#333940',
  pole: '#4C5158',

  trunk: '#6B4E35',
  foliage: '#4F8F4A',
  // Autumn (`autumnBase` in city/props.js): the colours a broadleaf turns. Spread across value as
  // well as hue so a park reads as several trees rather than one tree in four tints — the gold
  // sits above the lawn's luma, the red well under it, the orange between.
  foliageGold: '#D4A12A',
  foliageOrange: '#CC6A27',
  foliageRed: '#A9382C',

  // The duck pond — see city/pond.js. The only water in the game, so these three have nothing to
  // agree with and two things to stay clear of.
  //
  // **Value, not hue, is what separates water from lawn.** The first pass at this was a handsome
  // #5E88B4, and it is luma 130 against the park's 140 — the same trap `birdBody` documents one
  // entry up, and worse here because the pond is a 45-pixel *area* rather than a moving speck. A
  // pond has to read as a hole in the green from across the map, which means going properly dark:
  // `pondWater` is luma 101 and `pondShallow` 84, both a long way under the grass they sit in.
  //
  // Two of them because the water is drawn as a fan with a centre vertex (see `pondParts`), and
  // what that buys is depth for the price of a vertex colour: the open middle catches the sky and
  // the shallows round the rim go dark under the bank. One flat blue read as a painted disc.
  //
  // Hue is the same 216° in both, which is the free window between the courier cyan at 192° and the
  // VIP purple at 260° — 24° clear of the nearer one, on the same clearance rule the blooms and the
  // roadworks orange are held to, and `tools/probe.mjs` asserts it beside them. Saturation stays
  // under the blooms' own ceiling for the same reason: nothing in a park may read as a thing the
  // player has to act on.
  pondWater: '#456A8E',
  pondShallow: '#3A5876',
  // The shore. Damp earth rather than stone — a municipal pond is a hole in a lawn with a mown
  // edge, not a fountain basin. It sits at 34°, which is the taxi's own hue, and is kept apart from
  // it exactly the way `spoil` (31°) is: at 0.28 saturation against the taxi's 0.80 it is a brown,
  // and a brown ring 0.4 units wide is not a car. Darker than both the grass it interrupts (128
  // against 140) and the `sidewalk` a park's walk is paved in (156), so the pond has an edge
  // against everything it touches.
  pondBank: '#8C7F6B',

  // The basketball court — see city/blacktop.js. A sports court has to read as *paved* inside a
  // lawn, which is a value break before it is a hue: the blacktop at luma ~80 is a dark slab against
  // the park's 140, the same way the pond is a hole. The playing surface inside the lines is a brick
  // red rather than the textbook green or blue, because green vanishes into the lawn and blue is
  // what this game paints water — and it stays well under the saturation of anything the player is
  // meant to tap. The keys go a step lighter so the two ends read as ends from across the map.
  courtTop: '#4A4F57',
  courtPaint: '#93594A',
  courtKey: '#B0735A',
  courtLine: '#E6E1D5',
  // The hoops: a dark steel pole, a white board, an orange rim, a white net.
  hoopPole: '#3B444F',
  backboard: '#EDEDEA',
  backboardMark: '#B8473A',
  rim: '#D5642A',
  net: '#E8E6E0',
  // The players and their ball (game/hoopers.js). Muted jerseys for the fare-marker reason: a
  // saturated figure on a kerb is the description of a rider. One light, one dark, so the two are
  // told apart at 24px.
  hooperA: '#E4E0D6',
  hooperB: '#A84A3E',
  hooperShorts: '#33363F',
  basketball: '#D06A2C',

  // The skatepark — see city/skatepark.js. Poured concrete rather than blacktop, so it reads as a
  // *different* paved thing from the court across the park: pale (luma ~170) where the court is
  // dark, which holds against the lawn's 140 from the other side. The ramps are a shade lighter
  // than the floor so their curved faces separate from it under a flat sun, and the funbox and the
  // rail carry the only colour — a painted yellow, kept muted for the fare-marker reason.
  skateFloor: '#B4B0A6',
  skateRamp: '#C6C1B5',
  skateRampSide: '#9E998F',
  skateCoping: '#7F868E',
  skatePaint: '#C9A23E',
  // The skaters and their boards (game/skaters.js). One light top and one dark, like the hoopers.
  skaterA: '#5E7A8C',
  skaterB: '#D8D2C4',
  skaterPants: '#3A3832',
  skateDeck: '#A4573C',
  skateTruck: '#9AA0A6',
  skateWheel: '#E5DFCF',

  // --- The river ------------------------------------------------------------
  //
  // Same 216° family as the pond, and deliberately so: this game has exactly one idea of what
  // water looks like and a second one would read as a different substance. What differs is scale.
  // A pond is a 45-pixel hole in a lawn; the river is a 90-unit band across the whole map with
  // roads either side of it, so the two colours it has to hold against are `asphalt` (luma 105)
  // and the pale `sidewalk` — not grass.
  //
  // **That inverts the pond's rule.** The pond goes dark because it must read as a hole in
  // something bright; the river sits in something already dark, so going darker still would make
  // the map's biggest feature its least visible one. `riverWater` is luma 112 against asphalt's
  // 104 — a shade *lighter* than the road, which is what a sky-lit surface actually is, and enough
  // separation to read from across the city without the band shouting.
  //
  // Two of them for the pond's reason: the channel is drawn with its open middle catching the sky
  // and its edges going dark under the walls, which is depth for the price of a vertex colour.
  riverWater: '#4E7699',
  riverDeep: '#3C5C7B',
  // What the water is seen *through* to (city/riverwater.js): silt and rubble at the foot of the
  // walls. Never drawn as a surface — it only ever arrives through a few units of water, which
  // takes most of the red out of it, so it is chosen warm and olive to land green-brown rather
  // than as a second blue.
  riverBed: '#6B6648',
  // The channel wall, and the parapet standing on the kerb line above it. Engineering concrete
  // rather than the `kerb` a block is edged in: a river wall is a poured retaining structure and a
  // kerb is a laid stone, and at 0.75 units tall the parapet is the one piece of street furniture
  // in this city big enough for that distinction to show. At luma 139 it is a shade off the `kerb`
  // it stands on (136) and a long way under `concrete` (178), so a sunlit parapet cannot be
  // mistaken for the pale façade of a building behind it.
  riverWall: '#8D8B84',
  // The bridge deck. Asphalt, because it is road, and near enough the `asphalt` slab it continues
  // to be the same material — a shade darker, which is what a span in the shadow of its own
  // parapets is, and no more than that. The first cut went to luma 92 against the road's 104 and
  // came out looking like a hole in the map rather than a crossing over one; the deck sits inside
  // a two-unit-deep channel, so ambient occlusion is already taking a bite out of it before any
  // colour choice does.
  bridgeDeck: '#5E656E',
  // Its edge beam and parapet: the same poured concrete as the river wall, lightened, so the deck
  // is outlined against both the water under it and the road either end of it. It is doing the
  // work the kerb does on an ordinary block — telling you where the road stops — against a drop
  // rather than a step, so it is pushed further from the surface it edges: luma 170 against the
  // deck's 108, where a block's kerb is only 32 clear of its pavement.
  bridgeTrim: '#AFACA4',
  // The **underside**, and it is a much bigger decision than a soffit sounds like — because when the
  // drawbridge stands up, the underside is the whole of what the camera sees. Raised to 70 degrees
  // the leaf turns its belly through the view axis, so a soffit in `bridgeTrim`'s pale concrete
  // presented a blank panel the size of a block, at the same value as the buildings behind it: the
  // one moment in the game with a bridge standing on end read as a flat card lying on the skyline.
  //
  // At luma 74 it is the darkest surface in the city bar the trench a roadworks zone digs, which is
  // right twice over — a soffit is the one face of a bridge the sun never reaches, and a raised leaf
  // has to be legible from across the map as a *thing that has moved*.
  bridgeSoffit: '#4A4844',
  // The **lifting** span's running surface, and it is the one deck that is not asphalt.
  //
  // A bascule leaf is a steel grid — the road stops being road where the machinery starts, and that
  // is worth saying in colour because it is the one thing the player has to recognise from across
  // the map *before* it moves. In `bridgeDeck` it was a stripe of street lying over the water like
  // the other three, and the only tell that this one was different was a counterweight house the
  // size of a bus shelter.
  //
  // Cool where the asphalt is warm-grey, and light where the asphalt is dark: luma 136 against
  // `bridgeDeck`'s 100 and the road's own 104, which reads as galvanised plate under this sun
  // without going pale enough to be mistaken for the concrete trim it is bolted to at 172.
  drawbridgeDeck: '#87888C',

  // --- Boats ----------------------------------------------------------------
  //
  // A boat is about twenty pixels long at play zoom on a band of dark water, so what has to carry
  // is **value against the river**, not hue. `riverWater` renders around luma 112 and `riverDeep`
  // 87, so the barge's hull goes dark and its deck and load go pale, and the sailboat is white from
  // the waterline up: either way a boat reads as a value step against the water under it.
  //
  // Neither is allowed near the warm end. The taxi owns 34 degrees, the urgency ramp owns
  // everything from 1 to 126 and the roadworks orange sits at 6 — a working boat in red or orange
  // is a thing the player would look at twice on a board where warm means "act on this".
  // The trash barge (geometry/boat.js). Rust is a warm hue, so it is spent the only way this board
  // allows a warm one: at low saturation and low value, where it reads as dirty steel rather than
  // as an orange. The hull stays dark against the water (luma ~70 against the river's 87-112) and
  // the heap is where the variety lives — black bags, a muted green one held at 145 degrees (the
  // urgency ramp ends at 126), grey cardboard, a blue drum, a few white scraps that catch the sun.
  trashHull: '#4F4843',
  trashGrime: '#3E3B37',
  // The mound the rubbish sits in, lighter than the bags so they read as bags against it.
  trashHeap: '#6B655C',
  trashTyre: '#26272A',
  trashBag: '#2B2E33',
  trashBagGreen: '#4C6B55',
  trashBox: '#8E8576',
  trashJunk: '#6E7378',
  trashBarrel: '#3B5F8C',
  trashWhite: '#C9CCC8',
  // The wheelhouse is hunter green, flat and weathered — "ocean rusty and grimy" (Tyler, 2026-10-08,
  // replacing the working-boat red of 2026-10-07). Hunter green proper is #355E3B; this is a step
  // lighter because the hull's flat material lands it at about half value in the river's shade,
  // and at #355E3B the roof read black. The rust and grime are pieces over it, not a tint on it.
  trashHouse: '#43754A',
  // Rust bleeding from the window frames, and the scum line round the foot of the house.
  trashRust: '#7A4A2C',
  trashStack: '#2F3236',
  // The gulls (game/gulls.js): white bodies, grey backs, and nothing else — a yellow bill would be
  // a warm speck at full saturation and would not survive the 3 pixels it occupies anyway.
  gullBody: '#EEF0F0',
  gullWing: '#A7ADB3',
  // The boat that asks for the lift is a sailboat now, and it is the one **white** thing on the
  // water — a light hull is value against the river, which is what this whole section is about.
  sailHull: '#ECECE8',
  // The one saturated thing on the water, and it is a small one: the sailboat's boot stripe and
  // its sail cover. 213 degrees sits inside the same blue window the pond and the river already
  // occupy, 27 clear of the courier cyan — so it is a *boat* colour rather than a marker one.
  sailTrim: '#37698F',
  mast: '#C8CCD0',
  rigging: '#5E636A',
  boatDeck: '#B6B2A6',
  // The wake. Unlit and half transparent, so what reaches the screen is this lifted toward whatever
  // the water under it is doing — a foam white would blow out to a solid arrow at noon and vanish
  // at dusk, and a wake has to read the same at both.
  wake: '#DCE8EF',

  // Flower beds on the arterials' medians — see `flowerBedParts` in city/props.js. Blooms are drawn
  // from this per *flower*, not per bed, so one bed carries four or five of them.
  //
  // **The set is the whole free space on the wheel, and it is smaller than it looks.** Measured
  // where `getHSL` measures (linear-sRGB, not what a colour picker shows for the same hex), the
  // urgency ramp runs 1° → 126°, the taxi sits at 34°, the route yellow at 46°, the courier cyan at
  // 192° and the VIP purple at 260°. Requiring 20° of clearance either side leaves exactly four
  // windows: 71–106°, 146–172°, 212–240° and 280–341°.
  //
  // The first two are unusable for a different reason — they are greens, and a green flower on a
  // green mound on green grass is a flower nobody sees. So the planting lives in the other two:
  // blue at 223–230°, then violet, magenta and pink from 287° round to 331°. Nearest approach to
  // anything the player acts on is 27°, and the loudest of them is 0.66 saturated against the
  // 0.86–1.00 of every marker on the board. Both are asserted in tools/probe.mjs, the same way the
  // roadworks orange is.
  //
  // That the range comes out cool and slightly wild is a consequence of the constraint rather than
  // a choice, and it happens to suit municipal bedding — cornflower, lavender, phlox, cosmos.
  bloom: [
    '#9DB6E8',   // pale blue   223°
    '#6E86D6',   // cornflower  230°
    '#B968C9',   // orchid      287°
    '#9E5490',   // plum        315°
    '#BE5C9C',   // magenta     327°
    '#D97BB0',   // rose        331°
    '#E2A3CB',   // pale pink   325°
  ],

  // Park furniture. A bench's slats are timber and stand within a couple of units of a trunk, so
  // the one colour they must clearly not be is `trunk` (#6B4E35) — a bench painted the wood of the
  // tree beside it reads as a fallen branch. This is the same hue two steps lighter and a shade
  // less red, which is also what keeps it off `plywood` (#B98A54): that one is a bare board
  // propped against a barricade and this one is finished furniture. The frame reuses `pole` — it
  // is the same painted metal every other piece of street furniture in the city stands on.
  benchSlat: '#A2733F',

  // The statue. Pale limestone for the figure and a greyer stone under it, and the split matters
  // more than either colour: the figure is the thing to see from across the map, so it takes the
  // lightest value in the park — 20 points above the plinth, which is itself darker than the
  // `sidewalk` (#9E9C94) the plaza around it is paved in, so a statue never dissolves into its own
  // base or its own paving. Deliberately *not* a verdigris bronze, however classical: the obvious
  // patina green (~#7A8B6E) lands a few points off `park` (#6F9A5A) and a figure standing on grass
  // in the colour of grass is a figure nobody sees.
  statueStone: '#C9C3B4',
  statuePlinth: '#8E8A80',

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
  // The drawbridge gate's warning lamps (game/drawbridge.js). Lit, they are the signal's own amber
  // (`lightYellow`) — a lamp telling you to stop is the same lamp wherever it is mounted. Off, they
  // are this: a dark brown-amber lens, deep enough against the orange arm that a lit lamp is
  // plainly a change of state rather than the same colour a bit brighter, and still a lens rather
  // than a hole when the arm is standing idle.
  gateLampOff: '#3A2A16',
  // The gate arms' diagonal stripes. Black and white rather than the roadworks' `barrier` orange:
  // the drawbridge gate is a railway-style crossing arm, and the stripes are what make it read as
  // one. Not pure black, which goes to a hole on the shaded side, and the light stripe is the same
  // off-white as the other bands so it does not blow out under a golden-hour sun.
  gateStripeDark: '#26282C',
  gateStripeLight: '#EDE9DF',
  // The vest is *more* saturated than the cones and lighter, so a worker still reads as a figure
  // against the props standing around them rather than as one more cone.
  hiVis: '#FF7A33',
  // The cabbie thrown through the windscreen in a hard wreck (game/ejection.js). A work-shirt blue
  // so they separate from both the taxi's yellow and the fireball's orange they fly out of, and a
  // dark cap — the hat is most of what says *driver* rather than *another rider* at this size.
  driverShirt: '#4F7BC0',
  driverCap: '#33333C',
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

  // --- Crayon Mode (game/crayon.js, ?crayon) ------------------------------------------------
  //
  // Three colours, and each of them is a claim about wax on paper rather than about ink.
  //
  // The stroke is a **warm graphite**, not black: a crayon's darkest mark is the paper showing
  // through a pile of pigment, and it never reaches zero. Pure black lines over this palette read
  // as vector art — the exact look the pass is trying to get away from. Kept warm so it sits with
  // the golden-hour light instead of cutting a cold outline through it.
  crayonLine: '#3A2E28',
  // The page. A warm off-white the whole frame is lifted toward, which is what turns the sky from
  // *sky* into *paper someone drew a sky on*.
  paper: '#F7F0E2',
  // The fibre in it — where the tooth is deep enough that a stroke skipped. Grey-brown rather than
  // grey: a neutral speck on a warm page reads as dirt, not as texture.
  paperFibre: '#B9AC96',

  // --- Cartoon Mode (game/cartoon.js, ?cartoon) ---------------------------------------------
  //
  // The ink, for both the hero hulls and the city's screen-space line. **Not black**, and not for
  // the crayon's reason — a printed cartoon's ink genuinely is black. It is because this city is
  // lit at golden hour and the haze it sits in is a saturated sky blue: a true #000 outline is the
  // one thing in the frame with no hue at all, and against warm brick and cool haze it reads as a
  // hole rather than as a line. Two points of warmth and a lift off zero is enough to stop that
  // without ever reading as brown.
  toonInk: '#141110',

  // Rain Mode (`?rain`, game/rain.js). An overcast grade laid over whatever hour the day clock is
  // at, so the sky is a lid of cloud rather than a colour: blue-grey overhead, a paler wash at the
  // horizon, a sun that has lost most of its colour, and a fill that has turned cool. The haze
  // follows the sky through `hazeColor` like it always does.
  rainSkyTop: '#5B6878',
  rainSkyBottom: '#9AA5AF',
  rainSun: '#C9CCD2',
  rainHemiSky: '#9FB0C4',
  rainHemiGround: '#3A3F46',
  // The streaks and the crowns. Pale and a touch blue, never white: at 0.3 alpha over asphalt a
  // white streak reads as snow.
  rainStreak: '#C8D6E6',
  rainSplash: '#DCE6F0',
  // The glint a ripple throws off a puddle — the sky it is tilting towards.
  rainSheen: '#B8C6D6',
  // What a wet street mirrors where nothing stands over it — the cloud, a long way darker than it
  // looks overhead. See `skyTint` in game/rain.js for why it cannot be the sky's own colour.
  rainReflectSky: '#2C343E',
  // The same, under a sun shower's lighter sky (MOODS.shower in game/rain.js).
  rainReflectShower: '#6A7684',
  // A shaft of sun standing in the rain over a gap in the cloud: warm, and drawn additive.
  sunShaft: '#FFE0A6',
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
