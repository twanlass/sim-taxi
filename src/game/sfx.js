/**
 * The game's sound: the taxi's engine, Loco Mode, the doors, the crash, the jump and the blinker.
 *
 * The one thing in this project loaded from files rather than generated in code. The recordings
 * are a sound designer's, encoded from WAV masters by `tools/audio.mjs` into `assets/audio/*.m4a`;
 * `new URL(..., import.meta.url)` below is what makes Vite fingerprint and ship them, and it is
 * inert in node, which is what lets `tools/check.mjs` boot this module headless.
 *
 * **Everything is the taxi.** Ambient traffic is silent on purpose: twenty-odd engines and their
 * blinkers under one fixed overhead camera would be a wash, and every sound here is feedback about
 * the one car the player is driving.
 *
 * Two kinds of sound, and the split is the design:
 *
 * - **Beds**, which run continuously and are *steered* every frame by `update()` off the taxi's
 *   state — the engine idle (pitched by speed), the Loco engine (crossfaded in while the pill is
 *   held), and the blinker (running while `taxi.signalHand` is set). A bed is never started by an
 *   event, so nothing can leave one stuck on: whatever the frame says is what plays.
 * - **One-shots**, fired by `play(name)` from the site in main.js that already knows the thing
 *   happened — the same sites `haptic()` fires from, for the same reason.
 *
 * **Nothing can play until a gesture.** Every browser holds an `AudioContext` suspended until the
 * page has been touched, so the context is created on the first press and the decode happens then.
 * The fetches start at construction, so by the first tap the bytes are usually already here.
 *
 * **Read the browser at call time, never at import** — the rule `haptics.js` states for the same
 * reason: check.mjs imports this in node, where there is no `window`.
 */
// The designer's mix — see SHIPPED_MIX below.
import MIX from '../../assets/audio/mix.json' with { type: 'json' };
import { isNative } from '../util/platform.js';

// The designer's files, keyed by the designer's own names so a re-delivery drops straight in. Each
// is a literal `new URL` so Vite can see it at build time; a URL assembled from a variable is one
// Vite cannot find and will not ship.
export const FILES = {
  '01_ENG_idle_loop': new URL('../../assets/audio/01_ENG_idle_loop.m4a', import.meta.url).href,
  '02_IMPACT_bump_A': new URL('../../assets/audio/02_IMPACT_bump_A.m4a', import.meta.url).href,
  '02_IMPACT_bump_B': new URL('../../assets/audio/02_IMPACT_bump_B.m4a', import.meta.url).href,
  '02_IMPACT_bump_C': new URL('../../assets/audio/02_IMPACT_bump_C.m4a', import.meta.url).href,
  '03_ENG_accel_A': new URL('../../assets/audio/03_ENG_accel_A.m4a', import.meta.url).href,
  '03_ENG_accel_B': new URL('../../assets/audio/03_ENG_accel_B.m4a', import.meta.url).href,
  '03_ENG_accel_C': new URL('../../assets/audio/03_ENG_accel_C.m4a', import.meta.url).href,
  '03_ENG_accel_D': new URL('../../assets/audio/03_ENG_accel_D.m4a', import.meta.url).href,
  '03_ENG_accel_E': new URL('../../assets/audio/03_ENG_accel_E.m4a', import.meta.url).href,
  '04_ENG_brake_A': new URL('../../assets/audio/04_ENG_brake_A.m4a', import.meta.url).href,
  '04_ENG_brake_B': new URL('../../assets/audio/04_ENG_brake_B.m4a', import.meta.url).href,
  '04_ENG_brake_C': new URL('../../assets/audio/04_ENG_brake_C.m4a', import.meta.url).href,
  '05_LOCO_activate_A': new URL('../../assets/audio/05_LOCO_activate_A.m4a', import.meta.url).href,
  '05_LOCO_activate_B': new URL('../../assets/audio/05_LOCO_activate_B.m4a', import.meta.url).href,
  '05_LOCO_activate_C': new URL('../../assets/audio/05_LOCO_activate_C.m4a', import.meta.url).href,
  '06_LOCO_engine_loop': new URL('../../assets/audio/06_LOCO_engine_loop.m4a', import.meta.url).href,
  '07_LOCO_launch_A': new URL('../../assets/audio/07_LOCO_launch_A.m4a', import.meta.url).href,
  '07_LOCO_launch_B': new URL('../../assets/audio/07_LOCO_launch_B.m4a', import.meta.url).href,
  '07_LOCO_launch_C': new URL('../../assets/audio/07_LOCO_launch_C.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_A': new URL('../../assets/audio/08_LOCO_brake_hard_A.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_B': new URL('../../assets/audio/08_LOCO_brake_hard_B.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_C': new URL('../../assets/audio/08_LOCO_brake_hard_C.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_A': new URL('../../assets/audio/09_LOCO_skid_turn_A.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_B': new URL('../../assets/audio/09_LOCO_skid_turn_B.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_C': new URL('../../assets/audio/09_LOCO_skid_turn_C.m4a', import.meta.url).href,
  '10_DOOR_open_A': new URL('../../assets/audio/10_DOOR_open_A.m4a', import.meta.url).href,
  '10_DOOR_open_B': new URL('../../assets/audio/10_DOOR_open_B.m4a', import.meta.url).href,
  '10_DOOR_open_C': new URL('../../assets/audio/10_DOOR_open_C.m4a', import.meta.url).href,
  '11_DOOR_close_A': new URL('../../assets/audio/11_DOOR_close_A.m4a', import.meta.url).href,
  '11_DOOR_close_B': new URL('../../assets/audio/11_DOOR_close_B.m4a', import.meta.url).href,
  '11_DOOR_close_C': new URL('../../assets/audio/11_DOOR_close_C.m4a', import.meta.url).href,
  '12_IMPACT_crash_A': new URL('../../assets/audio/12_IMPACT_crash_A.m4a', import.meta.url).href,
  '12_IMPACT_crash_B': new URL('../../assets/audio/12_IMPACT_crash_B.m4a', import.meta.url).href,
  '12_IMPACT_crash_C': new URL('../../assets/audio/12_IMPACT_crash_C.m4a', import.meta.url).href,
  '13_JUMP_takeoff_A': new URL('../../assets/audio/13_JUMP_takeoff_A.m4a', import.meta.url).href,
  '13_JUMP_takeoff_B': new URL('../../assets/audio/13_JUMP_takeoff_B.m4a', import.meta.url).href,
  '13_JUMP_takeoff_C': new URL('../../assets/audio/13_JUMP_takeoff_C.m4a', import.meta.url).href,
  '14_JUMP_land_A': new URL('../../assets/audio/14_JUMP_land_A.m4a', import.meta.url).href,
  '14_JUMP_land_B': new URL('../../assets/audio/14_JUMP_land_B.m4a', import.meta.url).href,
  '14_JUMP_land_C': new URL('../../assets/audio/14_JUMP_land_C.m4a', import.meta.url).href,
  '15_SIGNAL_turn': new URL('../../assets/audio/15_SIGNAL_turn.m4a', import.meta.url).href,
  '17_BURGER_drive_through': new URL('../../assets/audio/17_BURGER_drive_through.m4a', import.meta.url).href,
  '18_HORN_honk': new URL('../../assets/audio/18_HORN_honk.m4a', import.meta.url).href,
  // Block 2 (Nicolás, October 2026, the final delivery): the city around the taxi rather than the
  // taxi. Its numbering restarts at 16 on the designer's own sheet, so 16-18 here are not the
  // burger and horn above; the names differ, which is all `FILES` cares about.
  '16_SCN_spawn_A': new URL('../../assets/audio/16_SCN_spawn_A.m4a', import.meta.url).href,
  '16_SCN_spawn_B': new URL('../../assets/audio/16_SCN_spawn_B.m4a', import.meta.url).href,
  '16_SCN_spawn_C': new URL('../../assets/audio/16_SCN_spawn_C.m4a', import.meta.url).href,
  '17_SCN_gate': new URL('../../assets/audio/17_SCN_gate.m4a', import.meta.url).href,
  '18_SCN_bridge': new URL('../../assets/audio/18_SCN_bridge.m4a', import.meta.url).href,
  '19_AMB_city_loop_B_ST': new URL('../../assets/audio/19_AMB_city_loop_B_ST.m4a', import.meta.url).href,
  '20_AMB_construction_loop_MONO': new URL('../../assets/audio/20_AMB_construction_loop_MONO.m4a', import.meta.url).href,
  '21_SCN_birds_soft_A': new URL('../../assets/audio/21_SCN_birds_soft_A.m4a', import.meta.url).href,
  '21_SCN_birds_soft_B': new URL('../../assets/audio/21_SCN_birds_soft_B.m4a', import.meta.url).href,
  '21_SCN_birds_soft_C': new URL('../../assets/audio/21_SCN_birds_soft_C.m4a', import.meta.url).href,
  '21_SCN_birds_strong_A': new URL('../../assets/audio/21_SCN_birds_strong_A.m4a', import.meta.url).href,
  '21_SCN_birds_strong_B': new URL('../../assets/audio/21_SCN_birds_strong_B.m4a', import.meta.url).href,
  '21_SCN_birds_strong_C': new URL('../../assets/audio/21_SCN_birds_strong_C.m4a', import.meta.url).href,
  '22_AIR_plane': new URL('../../assets/audio/22_AIR_plane.m4a', import.meta.url).href,
  '23_AIR_heli': new URL('../../assets/audio/23_AIR_heli.m4a', import.meta.url).href,
  '24_NPC_angry_A': new URL('../../assets/audio/24_NPC_angry_A.m4a', import.meta.url).href,
  '24_NPC_angry_B': new URL('../../assets/audio/24_NPC_angry_B.m4a', import.meta.url).href,
  '24_NPC_angry_C': new URL('../../assets/audio/24_NPC_angry_C.m4a', import.meta.url).href,
  '24_NPC_angry_D': new URL('../../assets/audio/24_NPC_angry_D.m4a', import.meta.url).href,
  '24_NPC_angry_E': new URL('../../assets/audio/24_NPC_angry_E.m4a', import.meta.url).href,
  '24_NPC_angry_F': new URL('../../assets/audio/24_NPC_angry_F.m4a', import.meta.url).href,
  '25_NPC_siren_loop': new URL('../../assets/audio/25_NPC_siren_loop.m4a', import.meta.url).href,
  '29_AMB_seagulls_loop_MONO': new URL('../../assets/audio/29_AMB_seagulls_loop_MONO.m4a', import.meta.url).href,
  '30_AMB_rain_loop_MONO': new URL('../../assets/audio/30_AMB_rain_loop_MONO.m4a', import.meta.url).href,
  '30_AMB_rain_loop_ST': new URL('../../assets/audio/30_AMB_rain_loop_ST.m4a', import.meta.url).href,
  '31_AMB_basketball_loop_MONO': new URL('../../assets/audio/31_AMB_basketball_loop_MONO.m4a', import.meta.url).href,
  '32_NPC_chirp_long_A': new URL('../../assets/audio/32_NPC_chirp_long_A.m4a', import.meta.url).href,
  '32_NPC_chirp_long_B': new URL('../../assets/audio/32_NPC_chirp_long_B.m4a', import.meta.url).href,
  '32_NPC_chirp_short_A': new URL('../../assets/audio/32_NPC_chirp_short_A.m4a', import.meta.url).href,
  '32_NPC_chirp_short_B': new URL('../../assets/audio/32_NPC_chirp_short_B.m4a', import.meta.url).href,
  'VO_dispatch_1': new URL('../../assets/audio/VO_dispatch_1.m4a', import.meta.url).href,
  'VO_dispatch_2': new URL('../../assets/audio/VO_dispatch_2.m4a', import.meta.url).href,
  'VO_dispatch_3': new URL('../../assets/audio/VO_dispatch_3.m4a', import.meta.url).href,
  'VO_dispatch_4': new URL('../../assets/audio/VO_dispatch_4.m4a', import.meta.url).href,
  // Tyler's recording of an elevated train going by (October 2026), its steady middle cut to a loop.
  'LTRAIN_AMB_pass_loop_MONO': new URL('../../assets/audio/LTRAIN_AMB_pass_loop_MONO.m4a', import.meta.url).href,
};

/**
 * What the game calls each sound, and the takes it draws from. The designer delivers most one-shots
 * as lettered variants (`_A`, `_B`, `_C`…) mixed level with each other and meant to be picked **one
 * per trigger**, so a door or a skid heard twice in a row is not the same recording twice — see
 * `pickTake`. A bed has one file, since a loop cannot change take mid-cycle.
 */
export const SOUNDS = {
  idle: ['01_ENG_idle_loop'],
  bump: ['02_IMPACT_bump_A', '02_IMPACT_bump_B', '02_IMPACT_bump_C'],
  accel: ['03_ENG_accel_A', '03_ENG_accel_B', '03_ENG_accel_C', '03_ENG_accel_D', '03_ENG_accel_E'],
  brake: ['04_ENG_brake_A', '04_ENG_brake_B', '04_ENG_brake_C'],
  locoActivate: ['05_LOCO_activate_A', '05_LOCO_activate_B', '05_LOCO_activate_C'],
  locoLoop: ['06_LOCO_engine_loop'],
  locoLaunch: ['07_LOCO_launch_A', '07_LOCO_launch_B', '07_LOCO_launch_C'],
  locoBrake: ['08_LOCO_brake_hard_A', '08_LOCO_brake_hard_B', '08_LOCO_brake_hard_C'],
  skid: ['09_LOCO_skid_turn_A', '09_LOCO_skid_turn_B', '09_LOCO_skid_turn_C'],
  // The same takes for a chasing cop's squeal. A key of its own, not a second call to `skid`: it
  // wants its own level (it is somebody else's car, somewhere else on the screen) and its own
  // `minGap`, or four cops cornering would spend the taxi's gap and swallow its own squeal.
  copSkid: ['09_LOCO_skid_turn_A', '09_LOCO_skid_turn_B', '09_LOCO_skid_turn_C'],
  doorOpen: ['10_DOOR_open_A', '10_DOOR_open_B', '10_DOOR_open_C'],
  doorClose: ['11_DOOR_close_A', '11_DOOR_close_B', '11_DOOR_close_C'],
  crash: ['12_IMPACT_crash_A', '12_IMPACT_crash_B', '12_IMPACT_crash_C'],
  takeoff: ['13_JUMP_takeoff_A', '13_JUMP_takeoff_B', '13_JUMP_takeoff_C'],
  land: ['14_JUMP_land_A', '14_JUMP_land_B', '14_JUMP_land_C'],
  signal: ['15_SIGNAL_turn'],
  // The siren is the one bed that is not the taxi — it is the cop coming after it, which is feedback
  // about the taxi all the same. Block 2's recording; it replaced our own stand-in (October 2026).
  siren: ['25_NPC_siren_loop'],
  // Not the designer's: delivered separately (October 2026) and named into the same scheme so they
  // sort after Block 1. The drive-through is the speaker at the burger joint's window, played once
  // per visit.
  driveThru: ['17_BURGER_drive_through'],
  horn: ['18_HORN_honk'],
  // Block 2: the city. Most of these are PLACED (below) — heard from where they happen.
  spawn: ['16_SCN_spawn_A', '16_SCN_spawn_B', '16_SCN_spawn_C'],
  gate: ['17_SCN_gate'],
  bridge: ['18_SCN_bridge'],
  // B alone. It shipped as A then B joined into one 42s loop until the designer's October 19 mix
  // note: "B works much better right now", and A was dropped.
  city: ['19_AMB_city_loop_B_ST'],
  // Mono only in the final delivery: the designer tried both in the game and kept mono for every
  // bed heard from a point on the map.
  construction: ['20_AMB_construction_loop_MONO'],
  // Two intensities, three takes each, "to cover the different bird animations": the strong set
  // is the flock scattering, the soft set the last of it settling.
  birdsUp: ['21_SCN_birds_strong_A', '21_SCN_birds_strong_B', '21_SCN_birds_strong_C'],
  birdsDown: ['21_SCN_birds_soft_A', '21_SCN_birds_soft_B', '21_SCN_birds_soft_C'],
  plane: ['22_AIR_plane'],
  heli: ['23_AIR_heli'],
  angry: ['24_NPC_angry_A', '24_NPC_angry_B', '24_NPC_angry_C', '24_NPC_angry_D', '24_NPC_angry_E',
    '24_NPC_angry_F'],
  seagulls: ['29_AMB_seagulls_loop_MONO'],
  rain: ['30_AMB_rain_loop_ST', '30_AMB_rain_loop_MONO'],
  court: ['31_AMB_basketball_loop_MONO'],
  // Two short and two long, all four drawn at random: one cop lighting up should not always sound
  // the same, and the length is part of that.
  chirp: ['32_NPC_chirp_short_A', '32_NPC_chirp_short_B', '32_NPC_chirp_long_A', '32_NPC_chirp_long_B'],
  // The backstory read out (game/backstory.js): Tyler's recordings, delivered as MP3s (October
  // 2026) and converted to 48 kHz WAV masters like the radio's ads. One sound a line, not four takes
  // of one: each line is its own recording at its own level.
  dispatch1: ['VO_dispatch_1'],
  dispatch2: ['VO_dispatch_2'],
  dispatch3: ['VO_dispatch_3'],
  dispatch4: ['VO_dispatch_4'],
  // The L train going by: Tyler's recording, looped, heard from the middle of the train.
  ltrain: ['LTRAIN_AMB_pass_loop_MONO'],
};

/**
 * Sounds whose files are **alternatives under audition**, not takes: the designer sent a mono and a
 * stereo cut, or a short and a long one, to find out which sits better. One plays at a time, the
 * one `mix.sounds[key].pick` names (an index into the list above), and the ⚙️ panel switches it
 * live — a bed swaps file on the next frame. Once a choice is made, the losers come out of the
 * list and the delivery, and the key comes out of here.
 */
export const PICKED = new Set(['rain']);

/**
 * Sounds heard **from somewhere**: `mix.place[key]` is the falloff — full inside `near` world units
 * of the taxi, silent past `far` — and each is panned by where it sits across the screen. main.js
 * hands over the distance and the pan (`placeAt` there); the curve lives here so the panel can move
 * it. Distance is from the taxi, as the siren's always was: the camera follows it, and it is the
 * one thing on the map the player is.
 */
export const PLACED = new Set(['gate', 'bridge', 'construction', 'birdsUp', 'birdsDown', 'plane',
  'heli', 'angry', 'seagulls', 'court', 'chirp', 'ltrain']);

/** What `play()` accepts — the one-shots. A typo throws here rather than going silent. */
export const SFX_EVENTS = new Set(['bump', 'accel', 'brake', 'locoActivate', 'locoLaunch',
  'locoBrake', 'skid', 'copSkid', 'doorOpen', 'doorClose', 'crash', 'takeoff', 'land', 'driveThru',
  'horn', 'spawn', 'gate', 'bridge', 'birdsUp', 'birdsDown', 'plane', 'heli', 'angry', 'chirp',
  'dispatch1', 'dispatch2', 'dispatch3', 'dispatch4']);

/** The beds: steered by `update()`, never fired. */
export const LOOPS = new Set(['idle', 'locoLoop', 'signal', 'siren', 'city', 'construction',
  'seagulls', 'rain', 'court', 'ltrain']);

/**
 * The ambient beds — Block 2's loops. Each runs silent from the first tap and `update()` sets its
 * level from `opts.ambient[key]` every frame, `{ level, d, pan }` (any part optional), the way the
 * siren has always worked: nothing starts one, so nothing can leave one running.
 */
export const AMBIENT = ['city', 'construction', 'seagulls', 'rain', 'court', 'ltrain'];

/**
 * The mix groups: every sound in exactly one, each group a gain node between its voices and its
 * bus (BUSES). Nicolás asked for them once Block 2 doubled the count (October 2026): with this many
 * elements a mix is set group against group first and sound against sound second, and the ⚙️ panel
 * lists the sounds under these headings with a fader, a mute and a solo each. The fader is in
 * mix.json (`groups.<key>.gain`) and ships; mute and solo are for listening only and never leave
 * the session. In the order the panel shows them. `police` also carries the synthesised rotor,
 * which has no key of its own (`makeRotor`).
 */
export const GROUPS = [
  { key: 'engine', label: 'Engine & Loco', bus: 'player',
    sounds: ['idle', 'accel', 'brake', 'locoActivate', 'locoLoop', 'locoLaunch', 'locoBrake', 'skid'] },
  { key: 'taxi', label: 'Taxi', bus: 'player', sounds: ['doorOpen', 'doorClose', 'signal', 'horn'] },
  { key: 'impacts', label: 'Impacts', bus: 'player', sounds: ['bump', 'crash', 'takeoff', 'land'] },
  { key: 'events', label: 'City events', bus: 'world',
    sounds: ['spawn', 'gate', 'bridge', 'birdsUp', 'birdsDown', 'plane', 'heli', 'driveThru'] },
  { key: 'ambience', label: 'Ambience', bus: 'world', sounds: AMBIENT },
  { key: 'people', label: 'People', bus: 'world', sounds: ['angry'] },
  { key: 'police', label: 'Police', bus: 'world', sounds: ['siren', 'copSkid', 'chirp'] },
  { key: 'dispatch', label: 'Dispatch', bus: 'player', sounds: ['dispatch1', 'dispatch2', 'dispatch3', 'dispatch4'] },
];
/** Which group a sound is in, by sound. */
export const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.sounds.map((s) => [s, g.key])));

/**
 * The buses above the groups — Nicolás's second level (October 2026), so a mix can be set Player
 * against World and music against effects before any group is touched:
 *
 *     Master ─┬─ Music ── the radio's tracks
 *             └─ SFX ──┬─ Player ── Engine & Loco, Taxi, Impacts
 *                      └─ World ─── City events, Ambience, People, Police
 *
 * Each is a gain node. Their faders are mix.json's: `buses.<key>.gain` for Master, Player and
 * World, and the two that were there first keep their old keys — SFX is `master` (it was the
 * whole effects level before there was a Master above it) and Music is `music.master`.
 */
export const BUSES = [
  { key: 'master', label: 'Master', parent: null },
  { key: 'music', label: 'Music', parent: 'master' },
  { key: 'sfx', label: 'SFX', parent: 'master' },
  { key: 'player', label: 'Player', parent: 'sfx' },
  { key: 'world', label: 'World', parent: 'sfx' },
];
// Where "bass" stops for `readBass`: the kick and the bass line, under the snare.
const BASS_HZ = 150;

/** The buses with a `buses.<key>` fader of their own in mix.json. */
const OWN_FADER = ['master', 'player', 'world'];

/**
 * Every node of the mix tree by its parent: buses, groups, sounds, the radio's tracks, and the
 * rotor (under Police, unlisted). This is what mute and solo walk — any of them can be muted or
 * soloed, and the keys share one namespace, which the probe checks.
 */
export const MIX_PARENT = {
  ...Object.fromEntries(BUSES.map((b) => [b.key, b.parent])),
  ...Object.fromEntries(GROUPS.map((g) => [g.key, g.bus])),
  ...GROUP_OF,
  rotor: 'police',
};

// The loops' true lengths, by file, from the masters (afinfo). A decoder that does not trim AAC's
// 2112 frames of encoder priming hands back a buffer that long *plus* the pad, and looping the whole
// buffer would put 44ms of silence in every cycle — a hiccup in the engine once every four
// seconds. See `loopWindow`. By file rather than by sound since a PICK bed changes file.
const LOOP_SECONDS = {
  '01_ENG_idle_loop': 4, '06_LOCO_engine_loop': 8, '15_SIGNAL_turn': 4.53125,
  '25_NPC_siren_loop': 8.6875, '19_AMB_city_loop_B_ST': 21,
  '20_AMB_construction_loop_MONO': 21, '29_AMB_seagulls_loop_MONO': 21,
  '30_AMB_rain_loop_MONO': 21, '30_AMB_rain_loop_ST': 21, '31_AMB_basketball_loop_MONO': 21,
  'LTRAIN_AMB_pass_loop_MONO': 7.5,
};
/** How far across the stereo field a placed sound may sit — never hard into one ear. */
const PAN_WIDTH = 0.7;

/**
 * The drive-through speaker's true length (afinfo on the master). The taxi's visit is timed to it —
 * see TAXI_ORDER_DWELL in game/drivethru.js, and the probe that holds the two together.
 */
export const DRIVE_THRU_SECONDS = 12.93;
/** ...and the quiet after it, before the lot lets the taxi go. Tyler's call: about two seconds. */
export const DRIVE_THRU_TAIL = 2;

/**
 * How far the radio drops while something has to be heard over it — the drive-through speaker. The
 * radio sits at -24 LUFS at full slider; -12 dB puts it at about -36, behind the speaker and still
 * playing. The speaker's master is -21.8 LUFS; at its first mix gain (0.6) and the default effects
 * slider (0.75, squared) it landed near -31, only 5 LU over the ducked radio, and on a phone it could
 * not be heard. At 1.2 it is near -25. Its one transient (0 dBFS, 11s in) cleared full scale at the old
 * 0.75 default; above about 0.91 effects that single hit clips, and the default is now 1, so it
 * does. The rest peaks at -4 to -7.
 */
const MUSIC_DUCK = 0.25;
// How long the radio takes to fade out as the game-over screen appears (`?musicfade=classic`). Long
// enough to read as the song ending rather than being cut, short enough that it is gone before the
// stats finish counting up.
const MUSIC_FADE_OUT = 1.5;
// The default: the song plays on under the stats (~3s of them) and fades once "Tap to continue"
// comes up. Slower than the classic fade because nothing is racing it any more — the card is just
// waiting on the player, so the song can trail off rather than get out of the way.
export const MUSIC_FADE_AT_HINT = 2.5;
/**
 * The dash radio (Tyler, October 2026; `?radiointro=classic` off). From Play the station is heard
 * the way it would be from inside the taxi — a cheap AM set through one tired door speaker — and
 * opens out into the full mix as the car rolls out of its garage: the film move from music playing
 * *in* the scene to music playing *over* it. The further apart the two ends are, the bigger that
 * reveal lands, so the in-car end is deliberately crushed rather than politely filtered (Tyler,
 * after the first cut: "make the audio sound even flatter… crush that even more"):
 *
 *  - **Band**: a high-pass at `lowCut` (no bass from a 4-inch cone), a low-pass at `highCut` (no
 *    air) and a peaking bump at `peakHz` (`peakDb`) for the honk. Both pass filters ring a little
 *    (`Q`, in dB as Web Audio has it for those two types). 700 Hz to 2 kHz is narrower than a real
 *    car speaker, closer to an AM receiver, which is the point.
 *  - **Mono**, so the stereo spreading out is part of the open.
 *  - **Crushed**: `drive` into a tanh soft clip quantised to `steps` levels a side — a ~6-bit
 *    converter, so quiet passages go grainy and loud ones flatten. Its output sits at `crushLevel`,
 *    so the in-car radio is under the open mix and the open swells as well as brightens: on an
 *    offline render of this graph a song in the car measures about 4 LU under the same song open
 *    (at 0.3 the crush was 8 LU *over* it — a clipper flattens the level up as well as the dynamics).
 *  - **Static**: a bed of hiss with sparse crackles and the odd pop (`staticBuffer`) at
 *    `staticLevel`, played into the same speaker so it is band-limited and crushed with the music:
 *    about 12 dB under the music in RMS, with the pops reaching the music's level.
 *
 * `music` is how many seconds of the first *song* play crushed before the car may leave its
 * doorway (`holdReveal` in game/opening.js). The announcer's intro is 6.3 s, and played before the
 * song it covered the whole in-car stretch, so the crush was only ever heard on a voice; holding
 * the shot until a song had played after it made the opening four seconds longer. So the station
 * talks *over* the music (`RADIO_FADE`): the first song starts a second into the intro.
 * `open` is the reveal, in seconds: the filters sweep to transparent (10 Hz, Nyquist, 0 dB), the
 * crushed path crossfades into the clean one, and the static dies away over the first `staticOut`
 * of it. Short enough to have landed by the end of the pull-back (`roll` and `release` come to about
 * four seconds, docs/gameplay.md). What gives the crushed end time to register is the shot before it:
 * the vignette holds on the car in its doorway for `DASH_REVEAL` (game/opening.js). Holding the
 * sound for two seconds after the car had left (the second cut) put the crush over a car already on
 * the street, where it read as late rather than as inside the car.
 */
export const DASH = {
  lowCut: 700, highCut: 2000, peakHz: 1400, peakDb: 8, Q: 4,
  drive: 4, steps: 32, crushLevel: 0.11, staticLevel: 0.5,
  open: 3, staticOut: 0.5, music: 4,
};
const DASH_OPEN_LOW = 10;
/**
 * The station talks over the music, the way a DJ does (Tyler, October 2026: "start music under the
 * announcer", then "crossfade between all of the DJ announcements and their music tracks";
 * `?radiofade=classic` for the hard cuts). Two shapes:
 *
 *  - **Talk into a song** (the intro, the sting out of an ad break, the station ID): the song starts
 *    `under` seconds into the voice at `duck` of its level (-6 dB) and rises to full over the voice's
 *    last `rise` seconds.
 *  - **Talk over a song's end** (the tee-up into an ad break, the station ID): the voice starts
 *    `over` seconds before the song ends, and the song dips to `duck` over `dip` seconds under it.
 *    The songs all have clean endings, so the voice lands on the last bars rather than on a cut.
 *
 * An ad is produced on its own and keeps its hard edges either side.
 */
// How long a context may sit stopped through the player's taps before it is replaced (`revive`),
// in seconds, and the fraction of that wall time its clock must have covered to count as moving.
// Not measured on a device yet: 1.5s is a guess at comfortably longer than a healthy `resume()`
// takes, and 0.5 leaves room for a stutter without mistaking a clock that has stopped.
const REVIVE = { after: 1.5, pace: 0.5 };
const RADIO_FADE = { under: 1, over: 2, duck: 0.5, rise: 1, dip: 0.4 };
// Where the opening songs of the last session are remembered, so the next one opens on another
// (Tyler: "always play a different initial music track on game start").
const OPENERS_KEY = 'simTaxi.openingSongs';
// The police helicopter's synthesised rotor (`makeRotor`): its blade-pass rate in Hz, and its level
// at full presence. Not in mix.json, which is keyed by the designer's files and has no file for it.
const ROTOR_CHOP = 11;
const ROTOR_GAIN = 0.16;
const AAC_PRIMING = 2112 / 48000;

/**
 * The radio: an intro, then songs back to back for as long as the page is open — a fresh pick at
 * the end of each, at random but never the one that just played. Kept apart from `FILES`/`SOUNDS`
 * because it is not the taxi and not in the mix: it plays into the music bus, under the Music
 * slider rather than the effects one, and nothing steers it from the frame.
 *
 * `seconds` is each master's true length, which is what the next track is scheduled against (the
 * same AAC-priming guard `loopWindow` is for, so a decoder that leaves the pad in does not open a
 * 44ms gap at every change). `gain` levels the four against each other and sits them under the
 * taxi: measured off the masters (ffmpeg ebur128) the intro is -17.3 LUFS and the songs -13.5
 * (country), -12.3 (jazz) and -10.8 (rock), against -34 for the engine idle and -22 for a crash —
 * so each is brought to -24 LUFS at full slider, and the slider only ever turns it down.
 */
const RADIO_FILES = {
  MUSIC_radio_intro: new URL('../../assets/audio/MUSIC_radio_intro.m4a', import.meta.url).href,
  '26_MUS_rolling': new URL('../../assets/audio/26_MUS_rolling.m4a', import.meta.url).href,
  '27_MUS_upbeat': new URL('../../assets/audio/27_MUS_upbeat.m4a', import.meta.url).href,
  '28_MUS_hiphop': new URL('../../assets/audio/28_MUS_hiphop.m4a', import.meta.url).href,
  '33_MUS_indiepop': new URL('../../assets/audio/33_MUS_indiepop.m4a', import.meta.url).href,
  RADIO_ad_earls: new URL('../../assets/audio/RADIO_ad_earls.m4a', import.meta.url).href,
  RADIO_ad_le_barge: new URL('../../assets/audio/RADIO_ad_le_barge.m4a', import.meta.url).href,
  RADIO_ad_loco_juice: new URL('../../assets/audio/RADIO_ad_loco_juice.m4a', import.meta.url).href,
  RADIO_break_in: new URL('../../assets/audio/RADIO_break_in.m4a', import.meta.url).href,
  RADIO_break_out: new URL('../../assets/audio/RADIO_break_out.m4a', import.meta.url).href,
  RADIO_station_id: new URL('../../assets/audio/RADIO_station_id.m4a', import.meta.url).href,
};
const dB = (d) => 10 ** (d / 20);
/**
 * The station (Tyler, October 2026): songs, and between them an ad break every `adEvery` songs —
 * the tee-up, one ad at random (never the last one), the sting back — and the station ID every
 * `idEvery`. Where both fall due (every sixth song) the ID follows the break, so the break is
 * never split by it.
 *
 * The October additions — funk, the ads, the ID, the two stings and the new intro (which replaced
 * a 15s one at -6.7) — were levelled by **RMS** rather than ebur128, ffmpeg not being to hand: the
 * four older tracks' RMS plus their LUFS-derived gain lands at -26.7 dB RMS on average (-25.9 to
 * -27.4), so each new one is brought to that.
 */
export const RADIO = {
  intro: 'MUSIC_radio_intro',
  // Nicolás's four (Block 2 final, October 2026), written for the station: 40-50s each with short
  // intros and clean endings, all mastered to -18 LUFS. They replaced four earlier 30s songs
  // (country, jazz, rock, funk) whose source was never recorded; those were deleted in October
  // 2026 rather than shipped in the App Store build behind a flag nothing in the app can set.
  songs: ['26_MUS_rolling', '27_MUS_upbeat', '28_MUS_hiphop', '33_MUS_indiepop'],
  ads: ['RADIO_ad_earls', 'RADIO_ad_le_barge', 'RADIO_ad_loco_juice'],
  breakIn: 'RADIO_break_in',
  breakOut: 'RADIO_break_out',
  stationId: 'RADIO_station_id',
  adEvery: 2,
  idEvery: 3,
  seconds: {
    MUSIC_radio_intro: 6.34775,
    '26_MUS_rolling': 45, '27_MUS_upbeat': 49.5714375, '28_MUS_hiphop': 40.6299375,
    '33_MUS_indiepop': 49.133875,
    RADIO_ad_earls: 9.4, RADIO_ad_le_barge: 14.528, RADIO_ad_loco_juice: 13.24,
    RADIO_break_in: 3.474271, RADIO_break_out: 4.284063, RADIO_station_id: 4.362438,
  },
  gain: {
    MUSIC_radio_intro: dB(-6.1),
    // ebur128 off the masters: -18.3, -17.8, -18.2 and -18.1 LUFS, true peak -3 to -3.9.
    '26_MUS_rolling': dB(-5.7), '27_MUS_upbeat': dB(-6.2), '28_MUS_hiphop': dB(-5.8),
    '33_MUS_indiepop': dB(-5.9),
    RADIO_ad_earls: dB(-9.4), RADIO_ad_le_barge: dB(-3.8), RADIO_ad_loco_juice: dB(-13),
    RADIO_break_in: dB(-3), RADIO_break_out: dB(-8.5), RADIO_station_id: dB(-8),
  },
};
/** Every file the radio can play, in the order the ⚙️ panel lists them. */
RADIO.all = [RADIO.intro, ...RADIO.songs, ...RADIO.ads, RADIO.breakIn,
  RADIO.breakOut, RADIO.stationId];
for (const key of RADIO.all) MIX_PARENT[key] = 'music';

/**
 * How much of a node passes for listening (0 or 1), given the panel's mute and solo sets — the
 * DAW rule. A muted node is silent. While anything is soloed, a node passes only if it is soloed,
 * sits under something soloed, or sits *above* something soloed (the path down to it has to stay
 * open); everything else is silent. Applied at every node, so a mute or a solo anywhere carries
 * down through the gain chain on its own. Pure, so the probe can hold the rule.
 */
export function monitorPass(key, { mute, solo }) {
  if (mute.has(key)) return 0;
  if (!solo.size) return 1;
  for (let k = key; k != null; k = MIX_PARENT[k]) if (solo.has(k)) return 1;
  for (const s of solo) for (let k = MIX_PARENT[s]; k != null; k = MIX_PARENT[k]) if (k === key) return 1;
  return 0;
}

/**
 * What the station puts between the `n`th song (counting from 1) and the next: `'ad'` for an ad
 * break, `'id'` for the station ID, in the order they play. Pure, so the check suite can hold the
 * running order without an audio clock.
 */
export function radioBetween(n) {
  const out = [];
  if (n % RADIO.adEvery === 0) out.push('ad');
  if (n % RADIO.idEvery === 0) out.push('id');
  return out;
}

/**
 * The mix: every number a sound designer might want to move, kept in `assets/audio/mix.json`
 * rather than here, so the `?audio` panel (game/audiopanel.js) can export a file that drops
 * straight over it. Its four parts:
 *
 * - `master` — the whole game's level, under the mute.
 * - `sounds` — per sound (every take of it together), `gain` (linear) and `rate` (playback rate:
 *   pitch *and* tempo). The gain is how the mix is set without re-exporting masters. The Block 1
 *   delivery arrives balanced against itself — the designer's note is to start every level at
 *   0 dB and move from there, which is what the shipped file does. It sits well under the test
 *   files it replaced: the idle measures -34 dB RMS where they were -25, and the blinker -50.
 *   `copSkid` is the one level that is ours rather than the designer's (see SOUNDS). `file` is
 *   the designer's name, for reading only.
 * - `minGap` — seconds before the same one-shot may fire again: a second skid inside 0.45s is the
 *   same skid. Zero means no limit.
 * - `engine` — the beds' behaviour:
 *   - `idleRateLo`/`idleRateHi`: the idle's playback rate standing still and at cruise. A rate is
 *     pitch and tempo together, which is exactly what an engine note does as it revs.
 *   - `locoRateLo`/`locoRateHi`: the Loco loop's, across the overdrive band (cruise to Loco top).
 *   - `idleUnderLoco`: how far the idle ducks while the Loco engine is up — it is still the same
 *     car underneath, so it ducks rather than cutting out.
 *   - `locoLoopAt`/`locoLoopFade`: when the Loco loop comes in under the activate, and over how
 *     long. The Block 1 activate is 12s: level for about 5.5s (-22 dB RMS in half-second windows),
 *     then a tail that is -35 dB by 7.5s and silent by 11, so a hold that outlasts it needs
 *     something to carry on with. Faded in across the tail rather than
 *     started with the press, where the two would stack.
 *   - `pitchGlide`/`release`: time constants for `setTargetAtTime`, in seconds (~95% of the way
 *     in 3x). The glide is short enough to track a speed change and long enough that a frame's
 *     jitter in `v` is not a zipper in the pitch.
 *   - `pullAwayHold`: how long the taxi has to stand still before pulling away plays `accel`. The
 *     hold is what keeps a car creeping in a queue from revving on every inch.
 *
 * `tune()` cleans whatever it is handed against the shape of the shipped file, so a pasted or
 * hand-edited mix can only ever move a known number to a sane value.
 */
// The taxi pulling away from a standstill: below `STOP_V`, then over `GO_V`.
const STOP_V = 0.4;
const GO_V = 1.2;

// What each knob may hold. A gain of zero is silence and is fine; a rate of zero stops the clock.
const LIMITS = {
  master: [0, 4],
  gain: [0, 8],
  rate: [0.25, 4],
  minGap: [0, 10],
  engine: [0, 30],
  place: [0, 300],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `raw` cleaned onto the shape of `base` — only keys `base` has, only finite numbers, clamped.
 * With `base` null this *is* the shipped file, and every key it names is taken as the shape.
 */
function cleanMix(raw, base) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const shape = base ?? src;
  const out = {
    master: clamp(num(src.master) ?? shape.master ?? 1, LIMITS.master),
    buses: {},
    groups: {},
    sounds: {},
    minGap: {},
    place: {},
    engine: {},
    music: { master: 1, tracks: {} },
  };
  for (const key of OWN_FADER) {
    out.buses[key] = { gain: clamp(num(src.buses?.[key]?.gain) ?? shape.buses?.[key]?.gain ?? 1, LIMITS.master) };
  }
  for (const { key } of GROUPS) {
    out.groups[key] = { gain: clamp(num(src.groups?.[key]?.gain) ?? shape.groups?.[key]?.gain ?? 1, LIMITS.gain) };
  }
  for (const key of Object.keys(SOUNDS)) {
    const from = shape.sounds?.[key] ?? {};
    const given = src.sounds?.[key] ?? {};
    out.sounds[key] = {
      file: from.file ?? key,
      gain: clamp(num(given.gain) ?? from.gain ?? 1, LIMITS.gain),
      rate: clamp(num(given.rate) ?? from.rate ?? 1, LIMITS.rate),
    };
    if (PICKED.has(key)) {
      const pick = Math.round(num(given.pick) ?? from.pick ?? 0);
      out.sounds[key].pick = clamp(pick, [0, SOUNDS[key].length - 1]);
    }
  }
  for (const key of PLACED) {
    const from = shape.place?.[key] ?? {};
    const given = src.place?.[key] ?? {};
    const near = clamp(num(given.near) ?? from.near ?? 10, LIMITS.place);
    out.place[key] = { near, far: Math.max(near + 1, clamp(num(given.far) ?? from.far ?? 60, LIMITS.place)) };
  }
  for (const key of SFX_EVENTS) {
    out.minGap[key] = clamp(num(src.minGap?.[key]) ?? shape.minGap?.[key] ?? 0, LIMITS.minGap);
  }
  for (const key of Object.keys(shape.engine ?? {})) {
    const v = num(src.engine?.[key]) ?? shape.engine[key];
    if (num(v) != null) out.engine[key] = clamp(v, LIMITS.engine);
  }
  // The radio: a level for the music as a whole, and a trim per track on top of its measured
  // `RADIO.gain` — 1 is the -24 LUFS the tracks were levelled to, so the shipped file is all ones.
  out.music.master = clamp(num(src.music?.master) ?? shape.music?.master ?? 1, LIMITS.master);
  for (const key of RADIO.all) {
    const v = num(src.music?.tracks?.[key]?.gain) ?? shape.music?.tracks?.[key]?.gain ?? 1;
    out.music.tracks[key] = { gain: clamp(v, LIMITS.gain) };
  }
  return out;
}

/** A deep copy, since a mix is nested and `tune` writes into it. */
const copyMix = (mix) => JSON.parse(JSON.stringify(mix));

/** The mix as shipped, from mix.json. The panel's Reset returns to this. */
export const SHIPPED_MIX = cleanMix(MIX, null);

const MUTE_KEY = 'simTaxi.muted';

/** The player's mute, as remembered. Exported for the startup screen, which plays before this exists. */
export function readMuted() {
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(on) {
  try { window.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* soft, as ever */ }
}

/**
 * Where a loop's real audio sits inside the decoded buffer. Trimmed or not, the tail is the tail,
 * so a buffer longer than the master by roughly the priming pad has it at the front.
 */
function loopWindow(buffer, seconds) {
  const extra = buffer.duration - seconds;
  const start = extra > AAC_PRIMING * 0.5 ? Math.min(AAC_PRIMING, extra) : 0;
  return { start, end: Math.min(buffer.duration, start + seconds) };
}

/**
 * @param {object} opts
 * @param {{ next: () => number }} [opts.rng]  Draws each trigger's take (`pickTake`). Math.random without.
 * @param {boolean} [opts.menuMusic]  Hold the station off the air until `goOnAir` — the title menu
 *   is silent until then (or plays songs alone, `menuSongs`). False (`?menumusic=classic`, or no title
 *   screen) opens on the intro.
 * @param {boolean} [opts.menuSongs]  Songs back to back under the title menu while it is off the air
 *   (`?titlemusic=classic`). False leaves the menu to the effects, so the music arrives with Play.
 * @param {boolean} [opts.radioFade]  The station talks over the edges of the songs (`RADIO_FADE`).
 *   False (`?radiofade=classic`) plays every track after the last with a hard cut.
 */
export function createSfx({ rng, menuMusic = false, menuSongs = false, radioFade = true } = {}) {
  // Every file the station can schedule, fetched and decoded up front.
  const songs = RADIO.songs;
  const playlist = [RADIO.intro, ...songs, ...RADIO.ads, RADIO.breakIn, RADIO.breakOut, RADIO.stationId];
  const hasAudio = typeof window !== 'undefined'
    && (window.AudioContext || window.webkitAudioContext);
  const state = {
    muted: hasAudio ? readMuted() : true,
    // The player's two volume sliders on the title screen's Settings (game/settings.js owns
    // remembering them; this only applies them). 0..1 as the slider reads, squared on the way to
    // the gain node, because a linear gain spends the whole bottom half of a slider on "loud".
    effects: 1,
    music: 1,
    // The radio pulled down under the drive-through speaker — see `duckMusic`.
    ducked: false,
    musicOut: false,
    // The station heard through the taxi's dash speakers, until `openDash` — see `DASH`.
    dashRadio: false,
    // When the first track after the intro starts, on the audio clock, while `dashRadio` — see
    // `dashMusicSeconds`.
    dashSongAt: null,
    ready: false,
    loaded: 0,
    total: Object.keys(FILES).length,
    held: false,
    // The radio track being previewed from the panel's Music section, or null — what turns its ▶
    // into a ■.
    previewTrack: null,
    // The radio's last few tracks as scheduled, `{ track, at }` in context seconds — for checking
    // the rotation from the console (`__taxi.sfx.state.radio`).
    radio: [],
    // Contexts thrown away for a new one (`revive`) — for checking from the console on a phone.
    revived: 0,
  };
  const random = rng ? () => rng.next() : Math.random;
  // Live, and read every frame, so the panel can move any number while the car is driving.
  const mix = copyMix(SHIPPED_MIX);
  const tuning = () => copyMix(mix);
  // The panel's mute and solo, on any node of the mix tree (MIX_PARENT) — for listening, so not
  // part of the mix: never stashed, never exported, gone on a reload. See `monitorPass`.
  const monitorSets = { mute: new Set(), solo: new Set() };
  const monitor = () => ({ mute: [...monitorSets.mute], solo: [...monitorSets.solo] });
  const pass = (key) => monitorPass(key, monitorSets);
  /** Merge a partial mix in. Anything unknown or non-numeric is dropped (see `cleanMix`). */
  function tuneMix(partial) {
    const merged = copyMix(mix);
    const src = partial && typeof partial === 'object' ? partial : {};
    if ('master' in src) merged.master = src.master;
    for (const part of ['buses', 'groups', 'sounds', 'minGap', 'place', 'engine']) {
      for (const [key, value] of Object.entries(src[part] ?? {})) {
        if (!(key in merged[part])) continue;
        merged[part][key] = part === 'buses' || part === 'groups' || part === 'sounds' || part === 'place'
          ? { ...merged[part][key], ...value } : value;
      }
    }
    if (src.music && typeof src.music === 'object') {
      if ('master' in src.music) merged.music.master = src.music.master;
      for (const [key, value] of Object.entries(src.music.tracks ?? {})) {
        if (key in merged.music.tracks) merged.music.tracks[key] = { ...merged.music.tracks[key], ...value };
      }
    }
    Object.assign(mix, cleanMix(merged, SHIPPED_MIX));
  }
  /** Mute or solo a node of the mix tree (either may be omitted). An unknown key is ignored. */
  function setMonitorSets(key, mute, solo) {
    if (!(key in MIX_PARENT)) return;
    if (mute !== undefined) monitorSets.mute[mute ? 'add' : 'delete'](key);
    if (solo !== undefined) monitorSets.solo[solo ? 'add' : 'delete'](key);
  }
  if (!hasAudio) {
    // Headless, or a browser without Web Audio: every call is a no-op — except the mix, which is
    // plain data and is what `npm run check` exercises.
    const noop = () => {};
    return {
      state, play: noop, update: noop, hold: noop, setMuted: noop, toggleMuted: () => true,
      setVolumes: noop,
      locoOn: noop, locoOff: noop, release: noop, unloop: noop, steer: noop, duckMusic: noop, fadeOutMusic: noop,
      goOnAir: (opts) => { state.dashRadio = Boolean(opts?.dash); },
      openDash: () => { state.dashRadio = false; }, dashMusicSeconds: () => Infinity, tuning, tune: tuneMix, reset: () => tuneMix(SHIPPED_MIX),
      monitor, setMonitor: (key, { mute, solo } = {}) => setMonitorSets(key, mute, solo),
      clearMonitor: () => { monitorSets.mute.clear(); monitorSets.solo.clear(); },
      audible: pass, meter: () => null,
      audition: () => null, stopAuditions: noop, files: FILES, radioFiles: RADIO_FILES,
      replace: async () => ({ ok: false, failed: [] }), revert: noop, replaced: () => null,
      pickReplacement: noop,
      auditionTrack: () => false, stopTrackPreview: noop, replaceTrack: async () => false, revertTrack: noop, trackReplaced: () => null,
    };
  }

  // Ask iOS for the "playback" session: plays through the ring/silent switch, the way a music app
  // does, because the game carries its own music as well as effects. The cost is that it stops
  // the player's own music rather than mixing with it; "ambient" was the other way round, and a
  // phone on silent heard nothing. Safari 16.4+; elsewhere the property does not exist.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* old */ }

  // Fetched now, decoded once there is a context to decode into.
  //
  // Each download is marked handled the moment it is made, because nothing else listens to it
  // until the first tap runs `start()` — and a download that fails before then is an *unhandled*
  // rejection in the meantime, which index.html's panel puts over the whole screen. That is a
  // launch with a bad connection: a Home Screen launch that lands on a dropped or still-attaching
  // network fails every uncached file at once, and Safari's `TypeError: Load failed` carries an
  // empty `stack`, so the panel read "Unhandled rejection:" and nothing else. A missing sound is
  // not a broken game; `start()` still awaits the original promise and logs it as one.
  //
  // The radio's other song set is fetched only if the ⚙️ panel asks to hear one of it.
  const bytes = {};
  const urls = { ...FILES, ...RADIO_FILES };
  const bytesOf = (key) => {
    if (!bytes[key]) {
      bytes[key] = fetch(urls[key]).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${urls[key]}`);
        return r.arrayBuffer();
      });
      bytes[key].catch(() => {});
    }
    return bytes[key];
  };
  for (const key of [...Object.keys(FILES), ...playlist]) bytesOf(key);

  let ctx = null;
  let master = null;
  // `resume()` and `suspend()` return promises that WebKit rejects (a context it has closed behind
  // the app's back, a resume it will not allow outside a gesture). Every call here is
  // fire-and-forget and the next gesture tries again, so a refusal is not an error worth a panel.
  // (`Promise.resolve` because the prefixed `webkitAudioContext` of an older iOS returns nothing.)
  const resumeCtx = () => { Promise.resolve(ctx.resume()).catch(() => {}); };
  const suspendCtx = () => { Promise.resolve(ctx.suspend()).catch(() => {}); };
  // The music's own level, beside `master` rather than under it, so the two sliders are
  // independent. The radio (`startRadio`) is what plays into it.
  let musicBus = null;
  // The radio's own fader inside the music bus, so a track previewed from the panel can play alone:
  // it goes to 0 while a preview runs and back up when the last one ends (`auditionTrack`).
  let radioBus = null;
  // The tree above the groups (BUSES): `out` is Master and the one node that reaches the speakers;
  // `master` is the SFX bus (named before there was a Master over it) and `musicBus` the Music
  // bus, each with a monitor node after it — they have their own automation (the player's
  // sliders, the duck, the fade at a run's end) that mute and solo must not fight. Player and
  // World are `busNode`.
  let out = null;
  const busNode = {};
  const monitorNode = {};
  // The ⚙️ panel's peak meter on `out`, made the first time it is read (`readMeter`): a tap off the
  // side of the chain, so it changes nothing that is heard, and absent from a normal session.
  let meterTap = null;
  // The street racer's underglow pulses to the music (`readBass`): a tap off the Music bus, made the
  // first time a racer asks, after the bus's own fader — so a muted or ducked song pulses nothing.
  let bassTap = null;
  /** What the SFX bus gain should read: the mix's level, under the player's slider and the mute. */
  const masterLevel = () => (state.muted ? 0 : mix.master * state.effects ** 2);
  const musicLevel = () => (state.muted || state.musicOut ? 0
    : mix.music.master * state.music ** 2 * (state.ducked ? MUSIC_DUCK : 1));
  const buffers = {};    // by file name
  // Files the designer dropped in from disk to try in place of a sound's own (the ⚙️ panel's
  // Replace…). By sound: `{ ids, names, pick }`, each buffer living in `buffers[id]` beside the
  // shipped ones, so every path that plays a file plays these without knowing. Several files are a
  // **variant set**: a one-shot draws one per trigger the way shipped takes do, and a bed — which
  // can only play one — plays `pick`. Never saved: a reload is the shipped set again.
  const replacements = {};
  const lastAt = {};
  const lastTake = {};   // by sound name: the file it played last

  /**
   * One of `name`'s takes, at random — but never the one it played last, so a run of three bumps
   * cannot be the same recording three times, which a plain pick does one time in nine. Only takes
   * that actually decoded are drawn from, so a missing file thins the set rather than silencing it.
   */
  function pickTake(name) {
    const r = replacements[name];
    if (r) {
      if (LOOPS.has(name) || r.ids.length === 1) return r.ids[r.pick];
      const fresh = r.ids.filter((id) => id !== lastTake[name]);
      const id = fresh[Math.floor(random() * fresh.length)];
      lastTake[name] = id;
      return id;
    }
    if (PICKED.has(name)) {
      const file = SOUNDS[name][mix.sounds[name].pick];
      return buffers[file] ? file : null;
    }
    const loaded = SOUNDS[name].filter((f) => buffers[f]);
    if (!loaded.length) return null;
    const fresh = loaded.length > 1 ? loaded.filter((f) => f !== lastTake[name]) : loaded;
    const file = fresh[Math.floor(random() * fresh.length)];
    lastTake[name] = file;
    return file;
  }

  // --- the beds, built once the buffers are in ---
  let idle = null;       // { src, gain }
  let loco = null;       // the Loco loop bed
  let signal = null;     // the blinker; recreated per indicating window so each opens on a tick
  let siren = null;      // the police siren; always running, its level steered by `update`
  let rotor = null;      // the police helicopter's rotor, synthesised; level steered by `update`
  const ambient = {};    // Block 2's beds, by key — see AMBIENT
  let activate = null;   // the current Loco activate voice, or null
  let locoSince = -1;    // ctx time the current hold began, or -1
  let signalHand = null;
  let stoppedFor = 0;
  let wasAir = false;

  /** The file a bed plays: its one file, or for a PICK the one chosen. */
  const bedFile = (key) => (replacements[key] ? replacements[key].ids[replacements[key].pick] : null)
    ?? SOUNDS[key][PICKED.has(key) ? mix.sounds[key].pick : 0];

  /**
   * A gain, then a stereo panner where the browser has one (every target since Safari 14.1), into
   * `key`'s group bus (GROUPS) and so the master. Every voice gets the panner so a placed sound and
   * an unplaced one are one shape.
   */
  function chain(src, gain, key) {
    const g = ctx.createGain();
    g.gain.value = gain;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(g);
    (pan ? g.connect(pan) : g).connect(soundBus[key] ?? groupBus[GROUP_OF[key]] ?? master);
    return { src, gain: g, pan, file: null };
  }

  // One gain node per group, between its voices and its bus — see GROUPS — and one per sound
  // between its voices and its group, which only carries that sound's mute and solo: its level is
  // per voice, because a bed re-aims its own gain every frame. Built with the context.
  const groupBus = {};
  const soundBus = {};
  /** Every fader and monitor node in the tree, moved to what the mix and the panel say. */
  function setLevels(tau = 0.02) {
    if (!ctx) return;
    const t = ctx.currentTime;
    out.gain.setTargetAtTime(mix.buses.master.gain * pass('master'), t, tau);
    monitorNode.sfx.gain.setTargetAtTime(pass('sfx'), t, tau);
    monitorNode.music.gain.setTargetAtTime(pass('music'), t, tau);
    for (const key of ['player', 'world']) busNode[key].gain.setTargetAtTime(mix.buses[key].gain * pass(key), t, tau);
    for (const { key } of GROUPS) groupBus[key].gain.setTargetAtTime(mix.groups[key].gain * pass(key), t, tau);
    for (const key of Object.keys(soundBus)) soundBus[key].gain.setTargetAtTime(pass(key), t, tau);
    for (const v of radioVoices) v.gain.gain.setTargetAtTime(trackLevel(v.key), t, tau);
    for (const v of auditions) if (v.track) v.gain.gain.setTargetAtTime(trackLevel(v.track), t, tau);
  }

  /**
   * The peak on Master since the last read, per channel, as linear sample values — the ⚙️ panel's
   * meter polls it every frame. Two analysers behind a splitter, since an AnalyserNode mixes its
   * input down to mono first and a hard-panned peak would read 6 dB low. Each read takes the last
   * 2048 samples (43 ms at 48 kHz), longer than a frame, so nothing between two reads is missed.
   */
  function readMeter() {
    if (!ctx) return null;
    if (!meterTap) {
      const split = ctx.createChannelSplitter(2);
      const sides = [ctx.createAnalyser(), ctx.createAnalyser()];
      out.connect(split);
      sides.forEach((a, i) => { a.fftSize = 2048; split.connect(a, i); });
      meterTap = { sides, data: new Float32Array(2048) };
    }
    return meterTap.sides.map((a) => {
      a.getFloatTimeDomainData(meterTap.data);
      let peak = 0;
      for (const x of meterTap.data) { const m = Math.abs(x); if (m > peak) peak = m; }
      return peak;
    });
  }

  /**
   * How much low end is on the Music bus right now, 0..1 — the kick drum, near enough. The bins
   * under `BASS_HZ`, averaged, on the analyser's own dB scale (minDecibels..maxDecibels mapped to
   * 0..1), with no smoothing of its own: the caller wants the transient, and smooths it there.
   */
  function readBass() {
    if (!ctx || !musicBus) return 0;
    if (!bassTap) {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
      musicBus.connect(a);
      const bins = Math.max(1, Math.round(BASS_HZ / (ctx.sampleRate / a.fftSize)));
      bassTap = { a, bins, data: new Uint8Array(a.frequencyBinCount) };
    }
    bassTap.a.getByteFrequencyData(bassTap.data);
    let sum = 0;
    // From bin 1: bin 0 is DC.
    for (let i = 1; i <= bassTap.bins; i++) sum += bassTap.data[i];
    return sum / bassTap.bins / 255;
  }

  function makeLoop(key, gain = 0) {
    const file = bedFile(key);
    const src = ctx.createBufferSource();
    src.buffer = buffers[file];
    src.loop = true;
    const w = loopWindow(src.buffer, LOOP_SECONDS[file] ?? src.buffer.duration);
    src.loopStart = w.start;
    src.loopEnd = w.end;
    const voice = chain(src, gain, key);
    voice.file = file;
    voice.scale = 1;
    src.start(0, w.start);
    return voice;
  }

  /** A bed whose file is in, or null — so a missing master is a quiet bed, not a throw. */
  const tryLoop = (key, gain) => (buffers[bedFile(key)] ? makeLoop(key, gain) : null);

  /** The PICK moved on the panel: start the new file and let the old one go. */
  function repick(key, voice) {
    if (!voice || voice.file === bedFile(key)) return voice;
    const level = voice.gain.gain.value;
    stopVoice(voice, 0.05);
    return tryLoop(key, level);
  }

  /**
   * How loud a placed sound is from `d` units off the taxi: whole inside `near`, nothing past
   * `far`, and squared between, which is closer to how a source fades than a straight line and
   * keeps it from hanging around at half level across a whole block.
   */
  function falloff(key, d) {
    const p = mix.place[key];
    if (!p || d == null) return 1;
    const k = Math.max(0, Math.min(1, (p.far - d) / Math.max(1e-3, p.far - p.near)));
    return k * k;
  }

  /** Point a voice at `{ d, pan, level }` — gain from the falloff, then the pan. */
  function aim(voice, key, at, tau) {
    const t = ctx.currentTime;
    const level = (at.level ?? 1) * falloff(key, at.d);
    voice.gain.gain.setTargetAtTime(mix.sounds[key].gain * (voice.scale ?? 1) * level, t, tau);
    if (voice.pan) {
      const p = Math.max(-1, Math.min(1, at.pan ?? 0)) * PAN_WIDTH;
      voice.pan.pan.setTargetAtTime(p, t, tau);
    }
  }

  function stopVoice(v, tau = mix.engine.release) {
    if (!v) return;
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, tau);
    try { v.src.stop(t + tau * 6); } catch { /* already stopped */ }
  }

  /**
   * The police helicopter's rotor (game/policeheli.js). **Synthesised, as a stand-in**: there is no
   * recording of one in the designer's set, and a getaway's chopper with no sound reads as a model
   * on a wire. Low-passed noise for the wash, chopped by a ROTOR_CHOP Hz tremolo for the blade
   * slap, with a low sine under it for the thump. Runs silent all run like the siren, and the
   * frame says how loud. Swap for a recording when there is one.
   */
  function makeRotor() {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;   // not `random`: that stream draws the takes
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 520;
    lowpass.Q.value = 0.9;
    const thump = ctx.createOscillator();
    thump.frequency.value = 58;
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.55;
    // The chop: a gain swung between 0.08 and 1 by a sine at the blade-pass rate.
    const chop = ctx.createGain();
    chop.gain.value = 0.54;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = ROTOR_CHOP;
    const depth = ctx.createGain();
    depth.gain.value = 0.46;
    lfo.connect(depth).connect(chop.gain);
    const g = ctx.createGain();
    g.gain.value = 0;
    noise.connect(lowpass).connect(chop);
    thump.connect(thumpGain).connect(chop);
    chop.connect(g).connect(soundBus.rotor);
    noise.start();
    thump.start();
    lfo.start();
    return { gain: g };
  }

  /** A context and the whole mix tree in it, up to the dash radio — everything but the voices. */
  function buildGraph() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
    const gainNode = (to) => { const g = ctx.createGain(); g.connect(to); return g; };
    out = gainNode(ctx.destination);
    monitorNode.sfx = gainNode(out);
    master = gainNode(monitorNode.sfx);
    master.gain.value = masterLevel();
    for (const key of ['player', 'world']) busNode[key] = gainNode(master);
    for (const { key, bus } of GROUPS) groupBus[key] = gainNode(busNode[bus]);
    for (const [key, parent] of Object.entries(GROUP_OF)) soundBus[key] = gainNode(groupBus[parent]);
    soundBus.rotor = gainNode(groupBus.police);
    monitorNode.music = gainNode(out);
    musicBus = gainNode(monitorNode.music);
    musicBus.gain.value = musicLevel();
    setLevels(0.001);
    radioBus = ctx.createGain();
    buildDash();
    setDash(state.dashRadio, ctx.currentTime);
  }

  /** The beds that run all session, out of buffers already decoded — a fresh set (`revive`). */
  function buildBeds() {
    idle = tryLoop('idle');
    siren = tryLoop('siren');
    loco = tryLoop('locoLoop');
    for (const key of AMBIENT) ambient[key] = tryLoop(key);
    rotor = makeRotor();
  }

  /** Any bed not running yet whose file has now decoded, so each starts the moment it can. */
  function fillBeds() {
    idle ??= tryLoop('idle');
    siren ??= tryLoop('siren');
    loco ??= tryLoop('locoLoop');
    for (const key of AMBIENT) ambient[key] ??= tryLoop(key);
    rotor ??= makeRotor();
  }

  async function decodeAll(keys) {
    await Promise.all(keys.map(async (key) => {
      if (buffers[key] || !FILES[key]) return;
      const p = bytesOf(key);
      try {
        const buf = await p;
        buffers[key] = await ctx.decodeAudioData(buf);
        state.loaded++;
      } catch (err) {
        console.warn(`sfx: ${key} did not load`, err);
      }
    }));
  }

  // In three waves, each waiting on the last, because the title menu's sound is the city's beds and
  // they used to be the *last* thing it got. One `Promise.all` over every file handed the decoder
  // all 73 at once (~400 s of audio, and the radio's ~185 s queued ahead of them), and nothing
  // started until the slowest had finished — so the menu sat silent through the whole set, with
  // the city loop ~50th in the queue. The spawn's takes still go first (the one sound with a
  // deadline, see `play`), then the city bed on its own, then the rest of the beds, then
  // everything else. Measured on a cloud core with ffmpeg as a stand-in decoder: the
  // spawn and the city loop together are ~0.15 s, the whole set ~4 s.
  async function start() {
    buildGraph();
    rotor = makeRotor();
    const rest = Object.keys(FILES);
    const beds = ['idle', 'siren', 'locoLoop', ...AMBIENT].map(bedFile);
    // The dispatch lines go first too: the story opens on the tap that, on the web, can be the
    // first one, and they are ~19 s of speech, a sliver of the decoder's time.
    await decodeAll([...SOUNDS.spawn, bedFile('city'), ...SOUNDS.dispatch1, ...SOUNDS.dispatch2,
      ...SOUNDS.dispatch3, ...SOUNDS.dispatch4]);
    fillBeds();
    // The station's ~185 s goes behind the effects while it is off the air (the title menu); on
    // the air already (no title screen, or the menu's own songs) it waits only for the spawn and
    // the city. Play pressed before the effects are in opens the station itself (`goOnAir`), so
    // it is not started a second time here.
    const radioNow = onAir || menuSongs;
    if (radioNow) startRadio();
    await decodeAll(beds);
    fillBeds();
    await decodeAll(rest);
    fillBeds();
    if (!radioNow && !onAir) startRadio();
    state.ready = true;
    if (state.held) suspendCtx();
  }

  // The dash radio (`DASH`), between `radioBus` and the music bus:
  //
  //   radioBus ─┐                  ┌─ mono ─ drive ─ crush ─ crushOut ─┐
  //   static ───┴─ highpass ─ bump ┤                                   ├─ lowpass ─ musicBus
  //                                └─ clean ───────────────────────────┘
  //
  // In the car `crushOut` is up and `clean` is shut; the open sweeps the filters and swaps the two.
  let dash = null;
  function buildDash() {
    const filter = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const low = filter('highpass', DASH_OPEN_LOW, DASH.Q);
    const bump = filter('peaking', DASH.peakHz, 1);
    const high = filter('lowpass', ctx.sampleRate / 2, DASH.Q);
    // One speaker: a gain node held to one channel down-mixes whatever reaches it, and the
    // low-pass up-mixes it back to both sides.
    const mono = gain(1);
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    const drive = gain(DASH.drive);
    const crush = ctx.createWaveShaper();
    crush.curve = crushCurve();
    const crushOut = gain(0);
    const clean = gain(1);
    radioBus.connect(low).connect(bump);
    bump.connect(mono).connect(drive).connect(crush).connect(crushOut).connect(high);
    bump.connect(clean).connect(high);
    high.connect(musicBus);
    dash = { low, bump, high, crushOut, clean, staticGain: null, staticSrc: null };
  }
  /** tanh, quantised to `DASH.steps` levels a side: the soft clip and the bit depth in one curve. */
  function crushCurve() {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(Math.tanh(x * 2) * DASH.steps) / DASH.steps;
    }
    return curve;
  }
  /**
   * Six seconds of AM static, made once: hiss (white noise through a one-pole low-pass, so it is a
   * wash rather than a fizz once the speaker band has had it), crackles at about 14 a second, and a
   * louder pop about one second in two. Six seconds so the loop is not heard as a pattern; it never
   * plays longer than the vignette anyway.
   */
  function staticBuffer() {
    const rate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.round(rate * 6), rate);
    const d = buffer.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * 0.06;
    }
    const click = (amp, len) => {
      const at = Math.floor(Math.random() * (d.length - len));
      const sign = Math.random() < 0.5 ? -1 : 1;
      for (let k = 0; k < len; k++) d[at + k] += sign * amp * Math.exp(-k / (len / 4)) * (k % 2 ? -0.6 : 1);
    };
    for (let i = 0; i < 6 * 14; i++) click(0.05 + Math.random() * 0.2, 6 + Math.floor(Math.random() * 30));
    for (let i = 0; i < 3; i++) click(0.5 + Math.random() * 0.3, 60 + Math.floor(Math.random() * 120));
    return buffer;
  }
  /** In the car (`true`) or open, on the spot. */
  function setDash(inCar, at) {
    const set = (param, v) => { param.cancelScheduledValues(0); param.setValueAtTime(v, at); };
    set(dash.low.frequency, inCar ? DASH.lowCut : DASH_OPEN_LOW);
    set(dash.bump.gain, inCar ? DASH.peakDb : 0);
    set(dash.high.frequency, inCar ? DASH.highCut : ctx.sampleRate / 2);
    set(dash.crushOut.gain, inCar ? DASH.crushLevel : 0);
    set(dash.clean.gain, inCar ? 0 : 1);
    if (inCar && !dash.staticSrc) {
      const src = ctx.createBufferSource();
      src.buffer = staticBuffer();
      src.loop = true;
      dash.staticGain = ctx.createGain();
      dash.staticGain.gain.value = DASH.staticLevel;
      src.connect(dash.staticGain).connect(dash.low);
      src.start(at);
      dash.staticSrc = src;
    }
  }

  // --- the radio ---
  const radioBuffers = {};
  let lastSong = null;
  let lastAd = null;
  let songsPlayed = 0;
  // What plays after the song just queued and before the next one: the ad break and the ID.
  const between = [];
  // A track the panel's Replace… has stood a local file in for: `{ buffer, name }`. Takes effect
  // the next time that track is scheduled — the one already playing plays out.
  const radioReplaced = {};
  const trackBuffer = (key) => radioReplaced[key]?.buffer ?? radioBuffers[key];
  // What a track is played for: the master's true length, or a local file's own.
  const trackSeconds = (key) => (radioReplaced[key] ? radioReplaced[key].buffer.duration : RADIO.seconds[key]);
  // The track's mute and solo ride its own gain, as its level does: a preview plays into the music
  // bus past `radioBus`, so there is no one node every play of a track goes through.
  const trackLevel = (key) => RADIO.gain[key] * mix.music.tracks[key].gain * pass(key);
  // Tracks on the clock right now, so a level moved on the panel reaches the song that is playing.
  const radioVoices = new Set();
  // One decode per file however many callers ask: the menu and the cut to the intro can both want
  // the same track inside the same second.
  const decoding = {};
  function decodeRadio(key) {
    decoding[key] ??= (async () => {
      try {
        radioBuffers[key] = await ctx.decodeAudioData(await bytesOf(key));
      } catch (err) {
        console.warn(`sfx: ${key} did not load`, err);
      }
    })();
    return decoding[key];
  }
  // The station proper — intro, then songs with ad breaks and IDs — or the title menu's songs on
  // their own. Off the air until Play when there is a title screen (`goOnAir`); see `startRadio`.
  let onAir = !menuMusic;
  // Bumped on the cut to the intro, so the menu's tracks, stopped mid-song, cannot top the queue
  // back up from their `onended`.
  let generation = 0;
  // While the intro is still decoding after the cut, nothing may be scheduled ahead of it.
  let introPending = false;

  // The track last put on the clock — `{ key, at, end, voice }` — which the next one may overlap
  // (`RADIO_FADE`). Null after a cut.
  let prev = null;
  const talksIntoSong = new Set([RADIO.intro, RADIO.breakOut, RADIO.stationId]);
  const talksOverSong = new Set([RADIO.breakIn, RADIO.stationId]);
  // The songs that opened the last session (`OPENERS_KEY`): the first song this session plays, on
  // the menu and after the intro, is neither of them while there is any other to pick.
  const lastOpeners = (() => {
    try { return JSON.parse(window.localStorage.getItem(OPENERS_KEY)) || []; } catch { return []; }
  })();
  const openers = [];
  function opened(song) {
    openers.push(song);
    try { window.localStorage.setItem(OPENERS_KEY, JSON.stringify(openers)); } catch { /* soft */ }
  }

  /** Play `key` into the music bus from `when`, calling `onEnd` once it has finished. */
  function playTrack(key, when, onEnd) {
    const buffer = trackBuffer(key);
    const w = loopWindow(buffer, trackSeconds(key));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = trackLevel(key);
    src.connect(g).connect(radioBus);
    const voice = { key, gain: g, src, at: when };
    radioVoices.add(voice);
    src.onended = () => { radioVoices.delete(voice); onEnd(); };
    src.start(when, w.start, w.end - w.start);
    lastVoice = voice;
    return when + (w.end - w.start);
  }
  let lastVoice = null;

  // Tracks scheduled on the audio clock and not yet ended, and when the last of them ends.
  let ahead = 0;
  let queuedEnd = 0;
  function queue(key) {
    const now = ctx.currentTime;
    let when = Math.max(queuedEnd, now);
    // Overlap the track before (`RADIO_FADE`), if it is still on the clock. A song that decoded too
    // late to go in under the voice, or a voice too late for the song's tail, just follows it.
    const live = radioFade && prev && prev.end > now;
    const intoSong = live && songs.includes(key) && talksIntoSong.has(prev.key);
    const overSong = live && talksOverSong.has(key) && songs.includes(prev.key);
    if (intoSong) when = Math.max(prev.at + RADIO_FADE.under, now);
    if (overSong) when = Math.max(prev.end - RADIO_FADE.over, now);
    const gen = generation;
    ahead++;
    if (onAir && state.dashRadio && key !== RADIO.intro && state.dashSongAt === null) state.dashSongAt = when;
    const end = playTrack(key, when, () => { if (gen !== generation) return; ahead--; topUp(); });
    if (intoSong && when < prev.end) {
      // Under the voice, then up to its own level as the voice finishes.
      const g = lastVoice.gain.gain, level = trackLevel(key);
      g.setValueAtTime(level * RADIO_FADE.duck, when);
      g.setValueAtTime(level * RADIO_FADE.duck, Math.max(when, prev.end - RADIO_FADE.rise));
      g.linearRampToValueAtTime(level, prev.end);
    }
    if (overSong && when < prev.end) {
      // The song's last bars dip under the voice and play out there.
      const g = prev.voice.gain.gain, level = trackLevel(prev.key);
      g.setValueAtTime(level, when);
      g.linearRampToValueAtTime(level * RADIO_FADE.duck, Math.min(prev.end, when + RADIO_FADE.dip));
    }
    // The queue carries on from the later of the two ends: a song that went in under a voice ends
    // after it, and a voice over a song's tail ends after the song.
    queuedEnd = Math.max(end, queuedEnd);
    prev = { key, at: when, end, voice: lastVoice };
    state.radio = [...state.radio.slice(-7), { track: key, at: when }];
  }

  /**
   * Keep **two** tracks on the clock: the one playing and the one after it. So the next song is
   * always already scheduled when the current one ends and the cut is sample-exact, where starting
   * each song from the previous one's `onended` would leave a gap of however late that event
   * lands. The clock stops with a hold, so a pause stops the radio mid-song, queue and all.
   */
  function topUp() {
    if (introPending) return;
    const freshPick = (keys, last, avoid = []) => {
      const loaded = keys.filter((k) => trackBuffer(k));
      if (!loaded.length) return null;
      let fresh = loaded.length > 1 ? loaded.filter((k) => k !== last) : loaded;
      const away = fresh.filter((k) => !avoid.includes(k));
      if (away.length) fresh = away;
      return fresh[Math.floor(random() * fresh.length)];
    };
    while (ahead < 2) {
      if (between.length) {
        const next = between.shift();
        if (trackBuffer(next)) queue(next);
        continue;
      }
      // The run's first song is not one the last session opened on.
      const opening = onAir && songsPlayed === 0;
      const song = freshPick(songs, lastSong, opening ? lastOpeners : []);
      if (!song) return;
      lastSong = song;
      if (opening) opened(song);
      queue(song);
      // The menu is songs alone: the station only talks once it is on the air.
      if (!onAir) continue;
      // Count the song, then line up what follows it. A break with no ad decoded is skipped
      // whole: a tee-up into nothing is worse than no break.
      songsPlayed++;
      for (const slot of radioBetween(songsPlayed)) {
        if (slot === 'id') { between.push(RADIO.stationId); continue; }
        const ad = freshPick(RADIO.ads, lastAd);
        if (ad) { lastAd = ad; between.push(RADIO.breakIn, ad, RADIO.breakOut); }
      }
    }
  }

  /**
   * On the air: the intro, then songs for as long as the page is open. The intro is decoded first
   * so it starts as soon after the tap as it can; the songs decode while it plays. A file that
   * failed to download is a warning and a gap in the rotation, never an error — the rule for every
   * sound here.
   *
   * Off the air (the title menu, Tyler October 2026): one song picked at random, decoded ahead of
   * everything else so the menu is not silent for long after the first tap, then more songs back to
   * back with no ads and no ID until Play cuts to the intro (`goOnAir`). That is `?titlemusic=classic`
   * now: by default the menu is effects only (Tyler, October 2026), so the music is something Play
   * gives you rather than something it changes. The tracks still decode here, intro first, so the
   * cut to the intro is not waiting on a decode.
   */
  async function startRadio() {
    if (onAir) { openStation(); return; }
    if (!menuSongs) {
      await decodeRadio(RADIO.intro);
      await Promise.all(playlist.map(decodeRadio));
      return;
    }
    const fresh = songs.filter((k) => !lastOpeners.includes(k));
    const pool = fresh.length ? fresh : songs;
    const first = pool[Math.floor(random() * pool.length)];
    await decodeRadio(first);
    if (!onAir && trackBuffer(first)) { lastSong = first; opened(first); queue(first); }
    await Promise.all(playlist.map(decodeRadio));
    if (!onAir) topUp();
  }

  /** Cut whatever the menu is playing and open the station on its intro. */
  async function openStation() {
    generation++;
    const t = ctx.currentTime;
    // The first song after the intro is never the one the menu was playing. `lastSong` alone is
    // the menu's *next* song, already queued behind it, so read the one actually sounding.
    const sounding = [...radioVoices].filter((v) => v.at <= t).pop();
    if (sounding && songs.includes(sounding.key)) lastSong = sounding.key;
    for (const v of radioVoices) {
      // A cut, but not a click: 60ms down, then stopped.
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, 0.02);
      try { v.src.stop(t + 0.1); } catch { /* not started yet: stop() still cancels it */ }
    }
    radioVoices.clear();
    ahead = 0;
    queuedEnd = 0;
    between.length = 0;
    songsPlayed = 0;
    state.dashSongAt = null;
    prev = null;
    introPending = true;
    await decodeRadio(RADIO.intro);
    introPending = false;
    if (trackBuffer(RADIO.intro)) queue(RADIO.intro);
    await Promise.all(playlist.map(decodeRadio));
    topUp();
  }

  /**
   * Play: the menu's song gives way to the announcer. Before the first tap there is no context yet
   * and nothing to cut, so it only flips the flag and `startRadio` opens on the intro itself.
   */
  function goOnAir({ dash: inCar = false } = {}) {
    if (onAir) return;
    onAir = true;
    state.dashRadio = inCar;
    if (ctx) { setDash(inCar, ctx.currentTime); openStation(); }
  }

  /**
   * Out of the car: sweep the dash radio open into the full mix over `seconds` (`DASH`). Once, and
   * a no-op if the run did not start in the car. Before the first tap there is no context, so it
   * only clears the flag and the station starts open.
   */
  function openDash(seconds = DASH.open) {
    if (!state.dashRadio) return;
    state.dashRadio = false;
    if (!ctx) return;
    const t = ctx.currentTime;
    const ramp = (param, v, curve = 'linear', end = t + seconds) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      if (curve === 'exp') param.exponentialRampToValueAtTime(v, end);
      else param.linearRampToValueAtTime(v, end);
    };
    // Exponential on the two frequencies, so the sweep moves through the octaves at an even pace
    // rather than spending most of its time above 10 kHz; the bump's gain is in dB, so linear.
    ramp(dash.low.frequency, DASH_OPEN_LOW, 'exp');
    ramp(dash.high.frequency, ctx.sampleRate / 2, 'exp');
    ramp(dash.bump.gain, 0);
    ramp(dash.crushOut.gain, 0);
    ramp(dash.clean.gain, 1);
    if (dash.staticSrc) {
      const gone = t + seconds * DASH.staticOut;
      ramp(dash.staticGain.gain, 0, 'linear', gone);
      dash.staticSrc.stop(gone + 0.05);
      dash.staticSrc = null;
    }
  }

  /**
   * A new context in place of one iOS will not give back, built inside the gesture that found it
   * dead so it starts running. Everything sounding in the old one is dropped with it: the beds are
   * rebuilt off the decoded buffers (an `AudioBuffer` belongs to no context), the radio carries on
   * with its next track rather than replaying the intro, and a one-shot that was mid-air is lost.
   */
  function revive() {
    const old = ctx;
    for (const v of radioVoices) v.src.onended = null;
    radioVoices.clear();
    for (const v of auditions) v.src.onended = null;
    auditions.clear();
    state.previewTrack = null;
    Promise.resolve(old.close?.()).catch(() => {});
    meterTap = null;
    bassTap = null;
    signal = null;
    signalHand = null;
    activate = null;
    locoSince = -1;
    buildGraph();
    setLevels(0.001);
    buildBeds();
    // The old clock's schedule means nothing on the new one.
    generation++;
    ahead = 0;
    queuedEnd = 0;
    prev = null;
    state.dashSongAt = null;
    if (onAir || menuSongs) topUp();
    state.revived++;
  }

  // The unlock. Created *inside* the gesture, because Safari only lets a context start running
  // from one; `resume()` again on every later gesture until it is actually running, because iOS
  // will also suspend it behind the app's back (a phone call, the app backgrounded).
  //
  // **And sometimes never gives it back.** Coming back from another app, WKWebView can leave the
  // context `suspended` or `interrupted` with a `resume()` that never settles, or report `running`
  // with a clock that does not move — the game came back silent and stayed that way however much
  // it was tapped (Tyler, October 2026; WebKit bugs 240646 and 291892 are the same shape). So each
  // gesture also checks the clock against the wall since the last one, and a context that has had
  // a gesture to resume in and still is not keeping time is thrown away (`revive`). Only while
  // nothing is holding it: a pause stops the clock on purpose.
  let probe = null;       // { wall, clock } at the last gesture that found the context free to run
  let revivedAt = -Infinity;
  const unlock = () => {
    if (!ctx) { start(); return; }
    if (state.held || document.hidden) { probe = null; return; }
    const wall = performance.now() / 1000;
    const span = probe ? wall - probe.wall : 0;
    const moving = probe && ctx.state === 'running' && ctx.currentTime - probe.clock >= span * REVIVE.pace;
    // Only a clock seen moving moves the baseline, so a stall is measured from the first gesture
    // that had the chance to fix it — however often the player taps in between.
    if (!probe || moving) probe = { wall, clock: ctx.currentTime };
    else if (span >= REVIVE.after && wall - revivedAt >= REVIVE.after) {
      revivedAt = wall;
      revive();
      probe = null;
      return;
    }
    if (ctx.state !== 'running') resumeCtx();
  };
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  const wake = () => {
    if (!ctx) return;
    probe = null;
    if (document.hidden) suspendCtx();
    else if (!state.held) resumeCtx();
  };
  document.addEventListener('visibilitychange', wake);
  // A page restored from the back-forward cache fires this and not `visibilitychange`.
  window.addEventListener('pageshow', wake);

  /**
   * Fire a one-shot. `delay` is seconds from now on the audio clock, which stops with a hold, so a
   * door scheduled to close after the rider climbs in waits through a pause with the rest.
   */
  function play(name, { gain = 1, rate = 1, delay = 0, at = null, steered = false, loop = false } = {}) {
    if (!SFX_EVENTS.has(name)) throw new Error(`unknown sound: ${name}`);
    // Gated on the context, not on `ready`: `ready` waits for every file, and a one-shot only needs
    // its own (`pickTake` draws from the decoded takes and answers null without one). The spawn is
    // why — it has the length of the city's entrance to land in, and on `ready` it missed whenever
    // the whole set took longer than that to decode, which read as "sometimes it plays".
    if (!ctx || state.muted) return null;
    const now = ctx.currentTime;
    const gap = mix.minGap[name];
    if (gap && lastAt[name] != null && now + delay - lastAt[name] < gap) return null;
    const file = pickTake(name);
    if (!file) return null;
    // A placed one-shot too far away to hear is not played, and does not spend its gap — unless it
    // is `steered`: a long sound on something that moves, re-aimed every frame (`steer`). The plane
    // and the rooftop chopper both *start* off the edge of the map, past any sane `far`, and
    // skipping them there meant they were never heard at all.
    if (at && !steered && PLACED.has(name) && (at.level ?? 1) * falloff(name, at.d) <= 0) return null;
    lastAt[name] = now + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffers[file];
    src.playbackRate.value = rate * mix.sounds[name].rate;
    // Only the ⚙️ panel's ⏸ Hold asks for a loop: a plane frozen overhead, sounding for as long as
    // it is held so its falloff can be walked. `unloop` lets it play out when it is let go.
    src.loop = loop;
    const voice = chain(src, gain * mix.sounds[name].gain, name);
    voice.file = file;
    voice.scale = gain;
    src.onended = () => { voice.ended = true; };
    if (at) {
      voice.gain.gain.value = gain * mix.sounds[name].gain * (at.level ?? 1) * falloff(name, at.d);
      if (voice.pan) voice.pan.pan.value = Math.max(-1, Math.min(1, at.pan ?? 0)) * PAN_WIDTH;
    }
    src.start(now + delay);
    return voice;
  }

  /**
   * Re-aim a placed one-shot that is still playing — the drawbridge, the chopper and the aeroplane
   * are long sounds on things that move, or that the taxi moves past.
   */
  function steer(voice, name, at) {
    if (!voice || !ctx) return;
    aim(voice, name, at, 0.15);
  }

  /** The pill went down — the frame `boost.press()` answered true. */
  function locoOn() {
    if (!state.ready) return;
    play('locoLaunch');
    stopVoice(activate);
    activate = play('locoActivate');
    locoSince = ctx.currentTime;
  }

  /** The hold ended — released, braked, run out, or the run over. Idempotent. */
  function locoOff() {
    if (!state.ready || locoSince < 0) return;
    locoSince = -1;
    stopVoice(activate, 0.15);
    activate = null;
  }

  /**
   * Steer the beds off this frame's taxi.
   *
   * @param {number} dt
   * @param {object} taxi       `traffic.taxi`
   * @param {object} opts
   * @param {number} opts.cruise  The ordinary top speed (SPEED).
   * @param {number} opts.top     The Loco top (`boostCruise()`).
   * @param {boolean} opts.holding  The pill is held (not the cooldown tail).
   * @param {boolean} opts.over   The run has ended.
   * @param {boolean} [opts.menu]  The title menu is up and Play has not been pressed. The taxi is
   *   not the player's yet, so it makes no sound at all — the city's beds and one-shots carry on
   *   (Tyler, October 2026: the menu is effects only, and the idle under it read as the run having
   *   started). Unlike `over` it leaves the siren and the rotor alone, which are the city's.
   * @param {number} [opts.siren]  0..1, how loud the nearest running siren is from where the taxi
   *   is — main.js works it out from distance (see `sirenLevel` there). 0 is no siren on the map.
   */
  function update(dt, taxi, {
    cruise, top, holding, over, menu = false, siren: sirenAt = 0, rotor: rotorAt = 0, ambient: places = {},
  }) {
    // Not `ready`: that waits for every file, and the beds start as their own files land (`start`).
    // Every voice below is null-checked until then.
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = Math.max(0, taxi.v);
    const alive = !over && !menu && !taxi.crashed;

    if (!holding && locoSince >= 0) locoOff();

    // The engine. Pitched off speed, ducked under Loco, and gone with the run.
    const s = Math.min(1, v / cruise);
    const locoUp = alive && locoSince >= 0;
    const e = mix.engine;
    // A Replace… from the panel swaps the bed's file on the next frame, as a PICK change does.
    idle = repick('idle', idle);
    loco = repick('locoLoop', loco);
    if (idle) {
      const rate = (e.idleRateLo + (e.idleRateHi - e.idleRateLo) * s) * mix.sounds.idle.rate;
      idle.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const g = !alive ? 0 : mix.sounds.idle.gain * (locoUp ? e.idleUnderLoco : 1);
      idle.gain.gain.setTargetAtTime(g, t, alive ? e.pitchGlide * 2 : 0.4);
    }
    if (loco) {
      const over01 = Math.max(0, Math.min(1, (v - cruise) / Math.max(1e-6, top - cruise)));
      const rate = (e.locoRateLo + (e.locoRateHi - e.locoRateLo) * over01)
        * mix.sounds.locoLoop.rate;
      loco.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const held = locoUp ? t - locoSince : 0;
      const k = locoUp
        ? Math.max(0, Math.min(1, (held - e.locoLoopAt) / Math.max(1e-3, e.locoLoopFade))) : 0;
      loco.gain.gain.setTargetAtTime(mix.sounds.locoLoop.gain * k, t, locoUp ? 0.3 : e.release);
    }

    // Pulling away from a stop. Not while the pill is up: the launch is that car's pull-away.
    if (v < STOP_V) stoppedFor += dt;
    else {
      if (v > GO_V && stoppedFor >= e.pullAwayHold && alive && !taxi.boost) play('accel');
      if (v > GO_V) stoppedFor = 0;
    }

    // No brake sound when the taxi slows on its own. There used to be one, off the brake *lamp*'s
    // rising edge, and the lamp lights on any deceleration — so letting go of Loco Mode, which
    // only bleeds the overdrive back down to cruise, screeched every time (Tyler, October 2026).
    // The rule now is that a tyre sound means rubber on the road: the pedal, the drift, the
    // bootleg and the cornering slide all lay marks (`layRubber` in main.js), and a red or a coast
    // lays none.

    // Off a ramp. The landing has its own event (`traffic.onTaxiLand`); the takeoff is only
    // visible as `hopFrom` turning non-null, so it is read off the edge here.
    const air = taxi.hopFrom != null;
    if (air && !wasAir && alive) play('takeoff');
    wasAir = air;

    // The blinker. A fresh voice per window, so it opens on its first tick exactly as the lamp
    // opens lit (the sim restarts `signalT` on every change of hand — see TURN_SIGNAL_HZ). The
    // master's ticks are 0.9s apart, which is the sim's 1.1 Hz: they stay in step with the lamp.
    const hand = alive ? taxi.signalHand : null;
    if (hand !== signalHand) {
      stopVoice(signal, 0.03);
      signal = hand && buffers[SOUNDS.signal[0]] && !state.muted ? makeLoop('signal', mix.sounds.signal.gain)
        : null;
      signalHand = hand;
    }
    if (signal) {
      signal.gain.gain.setTargetAtTime(mix.sounds.signal.gain, t, 0.02);
      signal.src.playbackRate.setTargetAtTime(mix.sounds.signal.rate, t, 0.02);
    }

    // The siren. A bed like the idle rather than a voice started per chase: it runs silent all
    // run and the frame says how loud, so a chase that ends any of the ways one can (lost, bust,
    // the depot, a wreck) can never leave it wailing. A quarter-second glide, so a cop passing
    // the falloff's edge swells in rather than switching on. Gone with the run, like the engine.
    siren = repick('siren', siren);
    if (siren) {
      const g = over ? 0 : mix.sounds.siren.gain * siren.scale * Math.max(0, Math.min(1, sirenAt));
      siren.gain.gain.setTargetAtTime(g, t, over ? 0.4 : 0.25);
      siren.src.playbackRate.setTargetAtTime(mix.sounds.siren.rate, t, 0.02);
    }
    if (rotor) {
      const g = over ? 0 : ROTOR_GAIN * Math.max(0, Math.min(1, rotorAt));
      rotor.gain.gain.setTargetAtTime(g, t, over ? 0.4 : 0.3);
    }

    // A placed ▶ from the panel follows its pin, its rings and its Level as it plays. A short glide:
    // this is a knob being turned, not a car rounding a corner. Gone off the map reads as silent.
    for (const v of auditions) if (v.where) aim(v, v.key, v.where() ?? { level: 0 }, 0.03);

    // The city's beds. Half a second's glide: a bed swelling as the taxi rounds the corner onto
    // the court reads as arriving, and a frame's worth of distance is never a step.
    for (const key of AMBIENT) {
      ambient[key] = repick(key, ambient[key]);
      const bed = ambient[key];
      if (!bed) continue;
      bed.src.playbackRate.setTargetAtTime(mix.sounds[key].rate, t, 0.02);
      const at = places[key] ?? { level: 0 };
      aim(bed, key, over ? { ...at, level: 0 } : at, over ? 0.6 : 0.5);
    }
  }

  /** Stop the clock under everything — the pause and the robber's line, which stop the world. */
  function hold(on) {
    if (on === state.held) return;
    state.held = on;
    probe = null;
    if (!ctx) return;
    if (on) suspendCtx();
    else if (!document.hidden) resumeCtx();
  }

  function setMuted(on) {
    state.muted = Boolean(on);
    writeMuted(state.muted);
    if (!ctx) return;
    master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.02);
    if (state.muted) { stopVoice(signal, 0.02); signal = null; signalHand = null; }
  }

  /** The player's sliders, 0..1 each; either may be omitted. Applied at once if the context is up. */
  function setVolumes({ effects, music } = {}) {
    const unit = (v, was) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : was);
    state.effects = unit(effects, state.effects);
    state.music = unit(music, state.music);
    if (!ctx) return;
    master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.02);
  }

  /** Pull the radio down under a voice that has to be heard (true), or let it back up (false). */
  function duckMusic(on) {
    if (Boolean(on) === state.ducked) return;
    state.ducked = Boolean(on);
    if (!ctx) return;
    // Slower back up than down: the speaker's first word should not be under the chorus, and the
    // song coming back over half a second reads as a fade rather than a switch.
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, on ? 0.12 : 0.5);
  }

  /**
   * Fade the radio out for good — the game-over screen. Latched in `musicLevel`, so a slider or a
   * duck released afterwards cannot bring it back; nothing has to undo it, because Retry and Quit
   * both reload the page.
   */
  function fadeOutMusic(seconds = MUSIC_FADE_OUT) {
    if (state.musicOut) return;
    state.musicOut = true;
    if (!ctx) return;
    const g = musicBus.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + seconds);
  }

  function tune(partial) {
    tuneMix(partial);
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(masterLevel(), t, 0.02);
    if (!state.musicOut) musicBus.gain.setTargetAtTime(musicLevel(), t, 0.02);
    setLevels();
  }

  // The panel's audition voices, tracked so an 11-second activate can be stopped.
  const auditions = new Set();
  /**
   * Play a sound once at its mixed gain and rate, loops included and past `minGap` — the panel's
   * ▶. A sound with variants draws the next take the way `play` does. Returns the file it played,
   * or null when nothing could (no tap yet, the file missing, muted or held).
   *
   * With `where` (a function answering `{ d, pan }` off `placeAt`, or null), it is heard from
   * there, and re-aimed every frame in `update` like a bed — so dragging a ring, the Level slider
   * or panning the 👂 moves it while it plays (Tyler, October 2026). Without, it is the raw file —
   * what Shift-▶ asks for, and every sound with no place.
   */
  function audition(key, where = null) {
    if (!state.ready || state.muted || state.held || !SOUNDS[key]) return null;
    const file = pickTake(key);
    if (!file) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffers[file];
    src.playbackRate.value = mix.sounds[key].rate;
    const at = where?.();
    const voice = chain(src, mix.sounds[key].gain * (at ? falloff(key, at.d) : 1), key);
    if (at && voice.pan) voice.pan.pan.value = Math.max(-1, Math.min(1, at.pan ?? 0)) * PAN_WIDTH;
    if (where) Object.assign(voice, { key, where });
    auditions.add(voice);
    src.onended = () => auditions.delete(voice);
    src.start();
    return file;
  }
  function stopAuditions() {
    for (const v of auditions) stopVoice(v, 0.03);
    auditions.clear();
    radioPreviewing(false);
    state.previewTrack = null;
  }

  /** Stop a previewed radio track — its ■ on the panel — and let the radio back up. */
  function stopTrackPreview() {
    for (const v of auditions) if (v.track) { stopVoice(v, 0.03); auditions.delete(v); }
    radioPreviewing(false);
    state.previewTrack = null;
  }

  /** Hold the radio silent under a previewed track, or let it back up. */
  function radioPreviewing(on) {
    if (!radioBus) return;
    radioBus.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, on ? 0.05 : 0.4);
  }
  const previewingTrack = () => [...auditions].some((v) => v.track);

  /**
   * Play one radio track from the top — the Music section's ▶. Into the music bus, so the Music
   * levels steer it, and **alone**: any other previewed track stops and the radio is held silent
   * until this one ends or ■ Stop previews cuts it — two songs over each other judge neither.
   */
  function auditionTrack(key) {
    // The song set this session's station does not play is only fetched on asking: the first ▶
    // decodes it and plays once it is in.
    if (ctx && !trackBuffer(key) && !decoding[key] && RADIO.all.includes(key)) {
      decodeRadio(key).then(() => { if (trackBuffer(key)) auditionTrack(key); });
      return false;
    }
    if (!state.ready || state.muted || state.held || !trackBuffer(key)) return false;
    for (const v of auditions) if (v.track) { stopVoice(v, 0.03); auditions.delete(v); }
    radioPreviewing(true);
    const buffer = trackBuffer(key);
    const w = loopWindow(buffer, trackSeconds(key));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = trackLevel(key);
    src.connect(g).connect(musicBus);
    const voice = { src, gain: g, track: key };
    auditions.add(voice);
    src.onended = () => {
      auditions.delete(voice);
      if (!previewingTrack()) { radioPreviewing(false); state.previewTrack = null; }
    };
    state.previewTrack = key;
    src.start(0, w.start, w.end - w.start);
    return true;
  }

  /** A local file in place of a radio track, until `revertTrack` or a reload. See `radioReplaced`. */
  async function replaceTrack(key, bytesIn, name) {
    if (!ctx || !(key in RADIO.seconds)) return false;
    try { radioReplaced[key] = { buffer: await ctx.decodeAudioData(bytesIn), name }; } catch { return false; }
    topUp();
    return true;
  }

  /**
   * Play local files in place of `key`'s own — all its takes, until `revert` or a reload. Several
   * files are a variant set (see `replacements`). A bed swaps on the next frame (`repick` sees the
   * file change). `ok` is false when nothing could decode — no tap yet, or not audio the browser
   * reads; `failed` names any file that was skipped.
   *
   * @param {string} key
   * @param {{ bytes: ArrayBuffer, name: string }[]} files
   */
  async function replace(key, files) {
    if (!ctx || !SOUNDS[key] || !files.length) return { ok: false, failed: files.map((f) => f.name) };
    const stamp = Date.now();
    const ids = [], names = [], failed = [];
    for (const [n, f] of files.entries()) {
      try {
        const id = `replaced:${key}:${stamp}:${n}`;
        buffers[id] = await ctx.decodeAudioData(f.bytes);
        ids.push(id);
        names.push(f.name);
      } catch { failed.push(f.name); }
    }
    if (!ids.length) return { ok: false, failed };
    revert(key);
    replacements[key] = { ids, names, pick: 0 };
    return { ok: true, failed };
  }
  function revert(key) {
    for (const id of replacements[key]?.ids ?? []) delete buffers[id];
    delete replacements[key];
  }

  // The iOS app does not wait for a tap. Its shell lifts WebKit's gesture rule
  // (`mediaTypesRequiringUserActionForPlayback = []`, the same allowance the startup screen's
  // sting runs on — game/splashsound.js), so the context can run from boot and the files decode
  // while the logo plays. Waiting for the first tap there meant the title menu came up silent and
  // the city only arrived a tap *and* a decode later. Should WebKit hold the context suspended
  // anyway, the first tap resumes it (`unlock`), which is where every browser still starts.
  if (isNative()) start();

  return {
    state,
    play,
    replace,
    revert,
    /** The local files standing in for `key` — `{ ids, names, pick }` — or null. */
    replaced: (key) => (replacements[key] ? { ...replacements[key] } : null),
    auditionTrack,
    stopTrackPreview,
    replaceTrack,
    revertTrack: (key) => { delete radioReplaced[key]; },
    /** The local file standing in for a radio track, or null. */
    trackReplaced: (key) => radioReplaced[key]?.name ?? null,
    /** Which local file a replaced bed plays. */
    pickReplacement(key, i) {
      const r = replacements[key];
      if (r) r.pick = Math.max(0, Math.min(r.ids.length - 1, Math.round(i)));
    },
    tuning,
    tune,
    reset: () => tune(SHIPPED_MIX),
    /** What is muted and soloed on the panel, `{ mute: [...], solo: [...] }`, by node of MIX_PARENT. */
    monitor,
    /**
     * Mute or solo any bus, group, sound or track for listening — `setMonitor('ambience',
     * { solo: true })`, `setMonitor('angry', { mute: true })`.
     */
    setMonitor(key, { mute, solo } = {}) { setMonitorSets(key, mute, solo); setLevels(); },
    clearMonitor() { monitorSets.mute.clear(); monitorSets.solo.clear(); setLevels(); },
    /** 1 if `key` passes for listening under the current mutes and solos, else 0. */
    audible: pass,
    /** The peak on Master since the last read, `[left, right]` linear, or null before a tap. */
    meter: readMeter,
    /** The low end on the Music bus, 0..1 — what the street racer's underglow pulses to. */
    bass: readBass,
    audition,
    stopAuditions,
    files: FILES,
    update,
    hold,
    locoOn,
    locoOff,
    /** Fade out a voice `play()` returned — the drive-through speaker as the taxi leaves the lot. */
    release: (voice, tau = 0.3) => stopVoice(voice, tau),
    /** Let a voice `play({ loop: true })` started finish the pass it is on, then end. */
    unloop: (voice) => { if (voice) voice.src.loop = false; },
    steer,
    duckMusic,
    fadeOutMusic,
    goOnAir,
    openDash,
    /**
     * How long the first song after the intro has been playing through the dash, in seconds: 0
     * before it starts (negative while it is only scheduled reads as 0 too), and Infinity when there
     * is no context to play it — before the first tap nothing is playing, so nothing should wait.
     */
    dashMusicSeconds: () => (!ctx ? Infinity
      : state.dashSongAt === null ? 0 : Math.max(0, ctx.currentTime - state.dashSongAt)),
    setMuted,
    setVolumes,
    toggleMuted: () => { setMuted(!state.muted); return state.muted; },
  };
}
