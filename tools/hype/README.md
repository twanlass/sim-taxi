# The trailer

`./hype.sh` records footage off the real game and cuts it into a one-minute trailer with its own
soundtrack: `hype/sim-taxi-trailer.mp4`, 1280×720, 30fps. Nothing in it is mocked up — every frame
of city is the shipped bundle, driven by an autopilot that taps riders and holds Loco Mode the way
a player does.

```bash
./hype.sh                 # record every scene (~25 min under SwiftShader), then compose (~5 min)
./hype.sh --compose       # re-cut from the footage already in hype/frames
./hype.sh play crash      # re-record two scenes, then compose
```

Needs Chromium (`CHROME`, default `/opt/pw-browsers/chromium`) and an ffmpeg with libx264
(`FFMPEG`, or `pip install imageio-ffmpeg` and it is found automatically). The two fonts are OFL
and fetched from Google Fonts on the first compose rather than committed.

## How the footage is smooth

Headless WebGL runs on SwiftShader at ~3 frames a second, so anything recorded against the wall
clock is a slideshow. `cdp.mjs` takes the clock away from the page instead: a script injected before
the bundle replaces `performance.now`, `Date.now` and `requestAnimationFrame`, and the recorder
advances that virtual clock by exactly 1/30s per captured frame. `THREE.Clock` reads
`performance.now`, so the game sees a steady 30fps however long each frame took to draw.

What it does not reach is the compositor's own timeline — CSS transitions and Web Animations run on
wall time. Everything that does that is HUD, and the trailer hides the HUD, so it does not show.
The story beats that *are* DOM (the robber's line, the radio) stay up.

## The pieces

| File | Does |
|---|---|
| `cdp.mjs` | Chromium over CDP with the virtual clock. `frame()` steps and screenshots |
| `pilot.js` | Evaluated into the page: the autopilot (a rider tap is `routeTo` + `markDirected`, Loco Mode is `boost.press()`), the follow camera, the HUD switch, and a status line the edit reads |
| `record.mjs` | The scenes — `opening`, `play`, `drawbridge`, `drift`, `crash` — each a fresh page load on a pinned `?seed=`/`?run=` with a seeded pilot, so a re-record should give the same footage (not yet checked frame for frame — the robber's line is still dismissed on wall time). Writes `<scene>/NNNNN.jpg` and a `log.json` of the pilot's status every 5 frames |
| `timeline.mjs` | The sections on a 120 BPM grid. Shared by the music and the edit so a cut and a drum hit cannot drift apart. A beat is 0.5s — exactly 15 frames |
| `music.mjs` | The soundtrack, synthesised sample by sample: kick, clap, hats, a rolling bass, offbeat stabs and a hook, arranged per section (a riser into the drop, a half-time breath under the wreck). No samples, like the rest of the project |
| `edit.mjs` | The cut: which scene and frame plays when, the titles, the flashes |
| `compose.html` / `compose.mjs` | Renders each output frame in Chromium — footage, grade, beat punch-ins, titles — as a pure function of edit time, then muxes with ffmpeg |

## Re-cutting

The edit refers to footage by frame index, so it is tied to the recording. Re-recording a scene
with the same seeds should reproduce it; changing a scene's setup, the seeds, or the game itself will move
things, and `edit.mjs` then needs its `from` values re-picked. Each scene's `log.json` is where to
find the beats (`delivered` ticking up, `robbery` going true, `crashed`), and a contact sheet is the
quickest way to judge a framing:

```bash
ffmpeg -pattern_type glob -i 'hype/frames/play/*.jpg' -vf "select='not(mod(n\,30))',scale=320:-1,tile=6x6" -frames:v 1 sheet.jpg
```

`compose.mjs --only 20,30` renders a sub-range for a quick look.
