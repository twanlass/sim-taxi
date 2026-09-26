/**
 * The cut: which footage plays when, and what the titles say over it. Times are edit seconds on
 * the 120 BPM grid in timeline.mjs (a beat is 0.5s); `from` is a frame index into the recorded
 * scene. Picked by reading each scene's log.json for its beats — the pickup, the robber getting
 * in, the wreck — and then by eye off a contact sheet.
 *
 * Tied to the footage the default seeds record (`--seed 4242 --run 9001`). Both of the `play` and
 * `crash` takes happen to run into the bank job on their own — the pilot drives past the bank
 * with an empty seat — which is where the heist section comes from.
 */

const shot = (at, dur, scene, from, speed = 1) => ({ at, dur, scene, from, speed });

// Frame the wreck lands on in the `crash` take (log.json: `crashed` goes true between 1055 and
// 1060). The section is cut so the impact sits on the bar line at 46s.
const IMPACT = 1058;

export const EDIT = {
  shots: [
    // Intro: the city rising out of the ground, the depot, the cab rolling out.
    shot(0, 4, 'opening', 0),
    shot(4, 4, 'opening', 130),
    // Drop: the camera pulling back off the depot, under the title.
    shot(8, 2, 'opening', 250),
    // Tap a rider: the band down the road, the pickup, the drop-off.
    shot(10, 2, 'play', 0),
    shot(12, 2, 'play', 40),
    shot(14, 2, 'play', 205),
    // Beat the clock.
    shot(16, 2, 'play', 330),
    shot(18, 2, 'play', 500),
    shot(20, 2, 'play', 640),
    // Loco Mode: a cut every two beats.
    shot(22, 1, 'play', 10),
    shot(23, 1, 'play', 160),
    shot(24, 1, 'play', 345),
    shot(25, 1, 'play', 515),
    shot(26, 1, 'play', 650),
    shot(27, 1, 'play', 765),
    shot(28, 1, 'crash', 880),
    shot(29, 1, 'crash', 960),
    // The city: along the river, then the span going up and the tug going through.
    shot(30, 2, 'drift', 30, 1.5),
    shot(32, 2, 'drawbridge', 130, 1.5),
    shot(34, 2, 'drawbridge', 250, 1.5),
    // The heist.
    shot(36, 2, 'crash', 760),
    shot(38, 1, 'crash', 822),
    shot(39, 1, 'play', 1020),
    shot(40, 1, 'crash', 925),
    shot(41, 1, 'play', 1062),
    shot(42, 1, 'crash', 950),
    shot(43, 1, 'play', 1140),
    // The wreck: two seconds of run-up at full speed, then the game's own slow motion, stretched.
    shot(44, 2, 'crash', IMPACT - 60),
    shot(46, 4, 'crash', IMPACT, 0.62),
    // Finale: a cut on every beat.
    shot(50, 1, 'play', 1180),
    shot(51, 1, 'crash', 930),
    shot(52, 0.5, 'drawbridge', 215),
    shot(52.5, 0.5, 'play', 60),
    shot(53, 0.5, 'crash', 870),
    shot(53.5, 0.5, 'play', 355),
    shot(54, 0.5, 'play', 1100),
    shot(54.5, 0.5, 'crash', 1010),
    shot(55, 0.5, 'play', 1215),
    shot(55.5, 0.5, 'crash', 1040),
    // Under the end card.
    shot(56, 6, 'drift', 380, 0.6),
  ],

  titles: [
    { at: 0.7, dur: 3.1, text: 'One <em>city</em>.', size: 120, y: 70 },
    { at: 4.5, dur: 3.3, text: 'One <em>cab</em>.', size: 120, y: 70 },
    { at: 8.0, dur: 2.0, kind: 'logo', text: 'SIM TAXI' },
    { at: 10.1, dur: 3.8, text: 'Tap a <em>rider</em>.', sub: 'The road lights up. The cab does the rest.', size: 104, y: 70 },
    { at: 14.0, dur: 1.9, text: 'Get <em>paid</em>.', size: 120, y: 70 },
    { at: 16.1, dur: 5.8, text: 'Beat the <em>clock</em>.', sub: 'Every rider is counting', size: 110, y: 70 },
    { at: 22.0, dur: 3.9, text: 'Hold for<br><em>Loco Mode™</em>', size: 110, y: 60 },
    { at: 26.0, dur: 3.9, text: 'Red lights are<br>a <em>suggestion</em>.', size: 96, y: 62 },
    { at: 30.1, dur: 1.8, text: 'A <em>living</em> city.', size: 110, y: 70 },
    { at: 32.0, dur: 3.9, text: 'Mind the <em>bridge</em>.', size: 110, y: 70 },
    { at: 36.1, dur: 1.8, text: 'Rob a <em>bank</em>?', size: 120, y: 70 },
    { at: 40.0, dur: 3.9, text: 'Lose the <em>cops</em>.', size: 120, y: 70 },
    { at: 46.4, dur: 3.5, text: '…or <em>don’t</em>.', size: 130, y: 64 },
    { at: 50.5, dur: 5.4, text: 'Drive like you<br><em>stole it</em>.', size: 120, y: 56 },
    { at: 56.3, dur: 5.7, kind: 'logo', text: 'SIM TAXI', sub: 'Tap. Route. Floor it.', scale: 1.15 },
  ],

  flashes: [8, 22, 36, 46, 50, 56],

  // Beat punch-in strength per section; nothing under the intro, the slow motion or the end card.
  punch: { title: 0.03, clock: 0.025, loco: 0.045, city: 0.02, heist: 0.035, finale: 0.05 },

  // When the end card's backdrop comes up over the footage, and how far.
  endCard: 56,
  endDim: 0.78,
};
