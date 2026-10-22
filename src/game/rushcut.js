import { MAX_SPAN } from '../city/grid.js';
import { PLAY_ZOOM, RIGHT, UP, VIEW_UP } from './camera.js';

// The rush's pull-out (Tyler, 2026-10-20: "maybe we even zoom out and highlight them then continue
// the game"). Each step up the kerb's ramp (KERB_RAMP in difficulty.js) puts its new riders on the
// kerb at once, the first of them the first time in a run the board is more than one rider — so the
// world stops for a beat, the camera pulls out over the taxi and all of them, each rider's mark pops in turn, and the
// camera comes back to where it was before anything moves again.
//
// **Stopped, not slowed**, for the bank job's reason (game/bankjob.js): the clocks the beat is
// showing must not be spent on showing them. Everything here runs on wall time and main.js draws
// and returns, the same freeze branch as the bank job's cut. A tap anywhere skips to the way back.
//
// The framing is the bank job's `frameCut` arithmetic with the opposite clamp: that one is a
// push-in and never goes wider than 34, this one is a pull-out and never goes *tighter* than play
// zoom, so a rush that happens to land all on screen still reads as the camera stepping back.

/** Seconds out, held, and back. */
const OUT = 0.8;
const HOLD = 1.9;
const BACK = 0.7;
/** Each rider's pop, and the gap between one rider's and the next. */
const POP = 0.45;
const POP_STAGGER = 0.28;
/** How far a mark swells at the top of its pop. */
const POP_SCALE = 0.6;
/** Room round the riders and the taxi, in world units of screen, and the HUD's share of the height. */
const MARGIN = 6;
const HUD_TOP = 0.15;
const HUD_BOTTOM = 0.2;
/**
 * Never wider than this. The rush's riders stand within RUSH_REACH of the taxi, which a phone held
 * upright fits under 78 (every junction's 2-block diamond, swept at 390 × 844); past the cap the farthest rider is left at the frame's edge rather than
 * the whole island shrunk to a postage stamp.
 */
const ZOOM_MAX = MAX_SPAN * 0.75;

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Where to stand to see every point, at least as wide as play zoom. Pure, for the probe.
 *
 * @param points  world points `{x, z}` — the riders' kerbs and the taxi
 * @param aspect  width over height
 */
export function frameRush(points, aspect) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    const sx = p.x * RIGHT.x + p.z * RIGHT.z;
    const sy = p.x * VIEW_UP.x + p.z * VIEW_UP.z;
    x0 = Math.min(x0, sx);
    x1 = Math.max(x1, sx);
    y0 = Math.min(y0, sy);
    y1 = Math.max(y1, sy);
  }
  const usable = 1 - HUD_TOP - HUD_BOTTOM;
  const halfW = (x1 - x0) / 2 + MARGIN;
  const halfH = (y1 - y0) / 2 + MARGIN;
  const zoom = Math.min(ZOOM_MAX, Math.max(PLAY_ZOOM, halfH / usable, halfW / aspect));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2 - zoom * (HUD_BOTTOM - HUD_TOP);
  // Back onto the ground — see `frameCut` in game/bankjob.js.
  const b = cy / UP.dot(VIEW_UP);
  return { x: RIGHT.x * cx + UP.x * b, z: RIGHT.z * cx + UP.z * b, zoom };
}

/**
 * @param controller  the city camera (game/camera.js)
 */
export function createRushCut(controller) {
  let cut = null;

  function setPop(entry, s) {
    entry.marker.group.scale.copy(entry.markerScale).multiplyScalar(s);
    entry.ring.scale.copy(entry.ringScale).multiplyScalar(s);
  }

  return {
    running: () => cut !== null,

    /**
     * Open the beat over `riders` (waiting fares — anything with a `slot` and a kerb point) and the
     * taxi. `kerb(fare)` is where the rider stands.
     */
    begin(riders, kerb, taxi, aspect) {
      if (cut || riders.length === 0) return false;
      controller.cancelGlide();
      const from = { x: controller.state.target.x, z: controller.state.target.z, zoom: controller.state.zoom };
      const points = [{ x: taxi.x, z: taxi.z }, ...riders.map(kerb)];
      cut = {
        t: 0,
        from,
        to: frameRush(points, aspect),
        pops: riders.map((f) => ({
          marker: f.slot.marker,
          ring: f.slot.marker.ring,
          markerScale: f.slot.marker.group.scale.clone(),
          ringScale: f.slot.marker.ring.scale.clone(),
        })),
      };
      return true;
    },

    /** Jump to the way back. */
    skip() {
      if (cut && cut.t < OUT + HOLD) cut.t = OUT + HOLD;
    },

    /** Wall time. Returns false on the frame the beat ends, with the camera back where it was. */
    update(dt, aspect) {
      if (!cut) return false;
      cut.t += dt;
      const { from, to, t } = cut;
      let u;
      if (t < OUT) u = smootherstep(t / OUT);
      else if (t < OUT + HOLD) u = 1;
      else u = 1 - smootherstep(Math.min(1, (t - OUT - HOLD) / BACK));
      controller.cutTo(
        from.x + (to.x - from.x) * u,
        from.z + (to.z - from.z) * u,
        from.zoom + (to.zoom - from.zoom) * u,
        0,
        aspect,
      );

      // The pops: one rider after another, starting as the camera settles. A swell that holds a
      // little bigger for the rest of the hold, so the last one popped is not the only one that
      // reads as picked out, and settles back with the camera's return.
      const hold = t - OUT * 0.75;
      cut.pops.forEach((entry, k) => {
        const local = hold - k * POP_STAGGER;
        let s = 1;
        if (local > 0) {
          const swell = local < POP ? Math.sin((local / POP) * Math.PI) * POP_SCALE : 0;
          s = 1 + swell + 0.18 * Math.min(1, local / POP) * u;
        }
        setPop(entry, s);
      });

      if (t >= OUT + HOLD + BACK) {
        for (const entry of cut.pops) setPop(entry, 1);
        controller.cutTo(from.x, from.z, from.zoom, 0, aspect);
        cut = null;
        return false;
      }
      return true;
    },

    /** Drop the beat where it stands — the run ended under it. */
    release(aspect) {
      if (!cut) return;
      for (const entry of cut.pops) setPop(entry, 1);
      controller.cutTo(cut.from.x, cut.from.z, cut.from.zoom, 0, aspect);
      cut = null;
    },
  };
}
