import { createSpeech } from './speech.js';

// The opening tutorial. Two things a new player cannot work out by looking:
//
//   1. Which of the hundred cars down there is *theirs*. **This beat is currently switched off** —
//      see `TAXI_BEAT` below. The opening vignette answers it by showing the player's own garage
//      door open and their own car drive out of it, which is a better answer than a sentence, and
//      it gets the run to its first instruction a beat sooner.
//   2. That a rider is a thing you tap. The camera pans to the first one on the kerb and the
//      bubble says so, pointed at a figure that is now in the middle of the frame.
//
// Everything else in the game — the drop-off dispatching itself, the timer ring, Loco Mode — either
// happens without being asked for or is a control on the screen. None of it is taught here.
//
// It runs at the top of **every** run. Remembering it across loads was tried — a `localStorage`
// flag, on the grounds that play-again is a `location.reload()` and a lesson learned once should
// not be charged for on every retry — and taken back out: the opening is a tap long, the clocks
// are held through it, and between it and the vignette it is the whole of how a player is shown
// which car is theirs. Someone back after a week gets that for free rather than hunting for it.
//
// The fare clocks are held while this runs (main.js calls `fares.setPaused`), so the tutorial never
// spends the clock the player is about to need. That matters more than it did when every rider got
// a flat sixty seconds: a clock is budgeted from the driving its own trip costs now
// (see difficulty.md), so what a lesson would eat is margin that was calculated for driving.
// Nothing auto-advances: every gated beat waits for a tap, because a tutorial on a timer is one the
// slower reader loses.

// Whether the first beat runs at all. **Off**, and the opening vignette is why: the one thing a new
// player cannot work out by looking is which of the hundred cars down there is theirs, and a bubble
// saying so was the cheapest way to answer it — until the run started by showing the player's own
// garage door open and their own car drive out of it. That answers it better than a sentence can,
// so the bubble is now the second time they are told, and the run gets to its first instruction a
// beat sooner. See docs/gameplay.md#the-opening-vignette.
//
// A flag rather than a deletion: the beat is intact behind it (`openOnTaxi`, `LINES.taxi`, the
// 'taxi' step in both step sets), because the vignette is a prototype and this is the thing that
// has to come back if it goes.
const TAXI_BEAT = false;

// Every line, in the order it is spoken. Kept together so the whole script is one thing to read.
const LINES = {
  taxi: "Let's pick up some rides and earn some cash.",
  rider: 'Tap rider to start',
  boost: 'Hold to floor it',
  // Said instead of the line above once the player has *pressed* the pill without ever holding it —
  // see BOOST_HINT_SHOWS. Repeating "Hold to floor it" at someone who is jabbing the pill is a
  // louder version of the sentence they have already read and acted on; this one names what they
  // are doing wrong, which is the only new information there is to give them.
  boostAgain: "Hold it down — don't tap",
};
// Who is talking, in the bubble's title. Every beat is the game giving a tip, not a character.
const TITLE = 'Tip';

// Where the pointer touches, in world units up from the ground. A rider's crystal floats over their
// head with its top point at ~7.4 at the peak of its bounce, so the bubble stands on that rather than
// covering it; the taxi's is just over its roof.
const RIDER_TIP_Y = 8;
const TAXI_TIP_Y = 2.8;

// A beat between the city finishing its entrance and the tutorial saying anything. This was a
// full second of static city back when a run opened on one — the beat existed to establish that
// there is a place here before the lights came down. The entrance animation now does that job
// with three-plus seconds of the city building itself (main.js holds this whole module frozen
// behind `isBlocked` until the wave lands), so all that is needed after it is a breath: long
// enough that the last building settling and the lights dimming read as two events, short enough
// that the tutorial still feels triggered by the entrance ending. The clocks are already held, so
// it costs nothing.
const OPENING_HOLD = 0.25;

// A beat between the first bubble leaving and the camera setting off for the rider, so the two
// moves read as consecutive rather than as one interrupting the other.
const HANDOFF = 0.35;

// The third beat lands a beat after the player's **first drop-off** — the moment the loop has
// closed once and they know what the job is. Told any earlier and Loco Mode is a fourth new thing
// arriving while they are still working out the first three; told here it answers a question they
// have just earned ("that took a while — can I go faster?").
//
// It was a fraction of the trip at first — half way to the pickup, measured along the road driven.
// That is a better *description* of a moment, and it was unpredictable in practice: trip lengths
// vary by a factor of five, so the hint arrived anywhere between three seconds and half a minute in.
// Then it was a fixed three seconds off the tap that sent the taxi at the first rider, which is
// predictable but lands mid-pickup, with the player watching the car and the fare's clock draining.
// Two seconds off the drop-off is both: a fixed delay, hung on the one beat in a run where nothing
// else is being asked of the player.
const BOOST_HINT_DELAY = 2;
// Unlike the first two, this beat gates nothing — the run is live and the clocks are running, so it
// cannot sit there until it is tapped. Long enough to read twice after the line lands.
const BOOST_HINT_LINGER = 6;

// **The beat is answered by a hold, not by a press.** It used to retire on the first press of the
// pill, which is the one gesture that does *not* teach what the pill does: a tap spends a slice of
// fuel and hands it straight back a second later, so a player who only ever jabbed it came away
// having seen Loco Mode flicker rather than having driven in it, and nothing ever told them again.
// So the hint now comes back, and what closes it for good is a hold long enough to have felt the
// boost sustain (`LOCO_HINT_HOLD`).
//
// This beat runs *alongside* a live run, so a hint that simply sat there until it was obeyed would
// be a bubble over a taxi the player is trying to drive. Hence a fixed budget rather than a nag:
// three showings of BOOST_HINT_LINGER, and then it gives up and lets them play. A player who has
// not taken it by the third is not going to.
//
// **No spotlight on this beat.** It used to dim the city to a pool around the pill like the rider
// beat does, and that is exactly wrong for this lesson: whether it is safe to floor it is a
// question about the road ahead of the taxi, and the spotlight darkened the road and the taxi both
// (Tyler, 2026-10-04). The pill's own pulse (`coach-boost`) and the bubble's pointer say which
// control is meant.
const BOOST_HINT_SHOWS = 3;
// The gap between showings. Long enough that the bubble is plainly a second attempt rather than a
// flicker, short enough that the press it is answering (or the absence of one) is still the thing
// the player was last doing.
const BOOST_HINT_REPEAT_GAP = 10;

/**
 * How long the pill has to stay down before the player counts as having *held* it, in seconds.
 *
 * Deliberately three times `LOCO_PUNCH_HOLD` (0.25, game/camera.js). That one is a gesture test —
 * "is this a tap or a hold" — and 0.25 is the right line for a camera that must not pop on a jab.
 * This is a different question: has the player felt the boost *keep going* because they kept
 * pressing? A quarter second is over before the wheelie has finished playing. Three quarters is
 * 15% of the 5s a third-tank holds (BOOST_DURATION 15 × BOOST_FARE_REWARD), well clear of a slow
 * tap at 200ms and short enough that it is satisfied by the first press that means it.
 */
export const LOCO_HINT_HOLD = 0.75;

// Gentler than the boost chase (3.2) and a touch firmer than the ambient opening follow (1.5): the
// bubble is talking about this car *now*, so it wants to be centred while the line is still typing,
// without the framing whipping across the city to get there.
const COACH_FOLLOW = 2.0;

// The lit pool, in world units — sized here rather than in pixels because 1 world unit is only
// ~7.7px at play zoom, so a pool measured in pixels would be a different size on every viewport.
// The taxi is ~4 units long and a rider stands about 3 tall, so 6 units of clean centre is "the
// subject and the kerb it stands on" and no more; the fade runs out over about half a block.
// Both were half again as wide at first, which lit most of a 5x5 city and made the pool read as
// general gloom rather than as a light pointed at one thing.
export const POOL_CLEAR = 6;
export const POOL_EDGE = 17;

// The steps that own the camera, and the steps that are a bubble waiting to be answered. Everything
// after the second dismissal is neither: the run is live, the player is driving, and the third beat
// is a note in the corner rather than something standing in front of the game.
const CAMERA_STEPS = new Set(['wait', 'taxi', 'toRider', 'rider', 'restore']);
const GATED_STEPS = new Set(['wait', 'taxi', 'toRider', 'rider']);

/**
 * Wire the tutorial up.
 *
 * Every dependency is a callback rather than a module import, because this thing reaches across
 * four systems that have no business knowing about each other — the camera controller, the fare
 * board, the taxi and the scene's lighting — and the wiring is main.js's job.
 *
 * @param controller    the city camera (glideTo / followXZ / updateGlide)
 * @param aspect        () => number, the live viewport aspect
 * @param isNarrow      () => boolean; on a wide viewport the whole city is framed by default, so
 *                      the tutorial puts that framing back when it is done
 * @param taxi          the live taxi car object, read for its position each frame
 * @param viewport      util/viewport.js — the frame the bubble is kept inside
 * @param project       (x, y, z) => {x, y} — world to viewport pixels, for aiming the spotlight
 * @param pixelsPerUnit () => number — the camera's current scale, for sizing it
 * @param boostTarget   () => {x, y} | null — the top of the gas pedal, where the third beat's bubble
 *                      points
 * @param waitingFare   () => fare | null — whoever is on the kerb to point at
 * @param fareLocation  (fare) => {x, z} — the kerb corner to centre, not the junction
 * @param isDispatched  () => boolean — has the player sent the taxi at anyone yet
 * @param hasDelivered  () => boolean — has a rider been dropped off yet; the third beat's countdown
 *                      runs off this, so the Loco Mode hint lands once the loop has closed one turn
 * @param boostHeld     () => boolean — has Loco Mode been *held* (LOCO_HINT_HOLD) at least once. This
 *                      is what answers the third beat: it never appears if this is already true, and
 *                      it stops repeating the moment it becomes true
 * @param boostUsed     () => boolean — has the pill been pressed at all, hold or jab. Chooses which
 *                      line a repeat showing says, and nothing else: a press is not an answer
 * @param isOver        () => boolean — run ended under the tutorial (a wreck, say); drop everything
 * @param isBlocked     () => boolean — something else is holding the run in front of this, so say
 *                      nothing and take no taps until it lets go
 * @param isQuiet       () => boolean — the run is live but busy (a getaway): the Loco Mode beat comes
 *                      down if it is up and waits, without spending one of its showings
 * @param shouldIgnoreTap () => boolean — true for the click that closes out a camera drag, so a
 *                      swipe does not also dismiss the bubble it dragged past
 * @param onRunning     (running: boolean) => void — fires on start and on the *second* dismissal;
 *                      main.js holds the fare clocks and the HUD's entrance between the two. The
 *                      third beat is deliberately outside it — the run is live by then.
 */
export function createTutorial({
  controller, aspect, isNarrow, taxi, viewport = null, project, pixelsPerUnit,
  boostTarget = () => null,
  waitingFare, fareLocation, isDispatched, hasDelivered = () => false,
  boostHeld = () => false, boostUsed = () => false,
  isOver = () => false, isBlocked = () => false, isQuiet = () => false,
  shouldIgnoreTap = () => false,
  onRunning = () => {},
}) {
  const root = document.getElementById('coach');
  const idle = {
    state: { step: 'done' },
    update: () => {},
    frameCamera: () => false,
    holdsCamera: () => false,
    releaseCamera: () => {},
    dismiss: () => {},
  };
  if (!root) return idle;

  // 'wait' → 'taxi' → 'toRider' → 'rider' → 'restore' → 'toBoost' → 'boost' → 'done'. `wait` is the
  // beat of city before the first bubble; `restore` only exists on a wide viewport, where nothing
  // else would ever put the default whole-city framing back; `toBoost` is the whole first fare —
  // pickup, drive and drop-off — with nothing on screen.
  const state = { step: 'wait' };
  // The third beat's countdown, how long it stays once it lands, and how many showings it has spent
  // of its BOOST_HINT_SHOWS budget. The step goes back to 'toBoost' between showings, so `boostWait`
  // is both the first delay and every gap after it.
  let boostWait = 0;
  let linger = 0;
  let boostShows = 0;
  let wait = 0;
  let panned = false;
  let cameraReleased = false;
  const home = { x: controller.state.target.x, z: controller.state.target.z };

  // Where the spotlight is pointed. The taxi while the first bubble is up, then the rider from the
  // moment the camera sets off for them — so the pool is already on the rider and the pan brings
  // the player to it, rather than the light snapping on after they arrive.
  const spotlight = document.getElementById('spotlight');
  let spotAt = null;              // {x, z} in world space, or null for "aim at the taxi"

  const bubble = createSpeech(root, { viewport, typing: true, onDismiss: () => dismiss() });
  // What each beat's bubble points at. The rider is read off the same point the spotlight is, so
  // the two stay on one figure.
  const atTaxi = () => project(taxi.x, TAXI_TIP_Y, taxi.z);
  const atRider = () => (spotAt ? project(spotAt.x, RIDER_TIP_Y, spotAt.z) : null);

  /**
   * Aim and size the pool for this frame. Cheap — four custom properties on one div. Anchored in
   * world space and sized in world units, since both subjects it has ever had are in the city.
   */
  function updateSpotlight() {
    if (!spotlight) return;
    const world = spotAt ?? { x: taxi.x, z: taxi.z };
    // 1.4 up: the middle of a car's flank and about a rider's chest, so the pool is centred on
    // the subject rather than on the patch of road it is standing on.
    const p = project(world.x, 1.4, world.z);
    const px = pixelsPerUnit();
    const at = { x: p.x, y: p.y, r0: POOL_CLEAR * px, r1: POOL_EDGE * px };
    spotlight.style.setProperty('--sx', `${at.x.toFixed(0)}px`);
    spotlight.style.setProperty('--sy', `${at.y.toFixed(0)}px`);
    spotlight.style.setProperty('--r0', `${at.r0.toFixed(0)}px`);
    spotlight.style.setProperty('--r1', `${at.r1.toFixed(0)}px`);
  }

  function end() {
    if (state.step === 'done') return;
    state.step = 'done';
    bubble.hide();
    document.body.classList.remove('coach-open', 'spotlight-on', 'coach-boost');
    window.removeEventListener('click', onTap);
    onRunning(false);
  }

  /** The player is done with the current beat: advance, or wind the whole thing up. */
  function dismiss() {
    if (state.step === 'taxi') {
      bubble.hide();
      state.step = 'toRider';
      wait = HANDOFF;
      return;
    }
    if (state.step === 'rider') { finish(); return; }
    // The third beat is deliberately **not** dismissible. It used to close on any tap, and the two
    // taps most likely to arrive while it is up are the two that mean the player has not learned it
    // yet: a jab at the pill (routed here explicitly by `holdLocoMode`, since a touch's synthesised
    // click can be swallowed by its own preventDefault) and a tap on the road to route the taxi. It
    // was answering itself with the gesture it exists to correct. What closes it is `boostHeld`,
    // read in `update` — or its own linger running out, which brings it back rather than ending it.
  }

  /**
   * Second beat answered (or skipped). This is where the tutorial stops standing in front of the
   * game: the clocks start, the HUD slides in, and the framing goes back where it was on a desktop.
   * What is left after it — the whole first fare, and the boost hint a beat after it is delivered —
   * happens alongside a live run rather than instead of one.
   */
  function finish() {
    if (!GATED_STEPS.has(state.step)) return;
    bubble.hide();
    // The lights come up with the bubble's dismissal, not with the end of the restore glide —
    // holding the city dark through a camera move the player did not ask for reads as the tutorial
    // still having something to say.
    document.body.classList.remove('coach-open', 'spotlight-on');
    onRunning(false);
    boostWait = BOOST_HINT_DELAY;
    if (!isNarrow() && !cameraReleased) {
      state.step = 'restore';
      controller.glideTo(home.x, home.z);
      return;
    }
    state.step = 'toBoost';
  }

  /** Third beat: the Loco Mode pill, called out while the player watches the taxi drive itself. */
  function showBoostHint() {
    state.step = 'boost';
    linger = BOOST_HINT_LINGER;
    boostShows += 1;
    // Pulses the pill itself, so the bubble is not the only thing saying which control it means.
    // No spotlight here — see BOOST_HINT_SHOWS.
    document.body.classList.add('coach-boost');
    // A player who has pressed the pill and still not held it gets told what they are doing rather
    // than told the same thing twice. `boostUsed` is a press of any length, which is exactly the
    // gesture this line is about.
    bubble.show(TITLE, boostUsed() ? LINES.boostAgain : LINES.boost, boostTarget);
  }

  /**
   * One showing over, with the hold still not taken: take the bubble down and go around
   * again after BOOST_HINT_REPEAT_GAP. Not `end()` — that retires the whole tutorial, and this beat
   * is only finished when it has been *answered* (a hold) or has spent its budget of showings.
   */
  function retireBoostHint() {
    bubble.hide();
    document.body.classList.remove('coach-boost');
    if (boostShows >= BOOST_HINT_SHOWS) { end(); return; }
    state.step = 'toBoost';
    boostWait = BOOST_HINT_REPEAT_GAP;
  }

  // One handler for the whole screen, not a click on the bubble: a tap anywhere advances. It stays
  // on `window` rather than an overlay so the tap still reaches the city underneath — on the second
  // beat the whole lesson is the tap landing on the rider, and a full-screen catcher would eat the
  // one gesture being taught. `shouldIgnoreTap` is the same guard the picker uses, so a swipe that
  // dragged the map does not also count as an answer.
  // `isBlocked` matters as much as the pan guard here: the Home Screen screen is a full-bleed
  // overlay above this one that waits to be tapped, and the tap that dismisses *it* would otherwise
  // bubble straight through and burn a beat the player never saw.
  const onTap = () => { if (!shouldIgnoreTap() && !isBlocked()) bubble.tap(); };
  window.addEventListener('click', onTap);

  /**
   * Lights down, first line up.
   *
   * **Currently switched off** — see `TAXI_BEAT` above. Kept whole rather than deleted, because
   * what turns it back on is one flag and the argument for it may well come back.
   */
  function openOnTaxi() {
    state.step = 'taxi';
    updateSpotlight();                    // aim it before it fades up, or it blooms from the centre
    document.body.classList.add('spotlight-on');
    bubble.show(TITLE, LINES.taxi, atTaxi);
  }

  /** Straight to the second beat: no line, just the pan setting off for the rider. */
  function openOnRider() {
    state.step = 'toRider';
    wait = 0;
  }

  // The clocks are held and the chips are hidden from frame one, even though nothing is on screen
  // yet — the opening beat is part of the tutorial, and the player should not be paying for it.
  document.body.classList.add('coach-open');
  onRunning(true);
  wait = OPENING_HOLD;

  function update(dt) {
    if (state.step === 'done') return;
    if (isOver()) { end(); return; }
    // Something else is holding the run in front of this — on iOS in a tab, the "Add to Home
    // Screen" screen (game/homescreen.js), which sits above this one and parks the fare loop until
    // it is tapped. Freeze rather than run behind it: the opening hold would tick away unseen, the
    // spotlight would darken a city nobody is looking at, and the first line would type itself out
    // underneath an overlay. The clocks are already held from both sides, so nothing is lost.
    if (isBlocked()) return;
    bubble.update(dt);
    // Tracked through the restore glide too: the pool is fading out over ~0.45s and a stale centre
    // would slide it across the city as the camera moves under it.
    updateSpotlight();

    // Ahead of the opening hold as well as the bubbles: a player quick enough to grab a rider
    // inside the first second should not then be shown a bubble that immediately dismisses itself.
    if (GATED_STEPS.has(state.step) && isDispatched()) { finish(); return; }

    if (state.step === 'wait') {
      wait -= dt;
      // The camera is already easing onto the taxi through this — it is the one thing that should
      // be under way before the bubble speaks, so the car is framed by the time it does.
      if (wait <= 0) (TAXI_BEAT ? openOnTaxi : openOnRider)();
      return;
    }

    // (The guard above is also what handles a player who found a rider and tapped them without
    // waiting to be told — they have just done the whole of beat two unprompted, so the tutorial
    // gets out of the way rather than teaching it back to them. Load-bearing beyond the manners:
    // the fare clocks are held through the gated beats, so a bubble left up over a taxi that is
    // already driving a fare would freeze that fare's countdown for the entire delivery.)

    if (state.step === 'toRider') {
      if (wait > 0) { wait -= dt; return; }
      if (!panned) {
        const fare = waitingFare();
        if (!fare) return;              // board momentarily empty; wait for the next spawn
        const at = fareLocation(fare);
        controller.glideTo(at.x, at.z);
        // The pool moves to the rider now, with the camera, rather than when the bubble reappears
        // — so the light is already on them and the pan carries the player to it.
        spotAt = at;
        // And this beat is what *lights* it. `spotlight-on` used to go on in `openOnTaxi` alone,
        // which stopped happening the day TAXI_BEAT was switched off: the pool was aimed at the
        // rider every frame from here, sized correctly, and left at opacity 0 for the whole
        // tutorial. The one instruction a run still gives was pointing at a figure in an undimmed
        // city. Anything that turns the light on has to aim it first (same as `showBoostHint`),
        // or the fade-up blooms from wherever the previous subject left the centre — the taxi,
        // half a city away.
        updateSpotlight();
        document.body.classList.add('spotlight-on');
        panned = true;
        return;
      }
      // Show the line once the camera has actually arrived, so the rider it is pointing at is on
      // screen when it starts talking about them.
      if (!controller.isGliding()) {
        state.step = 'rider';
        bubble.show(TITLE, LINES.rider, atRider);
      }
      return;
    }

    // (Tapping the rider is the lesson, and landing it dismisses the bubble without needing a
    // second tap on the bubble itself — that is the `isDispatched` check at the top.)
    if (state.step === 'restore' && !controller.isGliding()) state.step = 'toBoost';

    // The countdown starts at the first drop-off and nowhere earlier, so a player who never
    // completes one is never told about Loco Mode — there is no point selling a way to drive faster
    // to someone who has not yet done the driving. Ticked through `restore` as well as `toBoost`
    // because on a desktop the restore glide can still be running when the delivery lands.
    if (boostWait > 0 && hasDelivered()
      && (state.step === 'restore' || state.step === 'toBoost')) boostWait -= dt;

    // A getaway: no bubble over the road. Only the Loco Mode beat can be live this late (a robbery
    // waits for two drop-offs, and the first two beats end on the first dispatch), so this is that
    // beat stepping back to its countdown — the showing handed back, since nobody read it — and a
    // fresh gap once it is over, so the hint does not land on the frame the chase ends.
    if (isQuiet() && (state.step === 'toBoost' || state.step === 'boost')) {
      if (state.step === 'boost') {
        bubble.hide();
        document.body.classList.remove('coach-boost');
        boostShows -= 1;
        state.step = 'toBoost';
      }
      boostWait = Math.max(boostWait, BOOST_HINT_REPEAT_GAP);
      return;
    }

    if (state.step === 'toBoost') {
      // Already discovered it — and *discovered* means held, not pressed. Nothing left to say, so
      // the tutorial simply stops rather than explaining a control the player is mid-way through
      // using. Checked before the countdown so a hold taken during a repeat gap retires the beat on
      // the frame it happens rather than at the end of that gap.
      if (boostHeld()) { end(); return; }
      if (boostWait > 0 || !hasDelivered()) return;
      showBoostHint();
      return;
    }

    if (state.step === 'boost') {
      // The one thing that answers this beat. Immediately, and mid-line if that is when it lands:
      // the bubble is talking about a gesture the player is now making, so it has nothing left to
      // say and the pool over the pill is dimming a city they are driving through at full tilt.
      if (boostHeld()) { end(); return; }
      // Nothing else is waiting on it — the run is live and the clocks are running — so a showing
      // times itself out rather than sitting over the road. `retireBoostHint` brings it back a
      // gap later, or ends the tutorial once the showings are spent.
      if (!bubble.isTyping()) {
        linger -= dt;
        if (linger <= 0) retireBoostHint();
      }
    }
  }

  return {
    state,
    update,
    /**
     * Frame this step. Called from main.js's camera priority list rather than from `update`, so a
     * wreck or a Loco Mode chase outranks the tutorial's framing instead of fighting it.
     */
    frameCamera(dt) {
      if (state.step === 'wait' || state.step === 'taxi') {
        controller.followXZ(taxi.x, taxi.z, dt, COACH_FOLLOW, aspect());
        return true;
      }
      return controller.updateGlide(dt, aspect());
    },
    holdsCamera: () => CAMERA_STEPS.has(state.step) && !cameraReleased,
    /**
     * The player has taken the framing over — a swipe. Give up the camera but keep talking: the
     * lesson is still worth reading, it just stops dragging the map around while they read it.
     */
    releaseCamera() { cameraReleased = true; },
    dismiss,
  };
}
