/**
 * The polaroid on the run-end screen: one frame of the ending, copied off the game's own canvas.
 *
 * The canvas is not `preserveDrawingBuffer` (it costs a full-screen copy every frame), so a frame
 * can only be read in the same task that drew it — `grab` is called straight after a
 * `renderFrame()`, the way moveclip.js freezes its stills. It copies a centred square into a small
 * 2D canvas, which is what the card then shows. Small on purpose: the print is ~190 CSS pixels
 * wide at most, and a full-resolution copy of a 3x phone canvas is ~30MB of pixels to throw away.
 *
 * **Which frame.** A grab carries a priority and a lower one never replaces the print already
 * taken, so the shots can be offered in any order and the best one that actually rendered wins
 * (an equal one does replace it: main.js keeps offering the replay's frames until one is far
 * enough past the hit):
 *
 *   - `LIVE` — the live beat's last frame, pulled in on the wreck as the replay cuts in. The
 *     fallback for a replay tapped past before its last cut.
 *   - `REPLAY` — the replay's last and tightest cut, just past the impact, with the fireball at
 *     its biggest. The shot the whole replay is built to land on, so it is the one worth keeping.
 *   - `END` — a bust or a firing, grabbed as the card comes up: there is no single instant to pick
 *     there, and the frame the pull-in ended on is the ending. Also a wreck with no replay.
 */
export const PHOTO = { END: 0, LIVE: 1, REPLAY: 2 };

// The square's side as a fraction of the canvas's shorter side. Every ending frames its subject
// in the middle of the screen (the replay centres between the taxi and the impact, the live beat
// and a bust pull in on the taxi), so a centred crop keeps it; the trim loses the empty road at
// the edges that a print this small cannot afford.
const CROP = 0.72;
const SIDE = 360;   // device pixels of the print — ~2x its largest CSS size

export function createSnapshot(source) {
  let print = null;
  let rank = -1;

  return {
    /** Copy the frame just drawn, unless the print already held was taken at a higher priority. */
    grab(priority) {
      if (priority < rank) return false;
      const w = source.width;
      const h = source.height;
      if (!w || !h) return false;
      const side = Math.round(Math.min(w, h) * CROP);
      print ??= document.createElement('canvas');
      print.width = print.height = Math.min(SIDE, side);
      const ctx = print.getContext('2d');
      ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, print.width, print.height);
      rank = priority;
      return true;
    },
    /** The print to put on the card, or null if nothing was ever grabbed. */
    photo: () => (rank >= 0 ? print : null),
    /** Which priority the held print was taken at (-1 for none). For the checks. */
    rank: () => rank,
  };
}
